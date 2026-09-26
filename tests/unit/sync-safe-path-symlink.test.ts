import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { resolveWithinRoot, resolveRealWithinRoot } from "../../src/sync/safe-path";

describe("resolveRealWithinRoot (symlink-aware containment)", () => {
    let base: string;
    let root: string;
    let outside: string;

    beforeEach(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), "dosya-symlink-test-")));
        root = join(base, "sync-root");
        outside = join(base, "outside");
        mkdirSync(root);
        mkdirSync(outside);
    });

    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });

    it("fails closed when a directory symlink inside the root escapes it", () => {
        // A pre-existing directory symlink inside the sync root pointing outside.
        symlinkSync(outside, join(root, "alias"), "dir");
        // The lexical gate is fooled: the string stays under the root.
        expect(resolveWithinRoot(root, "alias/victim.txt")).not.toBeNull();
        // The real gate must refuse: the parent resolves outside the root.
        expect(resolveRealWithinRoot(root, "alias/victim.txt")).toBeNull();
    });

    it("fails closed when the candidate itself is a symlink escaping the root", () => {
        symlinkSync(join(outside, "target.txt"), join(root, "link.txt"), "file");
        expect(resolveRealWithinRoot(root, "link.txt")).toBeNull();
    });

    it("allows a legitimate existing nested file inside the root", () => {
        mkdirSync(join(root, "a", "b"), { recursive: true });
        const full = resolveRealWithinRoot(root, "a/b/file.txt");
        expect(full).not.toBeNull();
        expect(full!.startsWith(realpathSync(root) + sep)).toBe(true);
    });

    it("allows a new file whose directories do not exist yet", () => {
        const full = resolveRealWithinRoot(root, "new/deep/file.txt");
        expect(full).not.toBeNull();
    });

    it("still rejects a plain traversal name", () => {
        expect(resolveRealWithinRoot(root, "../escape.txt")).toBeNull();
    });

    it("returns null when the root does not exist", () => {
        expect(resolveRealWithinRoot(join(base, "no-such-root"), "file.txt")).toBeNull();
    });
});
