import { describe, it, expect } from "bun:test";
import { runSegmentedDownload, UrlExpiredError } from "../../src/commands/download";

interface Seg { index: number; start: number; end: number; bytesWritten: number; done: boolean }

function makeSegments(n: number): Seg[] {
    return Array.from({ length: n }, (_, i) => ({
        index: i, start: i * 1000, end: (i + 1) * 1000 - 1, bytesWritten: 0, done: false,
    }));
}

/**
 * Regression: `Promise.all` rejects on the first failure while its siblings are
 * still transferring. Restarting a segment that still has a live writer lets
 * that writer call writeSync() on an fd the caller has already closed — EBADF,
 * or a write into a recycled descriptor.
 */
describe("runSegmentedDownload — no orphaned writers", () => {
    it("waits for aborted segments to settle before restarting them", async () => {
        const segments = makeSegments(4);
        const live = new Map<number, number>();
        let maxConcurrentPerSegment = 0;
        let expireOnce = true;

        await runSegmentedDownload({
            segments,
            runSegment: async (seg, signal) => {
                const n = (live.get(seg.index) ?? 0) + 1;
                live.set(seg.index, n);
                maxConcurrentPerSegment = Math.max(maxConcurrentPerSegment, n);
                try {
                    if (expireOnce && seg.index === 0) {
                        await Bun.sleep(5);
                        throw new UrlExpiredError();
                    }
                    while (seg.bytesWritten < 1000) {
                        if (signal.aborted) return;
                        await Bun.sleep(3);
                        seg.bytesWritten += 100;
                    }
                    seg.done = true;
                } finally {
                    live.set(seg.index, (live.get(seg.index) ?? 1) - 1);
                }
            },
            refreshUrl: async () => { expireOnce = false; },
            onCheckpoint: () => {},
        });

        expect(maxConcurrentPerSegment).toBe(1);
        expect([...live.values()].every(v => v === 0)).toBe(true);
        expect(segments.every(s => s.done)).toBe(true);
        expect(segments.map(s => s.bytesWritten)).toEqual([1000, 1000, 1000, 1000]);
    });

    it("leaves no writer running after a non-recoverable failure", async () => {
        const segments = makeSegments(3);
        let running = 0;

        const failure = runSegmentedDownload({
            segments,
            runSegment: async (seg, signal) => {
                running++;
                try {
                    if (seg.index === 0) { await Bun.sleep(3); throw new Error("disk full"); }
                    for (let i = 0; i < 20; i++) {
                        if (signal.aborted) return;
                        await Bun.sleep(2);
                    }
                    seg.done = true;
                } finally {
                    running--;
                }
            },
            refreshUrl: async () => {},
            onCheckpoint: () => {},
        });

        await expect(failure).rejects.toThrow("disk full");
        // The caller closes the fd right after this returns
        expect(running).toBe(0);
    });
});

describe("runSegmentedDownload — completion and refresh limits", () => {
    it("returns once every segment is done", async () => {
        const segments = makeSegments(3);
        await runSegmentedDownload({
            segments,
            runSegment: async seg => { seg.bytesWritten = 1000; seg.done = true; },
            refreshUrl: async () => {},
            onCheckpoint: () => {},
        });
        expect(segments.every(s => s.done)).toBe(true);
    });

    it("gives up after the URL refresh budget is spent", async () => {
        const segments = makeSegments(2);
        let refreshes = 0;

        const failure = runSegmentedDownload({
            segments,
            runSegment: async () => { throw new UrlExpiredError(); },
            refreshUrl: async () => { refreshes++; },
            onCheckpoint: () => {},
            maxUrlRefreshes: 3,
        });

        await expect(failure).rejects.toThrow();
        expect(refreshes).toBe(3);
    });

    it("checkpoints resume state on every failed round", async () => {
        const segments = makeSegments(2);
        let checkpoints = 0;
        let expire = true;

        await runSegmentedDownload({
            segments,
            runSegment: async seg => {
                if (expire) throw new UrlExpiredError();
                seg.done = true;
            },
            refreshUrl: async () => { expire = false; },
            onCheckpoint: () => { checkpoints++; },
        });

        expect(checkpoints).toBeGreaterThan(0);
    });
});
