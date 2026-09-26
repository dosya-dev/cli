/**
 * Regression: the executor must never let a traversal path in an action escape
 * the sync root. Reproduces the path-traversal report against the real
 * applyActions - a download / move / delete whose path climbs out of root must
 * be refused and reported as a failure, leaving files outside the root intact.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyActions } from "../../src/sync/executor";
import type { SyncAction, SyncPair } from "../../src/sync/types";

const base = join(tmpdir(), "dosya-containment-test");
const root = join(base, "syncroot");
const outsideMarker = join(base, "OUTSIDE-victim.txt");
const POC_BYTES = "ATTACKER-CONTROLLED";

let server: ReturnType<typeof Bun.serve>;
let fakeRemote: any;
let pair: SyncPair;

beforeEach(() => {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(outsideMarker, "ORIGINAL", "utf8");
    server = Bun.serve({ port: 0, fetch: () => new Response(POC_BYTES) });
    const url = `http://127.0.0.1:${server.port}/blob`;
    fakeRemote = { async downloadUrls(ids: string[]) { return ids.map(id => ({ fileId: id, url, size: POC_BYTES.length })); } };
    pair = {
        id: "t", local: root, remoteWorkspaceId: "ws", remoteFolderId: null,
        syncMode: "two-way", conflictStrategy: "last-write-wins", excludes: [], pollIntervalMs: 0,
    };
});

afterEach(() => {
    server.stop(true);
    rmSync(base, { recursive: true, force: true });
});

describe("applyActions path containment", () => {
    it("refuses a download-new that escapes the root and leaves the outside file intact", async () => {
        const actions: SyncAction[] = [
            { kind: "download-new", relPath: "../OUTSIDE-victim.txt", remoteId: "f1", localPath: "../OUTSIDE-victim.txt", size: POC_BYTES.length },
        ];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);

        expect(readFileSync(outsideMarker, "utf8")).toBe("ORIGINAL");
        expect(res.applied).toBe(0);
        expect(res.failures.length).toBe(1);
    });

    it("refuses a delete-local that escapes the root", async () => {
        const actions: SyncAction[] = [
            { kind: "delete-local", localPath: "../OUTSIDE-victim.txt", remoteId: "f1", relPath: "../OUTSIDE-victim.txt" },
        ];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);

        expect(existsSync(outsideMarker)).toBe(true);
        expect(res.applied).toBe(0);
        expect(res.failures.length).toBe(1);
    });

    it("refuses a move-local whose destination escapes the root", async () => {
        writeFileSync(join(root, "inside.txt"), "MOVE-ME", "utf8");
        const moveDest = join(base, "MOVED-OUTSIDE.txt");
        const actions: SyncAction[] = [
            { kind: "move-local", fromPath: "inside.txt", toPath: "../MOVED-OUTSIDE.txt", remoteId: "f1" },
        ];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);

        expect(existsSync(moveDest)).toBe(false);
        expect(res.applied).toBe(0);
        expect(res.failures.length).toBe(1);
    });

    it("refuses a download through a pre-existing directory symlink that escapes the root", async () => {
        // The victim has a directory symlink inside the sync root pointing to a
        // sibling directory outside it. The local scanner skips symlinks, so the
        // alias is never in the inventory; a remote-controlled "alias/<name>"
        // then reconciles as a download-new. Lexically "alias/victim.txt" stays
        // under the root, so only the real-path gate can stop the escape.
        const outsideDir = join(base, "outside-dir");
        mkdirSync(outsideDir, { recursive: true });
        const outsideFile = join(outsideDir, "victim.txt");
        writeFileSync(outsideFile, "ORIGINAL", "utf8");
        symlinkSync(outsideDir, join(root, "alias"), "dir");

        const actions: SyncAction[] = [
            { kind: "download-new", relPath: "alias/victim.txt", remoteId: "f1", localPath: "alias/victim.txt", size: POC_BYTES.length },
        ];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);

        expect(readFileSync(outsideFile, "utf8")).toBe("ORIGINAL");
        expect(res.applied).toBe(0);
        expect(res.failures.length).toBe(1);
    });

    it("still applies a legitimate in-root download", async () => {
        const actions: SyncAction[] = [
            { kind: "download-new", relPath: "sub/ok.txt", remoteId: "f2", localPath: "sub/ok.txt", size: POC_BYTES.length },
        ];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);

        expect(res.applied).toBe(1);
        expect(res.failures.length).toBe(0);
        expect(readFileSync(join(root, "sub/ok.txt"), "utf8")).toBe(POC_BYTES);
    });
});
