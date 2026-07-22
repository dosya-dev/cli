import { join, dirname, basename } from "path";
import { mkdirSync, statSync, renameSync, rmSync, existsSync } from "fs";
import { getLongTimeout } from "../runtime";
import { loadConfig } from "../config";
import { debug } from "../output";
import { SyncRemote, remoteFolderPaths, type UploadItem } from "./remote";
import { DELTA_MAX_BYTES } from "./chunker";
import type { SyncAction, SyncPair } from "./types";
import type { FolderNode } from "../resolver";

export interface ApplyResult {
    applied: number;
    conflicts: number;
    failures: { action: string; error: string }[];
}

/** The parent path of a root-relative file path ("" for a root-level file). */
function parentOf(relPath: string): string {
    const i = relPath.lastIndexOf("/");
    return i === -1 ? "" : relPath.slice(0, i);
}

/** Insert a " (conflicted copy)" tag before a path's extension. */
export function conflictedCopyName(relPath: string, tag = "conflicted copy"): string {
    const slash = relPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : relPath.slice(0, slash + 1);
    const base = slash === -1 ? relPath : relPath.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const name = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    return `${dir}${name} (${tag})${ext}`;
}

/** A conflicted-copy path under `root` that doesn't already exist. */
function uniqueConflictPath(root: string, relPath: string): string {
    let candidate = conflictedCopyName(relPath);
    let n = 2;
    while (existsSync(join(root, candidate))) {
        candidate = conflictedCopyName(relPath, `conflicted copy ${n}`);
        n++;
    }
    return join(root, candidate);
}

/**
 * Ensure the remote folder for a root-relative parent path exists, creating any
 * missing segments and caching each `relPath -> id` as it goes.
 */
async function ensureRemoteFolder(
    remote: SyncRemote,
    rootFolderId: string | null,
    cache: Map<string, string>,
    parentPath: string,
): Promise<string | null> {
    if (parentPath === "") return rootFolderId;
    const cached = cache.get(parentPath);
    if (cached) return cached;

    const segments = parentPath.split("/");
    let parentId: string | null = rootFolderId;
    let acc = "";
    for (const seg of segments) {
        acc = acc ? `${acc}/${seg}` : seg;
        const hit = cache.get(acc);
        if (hit) { parentId = hit; continue; }
        const id = await remote.createFolder(seg, parentId);
        cache.set(acc, id);
        parentId = id;
    }
    return parentId;
}

/**
 * Apply a reconciled action list. Folders are created as needed for uploads;
 * downloads mkdir -p locally and write atomically. Per-action failures are
 * collected rather than aborting the whole cycle.
 */
export async function applyActions(
    remote: SyncRemote,
    pair: SyncPair,
    actions: SyncAction[],
    folders: FolderNode[],
): Promise<ApplyResult> {
    const failures: { action: string; error: string }[] = [];
    let applied = 0;
    const conflicts = actions.filter(a => a.kind === "conflict").length;
    const root = pair.local;
    const folderCache = new Map<string, string>(remoteFolderPaths(folders, pair.remoteFolderId));
    // Block-level delta upload is opt-in (config `sync_delta`) and capped.
    const deltaEnabled = (await loadConfig())?.sync_delta === "true";

    // 1) New uploads — resolve/create parent folders, then manifest→PUT→commit.
    const uploadItems: UploadItem[] = [];
    for (const a of actions) {
        if (a.kind !== "upload-new") continue;
        try {
            const folderId = await ensureRemoteFolder(remote, pair.remoteFolderId, folderCache, parentOf(a.relPath));
            const full = join(root, a.localPath);
            const size = statSync(full).size;
            uploadItems.push({ relPath: a.relPath, name: basename(a.relPath), size, folderId, localPath: full });
        } catch (err) {
            failures.push({ action: `upload-new ${a.relPath}`, error: (err as Error).message });
        }
    }
    if (uploadItems.length > 0) {
        try {
            const n = await remote.uploadNew(uploadItems);
            applied += n;
            debug(`sync: uploaded ${n} new file(s)`);
        } catch (err) {
            failures.push({ action: "upload-new batch", error: (err as Error).message });
        }
    }

    // 2) Version uploads for changed files (delta when enabled + under the cap).
    for (const a of actions) {
        if (a.kind !== "upload-update") continue;
        try {
            const full = join(root, a.localPath);
            const size = statSync(full).size;
            const mime = Bun.file(full).type || "application/octet-stream";
            const name = basename(a.relPath);
            const folderId = await ensureRemoteFolder(remote, pair.remoteFolderId, folderCache, parentOf(a.relPath));
            if (deltaEnabled && size > 0 && size <= DELTA_MAX_BYTES) {
                await remote.uploadDelta(full, name, size, mime, a.remoteId!, folderId);
            } else {
                await remote.uploadVersion(full, name, size, mime, a.remoteId!, folderId);
            }
            applied++;
        } catch (err) {
            failures.push({ action: `upload-update ${a.relPath}`, error: (err as Error).message });
        }
    }

    // 3) Downloads (new + updated).
    const downloads = actions.filter(a => a.kind === "download-new" || a.kind === "download-update") as Extract<SyncAction, { kind: "download-new" | "download-update" }>[];
    if (downloads.length > 0) {
        try {
            const urls = await remote.downloadUrls(downloads.map(a => a.remoteId));
            const byId = new Map(urls.map(u => [u.fileId, u]));
            for (const a of downloads) {
                try {
                    const u = byId.get(a.remoteId);
                    if (!u) throw new Error("no download url returned");
                    const full = join(root, a.localPath);
                    mkdirSync(dirname(full), { recursive: true });
                    const res = await fetch(u.url, { signal: AbortSignal.timeout(getLongTimeout(600_000)) });
                    // Check res.ok only — reading the res.body getter before
                    // Bun.write(res) makes Bun.write hang forever (verified). Let
                    // Bun.write stream the body itself.
                    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
                    const tmp = `${full}.dosya-partial`;
                    await Bun.write(tmp, res);
                    renameSync(tmp, full);
                    applied++;
                } catch (err) {
                    failures.push({ action: `download ${a.relPath}`, error: (err as Error).message });
                }
            }
        } catch (err) {
            failures.push({ action: "download-manifest", error: (err as Error).message });
        }
    }

    // 3b) Conflicts (keep-both): preserve the local copy under a new name, then
    //     pull the remote version to the original path. Both survive, and the
    //     conflicted copy uploads on the next cycle — nothing is frozen or lost.
    const conflictActions = actions.filter(a => a.kind === "conflict") as Extract<SyncAction, { kind: "conflict" }>[];
    if (conflictActions.length > 0) {
        const pull: { remoteId: string; relPath: string }[] = [];
        for (const a of conflictActions) {
            try {
                const orig = join(root, a.relPath);
                if (existsSync(orig)) {
                    renameSync(orig, uniqueConflictPath(root, a.relPath));
                }
                pull.push({ remoteId: a.remoteId, relPath: a.relPath });
            } catch (err) {
                failures.push({ action: `conflict ${a.relPath}`, error: (err as Error).message });
            }
        }
        try {
            const urls = await remote.downloadUrls(pull.map(p => p.remoteId));
            const byId = new Map(urls.map(u => [u.fileId, u]));
            for (const p of pull) {
                try {
                    const u = byId.get(p.remoteId);
                    if (!u) throw new Error("no download url returned");
                    const full = join(root, p.relPath);
                    mkdirSync(dirname(full), { recursive: true });
                    const res = await fetch(u.url, { signal: AbortSignal.timeout(getLongTimeout(600_000)) });
                    // See the note above: never touch res.body before Bun.write.
                    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
                    const tmp = `${full}.dosya-partial`;
                    await Bun.write(tmp, res);
                    renameSync(tmp, full);
                    applied++;
                } catch (err) {
                    failures.push({ action: `conflict-download ${p.relPath}`, error: (err as Error).message });
                }
            }
        } catch (err) {
            failures.push({ action: "conflict-download-manifest", error: (err as Error).message });
        }
    }

    // 4) Local moves to match a remote rename/move.
    for (const a of actions) {
        if (a.kind !== "move-local") continue;
        try {
            const to = join(root, a.toPath);
            mkdirSync(dirname(to), { recursive: true });
            renameSync(join(root, a.fromPath), to);
            applied++;
        } catch (err) {
            failures.push({ action: `move-local ${a.fromPath}`, error: (err as Error).message });
        }
    }

    // 5) Local deletions.
    for (const a of actions) {
        if (a.kind !== "delete-local") continue;
        try {
            rmSync(join(root, a.localPath), { force: true });
            applied++;
        } catch (err) {
            failures.push({ action: `delete-local ${a.localPath}`, error: (err as Error).message });
        }
    }

    // 6) Remote deletions.
    for (const a of actions) {
        if (a.kind !== "delete-remote") continue;
        try {
            await remote.deleteFile(a.remoteId);
            applied++;
        } catch (err) {
            failures.push({ action: `delete-remote ${a.relPath}`, error: (err as Error).message });
        }
    }

    return { applied, conflicts, failures };
}
