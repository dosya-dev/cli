import { describe, it, expect } from "bun:test";
import { basename } from "path";
import { planFolderLevels, uploadRootName } from "../../src/commands/upload";

describe("planFolderLevels", () => {
    it("groups directories by depth, shallowest first", () => {
        const levels = planFolderLevels(new Set(["a", "a/b", "a/b/c", "d", "d/e"]));
        expect(levels).toEqual([
            ["a", "d"],
            ["a/b", "d/e"],
            ["a/b/c"],
        ]);
    });

    it("keeps every parent in an earlier level than its children", () => {
        const dirs = new Set([
            "x/y/z", "x", "x/y", "deep/er/still/more", "deep", "deep/er", "deep/er/still",
        ]);
        const levels = planFolderLevels(dirs);
        const levelOf = new Map<string, number>();
        levels.forEach((level, i) => level.forEach(d => levelOf.set(d, i)));
        for (const d of dirs) {
            if (!d.includes("/")) continue;
            const parent = d.substring(0, d.lastIndexOf("/"));
            expect(levelOf.get(parent)!).toBeLessThan(levelOf.get(d)!);
        }
    });

    it("returns no levels for an empty set", () => {
        expect(planFolderLevels(new Set())).toEqual([]);
    });

    it("covers every input directory exactly once", () => {
        const dirs = new Set(["a", "b/c", "b", "a/x/y", "a/x"]);
        const flat = planFolderLevels(dirs).flat();
        expect(flat.length).toBe(dirs.size);
        expect(new Set(flat)).toEqual(dirs);
    });
});

describe("uploadRootName", () => {
    it("uses the directory's own name", () => {
        expect(uploadRootName("/Users/someone/Downloads")).toBe("Downloads");
    });

    it("ignores a trailing slash", () => {
        expect(uploadRootName("/Users/someone/Downloads/")).toBe("Downloads");
    });

    it("resolves '.' to the current directory's name", () => {
        expect(uploadRootName(".")).toBe(basename(process.cwd()));
    });

    it("resolves a relative path to its real name", () => {
        expect(uploadRootName("./foo/../bar")).toBe("bar");
    });
});
