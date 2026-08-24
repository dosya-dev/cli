import { statSync } from "fs";
import { DosyaClient } from "../client";
import { getLongTimeout } from "../runtime";
import { uploadMultipart, loadUploadSession, saveUploadSession, removeUploadSession, makeSidecar, type ResumableInfo } from "../multipart";
import { Semaphore } from "../semaphore";
import { chunkFile } from "./chunker";
import type { FolderNode } from "../resolver";
import type { RemoteFile } from "./types";
import { isSafeRelPath } from "./safe-path";
import { debug } from "../output";

/** Default concurrent transfers for sync (tunable via config `sync_parallel`). */
export const DEFAULT_SYNC_PARALLEL = 8;

/**
 * New files at or below this size take the fast presigned batch path (buffered,
 * but memory stays bounded at threshold × concurrency). Larger files stream via
 * `upload/init` - multipart + cross-run resume above the server's threshold, a
 * single streamed PUT below it - so we never buffer a big file into RAM and a
 * mid-file failure resumes instead of restarting.
 */
export const UPLOAD_STREAM_THRESHOLD = 8 * 1024 * 1024; // 8 MiB

export interface UploadNewOpts {
    /** Fires after each successful PUT with the running count and file size. */
    onProgress?: (done: number, bytes: number) => void;
    /** Fires when a single file fails to upload (the batch still continues). */
    onError?: (name: string, err: Error) => void;
    /** Max concurrent PUTs (default {@link DEFAULT_SYNC_PARALLEL}). */
    concurrency?: number;
}

/**
 * Outcome of one transfer, carrying the server's authoritative row metadata so
 * the engine can build sync state from results instead of re-fetching a full
 * snapshot after every cycle. `updatedAt` is null when the server predates the
 * timestamp fields - the engine then falls back to the snapshot read-back.
 */
export interface UploadResult {
    fileId: string;
    version: number;
    updatedAt: number | null;
    size: number;
}

/** A successfully committed new file (batch path), with its server metadata. */
export interface UploadedNewFile {
    relPath: string;
    fileId: string;
    name: string;
    folderId: string | null;
    size: number;
    updatedAt: number | null;
    version: number;
}

const SYNC_HEADER = { "X-Dosya-Sync": "1" };

interface SnapshotFile {
    id: string;
    name: string;
    size_bytes: number;
    mime_type: string | null;
    folder_id: string | null;
    updated_at: number;
    current_version: number;
}

interface SnapshotResponse {
    ok: boolean;
    files: SnapshotFile[];
    folders: FolderNode[];
    nextCursor: string | null;
    hasMore: boolean;
}

/** New-file upload item, with its remote parent folder already resolved. */
export interface UploadItem {
    relPath: string;
    name: string;
    size: number;
    folderId: string | null;
    localPath: string;
}

/** Build a `folderId -> path (relative to rootFolderId)` resolver; null = outside the root subtree. */
function makePathOf(folders: FolderNode[], rootFolderId: string | null): (folderId: string | null) => string | null {
    const byId = new Map(folders.map(f => [f.id, f]));
    const cache = new Map<string | null, string | null>();
    function pathOf(folderId: string | null): string | null {
        if (folderId === rootFolderId) return "";
        if (folderId === null) return rootFolderId === null ? "" : null;
        if (cache.has(folderId)) return cache.get(folderId)!;
        const f = byId.get(folderId);
        if (!f) { cache.set(folderId, null); return null; }
        const parent = pathOf(f.parent_id);
        const p = parent === null ? null : parent === "" ? f.name : `${parent}/${f.name}`;
        cache.set(folderId, p);
        return p;
    }
    return pathOf;
}

/**
 * Resolve remote files' paths relative to the pair's remote root folder.
 * Files outside that subtree are dropped.
 */
export function buildRemotePaths(files: SnapshotFile[], folders: FolderNode[], rootFolderId: string | null): Map<string, RemoteFile> {
    const pathOf = makePathOf(folders, rootFolderId);
    const out = new Map<string, RemoteFile>();
    for (const file of files) {
        const parentPath = pathOf(file.folder_id);
        if (parentPath === null) continue; // not under the pair's root
        const relPath = parentPath === "" ? file.name : `${parentPath}/${file.name}`;
        // Quarantine a snapshot record whose resolved path is not a safe
        // root-relative path (a hostile ".."/separator/control-char name). Left
        // in, it would persist into sync state and reach a filesystem sink that
        // escapes the sync root. See safe-path.ts.
        if (!isSafeRelPath(relPath)) {
            debug(`sync: dropping remote file ${file.id} with unsafe path ${JSON.stringify(relPath)}`);
            continue;
        }
        out.set(file.id, {
            id: file.id,
            name: file.name,
            folderId: file.folder_id,
            size: file.size_bytes,
            updatedAt: file.updated_at,
            version: file.current_version,
            relPath,
        });
    }
    return out;
}

/** Map of `relPath -> folderId` for every folder under the pair's root. */
export function remoteFolderPaths(folders: FolderNode[], rootFolderId: string | null): Map<string, string> {
    const pathOf = makePathOf(folders, rootFolderId);
    const out = new Map<string, string>();
    for (const f of folders) {
        const p = pathOf(f.id);
        if (p !== null && p !== "" && isSafeRelPath(p)) out.set(p, f.id);
    }
    return out;
}

export class SyncRemote {
    private region?: string;

    constructor(private client: DosyaClient, public readonly workspaceId: string) {}

    private async req<T>(path: string, opts: { method: string; body?: unknown } = { method: "GET" }): Promise<T> {
        const res = await this.client.request<T>(path, { ...opts, headers: SYNC_HEADER });
        if (!res.ok) {
            const e = res.data as unknown as { error?: string };
            throw new Error(e?.error ?? `HTTP ${res.status} for ${path}`);
        }
        return res.data;
    }

    /** The workspace's default upload region (needed by manifest/commit). */
    async getRegion(): Promise<string> {
        if (this.region) return this.region;
        try {
            const d = await this.req<{ workspace: { default_region?: string } }>(`/api/workspaces/${this.workspaceId}`, { method: "GET" });
            this.region = d.workspace?.default_region || "auto";
        } catch {
            this.region = "auto";
        }
        return this.region;
    }

    /** Full or delta snapshot, paginated by cursor. Folders come on the first page. */
    async snapshot(folderId: string | null, opts: { since?: number } = {}): Promise<{ files: SnapshotFile[]; folders: FolderNode[]; truncated: boolean }> {
        const files: SnapshotFile[] = [];
        let folders: FolderNode[] = [];
        let cursor: string | undefined;
        let first = true;
        let truncated = false;
        do {
            const params = new URLSearchParams({ workspace_id: this.workspaceId, limit: "5000" });
            if (folderId) params.set("folder_id", folderId);
            if (opts.since) params.set("since", String(opts.since));
            if (cursor) params.set("cursor", cursor);
            const data = await this.req<SnapshotResponse>(`/api/sync/snapshot?${params}`, { method: "GET" });
            files.push(...(data.files ?? []));
            if (first) { folders = data.folders ?? []; first = false; }
            // The server says there's more but gave no cursor to fetch it - the
            // remote view is PARTIAL. Flag it so the engine suppresses deletions
            // (a tracked file missing from a truncated snapshot is NOT a delete).
            if (data.hasMore && !data.nextCursor) { truncated = true; break; }
            cursor = data.hasMore ? data.nextCursor ?? undefined : undefined;
        } while (cursor);
        return { files, folders, truncated };
    }

    /**
     * Upload brand-new files via manifest → presigned PUT → commit, batched.
     * PUTs within a batch run concurrently (bounded by `opts.concurrency`) -
     * uploading one file at a time is latency-bound and crawls on a big push.
     * A single file's failure is reported via `opts.onError` and skipped rather
     * than aborting the whole batch (it retries next cycle). `opts.onProgress`
     * fires after each success with the running count + file size for the ETA.
     */
    async uploadNew(items: UploadItem[], opts: UploadNewOpts = {}): Promise<{ committed: number; files: UploadedNewFile[] }> {
        if (items.length === 0) return { committed: 0, files: [] };
        const region = await this.getRegion();
        const sem = new Semaphore(Math.max(1, opts.concurrency ?? DEFAULT_SYNC_PARALLEL));

        // The server caps manifest/commit at 5000 files per request, so a large
        // sync (thousands of new files) must be chunked or it's rejected wholesale.
        // Committing each batch also means an interrupted run resumes: the server
        // dedups already-committed files out of the next manifest.
        const BATCH = 1000;
        let committed = 0;
        let putDone = 0;
        const files: UploadedNewFile[] = [];

        for (let start = 0; start < items.length; start += BATCH) {
            const slice = items.slice(start, start + BATCH);

            const manifest = await this.req<{
                uploads: { relPath: string; fileId: string; r2Key: string; name: string; url: string; size: number; folderId: string | null; contentType: string; ext: string | null }[];
            }>("/api/sync/manifest", {
                method: "POST",
                body: {
                    workspace_id: this.workspaceId,
                    folder_id: null,
                    region,
                    files: slice.map(i => ({ relPath: i.relPath, name: i.name, size: i.size, folder_id: i.folderId })),
                },
            });

            const byRel = new Map(slice.map(i => [i.relPath, i]));
            type CommitFile = { file_id: string; r2_key: string; name: string; size: number; folder_id: string | null; content_type: string; ext: string | null };
            type PutOutcome = { cf: CommitFile; relPath: string };

            const results = await Promise.all((manifest.uploads ?? []).map(u => sem.run(async (): Promise<PutOutcome | null> => {
                const item = byRel.get(u.relPath);
                if (!item) return null;
                try {
                    // Buffer the file rather than passing the BunFile directly - a
                    // BunFile as a fetch body segfaults the compiled binary (Bun bug),
                    // and a known Content-Length is what R2's presigned PUT expects.
                    const res = await fetch(u.url, {
                        method: "PUT",
                        body: await Bun.file(item.localPath).arrayBuffer(),
                        headers: { "Content-Type": u.contentType },
                        signal: AbortSignal.timeout(getLongTimeout(600_000)),
                    });
                    if (!res.ok) throw new Error(`R2 PUT failed for ${u.name}: HTTP ${res.status}`);
                    opts.onProgress?.(++putDone, item.size);
                    return { cf: { file_id: u.fileId, r2_key: u.r2Key, name: u.name, size: u.size, folder_id: u.folderId, content_type: u.contentType, ext: u.ext }, relPath: u.relPath };
                } catch (err) {
                    opts.onError?.(u.name, err as Error);
                    return null;
                }
            })));

            const done = results.filter((f): f is PutOutcome => f !== null);
            if (done.length > 0) {
                const commit = await this.req<{ committed: number; committed_at?: number }>("/api/sync/commit", {
                    method: "POST",
                    body: { workspace_id: this.workspaceId, region, files: done.map(d => d.cf) },
                });
                committed += commit.committed ?? done.length;
                // committed_at is the updated_at every row in this batch got; an
                // older server omits it → null → the engine falls back to the
                // snapshot read-back instead of guessing a timestamp.
                const ts = typeof commit.committed_at === "number" ? commit.committed_at : null;
                for (const d of done) {
                    files.push({ relPath: d.relPath, fileId: d.cf.file_id, name: d.cf.name, folderId: d.cf.folder_id, size: d.cf.size, updatedAt: ts, version: 1 });
                }
            }
        }

        return { committed, files };
    }

    /**
     * Upload a file through the `upload/init` flow - streaming, never buffering
     * the whole file. When `fileId` is set it records a new version; when null it
     * creates a new file. Large files (server returns `resumable`) go multipart
     * with per-part retry and cross-run resume via an on-disk sidecar; otherwise
     * a single streamed PUT. The `X-Dosya-Sync` header suppresses the activity
     * event, matching the batch path.
     */
    async uploadViaInit(localPath: string, name: string, size: number, mime: string, folderId: string | null, fileId: string | null): Promise<UploadResult> {
        // Reuse an interrupted session for this exact file (cross-run resume).
        const resumed = loadUploadSession(localPath, size);
        let sessionId: string;
        let uploadUrl: string;
        let resumable: ResumableInfo | null;

        if (resumed) {
            sessionId = resumed.session_id;
            uploadUrl = `/api/upload/${resumed.session_id}`;
            resumable = resumed.resumable;
        } else {
            const init = await this.req<{ session_id: string; upload_url: string; resumable: ResumableInfo | null }>("/api/upload/init", {
                method: "POST",
                body: { workspace_id: this.workspaceId, file_name: name, file_size: size, mime_type: mime, folder_id: folderId, ...(fileId ? { file_id: fileId } : {}) },
            });
            sessionId = init.session_id;
            uploadUrl = init.upload_url;
            resumable = init.resumable;
            // Persist before sending bytes so an interrupt mid-upload can resume.
            if (resumable) saveUploadSession(localPath, makeSidecar(localPath, sessionId, size, resumable));
        }

        if (resumable) {
            const f = await uploadMultipart({ client: this.client, filePath: localPath, size, sessionId, resumable, concurrency: 4, bar: null, headers: SYNC_HEADER });
            removeUploadSession(localPath); // success - drop the sidecar
            // The complete response's created_at equals the file row's updated_at
            // (one `now` per request, both branches).
            return { fileId: f.id, version: f.version ?? 1, updatedAt: typeof f.created_at === "number" ? f.created_at : null, size: f.size_bytes ?? size };
        }
        const res = await this.client.request<{ file?: { id: string; version?: number; created_at?: number; size_bytes?: number } }>(uploadUrl, {
            method: "PUT",
            rawBody: Bun.file(localPath).stream(),
            headers: { "Content-Type": mime || "application/octet-stream", "Content-Length": String(size), ...SYNC_HEADER },
            timeout: getLongTimeout(600_000),
        });
        if (!res.ok) throw new Error(`Upload failed for ${name}: HTTP ${res.status}`);
        const f = res.data?.file;
        return {
            fileId: f?.id ?? fileId ?? "",
            version: f?.version ?? 1,
            updatedAt: typeof f?.created_at === "number" ? f.created_at : null,
            size: f?.size_bytes ?? size,
        };
    }

    /** Upload a new version of an existing file (delegates to {@link uploadViaInit}). */
    async uploadVersion(localPath: string, name: string, size: number, mime: string, fileId: string, folderId: string | null): Promise<UploadResult> {
        return this.uploadViaInit(localPath, name, size, mime, folderId, fileId);
    }

    async downloadUrls(fileIds: string[]): Promise<{ fileId: string; url: string; name: string; size: number }[]> {
        if (fileIds.length === 0) return [];
        // The server caps download-manifest at 500 ids per request, so a large
        // pull (thousands of files) must be batched or it's rejected wholesale.
        const BATCH = 500;
        const out: { fileId: string; url: string; name: string; size: number }[] = [];
        for (let start = 0; start < fileIds.length; start += BATCH) {
            const slice = fileIds.slice(start, start + BATCH);
            const data = await this.req<{ downloads: { fileId: string; url: string; name: string; size: number }[] }>(
                "/api/sync/download-manifest",
                { method: "POST", body: { workspace_id: this.workspaceId, file_ids: slice } },
            );
            out.push(...(data.downloads ?? []));
        }
        return out;
    }

    /** Which of these chunk hashes the workspace does NOT already have. */
    async chunksMissing(hashes: string[]): Promise<Set<string>> {
        const uniq = [...new Set(hashes)];
        const out = new Set<string>();
        const BATCH = 20000; // server MAX_HASHES
        for (let i = 0; i < uniq.length; i += BATCH) {
            const d = await this.req<{ missing: string[] }>("/api/sync/chunks/missing", {
                method: "POST",
                body: { workspace_id: this.workspaceId, hashes: uniq.slice(i, i + BATCH) },
            });
            for (const h of d.missing ?? []) out.add(h);
        }
        return out;
    }

    /** Presigned R2 PUT urls for a set of chunks, keyed by hash. */
    async chunksPresign(chunks: { hash: string; size: number }[], region: string): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        const BATCH = 5000; // server MAX_CHUNKS
        for (let i = 0; i < chunks.length; i += BATCH) {
            const d = await this.req<{ uploads: { hash: string; url: string }[] }>("/api/sync/chunks/presign", {
                method: "POST",
                body: { workspace_id: this.workspaceId, region, chunks: chunks.slice(i, i + BATCH) },
            });
            for (const u of d.uploads ?? []) out.set(u.hash, u.url);
        }
        return out;
    }

    /**
     * Block-level delta upload of a new version: chunk the file, upload only the
     * chunks the workspace lacks, then commit the ordered manifest (the server
     * reassembles). Caller guarantees size <= DELTA_MAX_BYTES.
     */
    async uploadDelta(localPath: string, name: string, size: number, mime: string, fileId: string | null, folderId: string | null): Promise<UploadResult> {
        const region = await this.getRegion();
        const manifest = await chunkFile(localPath);
        const missing = await this.chunksMissing(manifest.map(c => c.hash));

        const seen = new Set<string>();
        const toUpload = manifest.filter(c => missing.has(c.hash) && !seen.has(c.hash) && (seen.add(c.hash), true));

        if (toUpload.length > 0) {
            const urls = await this.chunksPresign(toUpload.map(c => ({ hash: c.hash, size: c.size })), region);
            const file = Bun.file(localPath);
            for (const c of toUpload) {
                const url = urls.get(c.hash);
                if (!url) throw new Error(`no presigned url for chunk ${c.hash.slice(0, 8)}`);
                // Buffer the chunk (see the note in uploadNew: a BunFile/Blob
                // body segfaults the compiled binary).
                const res = await fetch(url, {
                    method: "PUT",
                    body: await file.slice(c.offset, c.offset + c.size).arrayBuffer(),
                    headers: { "Content-Type": "application/octet-stream" },
                    signal: AbortSignal.timeout(getLongTimeout(600_000)),
                });
                if (!res.ok) throw new Error(`chunk PUT failed (${c.hash.slice(0, 8)}): HTTP ${res.status}`);
            }
        }

        const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : null;
        const commit = await this.req<{ file_id: string; version?: number; updated_at?: number }>("/api/sync/chunks/commit", {
            method: "POST",
            body: {
                workspace_id: this.workspaceId,
                region,
                file_id: fileId,
                folder_id: folderId,
                name,
                size,
                content_type: mime,
                ext,
                chunks: manifest.map(c => ({ hash: c.hash, size: c.size })),
            },
        });
        return {
            fileId: commit.file_id ?? fileId ?? "",
            version: commit.version ?? 1,
            updatedAt: typeof commit.updated_at === "number" ? commit.updated_at : null,
            size,
        };
    }

    async moveFile(id: string, folderId: string | null): Promise<void> {
        await this.req(`/api/files/${encodeURIComponent(id)}/move`, { method: "PUT", body: { folder_id: folderId } });
    }

    async renameFile(id: string, name: string): Promise<void> {
        await this.req(`/api/files/${encodeURIComponent(id)}/rename`, { method: "PUT", body: { name } });
    }

    async deleteFile(id: string): Promise<void> {
        await this.req(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    /** Create one folder segment (idempotent server-side), returning its id. */
    async createFolder(name: string, parentId: string | null): Promise<string> {
        const d = await this.req<{ folder?: { id: string }; id?: string }>("/api/folders", {
            method: "POST",
            body: { workspace_id: this.workspaceId, name, parent_id: parentId },
        });
        const id = d.folder?.id ?? d.id;
        if (!id) throw new Error(`Folder create for "${name}" returned no id`);
        return id;
    }

    /**
     * Create many sibling folders (all under the same already-existing parents)
     * in one request, returning a `parentId|name -> id` map. The server caps a
     * batch at 500, so callers chunk. This turns a first backup's thousands of
     * per-folder round-trips (~48 min for 29k folders) into a handful (~1s).
     */
    async createFoldersBatch(items: { name: string; parentId: string | null }[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        const BATCH = 500;
        for (let i = 0; i < items.length; i += BATCH) {
            const slice = items.slice(i, i + BATCH);
            const d = await this.req<{ folders?: { name: string; parent_id: string | null; id: string }[] }>("/api/folders/batch", {
                method: "POST",
                body: { workspace_id: this.workspaceId, folders: slice.map(f => ({ name: f.name, parent_id: f.parentId })) },
            });
            for (const f of d.folders ?? []) out.set(`${f.parent_id ?? "null"}|${f.name}`, f.id);
        }
        return out;
    }
}
