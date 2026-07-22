/**
 * In-memory fake of the dosya sync API — enough of it to drive the real CLI
 * sync engine (whole-file path) end-to-end with no network or credentials.
 *
 * Implements: workspace region, snapshot, manifest→R2 PUT→commit, download-
 * manifest→R2 GET, folder create (idempotent), file move/rename/delete/
 * batch-delete, and upload/init→PUT for new versions. State is inspectable so a
 * test can assert the resulting remote tree.
 */

interface FakeFile {
    id: string;
    name: string;
    folder_id: string | null;
    size_bytes: number;
    mime_type: string;
    extension: string | null;
    updated_at: number;
    current_version: number;
}
interface FakeFolder { id: string; name: string; parent_id: string | null }

export interface FakeSyncApi {
    base: string;
    /** Install as globalThis.fetch (in-memory; avoids same-process HTTP deadlocks). */
    install: () => void;
    /** Restore the real fetch. */
    stop: () => void;
    files: Map<string, FakeFile>;
    folders: Map<string, FakeFolder>;
    objects: Map<string, Uint8Array>;   // fileId -> bytes
    /** Reconstruct remote relPaths (root-relative) for every file. */
    paths: () => Map<string, string>;   // relPath -> fileId
    /** Test helper: put a file directly into the remote (simulates a web upload). */
    addRemoteFile: (relPath: string, bytes: string) => string;
    addRemoteFolderPath: (relPath: string) => string;
}

export function startFakeSyncApi(): FakeSyncApi {
    const files = new Map<string, FakeFile>();
    const folders = new Map<string, FakeFolder>();
    const objects = new Map<string, Uint8Array>();
    const sessions = new Map<string, { file_id: string | null; name: string; folder_id: string | null; content_type: string; ext: string | null }>();
    let clock = 1000;
    let seq = 0;
    const id = (p: string) => `${p}${++seq}`;

    function folderPath(fid: string | null): string {
        if (!fid) return "";
        const f = folders.get(fid);
        if (!f) return "";
        const parent = folderPath(f.parent_id);
        return parent ? `${parent}/${f.name}` : f.name;
    }
    function relOf(f: FakeFile): string {
        const p = folderPath(f.folder_id);
        return p ? `${p}/${f.name}` : f.name;
    }
    function paths(): Map<string, string> {
        const m = new Map<string, string>();
        for (const f of files.values()) m.set(relOf(f), f.id);
        return m;
    }
    function findFolder(parentId: string | null, name: string): FakeFolder | undefined {
        for (const f of folders.values()) if ((f.parent_id ?? null) === (parentId ?? null) && f.name === name) return f;
        return undefined;
    }
    function ensureFolderPath(relPath: string): string {
        let parent: string | null = null;
        for (const seg of relPath.split("/")) {
            let f = findFolder(parent, seg);
            if (!f) { f = { id: id("fld_"), name: seg, parent_id: parent }; folders.set(f.id, f); }
            parent = f.id;
        }
        return parent as string;
    }

    const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    const base = "http://fake.local";

    async function handle(req: Request): Promise<Response> {
        {
            const url = new URL(req.url);
            const path = url.pathname;
            const method = req.method;
            if (process.env.FAKE_DEBUG) console.error(`[fake] ${method} ${path}`);

            // ── R2 stand-ins ──
            // A PUT to /r2fail always 500s — lets a test assert that one bad file
            // is reported but doesn't abort the rest of the batch.
            if (method === "PUT" && path === "/r2fail") {
                return new Response("boom", { status: 500 });
            }
            if (method === "PUT" && path.startsWith("/r2put/")) {
                objects.set(path.slice("/r2put/".length), new Uint8Array(await req.arrayBuffer()));
                return new Response("", { status: 200 });
            }
            if (method === "GET" && path.startsWith("/r2get/")) {
                const b = objects.get(path.slice("/r2get/".length));
                return b ? new Response(b as unknown as BodyInit) : new Response("", { status: 404 });
            }

            // ── Workspace region ──
            if (method === "GET" && path.startsWith("/api/workspaces/")) {
                return json({ ok: true, workspace: { default_region: "auto" } });
            }

            // ── Snapshot ──
            if (method === "GET" && path === "/api/sync/snapshot") {
                return json({
                    ok: true,
                    files: [...files.values()].map(f => ({
                        id: f.id, name: f.name, size_bytes: f.size_bytes, mime_type: f.mime_type,
                        folder_id: f.folder_id, updated_at: f.updated_at, current_version: f.current_version,
                    })),
                    folders: [...folders.values()].map(f => ({ id: f.id, name: f.name, parent_id: f.parent_id, file_count: 0 })),
                    nextCursor: null, hasMore: false,
                });
            }

            // ── Manifest (new-file upload, step 1) ──
            if (method === "POST" && path === "/api/sync/manifest") {
                const body = await req.json() as { files: { relPath: string; name: string; size: number; folder_id: string | null }[] };
                // Mirror the real server cap (src/pages/api/sync/manifest.ts).
                if (body.files.length > 5000) return json({ ok: false, error: "Max 5000 files per request" }, 400);
                const uploads = body.files.map(f => {
                    const fileId = id("file_");
                    // A file named "*BOOM*" gets a presigned URL that 500s on PUT,
                    // so tests can force a single-file upload failure deterministically.
                    const url = f.name.includes("BOOM") ? `${base}/r2fail` : `${base}/r2put/${fileId}`;
                    return {
                        relPath: f.relPath, fileId, r2Key: `key/${fileId}`, name: f.name,
                        url, size: f.size, folderId: f.folder_id,
                        contentType: "application/octet-stream", ext: f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")) : null,
                    };
                });
                return json({ ok: true, uploads, skipped: 0, total: uploads.length });
            }

            // ── Commit ──
            if (method === "POST" && path === "/api/sync/commit") {
                const body = await req.json() as { files: { file_id: string; name: string; size: number; folder_id: string | null; content_type: string; ext: string | null }[] };
                // Mirror the real server cap (src/pages/api/sync/commit.ts).
                if (body.files.length > 5000) return json({ ok: false, error: "Max 5000 files per commit" }, 400);
                for (const f of body.files) {
                    files.set(f.file_id, {
                        id: f.file_id, name: f.name, folder_id: f.folder_id, size_bytes: f.size,
                        mime_type: f.content_type, extension: f.ext, updated_at: ++clock, current_version: 1,
                    });
                }
                return json({ ok: true, committed: body.files.length });
            }

            // ── Download manifest ──
            if (method === "POST" && path === "/api/sync/download-manifest") {
                const body = await req.json() as { file_ids: string[] };
                // Mirror the real server cap (src/pages/api/sync/download-manifest.ts).
                if (body.file_ids.length > 500) return json({ ok: false, error: "Max 500 files per request" }, 400);
                const downloads = body.file_ids.map(fid => {
                    const f = files.get(fid)!;
                    return { fileId: fid, url: `${base}/r2get/${fid}`, name: f.name, size: f.size_bytes };
                });
                return json({ ok: true, downloads });
            }

            // ── Folder create (idempotent, single segment) ──
            if (method === "POST" && path === "/api/folders") {
                const body = await req.json() as { name: string; parent_id: string | null };
                let f = findFolder(body.parent_id ?? null, body.name);
                if (!f) { f = { id: id("fld_"), name: body.name, parent_id: body.parent_id ?? null }; folders.set(f.id, f); }
                return json({ ok: true, folder: { id: f.id, name: f.name, parent_id: f.parent_id } }, 201);
            }

            // ── File mutations ──
            const mv = path.match(/^\/api\/files\/([^/]+)\/move$/);
            if (method === "PUT" && mv) {
                const body = await req.json() as { folder_id: string | null };
                const f = files.get(mv[1]); if (f) { f.folder_id = body.folder_id ?? null; f.updated_at = ++clock; }
                return json({ ok: true });
            }
            const rn = path.match(/^\/api\/files\/([^/]+)\/rename$/);
            if (method === "PUT" && rn) {
                const body = await req.json() as { name: string };
                const f = files.get(rn[1]); if (f) { f.name = body.name; f.updated_at = ++clock; }
                return json({ ok: true });
            }
            const del = path.match(/^\/api\/files\/([^/]+)$/);
            if (method === "DELETE" && del) { files.delete(del[1]); return json({ ok: true, permanent: false }); }
            if (method === "POST" && path === "/api/files/batch-delete") {
                const body = await req.json() as { file_ids: string[] };
                for (const fid of body.file_ids) files.delete(fid);
                return json({ ok: true, deleted: body.file_ids.length });
            }

            // ── Version upload (upload/init → PUT) ──
            if (method === "POST" && path === "/api/upload/init") {
                const body = await req.json() as { file_name: string; file_size: number; mime_type: string; folder_id: string | null; file_id?: string };
                const sid = id("sess_");
                sessions.set(sid, { file_id: body.file_id ?? null, name: body.file_name, folder_id: body.folder_id ?? null, content_type: body.mime_type, ext: body.file_name.includes(".") ? body.file_name.slice(body.file_name.lastIndexOf(".")) : null });
                return json({ ok: true, session_id: sid, upload_url: `${base}/api/upload/${sid}`, resumable: null });
            }
            const up = path.match(/^\/api\/upload\/([^/]+)$/);
            if (method === "PUT" && up) {
                const s = sessions.get(up[1]);
                if (!s) return json({ ok: false, error: "no session" }, 404);
                const bytes = new Uint8Array(await req.arrayBuffer());
                const fid = s.file_id ?? id("file_");
                objects.set(fid, bytes);
                const existing = files.get(fid);
                if (existing) { existing.current_version += 1; existing.size_bytes = bytes.byteLength; existing.updated_at = ++clock; }
                else files.set(fid, { id: fid, name: s.name, folder_id: s.folder_id, size_bytes: bytes.byteLength, mime_type: s.content_type, extension: s.ext, updated_at: ++clock, current_version: 1 });
                return json({ ok: true, file: { id: fid, name: s.name, size_bytes: bytes.byteLength, version: files.get(fid)!.current_version } });
            }

            return json({ ok: false, error: `unhandled ${method} ${path}` }, 404);
        }
    }

    const realFetch = globalThis.fetch;

    return {
        base,
        install() {
            globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
                handle(new Request(input as RequestInfo, init))) as typeof fetch;
        },
        stop: () => { globalThis.fetch = realFetch; },
        files, folders, objects, paths,
        addRemoteFile(relPath: string, body: string) {
            const slash = relPath.lastIndexOf("/");
            const folderId = slash === -1 ? null : ensureFolderPath(relPath.slice(0, slash));
            const name = slash === -1 ? relPath : relPath.slice(slash + 1);
            const fid = id("file_");
            const bytes = new TextEncoder().encode(body);
            objects.set(fid, bytes);
            files.set(fid, { id: fid, name, folder_id: folderId, size_bytes: bytes.byteLength, mime_type: "text/plain", extension: name.includes(".") ? name.slice(name.lastIndexOf(".")) : null, updated_at: ++clock, current_version: 1 });
            return fid;
        },
        addRemoteFolderPath: (relPath: string) => ensureFolderPath(relPath),
    };
}
