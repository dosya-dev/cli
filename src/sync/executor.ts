import { join, dirname, basename } from "path";
import { mkdirSync, renameSync, rmSync, existsSync } from "fs";
import { stat } from "fs/promises";
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

/**
 * What actually happened this cycle, with the server's authoritative metadata
 * for every successful transfer. The engine builds the next "last synced"
 * state from this instead of re-scanning + re-fetching a full snapshot.
 */
export interface SyncResults {
    uploadedNew: { relPath: string; fileId: string; name: string; folderId: string | null; size: number; updatedAt: number | null; version: number }[];
    uploadedVersion: { remoteId: string; size: number; updatedAt: number | null; version: number }[];
    /** Successful downloads (incl. keep-both conflict pulls), local side statted post-write. */
    downloaded: { remoteId: string; relPath: string; mtimeMs: number; size: number }[];
    movedLocal: { remoteId: string; fromPath: string; toPath: string }[];
    deletedRemoteIds: string[];
    /** remoteIds whose action failed - their previous state record is carried forward so the action retries. */
    failedRemoteIds: string[];
    /**
     * remoteIds whose upload was skipped by the withheld-subtree guard. They
     * are absent from the snapshot, so the engine cannot rebuild their state
     * records from it - it carries the previous records forward instead. That
     * keeps the file TRACKED, which is what keeps the guard working: an
     * untracked local file is a legitimately new one, and uploading it creates
     * whatever folders it needs.
     */
    skippedWithheldIds: string[];
}

export interface ApplyResult {
    applied: number;
    conflicts: number;
    failures: { action: string; error: string }[];
    results: SyncResults;
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
 * Pre-create every remote folder the upload actions need, in ONE batched pass
 * (level by level so each parent is resolved before its children), populating
 * `cache`. This replaces thousands of sequential per-folder POSTs on a first
 * backup (~48 min for 29k folders) with a handful of batch requests (~1s). Any
 * folder the batch can't resolve simply falls back to lazy per-item creation.
 */
async function prewarmFolders(
    remote: SyncRemote,
    rootFolderId: string | null,
    cache: Map<string, string>,
    parentPaths: Set<string>,
): Promise<void> {
    // Every ancestor path that isn't already known, grouped by depth.
    const needed = new Set<string>();
    for (const path of parentPaths) {
        let acc = "";
        for (const seg of path.split("/")) {
            acc = acc ? `${acc}/${seg}` : seg;
            if (!cache.has(acc)) needed.add(acc);
        }
    }
    if (needed.size === 0) return;

    const byDepth = new Map<number, string[]>();
    for (const p of needed) {
        const d = p.split("/").length;
        const list = byDepth.get(d) ?? [];
        list.push(p);
        byDepth.set(d, list);
    }

    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
        const items: { path: string; name: string; parentId: string | null }[] = [];
        for (const p of byDepth.get(depth)!) {
            const slash = p.lastIndexOf("/");
            const parentPath = slash === -1 ? "" : p.slice(0, slash);
            // Skip if the parent didn't resolve (a shallower batch failed) - the
            // lazy path will create it. Root-level folders (parentPath "") use
            // the pair's root folder id.
            if (parentPath !== "" && !cache.has(parentPath)) continue;
            const parentId = parentPath === "" ? rootFolderId : cache.get(parentPath)!;
            items.push({ path: p, name: slash === -1 ? p : p.slice(slash + 1), parentId });
        }
        if (items.length === 0) continue;
        const created = await remote.createFoldersBatch(items.map(it => ({ name: it.name, parentId: it.parentId })));
        for (const it of items) {
            const id = created.get(`${it.parentId ?? "null"}|${it.name}`);
            if (id) cache.set(it.path, id);
        }
    }
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
    const results: SyncResults = {
        uploadedNew: [], uploadedVersion: [], downloaded: [], movedLocal: [],
        deletedRemoteIds: [], failedRemoteIds: [], skippedWithheldIds: [],
    };
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

    const STAT_BATCH = 256;

    // Pre-create every folder the uploads need in one batched pass (turns a
    // first backup's thousands of folder round-trips into a few). The per-item
    // ensureRemoteFolder calls below then hit the warmed cache. Best-effort:
    // anything the batch misses falls back to lazy creation.
    const uploadParents = new Set<string>();
    for (const a of actions) {
        if (a.kind === "upload-new" || a.kind === "upload-update") {
            // A vanished-remote upload must never cause a folder to be
            // created, here or in the lazy path below - prewarming its parent
            // would rebuild the very subtree the guard exists to protect.
            if (a.kind === "upload-new" && a.remoteVanished) continue;
            const p = parentOf(a.relPath);
            if (p) uploadParents.add(p);
        }
    }
    if (uploadParents.size > 0) {
        try { await prewarmFolders(remote, pair.remoteFolderId, folderCache, uploadParents); }
        catch (err) { debug(`sync: folder prewarm failed (${(err as Error).message}); falling back to lazy create`); }
    }

    // 1) New uploads - resolve parent folders serially (so idempotent folder
    //    creation can't race the shared cache), then stat files in bounded-
    //    parallel batches. A 100k-file first backup must not block the event
    //    loop on a synchronous statSync loop before uploads even start.
    const prepared: { relPath: string; full: string; name: string; folderId: string | null }[] = [];
    for (const a of actions) {
        if (a.kind !== "upload-new") continue;
        const parentPath = parentOf(a.relPath);

        // Fail closed for a file whose remote record vanished: resolve its
        // folder from what the snapshot actually showed, never by creating it.
        // A missing folder here means the whole subtree is gone from the
        // listing, and the two causes - really deleted, or access withdrawn
        // (hidden / permission-restricted / locked) - are indistinguishable.
        // Creating it would re-materialise a withheld subtree as fresh,
        // unrestricted folders and put the content back inside, undoing the
        // very protection that removed it. Skipping costs one file its upload
        // until access is restored or the user moves it; guessing wrong costs
        // the workspace its access controls.
        if (a.remoteVanished) {
            const folderId = parentPath === "" ? pair.remoteFolderId : folderCache.get(parentPath) ?? null;
            if (parentPath !== "" && folderId === null) {
                if (a.remoteId) results.skippedWithheldIds.push(a.remoteId);
                failures.push({
                    action: `upload-new ${a.relPath}`,
                    error: `skipped: this file was synced before, but neither it nor its folder "${parentPath}" is in the workspace listing any more. `
                        + `Uploading would re-create that folder as a new, unrestricted one, so the local file was left untouched and nothing was written to the server. `
                        + `If the folder was hidden, locked or its access revoked, ask the workspace owner; if it was really deleted, move the file to another folder to upload it.`,
                });
                debug(`sync: withheld-subtree guard skipped upload of ${a.relPath} (parent "${parentPath}" not in snapshot)`);
                continue;
            }
            prepared.push({ relPath: a.relPath, full: join(root, a.localPath), name: basename(a.relPath), folderId });
            continue;
        }

        try {
            const folderId = await ensureRemoteFolder(remote, pair.remoteFolderId, folderCache, parentPath);
            prepared.push({ relPath: a.relPath, full: join(root, a.localPath), name: basename(a.relPath), folderId });
        } catch (err) {
            failures.push({ action: `upload-new ${a.relPath}`, error: (err as Error).message });
        }
    }
    const uploadItems: UploadItem[] = [];
    for (let i = 0; i < prepared.length; i += STAT_BATCH) {
        await Promise.all(prepared.slice(i, i + STAT_BATCH).map(async p => {
            try {
                const size = (await stat(p.full)).size;
                uploadItems.push({ relPath: p.relPath, name: p.name, size, folderId: p.folderId, localPath: p.full });
            } catch (err) {
                failures.push({ action: `upload-new ${p.relPath}`, error: (err as Error).message });
            }
        }));
    }
    // Now that upload sizes are known, finalise the upload byte total (new files
    // + changed files, statted in parallel too) so the ETA is stable from the
    // first event. A file that fails to stat here is still handled in loop 2.
    uploadBytesTotal = uploadItems.reduce((sum, i) => sum + i.size, 0);
    const updateActions = actions.filter(a => a.kind === "upload-update") as Extract<SyncAction, { kind: "upload-new" | "upload-update" }>[];
    for (let i = 0; i < updateActions.length; i += STAT_BATCH) {
        const sizes = await Promise.all(updateActions.slice(i, i + STAT_BATCH).map(a =>
            stat(join(root, a.localPath)).then(s => s.size).catch(() => 0)));
        for (const s of sizes) uploadBytesTotal += s;
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
            // doesn't abort the whole backup - it just retries next cycle.
            const r = await remote.uploadNew(smallNew, {
                concurrency: parallel,
                onProgress: (done, bytes) => { upDone = done; upBytes += bytes; reportUp(); },
                onError: (name, err) => failures.push({ action: `upload-new ${name}`, error: err.message }),
            });
            applied += r.committed;
            results.uploadedNew.push(...r.files);
            debug(`sync: uploaded ${r.committed} new file(s)`);
        } catch (err) {
            failures.push({ action: "upload-new batch", error: (err as Error).message });
        }
    }
    // Large new files: stream each via upload/init, bounded by the same pool.
    await Promise.all(largeNew.map(item => sem.run(async () => {
        try {
            const mime = Bun.file(item.localPath).type || "application/octet-stream";
            const up = await remote.uploadViaInit(item.localPath, item.name, item.size, mime, item.folderId, null);
            results.uploadedNew.push({ relPath: item.relPath, fileId: up.fileId, name: item.name, folderId: item.folderId, size: up.size, updatedAt: up.updatedAt, version: up.version });
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
            const size = (await stat(full)).size;
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
            const up = (deltaEnabled && u.size > 0 && u.size <= DELTA_MAX_BYTES)
                ? await remote.uploadDelta(u.full, u.name, u.size, u.mime, u.remoteId, u.folderId)
                : await remote.uploadVersion(u.full, u.name, u.size, u.mime, u.remoteId, u.folderId);
            results.uploadedVersion.push({ remoteId: u.remoteId, size: up.size, updatedAt: up.updatedAt, version: up.version });
            applied++;
            upDone++; upBytes += u.size; reportUp();
        } catch (err) {
            results.failedRemoteIds.push(u.remoteId);
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
                const full = join(root, a.localPath);
                const tmp = `${full}.dosya-partial`;
                try {
                    const u = byId.get(a.remoteId);
                    if (!u) throw new Error("no download url returned");
                    mkdirSync(dirname(full), { recursive: true });
                    const res = await fetch(u.url, { signal: AbortSignal.timeout(getLongTimeout(600_000)) });
                    // Check res.ok only - reading the res.body getter before
                    // Bun.write(res) makes Bun.write hang forever (verified). Let
                    // Bun.write stream the body itself.
                    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
                    await Bun.write(tmp, res);
                    renameSync(tmp, full);
                    const st = await stat(full); // local truth for the state record
                    results.downloaded.push({ remoteId: a.remoteId, relPath: a.relPath, mtimeMs: st.mtimeMs, size: st.size });
                    applied++;
                    downDone++; downBytes += a.size ?? u.size ?? 0; reportDown();
                } catch (err) {
                    // Don't leak a half-written temp file on failure.
                    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
                    results.failedRemoteIds.push(a.remoteId);
                    failures.push({ action: `download ${a.relPath}`, error: (err as Error).message });
                }
            })));
        } catch (err) {
            for (const a of downloads) results.failedRemoteIds.push(a.remoteId);
            failures.push({ action: "download-manifest", error: (err as Error).message });
        }
    }

    // 3b) Conflicts (keep-both): preserve the local copy under a new name, then
    //     pull the remote version to the original path. Both survive, and the
    //     conflicted copy uploads on the next cycle - nothing is frozen or lost.
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
                results.failedRemoteIds.push(a.remoteId);
                failures.push({ action: `conflict ${a.relPath}`, error: (err as Error).message });
            }
        }
        try {
            const urls = await remote.downloadUrls(pull.map(p => p.remoteId));
            const byId = new Map(urls.map(u => [u.fileId, u]));
            await Promise.all(pull.map(p => sem.run(async () => {
                const full = join(root, p.relPath);
                const tmp = `${full}.dosya-partial`;
                try {
                    const u = byId.get(p.remoteId);
                    if (!u) throw new Error("no download url returned");
                    mkdirSync(dirname(full), { recursive: true });
                    const res = await fetch(u.url, { signal: AbortSignal.timeout(getLongTimeout(600_000)) });
                    // See the note above: never touch res.body before Bun.write.
                    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
                    await Bun.write(tmp, res);
                    renameSync(tmp, full);
                    const st = await stat(full);
                    results.downloaded.push({ remoteId: p.remoteId, relPath: p.relPath, mtimeMs: st.mtimeMs, size: st.size });
                    applied++;
                    downDone++; downBytes += p.size ?? u.size ?? 0; reportDown();
                } catch (err) {
                    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
                    results.failedRemoteIds.push(p.remoteId);
                    failures.push({ action: `conflict-download ${p.relPath}`, error: (err as Error).message });
                }
            })));
        } catch (err) {
            for (const p of pull) results.failedRemoteIds.push(p.remoteId);
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
            results.movedLocal.push({ remoteId: a.remoteId, fromPath: a.fromPath, toPath: a.toPath });
            applied++;
        } catch (err) {
            results.failedRemoteIds.push(a.remoteId);
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
            results.failedRemoteIds.push(a.remoteId);
            failures.push({ action: `delete-local ${a.localPath}`, error: (err as Error).message });
        }
    }

    // 6) Remote deletions.
    for (const a of actions) {
        if (a.kind !== "delete-remote") continue;
        try {
            await remote.deleteFile(a.remoteId);
            results.deletedRemoteIds.push(a.remoteId);
            applied++;
        } catch (err) {
            results.failedRemoteIds.push(a.remoteId);
            failures.push({ action: `delete-remote ${a.relPath}`, error: (err as Error).message });
        }
    }

    return { applied, conflicts, failures, results };
}
