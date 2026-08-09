import { describe, it, expect } from "bun:test";
import { resolveFavouriteWorkspaceId } from "../../src/commands/star";
import type { Resolved } from "../../src/resolver";

function target(type: "file" | "folder", id: string, workspaceId: string): Resolved {
    return { type, id, workspaceId, name: id };
}

describe("resolveFavouriteWorkspaceId", () => {
    // dosya star/unstar has the same root cause rm's batch-delete bug did: a
    // bare id resolved with no -w flag and no default workspace comes back
    // from resolver.ts with workspaceId: "" (deliberate - a raw id needs no
    // workspace to address it alone). /api/favourites POST and DELETE both
    // require workspace_id unconditionally though (favourites are rows keyed
    // by (user_id, workspace_id, file_id/folder_id) with no alternate lookup
    // path) - so sending "" straight through gets the same 400
    // "workspace_id is required" rm used to get. Unlike rm, there is no
    // sibling endpoint that skips workspace_id entirely, so the fix here is
    // to look the object's real workspace up first.

    it("returns the known workspace without making a network call", async () => {
        const client = {
            get: async () => {
                throw new Error("must not call GET when workspaceId is already known");
            },
        };
        const ws = await resolveFavouriteWorkspaceId(client as never, target("file", "file_a", "ws_1"));
        expect(ws).toBe("ws_1");
    });

    it("looks up a file's real workspace via GET /api/files/:id when unknown", async () => {
        const calls: string[] = [];
        const client = {
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, file: { workspace_id: "ws_9" } };
            },
        };
        const ws = await resolveFavouriteWorkspaceId(client as never, target("file", "file_a", ""));
        expect(ws).toBe("ws_9");
        expect(calls).toEqual(["/api/files/file_a"]);
    });

    it("looks up a folder's real workspace via GET /api/folders/:id when unknown", async () => {
        const calls: string[] = [];
        const client = {
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, folder: { workspace_id: "ws_9" } };
            },
        };
        const ws = await resolveFavouriteWorkspaceId(client as never, target("folder", "fld_a", ""));
        expect(ws).toBe("ws_9");
        expect(calls).toEqual(["/api/folders/fld_a"]);
    });
});
