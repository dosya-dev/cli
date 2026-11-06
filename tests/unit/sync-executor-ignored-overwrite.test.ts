/**
 * Regression: a download-new is planned only for a path the local scan did not
 * see. If a file nevertheless exists there (it was ignored via .dosyaignore, or
 * the filesystem is case-insensitive and the remote name differs only by case)
 * the executor must refuse to overwrite it rather than silently replace it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyActions } from "../../src/sync/executor";
import type { SyncAction, SyncPair } from "../../src/sync/types";

const base = join(tmpdir(), "dosya-ignored-overwrite-test");
const root = join(base, "syncroot");
const REMOTE_PAYLOAD = "REMOTE-PAYLOAD";

let server: ReturnType<typeof Bun.serve>;
let fakeRemote: any;
let pair: SyncPair;

beforeEach(() => {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "secrets.txt"), "LOCAL-SENTINEL", "utf8");
    server = Bun.serve({ port: 0, fetch: () => new Response(REMOTE_PAYLOAD) });
    const url = `http://127.0.0.1:${server.port}/blob`;
    fakeRemote = { async downloadUrls(ids: string[]) { return ids.map(id => ({ fileId: id, url, size: REMOTE_PAYLOAD.length })); } };
    pair = {
        id: "t", local: root, remoteWorkspaceId: "ws", remoteFolderId: null,
        syncMode: "two-way", conflictStrategy: "last-write-wins", excludes: [], pollIntervalMs: 0,
    };
});

afterEach(() => {
    server.stop(true);
    rmSync(base, { recursive: true, force: true });
});

function fsIsCaseInsensitive(): boolean {
    return existsSync(join(root, "SECRETS.TXT"));
}

describe("applyActions never overwrites an unsynced local file with a download-new", () => {
    it("refuses a download-new onto an existing (ignored) local file, same case", async () => {
        const actions: SyncAction[] = [
            { kind: "download-new", relPath: "secrets.txt", remoteId: "f1", localPath: "secrets.txt", size: REMOTE_PAYLOAD.length },
        ];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);

        expect(readFileSync(join(root, "secrets.txt"), "utf8")).toBe("LOCAL-SENTINEL");
        expect(res.applied).toBe(0);
        expect(res.failures.length).toBe(1);
        expect(res.failures[0].error).toContain("already exists");
        expect(existsSync(join(root, "secrets.txt.dosya-partial"))).toBe(false);
    });

    it("refuses a download-new whose name differs only by case on a case-insensitive filesystem", async () => {
        const actions: SyncAction[] = [
            { kind: "download-new", relPath: "SECRETS.TXT", remoteId: "f1", localPath: "SECRETS.TXT", size: REMOTE_PAYLOAD.length },
        ];
        // Probe before applying: on Linux the download itself creates SECRETS.TXT.
        const caseInsensitive = fsIsCaseInsensitive();
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);

        // The ignored local file is intact on every platform.
        expect(readFileSync(join(root, "secrets.txt"), "utf8")).toBe("LOCAL-SENTINEL");
        if (caseInsensitive) {
            // Windows / default macOS: SECRETS.TXT *is* secrets.txt - must refuse.
            expect(res.applied).toBe(0);
            expect(res.failures.length).toBe(1);
        } else {
            // Linux: a genuinely distinct file - the download is legitimate.
            expect(res.applied).toBe(1);
            expect(readFileSync(join(root, "SECRETS.TXT"), "utf8")).toBe(REMOTE_PAYLOAD);
        }
    });

    it("still downloads a download-new to a path where nothing exists", async () => {
        const actions: SyncAction[] = [
            { kind: "download-new", relPath: "fresh.txt", remoteId: "f1", localPath: "fresh.txt", size: REMOTE_PAYLOAD.length },
        ];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);
        expect(res.applied).toBe(1);
        expect(readFileSync(join(root, "fresh.txt"), "utf8")).toBe(REMOTE_PAYLOAD);
    });
});
