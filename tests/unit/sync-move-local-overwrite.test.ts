/**
 * Regression (bounty 2026-11-07): a remote rename onto a path where a local
 * file the planner did not see already lives (ignored, untracked, or differing
 * only by case) was planned as move-local, and the executor renamed over it.
 * Also: excludes must fold case where the filesystem does, so `.GIT/...` and
 * `.DOSYAIGNORE` from the remote are treated as the ignored `.git` and
 * `.dosyaignore`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyActions } from "../../src/sync/executor";
import { compileExcludes, DEFAULT_IGNORES } from "../../src/sync/config";
import { reconcile } from "../../src/sync/reconcile";
import type { SyncAction, SyncPair } from "../../src/sync/types";

const base = join(tmpdir(), "dosya-move-local-overwrite-test");
const root = join(base, "syncroot");
const fakeRemote: any = {};
let pair: SyncPair;

beforeEach(() => {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "tracked.txt"), "TRACKED", "utf8");
    writeFileSync(join(root, "private.txt"), "LOCAL-PRIVATE", "utf8");
    pair = {
        id: "t", local: root, remoteWorkspaceId: "ws", remoteFolderId: null,
        syncMode: "two-way", conflictStrategy: "keep-both", excludes: [], pollIntervalMs: 0,
    };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("move-local never renames over a different local file", () => {
    it("refuses a rename onto an existing unrelated file and keeps both", async () => {
        const actions: SyncAction[] = [{ kind: "move-local", fromPath: "tracked.txt", toPath: "private.txt", remoteId: "r1" }];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);
        expect(res.applied).toBe(0);
        expect(res.failures[0].error).toContain("already exists");
        expect(readFileSync(join(root, "private.txt"), "utf8")).toBe("LOCAL-PRIVATE");
        expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("TRACKED");
    });

    it("refuses a case-variant rename onto a different file on a case-folding filesystem", async () => {
        const caseInsensitive = existsSync(join(root, "PRIVATE.TXT"));
        const actions: SyncAction[] = [{ kind: "move-local", fromPath: "tracked.txt", toPath: "PRIVATE.TXT", remoteId: "r1" }];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);
        expect(readFileSync(join(root, "private.txt"), "utf8")).toBe("LOCAL-PRIVATE");
        expect(res.applied).toBe(caseInsensitive ? 0 : 1);
    });

    it("still allows a case-only rename of the file itself", async () => {
        const actions: SyncAction[] = [{ kind: "move-local", fromPath: "tracked.txt", toPath: "Tracked.txt", remoteId: "r1" }];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);
        expect(res.failures).toEqual([]);
        expect(res.applied).toBe(1);
        expect(readFileSync(join(root, "Tracked.txt"), "utf8")).toBe("TRACKED");
    });

    it("still moves onto a free path", async () => {
        const actions: SyncAction[] = [{ kind: "move-local", fromPath: "tracked.txt", toPath: "sub/renamed.txt", remoteId: "r1" }];
        const res = await applyActions(fakeRemote, pair, actions, [], undefined);
        expect(res.applied).toBe(1);
        expect(readFileSync(join(root, "sub/renamed.txt"), "utf8")).toBe("TRACKED");
    });
});

describe("excludes fold case on case-insensitive filesystems", () => {
    const ci = compileExcludes([...DEFAULT_IGNORES, "secret.txt"], true);
    const cs = compileExcludes([...DEFAULT_IGNORES, "secret.txt"], false);

    it("matches case variants of built-in and user ignores when folding", () => {
        expect(ci(".GIT/hooks/pre-commit")).toBe(true);
        expect(ci(".DOSYAIGNORE")).toBe(true);
        expect(ci("SECRET.TXT")).toBe(true);
        expect(ci("notes.txt")).toBe(false);
    });

    it("keeps exact-case matching when the filesystem is case-sensitive", () => {
        expect(cs(".git/hooks/pre-commit")).toBe(true);
        expect(cs(".GIT/hooks/pre-commit")).toBe(false);
    });

    it("drops a remote .GIT/hooks file from the plan when folding", () => {
        const actions = reconcile({
            local: new Map(), state: { files: {} } as any, mode: "pull-safe", conflictStrategy: "keep-both",
            localIncomplete: false, isExcluded: ci,
            remote: new Map([["h1", { remoteId: "h1", relPath: ".GIT/hooks/pre-commit", size: 10, updatedAt: 1, version: 1 } as any]]),
        });
        expect(actions).toEqual([]);
    });
});
