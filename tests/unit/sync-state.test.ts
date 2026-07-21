import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadState, saveState } from "../../src/sync/state";
import type { SyncFileRecord } from "../../src/sync/types";

const sampleRecord: SyncFileRecord = {
    remoteId: "r1", remoteName: "a.txt", remoteFolderId: null, remoteSize: 3,
    remoteUpdatedAt: 100, remoteVersion: 1,
    localPath: "a.txt", localSize: 3, localMtimeMs: 100000, syncedAt: 100,
};

describe("sync per-pair state", () => {
    it("round-trips through save/load", () => {
        process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosya-sync-state-"));
        saveState({ pairId: "pX", lastFullSyncAt: 5, files: { r1: sampleRecord }, folders: {} });
        const s = loadState("pX");
        expect(s.lastFullSyncAt).toBe(5);
        expect(s.files.r1.remoteName).toBe("a.txt");
    });

    it("returns an empty default when the file is missing", () => {
        process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosya-sync-state-empty-"));
        const s = loadState("does-not-exist");
        expect(s.files).toEqual({});
        expect(s.folders).toEqual({});
    });
});
