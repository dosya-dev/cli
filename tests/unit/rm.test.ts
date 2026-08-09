import { describe, it, expect } from "bun:test";
import { partitionFilesForDelete } from "../../src/commands/rm";
import type { Resolved } from "../../src/resolver";

function file(id: string, workspaceId: string): Resolved {
    return { type: "file", id, workspaceId, name: id };
}

describe("partitionFilesForDelete", () => {
    it("groups files with a known workspace for the batch endpoint", () => {
        const { batches, singles } = partitionFilesForDelete([
            file("file_a", "ws_1"),
            file("file_b", "ws_1"),
        ]);
        expect(singles).toEqual([]);
        expect(batches.get("ws_1")).toEqual(["file_a", "file_b"]);
    });

    it("routes files with no known workspace (bare ids, no default set) to single deletes instead of an empty batch group", () => {
        // This is the `dosya rm a b` bug: two bare ids resolved with no -w flag
        // and no default workspace both come back with workspaceId === "" from
        // resolver.ts (by design - a raw id needs no workspace to address it
        // alone). Grouping by that empty string and POSTing
        // { workspace_id: "" } to /api/files/batch-delete gets rejected by the
        // server's `payload.workspace_id?.trim()` check. They must fall back
        // to the same per-file DELETE that `dosya rm a` already uses alone.
        const { batches, singles } = partitionFilesForDelete([
            file("file_a", ""),
            file("file_b", ""),
        ]);
        expect(batches.size).toBe(0);
        expect(singles.map(f => f.id)).toEqual(["file_a", "file_b"]);
    });

    it("splits a mixed set: known-workspace files batch, unknown-workspace files go solo", () => {
        const { batches, singles } = partitionFilesForDelete([
            file("file_a", "ws_1"),
            file("file_b", ""),
            file("file_c", "ws_1"),
        ]);
        expect(batches.get("ws_1")).toEqual(["file_a", "file_c"]);
        expect(singles.map(f => f.id)).toEqual(["file_b"]);
    });

    it("routes a single file to the single-DELETE path even when its workspace is known - never batches a lone target", () => {
        // DELETE /api/files/:id enforces two checks /api/files/batch-delete's
        // bulk UPDATE does not: it 403s a locked file (lock_mode check) and it
        // 403s a file outside a folder-confined member's anchor
        // (isFileWithinSubtree). Routing a single known-workspace file through
        // batch-delete - which this partition briefly did, since it only
        // checked workspaceId truthiness and never file count - silently
        // bypasses both: a locked or out-of-anchor file's UPDATE just matches
        // zero rows and the CLI reports success. A lone target must always take
        // the single-DELETE path, matching what `dosya rm <one-file>` did
        // before this file's fix was ever written.
        const { batches, singles } = partitionFilesForDelete([file("file_a", "ws_1")]);
        expect(batches.size).toBe(0);
        expect(singles.map(f => f.id)).toEqual(["file_a"]);
    });

    it("routes zero files to an empty partition (no-op)", () => {
        const { batches, singles } = partitionFilesForDelete([]);
        expect(batches.size).toBe(0);
        expect(singles).toEqual([]);
    });
});
