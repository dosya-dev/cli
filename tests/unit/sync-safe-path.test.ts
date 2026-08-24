import { describe, it, expect } from "bun:test";
import { resolve, sep } from "path";
import { isSafeRelPath, resolveWithinRoot } from "../../src/sync/safe-path";

describe("isSafeRelPath", () => {
    it("accepts ordinary relative paths", () => {
        expect(isSafeRelPath("file.txt")).toBe(true);
        expect(isSafeRelPath("a/b/c.txt")).toBe(true);
        expect(isSafeRelPath(".gitignore")).toBe(true);
        expect(isSafeRelPath("dir/.hidden")).toBe(true);
    });

    it("rejects a parent-dir segment (POSIX and Windows separators)", () => {
        expect(isSafeRelPath("..")).toBe(false);
        expect(isSafeRelPath("../escape.txt")).toBe(false);
        expect(isSafeRelPath("a/../../escape.txt")).toBe(false);
        expect(isSafeRelPath("..\\escape.txt")).toBe(false);
        expect(isSafeRelPath("a\\..\\b")).toBe(false);
    });

    it("rejects absolute, drive-qualified, and UNC paths", () => {
        expect(isSafeRelPath("/etc/passwd")).toBe(false);
        expect(isSafeRelPath("C:\\Windows\\System32")).toBe(false);
        expect(isSafeRelPath("\\\\server\\share")).toBe(false);
        expect(isSafeRelPath("\\evil")).toBe(false);
    });

    it("rejects NUL and control characters", () => {
        expect(isSafeRelPath("a\x00b")).toBe(false);
        expect(isSafeRelPath("a\nb")).toBe(false);
    });

    it("rejects empty and lone-dot segments", () => {
        expect(isSafeRelPath("")).toBe(false);
        expect(isSafeRelPath(".")).toBe(false);
        expect(isSafeRelPath("a//b")).toBe(false);
        expect(isSafeRelPath("a/./b")).toBe(false);
    });
});

describe("resolveWithinRoot", () => {
    const root = "/tmp/syncroot";

    it("returns the resolved absolute path for a safe relPath", () => {
        expect(resolveWithinRoot(root, "a/b.txt")).toBe(resolve(root, "a/b.txt"));
    });

    it("returns the root itself for an empty-but-safe edge is rejected", () => {
        // An empty relPath is not a legal file path - reject it.
        expect(resolveWithinRoot(root, "")).toBeNull();
    });

    it("returns null when the path would escape the root (POSIX)", () => {
        expect(resolveWithinRoot(root, "../escape.txt")).toBeNull();
        expect(resolveWithinRoot(root, "a/../../escape.txt")).toBeNull();
    });

    it("returns null for Windows-style traversal even on POSIX hosts", () => {
        expect(resolveWithinRoot(root, "..\\escape.txt")).toBeNull();
    });

    it("returns null for absolute and drive-qualified candidates", () => {
        expect(resolveWithinRoot(root, "/etc/passwd")).toBeNull();
        expect(resolveWithinRoot(root, "C:\\Windows")).toBeNull();
    });

    it("does not treat a sibling dir sharing the root prefix as inside", () => {
        // /tmp/syncroot-evil must not count as inside /tmp/syncroot
        expect(resolveWithinRoot(root, "../syncroot-evil/x")).toBeNull();
    });

    it("keeps a legitimately nested path inside the root", () => {
        const full = resolveWithinRoot(root, "deep/nested/file.txt");
        expect(full).not.toBeNull();
        expect(full!.startsWith(resolve(root) + sep)).toBe(true);
    });
});
