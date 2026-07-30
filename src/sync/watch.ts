import { watch, type FSWatcher } from "fs";
import { DosyaClient } from "../client";
import { log, debug } from "../output";
import { runCycle } from "./engine";
import type { SyncPair } from "./types";

const DEBOUNCE_MS = 800;

/**
 * Continuously sync a pair: run on local fs events (debounced) and on an
 * interval (which also catches remote changes). Coalesces bursts into one
 * cycle. Runs until the process is interrupted.
 */
export async function watchPair(client: DosyaClient, pair: SyncPair): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let dirty = false;

    function schedule(): void {
        if (timer) clearTimeout(timer);
        timer = setTimeout(runOnce, DEBOUNCE_MS);
    }

    async function runOnce(): Promise<void> {
        if (running) { dirty = true; return; }
        running = true;
        try {
            const res = await runCycle(client, pair, false);
            if (res.applied > 0 || res.conflicts > 0 || res.failures.length > 0) {
                log(`[${pair.id}] applied ${res.applied}${res.conflicts ? `, ${res.conflicts} conflict(s)` : ""}${res.failures.length ? `, ${res.failures.length} failure(s)` : ""}`);
            }
            for (const f of res.failures) console.error(`  failed: ${f.action}: ${f.error}`);
        } catch (err) {
            console.error(`[${pair.id}] sync error: ${(err as Error).message}`);
        } finally {
            running = false;
            if (dirty) { dirty = false; schedule(); }
        }
    }

    // Initial reconcile.
    await runOnce();

    // Local watcher - recursive isn't reliable on all Linux kernels, so the
    // interval poll below covers correctness there at some latency cost.
    let watcher: FSWatcher | null = null;
    try {
        watcher = watch(pair.local, { recursive: true }, () => schedule());
    } catch (err) {
        debug(`recursive watch unavailable (${(err as Error).message}); relying on interval poll`);
    }

    const interval = setInterval(schedule, Math.max(5000, pair.pollIntervalMs));

    log(`Watching ${pair.local} <-> ${pair.remoteWorkspaceId} (${pair.syncMode}). Press Ctrl+C to stop.`);

    // Keep the event loop alive. The process-level SIGINT handler exits cleanly.
    await new Promise<void>(() => { void watcher; void interval; });
}
