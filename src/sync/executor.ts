import { join, dirname, basename } from "path";
import { mkdirSync, statSync, renameSync, rmSync, existsSync } from "fs";
import { getLongTimeout } from "../runtime";
import { loadConfig } from "../config";
import { debug } from "../output";
import { SyncRemote, remoteFolderPaths, DEFAULT_SYNC_PARALLEL, UPLOAD_STREAM_THRESHOLD, type UploadItem } from "./remote";
import { DELTA_MAX_BYTES } from "./chunker";
import { Semaphore } from "../semaphore";
import type { SyncAction, SyncPair, SyncProgressFn } from "./types";
import type { FolderNode } from "../resolver";

/** Parse the `sync_parallel` config value, clamped to a sane 1–16. */
function resolveParallel(raw: string | undefined): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_SYNC_PARALLEL;
    return Math.min(16, Math.floor(n));
}

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
    onProgress?: SyncProgressFn,
): Promise<ApplyResult> {
    const failures: { action: string; error: string }[] = [];
    let applied = 0;
    const conflicts = actions.filter(a => a.kind === "conflict").length;
    const root = pair.local;
    const folderCache = new Map<string, string>(remoteFolderPaths(folders, pair.remoteFolderId));
    const cfg = await loadConfig();
    // Block-level delta upload is opt-in (config `sync_delta`) and capped.
    const deltaEnabled = cfg?.sync_delta === "true";
    // How many transfers run at once. Sequential transfers are latency-bound and
    // crawl on a big push/pull; this is the single biggest throughput lever.
    const parallel = resolveParallel(cfg?.sync_parallel);
    const sem = new Semaphore(parallel);

    // Running totals for progress. Uploads = new files + changed-file versions;
    // downloads = new/updated pulls + keep-both conflict pulls. Byte totals feed
    // the "1.2 GB / 3.4 GB · rate · ETA" readout; download sizes come from the
    // remote snapshot (on the actions), upload sizes are statted just below.
    const uploadTotal =
        actions.filter(a => a.kind === "upload-new" || a.kind === "upload-update").length;
    const downloadTotal =
        actions.filter(a => a.kind === "download-new" || a.kind === "download-update" || a.kind === "conflict").length;
    let downloadBytesTotal = 0;
    for (const a of actions) {
        if (a.kind === "download-new" || a.kind === "download-update") downloadBytesTotal += a.size ?? 0;
        else if (a.kind === "conflict") downloadBytesTotal += a.remoteSize ?? 0;
    }
    let uploadBytesTotal = 0; // completed once upload sizes are known (below)
    let upDone = 0, downDone = 0, upBytes = 0, downBytes = 0;
    const reportUp = () => onProgress?.({ kind: "upload", done: upDone, total: uploadTotal, bytes: upBytes, totalBytes: uploadBytesTotal });
    const reportDown = () => onProgress?.({ kind: "download", done: downDone, total: downloadTotal, bytes: downBytes, totalBytes: downloadBytesTotal });

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
    // Now that upload sizes are known, finalise the upload byte total (new files
    // + a best-effort stat of each changed file) so the ETA is stable from the
    // first event. A file that fails to stat here is still handled in loop 2.
    uploadBytesTotal = uploadItems.reduce((sum, i) => sum + i.size, 0);
    for (const a of actions) {
        if (a.kind !== "upload-update") continue;
        try { uploadBytesTotal += statSync(join(root, a.localPath)).size; } catch { /* retried below */ }
    }
    // Partition by size: small files take the fast presigned batch path
    // (buffered, but bounded); large files stream via upload/init (multipart +
    // resume) so we never buffer a big file into RAM or lose progress mid-file.
    const smallNew = uploadItems.filter(i => i.size <= UPLOAD_STREAM_THRESHOLD);
    const largeNew = uploadItems.filter(i => i.size > UPLOAD_STREAM_THRESHOLD);

    if (smallNew.length > 0) {
        try {
            // Each PUT bumps the running upload count + bytes so a big first push
            // shows live movement and a byte-based ETA, not one summary at the end.
            // Per-file failures are collected (not fatal) so one bad file in /var
            // doesn't abort the whole backup — it just retries next cycle.
            const n = await remote.uploadNew(smallNew, {
                concurrency: parallel,
                onProgress: (done, bytes) => { upDone = done; upBytes += bytes; reportUp(); },
                onError: (name, err) => failures.push({ action: `upload-new ${name}`, error: err.message }),
            });
            applied += n;
            debug(`sync: uploaded ${n} new file(s)`);
        } catch (err) {
            failures.push({ action: "upload-new batch", error: (err as Error).message });
        }
    }
    // Large new files: stream each via upload/init, bounded by the same pool.
    await Promise.all(largeNew.map(item => sem.run(async () => {
        try {
            const mime = Bun.file(item.localPath).type || "application/octet-stream";
            await remote.uploadViaInit(item.localPath, item.name, item.size, mime, item.folderId, null);
            applied++;
            upDone++; upBytes += item.size; reportUp();
        } catch (err) {
            failures.push({ action: `upload-new ${item.relPath}`, error: (err as Error).message });
        }
    })));

    // 2) Version uploads for changed files (delta when enabled + under the cap).
    //    Resolve folders/sizes serially (avoids concurrent folder-create races),
    //    then transfer concurrently.
    const updates: { relPath: string; full: string; size: number; mime: string; name: string; remoteId: string; folderId: string | null }[] = [];
    for (const a of actions) {
        if (a.kind !== "upload-update") continue;
        try {
            const full = join(root, a.localPath);
            const size = statSync(full).size;
            const mime = Bun.file(full).type || "application/octet-stream";
            const name = basename(a.relPath);
            const folderId = await ensureRemoteFolder(remote, pair.remoteFolderId, folderCache, parentOf(a.relPath));
            updates.push({ relPath: a.relPath, full, size, mime, name, remoteId: a.remoteId!, folderId });
        } catch (err) {
            failures.push({ action: `upload-update ${a.relPath}`, error: (err as Error).message });
        }
    }
    await Promise.all(updates.map(u => sem.run(async () => {
        try {
            if (deltaEnabled && u.size > 0 && u.size <= DELTA_MAX_BYTES) {
                await remote.uploadDelta(u.full, u.name, u.size, u.mime, u.remoteId, u.folderId);
            } else {
                await remote.uploadVersion(u.full, u.name, u.size, u.mime, u.remoteId, u.folderId);
            }
            applied++;
            upDone++; upBytes += u.size; reportUp();
        } catch (err) {
            failures.push({ action: `upload-update ${u.relPath}`, error: (err as Error).message });
        }
    })));

    // 3) Downloads (new + updated).
    const downloads = actions.filter(a => a.kind === "download-new" || a.kind === "download-update") as Extract<SyncAction, { kind: "download-new" | "download-update" }>[];
    if (downloads.length > 0) {
        try {
            const urls = await remote.downloadUrls(downloads.map(a => a.remoteId));
            const byId = new Map(urls.map(u => [u.fileId, u]));
            await Promise.all(downloads.map(a => sem.run(async () => {
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
                    downDone++; downBytes += a.size ?? u.size ?? 0; reportDown();
                } catch (err) {
                    failures.push({ action: `download ${a.relPath}`, error: (err as Error).message });
                }
            })));
        } catch (err) {
            failures.push({ action: "download-manifest", error: (err as Error).message });
        }
    }

    // 3b) Conflicts (keep-both): preserve the local copy under a new name, then
    //     pull the remote version to the original path. Both survive, and the
    //     conflicted copy uploads on the next cycle — nothing is frozen or lost.
    const conflictActions = actions.filter(a => a.kind === "conflict") as Extract<SyncAction, { kind: "conflict" }>[];
    if (conflictActions.length > 0) {
        const pull: { remoteId: string; relPath: string; size?: number }[] = [];
        for (const a of conflictActions) {
            try {
                const orig = join(root, a.relPath);
                if (existsSync(orig)) {
                    renameSync(orig, uniqueConflictPath(root, a.relPath));
                }
                pull.push({ remoteId: a.remoteId, relPath: a.relPath, size: a.remoteSize });
            } catch (err) {
                failures.push({ action: `conflict ${a.relPath}`, error: (err as Error).message });
            }
        }
        try {
            const urls = await remote.downloadUrls(pull.map(p => p.remoteId));
            const byId = new Map(urls.map(u => [u.fileId, u]));
            await Promise.all(pull.map(p => sem.run(async () => {
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
                    downDone++; downBytes += p.size ?? u.size ?? 0; reportDown();
                } catch (err) {
                    failures.push({ action: `conflict-download ${p.relPath}`, error: (err as Error).message });
                }
            })));
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
