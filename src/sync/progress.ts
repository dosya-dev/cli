import { progress, progressEnd, progressInteractive, isQuiet } from "../output";
import type { SyncProgress, SyncProgressFn } from "./types";

/** Format one progress event into a human line (no pair prefix). */
export function formatProgress(ev: SyncProgress): string {
    switch (ev.kind) {
        case "scan": return "scanning local files…";
        case "snapshot": return "fetching remote listing…";
        case "plan": {
            const bits: string[] = [];
            if (ev.uploads) bits.push(`${ev.uploads} to upload`);
            if (ev.downloads) bits.push(`${ev.downloads} to download`);
            if (ev.deletes) bits.push(`${ev.deletes} to delete`);
            return bits.length ? `plan: ${bits.join(", ")}` : "already up to date";
        }
        case "upload": return `uploading ${ev.done}/${ev.total}…`;
        case "download": return `downloading ${ev.done}/${ev.total}…`;
        case "finalize": return "finalizing…";
    }
}

/**
 * Build a progress reporter for `sync run`. On a TTY it redraws one line in
 * place; when piped (the daemon's log file) it emits discrete milestone lines,
 * throttled so a big transfer doesn't write thousands of lines. Returns null in
 * quiet mode (nothing to report). Pair with `progressEnd()` after the cycle.
 */
export function makeSyncReporter(pairId: string, everyN = 250): SyncProgressFn | undefined {
    if (isQuiet()) return undefined;
    const interactive = progressInteractive();
    let lastLogged = 0;
    return (ev: SyncProgress) => {
        const line = `[${pairId}] ${formatProgress(ev)}`;
        if (interactive) { progress(line); return; }
        // Non-TTY: throttle the per-file upload/download spam; always log phases.
        if (ev.kind === "upload" || ev.kind === "download") {
            if (ev.done !== ev.total && ev.done - lastLogged < everyN) return;
            lastLogged = ev.done;
        }
        console.error(line);
    };
}
