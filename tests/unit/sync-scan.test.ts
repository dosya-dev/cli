import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { scanLocal } from "../../src/sync/scan";
import { compileExcludes } from "../../src/sync/config";

describe("scanLocal", () => {
    it("walks nested files, records dirs, and honours excludes", () => {
        const root = mkdtempSync(join(tmpdir(), "dosya-scan-"));
        writeFileSync(join(root, "a.txt"), "hi");
        mkdirSync(join(root, "sub"));
        writeFileSync(join(root, "sub", "b.txt"), "yo");
        writeFileSync(join(root, "skip.tmp"), "x");

        const res = scanLocal(root, compileExcludes(["*.tmp"]));

        expect(res.incomplete).toBe(false);
        expect(res.entries.get("a.txt")?.isDir).toBe(false);
        expect(res.entries.get("a.txt")?.size).toBe(2);
        expect(res.entries.get("sub")?.isDir).toBe(true);
        expect(res.entries.get("sub/b.txt")?.size).toBe(2);
        expect(res.entries.has("skip.tmp")).toBe(false);
    });
});
