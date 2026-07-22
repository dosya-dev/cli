import { statSync } from "fs";
import { DosyaClient } from "../client";
import { getLongTimeout } from "../runtime";
import { uploadMultipart, type ResumableInfo } from "../multipart";
import { chunkFile } from "./chunker";
import type { FolderNode } from "../resolver";
import type { RemoteFile } from "./types";

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
        if (p !== null && p !== "") out.set(p, f.id);
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
    async snapshot(folderId: string | null, opts: { since?: number } = {}): Promise<{ files: SnapshotFile[]; folders: FolderNode[] }> {
        const files: SnapshotFile[] = [];
        let folders: FolderNode[] = [];
        let cursor: string | undefined;
        let first = true;
        do {
            const params = new URLSearchParams({ workspace_id: this.workspaceId, limit: "5000" });
            if (folderId) params.set("folder_id", folderId);
            if (opts.since) params.set("since", String(opts.since));
            if (cursor) params.set("cursor", cursor);
            const data = await this.req<SnapshotResponse>(`/api/sync/snapshot?${params}`, { method: "GET" });
            files.push(...(data.files ?? []));
            if (first) { folders = data.folders ?? []; first = false; }
            cursor = data.hasMore ? data.nextCursor ?? undefined : undefined;
        } while (cursor);
        return { files, folders };
    }

    /**
     * Upload brand-new files via manifest → presigned PUT → commit, batched.
     * `onProgress(done)` fires after each file's PUT with the running count so a
     * long first push shows live movement instead of one summary at the end.
     */
    async uploadNew(items: UploadItem[], onProgress?: (done: number) => void): Promise<number> {
        if (items.length === 0) return 0;
        const region = await this.getRegion();

        // The server caps manifest/commit at 5000 files per request, so a large
        // sync (thousands of new files) must be chunked or it's rejected wholesale.
        // Committing each batch also means an interrupted run resumes: the server
        // dedups already-committed files out of the next manifest.
        const BATCH = 1000;
        let committed = 0;
        let putDone = 0;

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
            const commitFiles: { file_id: string; r2_key: string; name: string; size: number; folder_id: string | null; content_type: string; ext: string | null }[] = [];

            for (const u of manifest.uploads ?? []) {
                const item = byRel.get(u.relPath);
                if (!item) continue;
                // Buffer the file rather than passing the BunFile directly — a
                // BunFile as a fetch body segfaults the compiled binary (Bun bug),
                // and a known Content-Length is what R2's presigned PUT expects.
                const res = await fetch(u.url, {
                    method: "PUT",
                    body: await Bun.file(item.localPath).arrayBuffer(),
                    headers: { "Content-Type": u.contentType },
                    signal: AbortSignal.timeout(getLongTimeout(600_000)),
                });
                if (!res.ok) throw new Error(`R2 PUT failed for ${u.name}: HTTP ${res.status}`);
                commitFiles.push({ file_id: u.fileId, r2_key: u.r2Key, name: u.name, size: u.size, folder_id: u.folderId, content_type: u.contentType, ext: u.ext });
                onProgress?.(++putDone);
            }

            if (commitFiles.length > 0) {
                const commit = await this.req<{ committed: number }>("/api/sync/commit", {
                    method: "POST",
                    body: { workspace_id: this.workspaceId, region, files: commitFiles },
                });
                committed += commit.committed ?? commitFiles.length;
            }
        }

        return committed;
    }

    /** Upload a new version of an existing file via the upload/init flow. */
    async uploadVersion(localPath: string, name: string, size: number, mime: string, fileId: string, folderId: string | null): Promise<void> {
        const init = await this.req<{
            ok: boolean; session_id: string; upload_url: string; resumable: ResumableInfo | null;
        }>("/api/upload/init", {
            method: "POST",
            body: { workspace_id: this.workspaceId, file_name: name, file_size: size, mime_type: mime, folder_id: folderId, file_id: fileId },
        });

        if (init.resumable) {
            await uploadMultipart({ client: this.client, filePath: localPath, size, sessionId: init.session_id, resumable: init.resumable, concurrency: 4, bar: null });
            return;
        }
        const res = await this.client.request(init.upload_url, {
            method: "PUT",
            rawBody: Bun.file(localPath).stream(),
            headers: { "Content-Type": mime || "application/octet-stream", "Content-Length": String(size) },
            timeout: getLongTimeout(600_000),
        });
        if (!res.ok) throw new Error(`Version upload failed for ${name}: HTTP ${res.status}`);
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
    async uploadDelta(localPath: string, name: string, size: number, mime: string, fileId: string | null, folderId: string | null): Promise<void> {
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
        await this.req("/api/sync/chunks/commit", {
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
}
