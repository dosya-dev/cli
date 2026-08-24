/**
 * buildRemotePaths / remoteFolderPaths must quarantine snapshot entries whose
 * resolved path is not a safe root-relative path, so a hostile file or folder
 * name never becomes a tracked record or reaches a filesystem sink.
 */
import { describe, it, expect } from "bun:test";
import { buildRemotePaths, remoteFolderPaths } from "../../src/sync/remote";
import type { FolderNode } from "../../src/resolver";

interface SnapFile {
    id: string; name: string; size_bytes: number; mime_type: string | null;
    folder_id: string | null; updated_at: number; current_version: number;
}
const f = (id: string, name: string, folder_id: string | null = null): SnapFile => ({
    id, name, size_bytes: 1, mime_type: null, folder_id, updated_at: 1, current_version: 1,
});

describe("buildRemotePaths quarantine", () => {
    it("drops a root-level file whose name traverses up", () => {
        const map = buildRemotePaths([f("bad", "../escape.txt"), f("ok", "keep.txt")] as any, [], null);
        expect(map.has("bad")).toBe(false);
        expect(map.get("ok")?.relPath).toBe("keep.txt");
    });

    it("drops a file whose name uses a Windows-style traversal", () => {
        const map = buildRemotePaths([f("bad", "..\\escape.txt")] as any, [], null);
        expect(map.has("bad")).toBe(false);
    });

    it("drops a file that lives under a folder named '..'", () => {
        const folders: FolderNode[] = [{ id: "dd", name: "..", parent_id: null }];
        const map = buildRemotePaths([f("bad", "child.txt", "dd")] as any, folders, null);
        expect(map.has("bad")).toBe(false);
    });

    it("keeps a legitimately nested file", () => {
        const folders: FolderNode[] = [{ id: "sub", name: "sub", parent_id: null }];
        const map = buildRemotePaths([f("ok", "child.txt", "sub")] as any, folders, null);
        expect(map.get("ok")?.relPath).toBe("sub/child.txt");
    });
});

describe("remoteFolderPaths quarantine", () => {
    it("drops a folder whose resolved path escapes the root", () => {
        const folders: FolderNode[] = [
            { id: "dd", name: "..", parent_id: null },
            { id: "good", name: "docs", parent_id: null },
        ];
        const map = remoteFolderPaths(folders, null);
        expect(map.has("..")).toBe(false);
        expect(map.get("docs")).toBe("good");
    });
});
