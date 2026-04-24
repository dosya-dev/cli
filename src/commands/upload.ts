import { basename, join, relative, sep } from "path";
import { readdirSync, statSync } from "fs";
import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { ProgressBar } from "../progress";
import { printJson, fatal, log, EXIT } from "../output";

const HELP = `Upload a file or folder to dosya.dev.

Usage: dosya upload <file-or-folder> [flags]

Flags:
  --workspace, -w <id>   Target workspace ID (required if no default set)
  --folder <id>          Target folder ID
  --recursive, -r        Upload directory contents recursively
  --parallel <n>         Max concurrent uploads (default: 3)
  --json, -j             Output as JSON

Examples:
  dosya upload report.pdf --workspace ws_abc123
  dosya upload ./project --recursive --workspace ws_abc123
  dosya upload photo.jpg -w ws_abc123 --folder fld_xyz`;

export function uploadHelp(): void {
    console.log(HELP);
}

interface InitResponse {
    ok: boolean;
    session_id: string;
    upload_url: string;
    file_name: string;
    file_size: number;
}

interface UploadResult {
    ok: boolean;
    file: {
        id: string;
        name: string;
        size_bytes: number;
        version: number;
    };
}

interface FolderResponse {
    ok: boolean;
    id?: string;
    created_folders?: { id: string; name: string; parent_id: string | null }[];
}

async function uploadSingleFile(
    client: DosyaClient,
    filePath: string,
    workspaceId: string,
    folderId: string | null,
    flags: Record<string, string>,
): Promise<UploadResult> {
    const file = Bun.file(filePath);
    const size = file.size;
    const name = basename(filePath);
    const mime = file.type || "application/octet-stream";

    // Step 1: init upload
    const init = await client.post<InitResponse>("/api/upload/init", {
        workspace_id: workspaceId,
        file_name: name,
        file_size: size,
        mime_type: mime,
        folder_id: folderId,
    });

    // Step 2: stream file to upload endpoint
    const bar = flags.json !== undefined ? null : new ProgressBar(name, size);

    const stream = file.stream();
    let body: ReadableStream<Uint8Array> | ReadableStream;

    if (bar) {
        body = stream.pipeThrough(bar.createTransform());
    } else {
        body = stream;
    }

    const res = await client.request<UploadResult>(init.upload_url, {
        method: "PUT",
        rawBody: body as ReadableStream,
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
        },
        timeout: 600_000, // 10 min for large files
    });

    if (bar) bar.finish();

    if (!res.ok) {
        const err = res.data as { error?: string };
        throw new Error(err?.error ?? `Upload failed: ${res.status}`);
    }

    return res.data;
}

function walkDir(dir: string): string[] {
    const files: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkDir(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }
    return files;
}

/**
 * Promise-based semaphore for controlled concurrency (no busy-wait).
 */
class Semaphore {
    private available: number;
    private queue: (() => void)[] = [];

    constructor(max: number) {
        this.available = max;
    }

    async acquire(): Promise<void> {
        if (this.available > 0) {
            this.available--;
            return;
        }
        await new Promise<void>(resolve => this.queue.push(resolve));
    }

    release(): void {
        const next = this.queue.shift();
        if (next) {
            next();
        } else {
            this.available++;
        }
    }
}

export async function upload(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { uploadHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const filePath = args[0];
    if (!filePath) {
        fatal("File path required. Usage: dosya upload <file-or-folder>", EXIT.USAGE);
    }

    const workspaceId = flags.workspace ?? flags.w ?? config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id> or set a default: dosya config set default_workspace <id>", EXIT.USAGE);
    }

    const folderId = flags.folder ?? null;
    const isRecursive = flags.recursive !== undefined || flags.r !== undefined;
    const parallel = parseInt(flags.parallel ?? "3", 10);

    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
        fatal(`File not found: ${filePath}`);
    }

    if (stat.isFile()) {
        // Single file upload
        try {
            const result = await uploadSingleFile(client, filePath, workspaceId, folderId, flags);
            if (flags.json !== undefined) {
                printJson(result);
            } else {
                log(`Uploaded: ${result.file.id}`);
            }
        } catch (err) {
            fatal((err as Error).message);
        }
        return;
    }

    if (!stat.isDirectory()) {
        fatal("Path must be a file or directory.", EXIT.USAGE);
    }

    if (!isRecursive) {
        fatal("Use --recursive to upload a directory.", EXIT.USAGE);
    }

    // Recursive directory upload
    const allFiles = walkDir(filePath);
    if (allFiles.length === 0) {
        fatal("Directory is empty.");
    }

    if (flags.json === undefined) log(`Uploading ${allFiles.length} files...`);

    // Build unique subdirectory set and create folders
    const folderMap = new Map<string, string>(); // relative dir path -> folder ID
    if (folderId) folderMap.set(".", folderId);

    const subdirs = new Set<string>();
    for (const f of allFiles) {
        // Normalize to forward slashes for cross-platform consistency
        const rel = relative(filePath, f).split(sep).join("/");
        const dir = rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) : null;
        if (dir) subdirs.add(dir);
    }

    // Create folders (sorted by depth so parents are created first)
    const sortedDirs = [...subdirs].sort((a, b) => a.split("/").length - b.split("/").length);
    for (const dir of sortedDirs) {
        try {
            const parentDir = dir.includes("/") ? dir.substring(0, dir.lastIndexOf("/")) : ".";
            const parentFolderId = folderMap.get(parentDir) ?? folderId;
            const dirName = dir.includes("/") ? dir.substring(dir.lastIndexOf("/") + 1) : dir;

            const res = await client.post<FolderResponse>("/api/folders", {
                workspace_id: workspaceId,
                parent_id: parentFolderId,
                name: dirName,
            });

            // The folder creation might return created_folders array for nested paths
            if (res.created_folders && res.created_folders.length > 0) {
                const lastFolder = res.created_folders[res.created_folders.length - 1];
                folderMap.set(dir, lastFolder.id);
            } else if (res.id) {
                folderMap.set(dir, res.id);
            }
        } catch (err) {
            console.error(`Warning: failed to create folder "${dir}": ${(err as Error).message}`);
        }
    }

    // Upload files with promise-based concurrency limiter
    let completed = 0;
    let failed = 0;
    const results: UploadResult[] = [];
    const sem = new Semaphore(parallel);

    async function uploadWithLimit(fp: string): Promise<void> {
        await sem.acquire();
        try {
            // Normalize to forward slashes for cross-platform consistency
            const rel = relative(filePath, fp).split(sep).join("/");
            const dir = rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) : ".";
            const targetFolder = folderMap.get(dir) ?? folderId;

            const result = await uploadSingleFile(client, fp, workspaceId, targetFolder, flags);
            results.push(result);
            completed++;
        } catch (err) {
            console.error(`Failed: ${basename(fp)}: ${(err as Error).message}`);
            failed++;
        } finally {
            sem.release();
        }
    }

    await Promise.all(allFiles.map(f => uploadWithLimit(f)));

    if (flags.json !== undefined) {
        printJson({ uploaded: completed, failed, files: results });
    } else {
        log(`Done. ${completed} uploaded, ${failed} failed.`);
    }
}
