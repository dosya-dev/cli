import { progress, progressInteractive, isQuiet, formatBytes } from "../output";
import type { SyncProgress, SyncProgressFn } from "./types";

/** Human-friendly duration: "45s", "8m 12s", "1h 20m". */
export function formatDuration(sec: number): string {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/**
 * Build a transfer line: "uploading 3/10 · 1.2 MB / 3.4 MB · 4.5 MB/s · ~8s left".
 * Size, rate and ETA appear only once known (`totalBytes > 0`, `elapsedMs > 0`);
 * otherwise it degrades to the bare "uploading 3/10…" count.
 */
export function formatTransfer(
    verb: string, done: number, total: number, bytes: number, totalBytes: number, elapsedMs: number,
): string {
    if (totalBytes <= 0) return `${verb} ${done}/${total}…`;
    let line = `${verb} ${done}/${total} · ${formatBytes(bytes)} / ${formatBytes(totalBytes)}`;
    if (elapsedMs > 0 && bytes > 0) {
        const rate = bytes / (elapsedMs / 1000); // bytes/sec
        line += ` · ${formatBytes(rate)}/s`;
        const remain = totalBytes - bytes;
        if (rate > 0 && remain > 0) line += ` · ~${formatDuration(remain / rate)} left`;
    }
    return line;
}

/** Format one progress event into a human line (no pair prefix, no timing). */
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
        case "upload": return formatTransfer("uploading", ev.done, ev.total, ev.bytes, ev.totalBytes, 0);
        case "download": return formatTransfer("downloading", ev.done, ev.total, ev.bytes, ev.totalBytes, 0);
        case "finalize": return "finalizing…";
    }
}

/**
 * Build a progress reporter for `sync run`. On a TTY it redraws one line in
 * place; when piped (the daemon's log file) it emits discrete milestone lines,
 * throttled so a big transfer doesn't write thousands of lines. Returns null in
 * quiet mode. Pair with `progressEnd()` after the cycle.
 *
 * `now` is injectable so the byte-rate/ETA maths is deterministically testable.
 */
export function makeSyncReporter(
    pairId: string, everyN = 250, now: () => number = () => Date.now(),
): SyncProgressFn | undefined {
    if (isQuiet()) return undefined;
    const interactive = progressInteractive();
    let lastLogged = 0;
    let transferStart = 0;
    let transferKind = "";
    return (ev: SyncProgress) => {
        let body: string;
        if (ev.kind === "upload" || ev.kind === "download") {
            // Reset the clock when the direction flips so an upload phase doesn't
            // dilute the download's rate (and vice versa).
            if (ev.kind !== transferKind) { transferStart = now(); lastLogged = 0; transferKind = ev.kind; }
            const verb = ev.kind === "upload" ? "uploading" : "downloading";
            body = formatTransfer(verb, ev.done, ev.total, ev.bytes, ev.totalBytes, now() - transferStart);
        } else {
            body = formatProgress(ev);
        }
        const line = `[${pairId}] ${body}`;
        if (interactive) { progress(line); return; }
        // Non-TTY: throttle the per-file upload/download spam; always log phases.
        if (ev.kind === "upload" || ev.kind === "download") {
            if (ev.done !== ev.total && ev.done - lastLogged < everyN) return;
            lastLogged = ev.done;
        }
        console.error(line);
    };
}
