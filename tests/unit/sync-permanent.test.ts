/**
 * A 403 on a sync action is permanent: the server has said this key may not do
 * this, and asking again next cycle changes nothing. Before this, `sync watch`
 * retried every refused upload/delete on every cycle and logged the same line
 * forever. The refusal is now recorded in the pair's state, keyed by path, and
 * the action is skipped until the file changes locally or the user runs
 * `dosya sync run` explicitly.
 */
import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { AuthError, ApiError, NetworkError } from "../../src/errors";
import {
    isPermanentSyncError, recordPermanentFailures, suppressPermanentFailures, PERMANENT_HINT,
} from "../../src/sync/permanent";
import { loadState, saveState } from "../../src/sync/state";
import { applyActions } from "../../src/sync/executor";
import type { LocalEntry } from "../../src/sync/scan";
import type { PermanentFailure, SyncAction, SyncPair } from "../../src/sync/types";

const file = (mtimeMs: number, size = 3): LocalEntry => ({ size, mtimeMs, isDir: false });
const local = (entries: Record<string, LocalEntry>) => new Map(Object.entries(entries));

describe("isPermanentSyncError", () => {
    it("is a 403 and nothing else", () => {
        expect(isPermanentSyncError(new AuthError("no", 403))).toBe(true);
        expect(isPermanentSyncError(new ApiError("no", 403))).toBe(true);
        // A dead key is not a permanent per-path condition - re-auth fixes every path at once.
        expect(isPermanentSyncError(new AuthError("dead", 401))).toBe(false);
        expect(isPermanentSyncError(new NetworkError("offline"))).toBe(false);
        expect(isPermanentSyncError(new Error("R2 PUT failed for a.txt: HTTP 403"))).toBe(false);
    });
});

describe("recordPermanentFailures", () => {
    it("keys by path and fingerprints the local file, null when there is none", () => {
        const rec = recordPermanentFailures({}, [
            { relPath: "a.txt", action: "upload-update", message: "You don't have permission" },
            { relPath: "gone.txt", action: "delete-remote", message: "no" },
        ], local({ "a.txt": file(500) }), 1000);
        expect(rec["a.txt"]).toEqual({ action: "upload-update", message: "You don't have permission", failedAt: 1000, local: { size: 3, mtimeMs: 500 } });
        expect(rec["gone.txt"].local).toBeNull();
    });
});

describe("suppressPermanentFailures", () => {
    const prev: Record<string, PermanentFailure> = {
        "a.txt": { action: "upload-update", message: "no", failedAt: 1, local: { size: 3, mtimeMs: 500 } },
        "gone.txt": { action: "delete-remote", message: "no", failedAt: 1, local: null },
    };
    const upload: SyncAction = { kind: "upload-update", relPath: "a.txt", localPath: "a.txt", folderId: null, remoteId: "r1" };
    const del: SyncAction = { kind: "delete-remote", remoteId: "r2", relPath: "gone.txt" };

    it("skips an action whose file is unchanged since the refusal", () => {
        const out = suppressPermanentFailures([upload, del], prev, local({ "a.txt": file(500) }), false);
        expect(out.actions).toEqual([]);
        expect(out.suppressed.sort()).toEqual(["a.txt", "gone.txt"]);
        expect(Object.keys(out.permanent).sort()).toEqual(["a.txt", "gone.txt"]);
    });

    it("retries, and forgets the refusal, once the file changes locally", () => {
        const out = suppressPermanentFailures([upload], prev, local({ "a.txt": file(900) }), false);
        expect(out.actions).toEqual([upload]);
        expect(out.permanent["a.txt"]).toBeUndefined();
        expect(out.permanent["gone.txt"]).toBeDefined();
    });

    it("retries everything on an explicit run", () => {
        const out = suppressPermanentFailures([upload, del], prev, local({ "a.txt": file(500) }), true);
        expect(out.actions).toEqual([upload, del]);
        expect(out.permanent).toEqual({});
    });

    it("drops a record whose local file has since vanished", () => {
        const out = suppressPermanentFailures([], prev, local({}), false);
        expect(out.permanent["a.txt"]).toBeUndefined();
        // A refused remote delete needs no local file; it stays until retried.
        expect(out.permanent["gone.txt"]).toBeDefined();
    });

    it("leaves downloads alone even at a recorded path", () => {
        const dl: SyncAction = { kind: "download-update", relPath: "a.txt", remoteId: "r1", localPath: "a.txt" };
        const out = suppressPermanentFailures([dl], prev, local({ "a.txt": file(500) }), false);
        expect(out.actions).toEqual([dl]);
    });
});

describe("state carries permanent failures", () => {
    it("round-trips them and defaults to none", () => {
        process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosya-sync-perm-"));
        const permanentFailures = { "a.txt": { action: "upload-new", message: "no", failedAt: 1, local: null } };
        saveState({ pairId: "pP", lastFullSyncAt: 5, files: {}, folders: {}, permanentFailures });
        expect(loadState("pP").permanentFailures).toEqual(permanentFailures);
        expect(loadState("missing").permanentFailures).toEqual({});
    });
});

describe("applyActions classifies a 403", () => {
    it("reports a refused remote delete once, as permanent, with the retry hint", async () => {
        const root = mkdtempSync(join(tmpdir(), "dosya-perm-exec-"));
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "keep.txt"), "abc");
        const pair: SyncPair = {
            id: "t", local: root, remoteWorkspaceId: "ws", remoteFolderId: null,
            syncMode: "two-way", conflictStrategy: "last-write-wins", excludes: [], pollIntervalMs: 0,
        };
        const fakeRemote: any = {
            async deleteFile() { throw new AuthError("You don't have permission to delete files", 403); },
            async uploadVersion() { throw new NetworkError("offline"); },
        };
        const actions: SyncAction[] = [
            { kind: "delete-remote", remoteId: "r2", relPath: "gone.txt" },
            { kind: "upload-update", relPath: "keep.txt", localPath: "keep.txt", folderId: null, remoteId: "r1" },
        ];
        try {
            const res = await applyActions(fakeRemote, pair, actions, [], undefined);
            expect(res.results.permanentFailures).toEqual([
                { relPath: "gone.txt", action: "delete-remote", message: "You don't have permission to delete files" },
            ]);
            const refused = res.failures.find(f => f.action === "delete-remote gone.txt")!;
            expect(refused.error).toContain(PERMANENT_HINT);
            // The network failure is still an ordinary, retried failure.
            expect([...res.results.failedRemoteIds].sort()).toEqual(["r1", "r2"]);
            expect(res.failures.find(f => f.action === "upload-update keep.txt")!.error).not.toContain(PERMANENT_HINT);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
