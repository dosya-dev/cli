/**
 * Path / name addressing.
 *
 * Turns a human reference into a concrete `{ type, id, workspaceId }`. Accepts:
 *   - `ws_id:folder/sub/name.ext`   (explicit workspace)
 *   - `folder/sub/name.ext`         (workspace from --workspace / default)
 *   - `file_…` / `fld_…` / `ws_…`   (raw ids, passed through - no network)
 *
 * ID prefixes are the real ones minted by the API: files `file_`, folders
 * `fld_`, workspaces `ws_`.
 */

import { DosyaClient } from "./client";

export type RefType = "file" | "folder";

export interface Resolved {
    type: RefType;
    /** File/folder id. Empty string means the workspace root folder. */
    id: string;
    workspaceId: string;
    name: string;
}

export interface FolderNode {
    id: string;
    name: string;
    parent_id: string | null;
    file_count?: number;
}

export class ResolveError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ResolveError";
    }
}

/** Whole-reference id: `file_…`, `fld_…`, or `ws_…`. */
const ID_RE = /^(file|fld|ws)_[A-Za-z0-9]+$/;
const WS_RE = /^ws_[A-Za-z0-9]+$/;

/** True if a path segment contains a `*` or `?` wildcard. */
export function hasGlob(segment: string): boolean {
    return /[*?]/.test(segment);
}

/** Compile a single-segment glob (`*`, `?`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
    let re = "";
    for (const c of glob) {
        if (c === "*") re += "[^/]*";
        else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
}

export interface ParsedRef {
    workspaceId: string | null;
    segments: string[];
    rawId: { type: RefType; id: string } | null;
}

/**
 * Split a reference into a workspace, path segments, and (if it *is* an id) the
 * raw id. Pure - no network. Workspace precedence: explicit `ws_…:` prefix >
 * `opts.workspace` > `opts.defaultWorkspace`.
 */
export function parseRef(ref: string, opts: { workspace?: string; defaultWorkspace?: string }): ParsedRef {
    let workspaceId = opts.workspace || opts.defaultWorkspace || null;
    let rest = ref;

    // Optional `ws_id:` prefix. Only a real workspace id counts, so a filename
    // that happens to contain a colon is left untouched.
    const colon = ref.indexOf(":");
    if (colon !== -1 && WS_RE.test(ref.slice(0, colon))) {
        workspaceId = ref.slice(0, colon);
        rest = ref.slice(colon + 1);
    }

    // A bare id as the whole (post-prefix) reference.
    if (ID_RE.test(rest)) {
        if (rest.startsWith("ws_")) {
            // A workspace id addresses that workspace's root folder.
            return { workspaceId: rest, segments: [], rawId: { type: "folder", id: "" } };
        }
        return {
            workspaceId,
            segments: [],
            rawId: { type: rest.startsWith("file_") ? "file" : "folder", id: rest },
        };
    }

    // Tolerate a leading `./` or `/` - paths are always workspace-root-relative.
    rest = rest.replace(/^\.?\//, "");
    const segments = rest.length ? rest.split("/").filter(s => s.length > 0) : [];
    return { workspaceId, segments, rawId: null };
}

export interface FolderIndex {
    pathToId: Map<string, string>;
    idToPath: Map<string, string>;
    byId: Map<string, FolderNode>;
}

/** Build root-relative `/`-joined path indexes from a flat folder list. */
export function buildFolderIndex(folders: FolderNode[]): FolderIndex {
    const byId = new Map(folders.map(f => [f.id, f]));
    const idToPath = new Map<string, string>();

    function pathOf(f: FolderNode, seen: Set<string>): string {
        const cached = idToPath.get(f.id);
        if (cached !== undefined) return cached;
        if (seen.has(f.id)) return f.name; // defensive: never loop on a cycle
        seen.add(f.id);
        const parent = f.parent_id ? byId.get(f.parent_id) : undefined;
        const p = parent ? `${pathOf(parent, seen)}/${f.name}` : f.name;
        idToPath.set(f.id, p);
        return p;
    }

    for (const f of folders) pathOf(f, new Set());

    const pathToId = new Map<string, string>();
    for (const [id, p] of idToPath) pathToId.set(p, id);
    return { pathToId, idToPath, byId };
}

export class Resolver {
    private treeCache = new Map<string, FolderIndex>();

    constructor(private client: DosyaClient) {}

    /** Fetch (and cache for this invocation) the folder tree for a workspace. */
    private async tree(workspaceId: string): Promise<FolderIndex> {
        const cached = this.treeCache.get(workspaceId);
        if (cached) return cached;
        const data = await this.client.get<{ ok: boolean; folders: FolderNode[] }>(
            `/api/folders/tree?workspace_id=${encodeURIComponent(workspaceId)}`,
        );
        const idx = buildFolderIndex(data.folders ?? []);
        this.treeCache.set(workspaceId, idx);
        return idx;
    }

    async resolve(
        ref: string,
        opts: { workspace?: string; defaultWorkspace?: string; expect?: RefType },
    ): Promise<Resolved> {
        const parsed = parseRef(ref, opts);

        // A raw id is globally unique and addressable on its own - no workspace
        // needed (this keeps `dosya download file_…` working with no default set).
        if (parsed.rawId) {
            return {
                type: parsed.rawId.type,
                id: parsed.rawId.id,
                workspaceId: parsed.workspaceId ?? "",
                name: parsed.rawId.id,
            };
        }

        const workspaceId = parsed.workspaceId;
        if (!workspaceId) {
            throw new ResolveError(
                `No workspace for "${ref}". Use ws_id:path, --workspace <id>, or set a default workspace.`,
            );
        }

        if (parsed.segments.length === 0) {
            return { type: "folder", id: "", workspaceId, name: "/" };
        }

        const idx = await this.tree(workspaceId);
        const leafName = parsed.segments[parsed.segments.length - 1];
        const parentSegs = parsed.segments.slice(0, -1);
        const fullPath = parsed.segments.join("/");

        let parentId: string | null = null;
        if (parentSegs.length > 0) {
            const pid = idx.pathToId.get(parentSegs.join("/"));
            if (!pid) {
                throw new ResolveError(`No such folder: "${parentSegs.join("/")}" in workspace ${workspaceId}.`);
            }
            parentId = pid;
        }

        // Folder was explicitly requested (tree root, mkdir parent, …).
        if (opts.expect === "folder") {
            const fid = idx.pathToId.get(fullPath);
            if (!fid) throw new ResolveError(`No such folder: "${fullPath}" in workspace ${workspaceId}.`);
            return { type: "folder", id: fid, workspaceId, name: leafName };
        }

        // Try to match a file in the parent folder.
        const params = new URLSearchParams({ workspace_id: workspaceId, per_page: "500" });
        if (parentId) params.set("folder_id", parentId);
        const listing = await this.client.get<{
            ok: boolean;
            files: { id: string; name: string }[];
        }>(`/api/files?${params}`);

        const matches = (listing.files ?? []).filter(f => f.name === leafName);
        if (matches.length === 1) {
            return { type: "file", id: matches[0].id, workspaceId, name: leafName };
        }
        if (matches.length > 1) {
            throw new ResolveError(
                `"${fullPath}" is ambiguous - matches file ids: ${matches.map(m => m.id).join(", ")}. Use an id.`,
            );
        }

        // Not a file - fall back to a folder with that path.
        const fid = idx.pathToId.get(fullPath);
        if (fid) return { type: "folder", id: fid, workspaceId, name: leafName };

        throw new ResolveError(`No such file or folder: "${fullPath}" in workspace ${workspaceId}.`);
    }

    /**
     * Expand a single reference, applying a leaf glob (`*`/`?`) if present.
     * A non-glob reference returns exactly one result; a glob returns every
     * matching file and folder in the parent, and errors if nothing matches.
     */
    async expand(
        ref: string,
        opts: { workspace?: string; defaultWorkspace?: string; expect?: RefType },
    ): Promise<Resolved[]> {
        const parsed = parseRef(ref, opts);
        const leaf = parsed.segments[parsed.segments.length - 1] ?? "";
        if (parsed.rawId || !hasGlob(leaf)) {
            return [await this.resolve(ref, opts)];
        }

        const workspaceId = parsed.workspaceId;
        if (!workspaceId) {
            throw new ResolveError(`No workspace for "${ref}". Use ws_id:path, --workspace <id>, or set a default workspace.`);
        }

        const idx = await this.tree(workspaceId);
        const parentSegs = parsed.segments.slice(0, -1);
        let parentId: string | null = null;
        if (parentSegs.length > 0) {
            const pid = idx.pathToId.get(parentSegs.join("/"));
            if (!pid) throw new ResolveError(`No such folder: "${parentSegs.join("/")}" in workspace ${workspaceId}.`);
            parentId = pid;
        }

        const re = globToRegExp(leaf);
        const results: Resolved[] = [];

        // Matching subfolders directly under the parent.
        if (opts.expect !== "file") {
            for (const node of idx.byId.values()) {
                if ((node.parent_id ?? null) === parentId && re.test(node.name)) {
                    results.push({ type: "folder", id: node.id, workspaceId, name: node.name });
                }
            }
        }

        // Matching files in the parent folder.
        if (opts.expect !== "folder") {
            const params = new URLSearchParams({ workspace_id: workspaceId, per_page: "500" });
            if (parentId) params.set("folder_id", parentId);
            const listing = await this.client.get<{ ok: boolean; files: { id: string; name: string }[] }>(`/api/files?${params}`);
            for (const f of listing.files ?? []) {
                if (re.test(f.name)) results.push({ type: "file", id: f.id, workspaceId, name: f.name });
            }
        }

        if (results.length === 0) {
            throw new ResolveError(`No files or folders match "${ref}".`);
        }
        return results;
    }

    async resolveMany(
        refs: string[],
        opts: { workspace?: string; defaultWorkspace?: string; expect?: RefType },
    ): Promise<Resolved[]> {
        const out: Resolved[] = [];
        for (const ref of refs) out.push(...(await this.expand(ref, opts)));
        return out;
    }
}
