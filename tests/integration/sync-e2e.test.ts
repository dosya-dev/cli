import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { DosyaClient } from "../../src/client";
import { runCycle } from "../../src/sync/engine";
import type { SyncPair } from "../../src/sync/types";
import { startFakeSyncApi, type FakeSyncApi } from "../helpers/fake-sync-api";

/**
 * End-to-end sync of a deliberately complex local tree — deep nesting, spaces,
 * unicode, dotfiles, empty dirs — against an in-memory fake of the sync API.
 * Exercises the real engine: scan → snapshot → reconcile → executor.
 */
describe("sync end-to-end (complex folders, no network)", () => {
    let api: FakeSyncApi;
    let root: string;
    let pair: SyncPair;
    let client: DosyaClient;

    const write = (rel: string, body: string) => {
        const full = join(root, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body);
    };

    beforeAll(() => {
        // Isolate the sync state dir.
        process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosya-sync-e2e-cfg-"));
        root = mkdtempSync(join(tmpdir(), "dosya-sync-e2e-src-"));

        write("a.txt", "root file");
        write(".hidden", "a dotfile");
        write("docs/readme.md", "readme");
        write("docs/sub/deep.txt", "deep");
        write("docs/sub/with space.txt", "spaced");
        write("data/café.txt", "unicode");        // non-ascii folder+file
        mkdirSync(join(root, "empty"), { recursive: true }); // empty dir (files-only sync)

        api = startFakeSyncApi();
        api.install();   // route the engine's fetch through the in-memory fake
        client = new DosyaClient(api.base, "dos_test");
        pair = {
            id: "p_e2e", local: root, remoteWorkspaceId: "ws_test", remoteFolderId: null,
            syncMode: "two-way", conflictStrategy: "last-write-wins", excludes: [], pollIntervalMs: 15000,
        };
    });

    afterAll(() => {
        api.stop();
        rmSync(root, { recursive: true, force: true });
    });

    it("uploads the whole tree with structure preserved", async () => {
        const res = await runCycle(client, pair, false);
        expect(res.failures).toEqual([]);

        const remote = new Set(api.paths().keys());
        for (const p of ["a.txt", ".hidden", "docs/readme.md", "docs/sub/deep.txt", "docs/sub/with space.txt", "data/café.txt"]) {
            expect(remote.has(p)).toBe(true);
        }
        // Empty dirs are not synced (files-only) — documents that limitation.
        expect([...api.folders.values()].some(f => f.name === "empty")).toBe(false);
        // Nested hierarchy is real (sub's parent is docs).
        const docs = [...api.folders.values()].find(f => f.name === "docs" && f.parent_id === null);
        const sub = [...api.folders.values()].find(f => f.name === "sub");
        expect(docs).toBeDefined();
        expect(sub?.parent_id).toBe(docs!.id);
    });

    it("uploaded bytes are intact", async () => {
        const byPath = api.paths();
        const readRemote = (rel: string) => new TextDecoder().decode(api.objects.get(byPath.get(rel)!)!);
        expect(readRemote("docs/sub/with space.txt")).toBe("spaced");
        expect(readRemote("data/café.txt")).toBe("unicode");
    });

    it("is a no-op on the second run (state settles, no churn)", async () => {
        const res = await runCycle(client, pair, false);
        expect(res.failures).toEqual([]);
        expect(res.applied).toBe(0);
    });

    it("pulls a new remote file into the right nested local path", async () => {
        api.addRemoteFile("incoming/reports/q3.txt", "from cloud");
        const res = await runCycle(client, pair, false);
        expect(res.failures).toEqual([]);
        const local = join(root, "incoming/reports/q3.txt");
        expect(existsSync(local)).toBe(true);
        expect(readFileSync(local, "utf8")).toBe("from cloud");
    });

    it("uploads a new version when a local file changes", async () => {
        const byPath = api.paths();
        const fid = byPath.get("docs/readme.md")!;
        writeFileSync(join(root, "docs/readme.md"), "readme v2 — longer content");
        const res = await runCycle(client, pair, false);
        expect(res.failures).toEqual([]);
        expect(api.files.get(fid)!.current_version).toBeGreaterThanOrEqual(2);
    });

    it("mirrors a local deletion to the cloud (two-way)", async () => {
        rmSync(join(root, "docs/sub/deep.txt"));
        const res = await runCycle(client, pair, false);
        expect(res.failures).toEqual([]);
        expect(api.paths().has("docs/sub/deep.txt")).toBe(false);
    });
});

/**
 * Batching regression: the server caps manifest/commit at 5000 files and
 * download-manifest at 500. A real /var backup is ~8k files, so the engine
 * MUST chunk both directions or the whole cycle is rejected. The fake mirrors
 * those caps (returns "Max N files per request") so an un-batched call fails.
 */
describe("sync large trees (server batch caps)", () => {
    it("pushes >5000 new files in batches (manifest/commit cap = 5000)", async () => {
        process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosya-sync-big-cfg-"));
        const root = mkdtempSync(join(tmpdir(), "dosya-sync-big-push-"));
        const api = startFakeSyncApi();
        api.install();
        try {
            const N = 5001; // one past the 5000 cap → forces ≥2 batches
            for (let i = 0; i < N; i++) writeFileSync(join(root, `f${i}.txt`), `body ${i}`);
            const client = new DosyaClient(api.base, "dos_test");
            const pair: SyncPair = {
                id: "p_big_push", local: root, remoteWorkspaceId: "ws_test", remoteFolderId: null,
                syncMode: "push", conflictStrategy: "last-write-wins", excludes: [], pollIntervalMs: 15000,
            };
            const res = await runCycle(client, pair, false);
            expect(res.failures).toEqual([]);
            expect(api.files.size).toBe(N);
        } finally {
            api.stop();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("pulls >500 remote files in batches (download-manifest cap = 500)", async () => {
        process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosya-sync-big-cfg2-"));
        const root = mkdtempSync(join(tmpdir(), "dosya-sync-big-pull-"));
        const api = startFakeSyncApi();
        api.install();
        try {
            const M = 501; // one past the 500 cap → forces ≥2 download batches
            for (let i = 0; i < M; i++) api.addRemoteFile(`r${i}.txt`, `cloud ${i}`);
            const client = new DosyaClient(api.base, "dos_test");
            const pair: SyncPair = {
                id: "p_big_pull", local: root, remoteWorkspaceId: "ws_test", remoteFolderId: null,
                syncMode: "pull", conflictStrategy: "last-write-wins", excludes: [], pollIntervalMs: 15000,
            };
            const res = await runCycle(client, pair, false);
            expect(res.failures).toEqual([]);
            let present = 0;
            for (let i = 0; i < M; i++) if (existsSync(join(root, `r${i}.txt`))) present++;
            expect(present).toBe(M);
        } finally {
            api.stop();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
