import { join, dirname, basename } from "path";
import { mkdirSync, statSync, renameSync, rmSync } from "fs";
import { getLongTimeout } from "../runtime";
import { debug } from "../output";
import { SyncRemote, remoteFolderPaths, type UploadItem } from "./remote";
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

    // 2) Version uploads for changed files.
    for (const a of actions) {
        if (a.kind !== "upload-update") continue;
        try {
            const full = join(root, a.localPath);
            const size = statSync(full).size;
            const mime = Bun.file(full).type || "application/octet-stream";
            const folderId = await ensureRemoteFolder(remote, pair.remoteFolderId, folderCache, parentOf(a.relPath));
            await remote.uploadVersion(full, basename(a.relPath), size, mime, a.remoteId!, folderId);
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
                    if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
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
