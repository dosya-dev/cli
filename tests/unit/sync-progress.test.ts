import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { formatProgress, formatTransfer, formatDuration, makeSyncReporter } from "../../src/sync/progress";

describe("formatDuration", () => {
    it("renders seconds, minutes and hours", () => {
        expect(formatDuration(0)).toBe("0s");
        expect(formatDuration(45)).toBe("45s");
        expect(formatDuration(492)).toBe("8m 12s");
        expect(formatDuration(4800)).toBe("1h 20m");
        expect(formatDuration(-5)).toBe("0s"); // never negative
    });
});

describe("formatTransfer", () => {
    it("degrades to a bare count when sizes are unknown", () => {
        expect(formatTransfer("uploading", 3, 10, 0, 0, 0)).toBe("uploading 3/10…");
    });
    it("shows size once totalBytes is known, but no rate without elapsed time", () => {
        expect(formatTransfer("uploading", 1, 2, 500, 2000, 0)).toBe("uploading 1/2 · 500 B / 2.0 KB");
    });
    it("adds rate and ETA from bytes-per-elapsed", () => {
        // 5 MB done in 1s → 5 MB/s; 5 MB remaining → ~1s left.
        const mb = 1024 * 1024;
        expect(formatTransfer("uploading", 1, 2, 5 * mb, 10 * mb, 1000))
            .toBe("uploading 1/2 · 5.0 MB / 10.0 MB · 5.0 MB/s · ~1s left");
    });
});

describe("formatProgress", () => {
    it("renders each phase as a human line", () => {
        expect(formatProgress({ kind: "scan" })).toBe("scanning local files…");
        expect(formatProgress({ kind: "snapshot" })).toBe("fetching remote listing…");
        expect(formatProgress({ kind: "finalize" })).toBe("finalizing…");
        expect(formatProgress({ kind: "upload", done: 3, total: 10, bytes: 0, totalBytes: 0 }))
            .toBe("uploading 3/10…");
    });

    it("summarises the plan, omitting empty buckets", () => {
        expect(formatProgress({ kind: "plan", uploads: 5, downloads: 2, deletes: 0 }))
            .toBe("plan: 5 to upload, 2 to download");
        expect(formatProgress({ kind: "plan", uploads: 0, downloads: 0, deletes: 0 }))
            .toBe("already up to date");
    });
});

describe("makeSyncReporter (non-TTY path)", () => {
    let errors: string[];
    const realError = console.error;

    beforeEach(() => {
        errors = [];
        console.error = (msg?: unknown) => { errors.push(String(msg)); };
    });
    afterEach(() => {
        console.error = realError;
    });

    it("prefixes the pair id and always emits phase lines", () => {
        const report = makeSyncReporter("p1")!;
        report({ kind: "scan" });
        report({ kind: "plan", uploads: 2, downloads: 0, deletes: 0 });
        expect(errors).toEqual(["[p1] scanning local files…", "[p1] plan: 2 to upload"]);
    });

    it("throttles per-file progress but always emits the final count, with size + ETA", () => {
        // Deterministic clock: 1s elapses per event after the first.
        let t = 0;
        const report = makeSyncReporter("p1", 100, () => (t += 1000))!;
        const mb = 1024 * 1024;
        for (let i = 1; i <= 250; i++) {
            report({ kind: "upload", done: i, total: 250, bytes: i * mb, totalBytes: 250 * mb });
        }
        // Emits at 100, 200, and the final 250 (done === total) — not all 250.
        expect(errors.length).toBe(3);
        expect(errors[0]).toContain("[p1] uploading 100/250 · 100.0 MB / 250.0 MB");
        expect(errors[0]).toContain("/s"); // a rate is present
        expect(errors[2]).toContain("uploading 250/250 · 250.0 MB / 250.0 MB");
    });
});
