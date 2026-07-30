import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { scanLocal } from "../../src/sync/scan";
import { compileExcludes } from "../../src/sync/config";

describe("scanLocal", () => {
    it("walks nested files, records dirs, and honours excludes", async () => {
        const root = mkdtempSync(join(tmpdir(), "dosya-scan-"));
        writeFileSync(join(root, "a.txt"), "hi");
        mkdirSync(join(root, "sub"));
        writeFileSync(join(root, "sub", "b.txt"), "yo");
        writeFileSync(join(root, "skip.tmp"), "x");

        const res = await scanLocal(root, compileExcludes(["*.tmp"]));

        expect(res.incomplete).toBe(false);
        expect(res.entries.get("a.txt")?.isDir).toBe(false);
        expect(res.entries.get("a.txt")?.size).toBe(2);
        expect(res.entries.get("sub")?.isDir).toBe(true);
        expect(res.entries.get("sub/b.txt")?.size).toBe(2);
        expect(res.entries.has("skip.tmp")).toBe(false);
    });

    it("scales to a deep, wide tree without blocking or dropping files", async () => {
        const root = mkdtempSync(join(tmpdir(), "dosya-scan-big-"));
        // 20 dirs × 100 files = 2000 files across a nested structure.
        let expected = 0;
        for (let d = 0; d < 20; d++) {
            const dir = join(root, `d${d}`, "nested");
            mkdirSync(dir, { recursive: true });
            for (let f = 0; f < 100; f++) { writeFileSync(join(dir, `f${f}.txt`), `${d}-${f}`); expected++; }
        }
        const res = await scanLocal(root, () => false);
        expect(res.incomplete).toBe(false);
        const fileCount = [...res.entries.values()].filter(e => !e.isDir).length;
        expect(fileCount).toBe(expected);
        expect(res.entries.get("d7/nested/f42.txt")?.size).toBe("7-42".length);
    });

    it("--one-file-system keeps same-device dirs (nothing skipped on one fs)", async () => {
        const root = mkdtempSync(join(tmpdir(), "dosya-scan-ofs-"));
        writeFileSync(join(root, "a.txt"), "hi");
        mkdirSync(join(root, "sub"));
        writeFileSync(join(root, "sub", "b.txt"), "yo");
        // The temp tree is all one filesystem, so oneFileSystem must not drop
        // anything (the cross-device skip only fires across a real mount).
        const res = await scanLocal(root, () => false, { oneFileSystem: true });
        expect(res.incomplete).toBe(false);
        expect(res.entries.get("a.txt")?.size).toBe(2);
        expect(res.entries.get("sub")?.isDir).toBe(true);
        expect(res.entries.get("sub/b.txt")?.size).toBe(2);
    });
});
