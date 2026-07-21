import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { pairId, compileExcludes, loadSyncConfig, saveSyncConfig } from "../../src/sync/config";
import type { SyncConfig } from "../../src/sync/types";

describe("pairId", () => {
    it("is deterministic and input-sensitive", () => {
        expect(pairId("/a", "ws_1:x")).toBe(pairId("/a", "ws_1:x"));
        expect(pairId("/a", "ws_1:x")).not.toBe(pairId("/b", "ws_1:x"));
    });
});

describe("compileExcludes", () => {
    it("matches globs on the whole path and on any segment", () => {
        const ex = compileExcludes(["*.tmp", "node_modules"]);
        expect(ex("a.tmp")).toBe(true);
        expect(ex("node_modules/x/y")).toBe(true);
        expect(ex("a.txt")).toBe(false);
    });

    it("an empty exclude list matches nothing", () => {
        expect(compileExcludes([])("anything/at/all")).toBe(false);
    });
});

describe("sync config round-trip", () => {
    it("saves and loads pairs", () => {
        process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosya-sync-cfg-"));
        const cfg: SyncConfig = {
            pairs: [{
                id: "p1", local: "/a", remoteWorkspaceId: "ws_1", remoteFolderId: null,
                syncMode: "two-way", conflictStrategy: "last-write-wins", excludes: ["*.tmp"], pollIntervalMs: 15000,
            }],
        };
        saveSyncConfig(cfg);
        const loaded = loadSyncConfig();
        expect(loaded.pairs).toHaveLength(1);
        expect(loaded.pairs[0].id).toBe("p1");
        expect(loaded.pairs[0].excludes).toEqual(["*.tmp"]);
    });

    it("returns an empty config when none exists", () => {
        process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosya-sync-empty-"));
        expect(loadSyncConfig()).toEqual({ pairs: [] });
    });
});
