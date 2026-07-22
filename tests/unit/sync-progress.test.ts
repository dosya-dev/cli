import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { formatProgress, makeSyncReporter } from "../../src/sync/progress";

describe("formatProgress", () => {
    it("renders each phase as a human line", () => {
        expect(formatProgress({ kind: "scan" })).toBe("scanning local files…");
        expect(formatProgress({ kind: "snapshot" })).toBe("fetching remote listing…");
        expect(formatProgress({ kind: "upload", done: 3, total: 10 })).toBe("uploading 3/10…");
        expect(formatProgress({ kind: "download", done: 7, total: 7 })).toBe("downloading 7/7…");
        expect(formatProgress({ kind: "finalize" })).toBe("finalizing…");
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

    it("throttles per-file progress but always emits the final count", () => {
        const report = makeSyncReporter("p1", 100)!; // log at most every 100 files
        for (let i = 1; i <= 250; i++) report({ kind: "upload", done: i, total: 250 });
        // Emits at 100, 200, and the final 250 (done === total) — not all 250.
        expect(errors).toEqual([
            "[p1] uploading 100/250…",
            "[p1] uploading 200/250…",
            "[p1] uploading 250/250…",
        ]);
    });
});
