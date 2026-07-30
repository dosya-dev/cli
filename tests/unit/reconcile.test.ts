import { describe, it, expect } from "bun:test";
import { reconcile, type ReconcileInput } from "../../src/sync/reconcile";
import type { LocalEntry } from "../../src/sync/scan";
import type { RemoteFile, SyncFileRecord, SyncPairState, SyncMode, ConflictStrategy } from "../../src/sync/types";

function rec(over: Partial<SyncFileRecord> = {}): SyncFileRecord {
    return {
        remoteId: "r1", remoteName: "a.txt", remoteFolderId: null, remoteSize: 3,
        remoteUpdatedAt: 100, remoteVersion: 1,
        localPath: "a.txt", localSize: 3, localMtimeMs: 100000, syncedAt: 100, ...over,
    };
}
function remoteFile(over: Partial<RemoteFile> = {}): RemoteFile {
    return { id: "r1", name: "a.txt", folderId: null, size: 3, updatedAt: 100, version: 1, relPath: "a.txt", ...over };
}
function local(over: Partial<LocalEntry> = {}): LocalEntry {
    return { size: 3, mtimeMs: 100000, isDir: false, ...over };
}
function state(files: Record<string, SyncFileRecord> = {}): SyncPairState {
    return { pairId: "p", lastFullSyncAt: 0, files, folders: {} };
}
function run(over: Partial<ReconcileInput>): ReturnType<typeof reconcile> {
    return reconcile({
        local: new Map(), remote: new Map(), state: state(),
        mode: "two-way", conflictStrategy: "last-write-wins", localIncomplete: false, ...over,
    });
}

describe("reconcile - basic cases", () => {
    it("local-only file → upload-new", () => {
        const acts = run({ local: new Map([["a.txt", local()]]) });
        expect(acts).toEqual([{ kind: "upload-new", relPath: "a.txt", localPath: "a.txt", folderId: null }]);
    });

    it("remote-only file → download-new", () => {
        const acts = run({ remote: new Map([["r1", remoteFile()]]) });
        expect(acts).toEqual([{ kind: "download-new", relPath: "a.txt", remoteId: "r1", localPath: "a.txt", size: 3 }]);
    });

    it("in-sync tracked file → no action", () => {
        const acts = run({
            local: new Map([["a.txt", local()]]),
            remote: new Map([["r1", remoteFile()]]),
            state: state({ r1: rec() }),
        });
        expect(acts).toEqual([]);
    });
});

describe("reconcile - deletions", () => {
    it("local deleted, remote unchanged → delete-remote", () => {
        const acts = run({ remote: new Map([["r1", remoteFile()]]), state: state({ r1: rec() }) });
        expect(acts).toEqual([{ kind: "delete-remote", remoteId: "r1", relPath: "a.txt" }]);
    });

    it("local deleted, remote changed → download-new", () => {
        const acts = run({ remote: new Map([["r1", remoteFile({ updatedAt: 200, version: 2 })]]), state: state({ r1: rec() }) });
        expect(acts[0].kind).toBe("download-new");
    });

    it("remote deleted, local unchanged → delete-local", () => {
        const acts = run({ local: new Map([["a.txt", local()]]), state: state({ r1: rec() }) });
        expect(acts).toEqual([{ kind: "delete-local", localPath: "a.txt", remoteId: "r1", relPath: "a.txt" }]);
    });

    it("remote deleted, local changed → upload-new", () => {
        const acts = run({ local: new Map([["a.txt", local({ mtimeMs: 200000 })]]), state: state({ r1: rec() }) });
        expect(acts[0].kind).toBe("upload-new");
    });
});

describe("reconcile - both sides changed", () => {
    const bothChanged = {
        local: new Map([["a.txt", local({ mtimeMs: 150000 })]]),
        remote: new Map([["r1", remoteFile({ updatedAt: 200, version: 2 })]]),
        state: state({ r1: rec() }),
    };

    it("last-write-wins, remote newer → download-update", () => {
        const acts = run({ ...bothChanged });
        expect(acts[0].kind).toBe("download-update");
    });

    it("last-write-wins, local newer → upload-update", () => {
        const acts = run({
            local: new Map([["a.txt", local({ mtimeMs: 300000 })]]),
            remote: new Map([["r1", remoteFile({ updatedAt: 200, version: 2 })]]),
            state: state({ r1: rec() }),
        });
        expect(acts[0].kind).toBe("upload-update");
    });

    it("keep-both → conflict", () => {
        const acts = run({ ...bothChanged, conflictStrategy: "keep-both" as ConflictStrategy });
        expect(acts[0].kind).toBe("conflict");
    });
});

describe("reconcile - mode gating", () => {
    it("push drops download and delete-local", () => {
        const acts = run({
            remote: new Map([["r2", remoteFile({ id: "r2", relPath: "b.txt" })]]),   // would download-new
            mode: "push" as SyncMode,
        });
        expect(acts).toEqual([]);
    });

    it("push keeps delete-remote (mirror deletions)", () => {
        const acts = run({ remote: new Map([["r1", remoteFile()]]), state: state({ r1: rec() }), mode: "push" as SyncMode });
        expect(acts).toEqual([{ kind: "delete-remote", remoteId: "r1", relPath: "a.txt" }]);
    });

    it("pull drops upload and delete-remote", () => {
        const acts = run({ local: new Map([["a.txt", local()]]), mode: "pull" as SyncMode });
        expect(acts).toEqual([]);
    });

    it("push-safe drops delete-remote", () => {
        const acts = run({ remote: new Map([["r1", remoteFile()]]), state: state({ r1: rec() }), mode: "push-safe" as SyncMode });
        expect(acts).toEqual([]);
    });

    it("pull-safe drops delete-local", () => {
        const acts = run({ local: new Map([["a.txt", local()]]), state: state({ r1: rec() }), mode: "pull-safe" as SyncMode });
        expect(acts).toEqual([]);
    });
});

describe("reconcile - deletion safety valve", () => {
    it("suppresses all deletes when the local scan is incomplete", () => {
        const acts = run({ remote: new Map([["r1", remoteFile()]]), state: state({ r1: rec() }), localIncomplete: true });
        expect(acts).toEqual([]);
    });

    it("suppresses a mass-delete", () => {
        const files: Record<string, SyncFileRecord> = {};
        const remote = new Map<string, RemoteFile>();
        for (let i = 0; i < 12; i++) {
            const id = `r${i}`;
            files[id] = rec({ remoteId: id, localPath: `f${i}.txt` });
            remote.set(id, remoteFile({ id, relPath: `f${i}.txt` }));
        }
        // All 12 local files are gone → 12 delete-remote, which trips the valve.
        const acts = run({ remote, state: state(files) });
        expect(acts.filter(a => a.kind === "delete-remote")).toEqual([]);
    });
});
