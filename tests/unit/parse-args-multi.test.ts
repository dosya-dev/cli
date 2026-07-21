import { describe, it, expect } from "bun:test";
import { parseArgs } from "../../src/parse-args";

describe("parseArgs — new flags and repeatable flags", () => {
    it("accumulates repeated --exclude into multi", () => {
        const r = parseArgs(["sync", "add", ".", "ws_1:", "--exclude", "*.tmp", "--exclude", "node_modules"]);
        expect(r.multi.exclude).toEqual(["*.tmp", "node_modules"]);
        // flags still holds the last value for single-value callers
        expect(r.flags.exclude).toBe("node_modules");
    });

    it("accumulates the inline --exclude=value form too", () => {
        const r = parseArgs(["--exclude=*.tmp", "--exclude=x"]);
        expect(r.multi.exclude).toEqual(["*.tmp", "x"]);
    });

    it("parses the new value flags", () => {
        expect(parseArgs(["--mode", "two-way"]).flags.mode).toBe("two-way");
        expect(parseArgs(["--conflict", "keep-both"]).flags.conflict).toBe("keep-both");
        expect(parseArgs(["--query", "foo"]).flags.query).toBe("foo");
        expect(parseArgs(["--type", "images"]).flags.type).toBe("images");
        expect(parseArgs(["--version-of", "file_1"]).flags["version-of"]).toBe("file_1");
    });

    it("parses the new boolean flags", () => {
        expect(parseArgs(["--dry-run"]).flags["dry-run"]).toBe("");
        expect(parseArgs(["--zip"]).flags.zip).toBe("");
        expect(parseArgs(["--watch"]).flags.watch).toBe("");
    });

    it("leaves multi empty when no repeatable flag is used", () => {
        expect(parseArgs(["ls", "ws_1"]).multi).toEqual({});
    });
});
