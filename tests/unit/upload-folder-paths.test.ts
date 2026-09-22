import { describe, it, expect } from "bun:test";
import { requiredFolderPaths, planFolderLevels } from "../../src/commands/upload";

/**
 * `dosya upload -r` silently flattened part of the tree and overwrote files.
 *
 * The folder set was built from each file's IMMEDIATE parent only, so a
 * directory holding nothing but other directories was never created. The
 * per-folder create then resolved its missing parent as `?? rootTargetId`, so
 * `src/{a/deep/x.h, b/deep/y.h}` produced ONE `deep` folder at the root with
 * both files in it - and where two branches shared a filename, the second
 * upload landed as a new VERSION of the first rather than as its own file.
 *
 * Reproduced against production with the shipped 1.0.6 binary on 2026-09-03:
 * 12 files across l{1,2}/m{1,2}/f{1,2,3}.h uploaded, "Done. 12 uploaded, 0
 * failed", and SIX files existed afterwards - all at v2, under a flattened
 * `m1` and `m2`. No error, no warning, half the upload gone.
 */
describe("requiredFolderPaths", () => {
    it("includes ancestor directories that hold no files of their own", () => {
        expect(requiredFolderPaths(["l1/m1/f.h", "l2/m1/f.h"]))
            .toEqual(new Set(["l1", "l1/m1", "l2", "l2/m1"]));
    });

    it("keeps same-named directories under different parents distinct", () => {
        // This is the pair that used to collapse into one folder and take one
        // branch's files with it.
        const dirs = requiredFolderPaths(["a/deep/x.h", "b/deep/y.h"]);
        expect(dirs.has("a/deep")).toBe(true);
        expect(dirs.has("b/deep")).toBe(true);
        expect(dirs.has("deep")).toBe(false);
    });

    it("ignores files at the root, which need no folder", () => {
        expect(requiredFolderPaths(["a.txt", "b.txt"])).toEqual(new Set());
    });

    it("deduplicates shared ancestors rather than re-creating them per file", () => {
        expect(requiredFolderPaths(["x/y/1", "x/y/2", "x/y/z/3"]))
            .toEqual(new Set(["x", "x/y", "x/y/z"]));
    });

    it("gives planFolderLevels a set where every parent precedes its children", () => {
        // The two functions are a pair: the level planner assumes each path's
        // parent is also in the set, which is exactly what was not true before.
        const dirs = requiredFolderPaths(["a/b/c/d/f.h", "a/x/f.h"]);
        const levels = planFolderLevels(dirs);
        const levelOf = new Map<string, number>();
        levels.forEach((level, i) => level.forEach(d => levelOf.set(d, i)));

        for (const d of dirs) {
            if (!d.includes("/")) continue;
            const parent = d.substring(0, d.lastIndexOf("/"));
            expect(levelOf.has(parent)).toBe(true);
            expect(levelOf.get(parent)!).toBeLessThan(levelOf.get(d)!);
        }
    });
});
