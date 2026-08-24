import { basename, join, relative, sep } from "path";
import { readdirSync, statSync } from "fs";
import { createClient, DosyaClient } from "../client";
import { requireAuth } from "../config";
import { Resolver } from "../resolver";
import { ProgressBar } from "../progress";
import { getLongTimeout } from "../runtime";
import { Semaphore } from "../semaphore";
import {
    uploadMultipart, loadUploadSession, saveUploadSession, removeUploadSession, makeSidecar,
    type ResumableInfo, type UploadedFile,
} from "../multipart";
import { printJson, fatal, fatalError, log, debug, EXIT } from "../output";
import { checkUploadFile, checkBatchFitsQuota, type UploadLimits } from "@dosya-dev/shared";

/** Listing every rejected path in a 5000-file tree is not a report, it is noise. */
const MAX_LISTED_REJECTIONS = 10;

/**
 * The workspace's upload rules, or "no rules known" if they cannot be read.
 *
 * Failing open is deliberate and is the same choice the web client makes: this
 * check exists only to move a refusal earlier, so an unreachable endpoint must
 * restore the old behaviour (upload and let the server decide) rather than
 * block an upload that would have succeeded.
 */
async function fetchUploadLimits(client: DosyaClient, workspaceId: string): Promise<UploadLimits> {
    try {
        const res = await client.get<UploadLimits & { ok: boolean }>(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/upload-limits`,
        );
        return {
            allowed_extensions: res.allowed_extensions ?? null,
            blocked_extensions: res.blocked_extensions ?? null,
            max_file_size_gb: res.max_file_size_gb ?? null,
            storage_remaining_bytes: res.storage_remaining_bytes ?? null,
        };
    } catch (err) {
        debug(`upload-limits unavailable, proceeding without a pre-check: ${String(err)}`);
        return {};
    }
}

interface ScreenedPaths {
    accepted: string[];
    rejected: { name: string; reason: string }[];
    /** Bytes past the remaining space, or 0. A warning, never a refusal. */
    quotaOver: number;
}

function screenPaths(paths: string[], limits: UploadLimits): ScreenedPaths {
    const accepted: string[] = [];
    const rejected: { name: string; reason: string }[] = [];
    let total = 0;

    for (const p of paths) {
        const size = statSync(p).size;
        const reason = checkUploadFile({ name: basename(p), size }, limits);
        if (reason) { rejected.push({ name: p, reason }); continue; }
        accepted.push(p);
        total += size;
    }

    const fit = checkBatchFitsQuota(total, limits);
    return { accepted, rejected, quotaOver: fit.fits ? 0 : fit.over };
}

function humanBytes(bytes: number): string {
    const MB = 1_048_576, GB = 1_073_741_824;
    if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
    if (bytes >= MB) return `${(bytes / MB).toFixed(0)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const HELP = `Upload a file or folder to dosya.dev.

Usage: dosya upload <file-or-folder> [flags]

Flags:
  --workspace, -w <id>   Target workspace ID (required if no default set)
  --folder <id>          Target folder ID
  --recursive, -r        Upload directory contents recursively
  --parallel <n>         Max concurrent uploads (default: 3, max: 16)
  --version-of <file>    Upload as a new version of an existing file (single file)
  --json, -j             Output as JSON

Examples:
  dosya upload report.pdf --workspace ws_abc123
  dosya upload ./project --recursive --workspace ws_abc123
  dosya upload photo.jpg -w ws_abc123 --folder fld_xyz
  dosya upload report-v2.pdf --version-of report.pdf`;

export function uploadHelp(): void {
    console.log(HELP);
}

const DEFAULT_PARALLEL = 3;
const MAX_PARALLEL = 16;

interface InitResponse {
    ok: boolean;
    session_id: string;
    upload_url: string;
    file_name: string;
    file_size: number;
    /** Present only for files large enough to warrant multipart (>50 MB). */
    resumable: ResumableInfo | null;
}

interface UploadResult {
    ok: boolean;
    file: UploadedFile;
}

const SINGLE_PUT_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 8000];

interface FolderResponse {
    ok: boolean;
    folder?: { id: string; name: string; parent_id: string | null };
    id?: string;
    created_folders?: { id: string; name: string; parent_id: string | null }[];
}

/**
 * Stream a whole file in one PUT, retrying by rebuilding the stream.
 *
 * The HTTP client cannot retry a ReadableStream body (it is consumed once), so
 * the retry has to happen here where a fresh stream can be opened.
 */
async function putWholeFile(
    client: DosyaClient,
    filePath: string,
    uploadUrl: string,
    size: number,
    name: string,
    showProgress: boolean,
): Promise<UploadedFile> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= SINGLE_PUT_RETRIES; attempt++) {
        // A fresh stream and a fresh bar on every attempt
        const bar = showProgress ? new ProgressBar(name, size) : null;
        const stream = Bun.file(filePath).stream();
        const body: ReadableStream = bar ? stream.pipeThrough(bar.createTransform()) : stream;

        try {
            const res = await client.request<UploadResult>(uploadUrl, {
                method: "PUT",
                rawBody: body,
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": String(size),
                },
                timeout: getLongTimeout(600_000), // 10 min for large files
            });

            if (!res.ok) {
                const err = res.data as { error?: string };
                const message = err?.error ?? `Upload failed: ${res.status}`;
                // 4xx is a rejection, not a blip - replaying will not help
                if (res.status >= 400 && res.status < 500) throw new Error(message);
                throw Object.assign(new Error(message), { retryable: true });
            }

            if (bar) bar.finish();
            return res.data.file;
        } catch (err) {
            bar?.clear();
            lastError = err as Error;
            const retryable = (err as { retryable?: boolean }).retryable === true
                || err instanceof TypeError
                || (err as Error).name === "TimeoutError";
            if (!retryable || attempt >= SINGLE_PUT_RETRIES) throw lastError;
            debug(`Upload of ${name} failed (${lastError.message}); retrying in ${RETRY_DELAYS[attempt]}ms`);
            await Bun.sleep(RETRY_DELAYS[attempt]);
        }
    }

    throw lastError ?? new Error("Upload failed");
}

async function uploadSingleFile(
    client: DosyaClient,
    filePath: string,
    workspaceId: string,
    folderId: string | null,
    showProgress: boolean,
    parallelParts: number,
    versionOfFileId?: string,
): Promise<UploadResult> {
    const file = Bun.file(filePath);
    const size = file.size;
    const name = basename(filePath);
    const mime = file.type || "application/octet-stream";

    // Reuse an interrupted session for this exact file, if one is on disk
    const resumed = loadUploadSession(filePath, size);

    let sessionId: string;
    let uploadUrl: string;
    let resumable: ResumableInfo | null;

    if (resumed) {
        debug(`Reusing upload session ${resumed.session_id} for ${name}`);
        sessionId = resumed.session_id;
        uploadUrl = `/api/upload/${resumed.session_id}`;
        resumable = resumed.resumable;
    } else {
        const init = await client.post<InitResponse>("/api/upload/init", {
            workspace_id: workspaceId,
            file_name: name,
            file_size: size,
            mime_type: mime,
            folder_id: folderId,
            // When set, the server records this upload as a new version of the file.
            ...(versionOfFileId ? { file_id: versionOfFileId } : {}),
        });
        sessionId = init.session_id;
        uploadUrl = init.upload_url;
        resumable = init.resumable;

        // Record the session before sending bytes, so an interrupt mid-upload
        // is still resumable on the next run
        if (resumable) saveUploadSession(filePath, makeSidecar(filePath, sessionId, size, resumable));
    }

    const bar = showProgress ? new ProgressBar(name, size) : null;

    try {
        if (resumable) {
            const uploaded = await uploadMultipart({
                client, filePath, size, sessionId, resumable,
                concurrency: parallelParts, bar,
            });
            if (bar) bar.finish();
            removeUploadSession(filePath);
            return { ok: true, file: uploaded };
        }
    } catch (err) {
        bar?.clear();
        // Keep the sidecar: the whole point is that the next run resumes
        throw err;
    }

    // Small file - a single streamed PUT, retried by reopening the stream
    const uploaded = await putWholeFile(client, filePath, uploadUrl, size, name, showProgress);
    return { ok: true, file: uploaded };
}

interface WalkResult {
    files: string[];
    skipped: string[];
}

function walkDir(dir: string, out: WalkResult = { files: [], skipped: [] }): WalkResult {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            walkDir(fullPath, out);
        } else if (entry.isFile()) {
            out.files.push(fullPath);
        } else {
            // Symlinks, sockets, FIFOs, devices - record them so the skip is
            // visible rather than silent
            out.skipped.push(fullPath);
        }
    }
    return out;
}

// Semaphore now lives in its own module (../semaphore) so the sync engine can
// reuse it without pulling in the whole upload command. Re-exported for the
// existing test importer.
export { Semaphore };

/**
 * `parseInt("abc")` is NaN and `new Semaphore(NaN)` never grants a slot, so an
 * unparseable --parallel used to hang the CLI forever.
 */
function parseParallel(raw: string | undefined): number {
    if (!raw) return DEFAULT_PARALLEL;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
        fatal(`Invalid --parallel value: ${raw}. Must be an integer between 1 and ${MAX_PARALLEL}.`, EXIT.USAGE);
    }
    return Math.min(Math.floor(n), MAX_PARALLEL);
}

export async function upload(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { uploadHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const filePath = args[0];
    if (!filePath) {
        fatal("File path required. Usage: dosya upload <file-or-folder>", EXIT.USAGE);
    }

    const resolvedWorkspace = flags.workspace || config?.default_workspace;
    if (!resolvedWorkspace) {
        fatal("Workspace ID required. Use --workspace <id> or set a default: dosya config set default_workspace <id>", EXIT.USAGE);
    }
    // Re-bind so the narrowing survives into the nested upload closure
    const workspaceId: string = resolvedWorkspace;

    const folderId = flags.folder || null;
    const isRecursive = flags.recursive !== undefined;
    const parallel = parseParallel(flags.parallel);
    const isJson = flags.json !== undefined;

    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
        fatal(`File not found: ${filePath}`);
    }

    // --version-of uploads a single file as a new version of an existing one.
    if (flags["version-of"] && (isRecursive || !stat.isFile())) {
        fatal("--version-of can only be used with a single file.", EXIT.USAGE);
    }

    if (stat.isFile()) {
        // One file, one rule check. Cheap here and it saves the multipart
        // handshake on a file the workspace was never going to accept.
        const single = screenPaths([filePath], await fetchUploadLimits(client, workspaceId));
        if (single.rejected.length > 0) {
            const [only] = single.rejected;
            if (isJson) {
                printJson({ ok: false, error: "files_rejected", rejected: single.rejected });
                process.exit(EXIT.USAGE);
            }
            fatal(only.reason, EXIT.USAGE);
        }
        if (single.quotaOver > 0 && !isJson) {
            log(`Warning: this file is about ${humanBytes(single.quotaOver)} larger than the space left in this workspace.`);
        }
        try {
            let versionOfFileId: string | undefined;
            if (flags["version-of"]) {
                const r = await new Resolver(client).resolve(flags["version-of"], {
                    workspace: workspaceId,
                    defaultWorkspace: config?.default_workspace,
                });
                if (r.type !== "file") fatal("--version-of must reference a file.", EXIT.USAGE);
                versionOfFileId = r.id;
            }

            const result = await uploadSingleFile(client, filePath, workspaceId, folderId, !isJson, parallel, versionOfFileId);
            if (isJson) {
                printJson(result);
            } else {
                log(`Uploaded: ${result.file.id}`);
            }
        } catch (err) {
            fatalError(err);
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
    const { files: allFiles, skipped } = walkDir(filePath);

    if (skipped.length > 0 && !isJson) {
        log(`Skipping ${skipped.length} non-regular file(s) (symlinks, sockets, devices).`);
        for (const s of skipped) debug(`Skipped: ${s}`);
    }

    if (allFiles.length === 0) {
        fatal("Directory is empty.");
    }

    // Screen against the workspace's rules before creating a single folder.
    // `dosya upload -r` on a large tree used to create the whole folder
    // structure and then refuse file after file, one round trip each; on a
    // workspace with an extension whitelist that is a long way to travel to
    // learn the first thing about it.
    const limits = await fetchUploadLimits(client, workspaceId);
    const screened = screenPaths(allFiles, limits);
    if (screened.rejected.length > 0) {
        if (isJson) {
            printJson({ ok: false, error: "files_rejected", rejected: screened.rejected });
            process.exit(EXIT.USAGE);
        }
        for (const r of screened.rejected.slice(0, MAX_LISTED_REJECTIONS)) {
            log(`  skipped ${r.name}: ${r.reason}`);
        }
        const extra = screened.rejected.length - MAX_LISTED_REJECTIONS;
        if (extra > 0) log(`  ...and ${extra} more`);
    }
    if (screened.accepted.length === 0) {
        fatal("Every file was refused by this workspace's upload rules.", EXIT.USAGE);
    }
    if (screened.quotaOver > 0) {
        log(`Warning: this upload is about ${humanBytes(screened.quotaOver)} larger than the space left in this workspace. Some files may be refused.`);
    }
    allFiles.length = 0;
    allFiles.push(...screened.accepted);

    if (!isJson) log(`Uploading ${allFiles.length} files...`);

    /** Path relative to the upload root, normalized to forward slashes. */
    function relPath(fp: string): string {
        return relative(filePath, fp).split(sep).join("/");
    }

    // Build unique subdirectory set and create folders
    const folderMap = new Map<string, string>(); // relative dir path -> folder ID
    if (folderId) folderMap.set(".", folderId);

    const subdirs = new Set<string>();
    for (const f of allFiles) {
        const rel = relPath(f);
        const dir = rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) : null;
        if (dir) subdirs.add(dir);
    }

    // Create folders (sorted by depth so parents are created first)
    const sortedDirs = [...subdirs].sort((a, b) => a.split("/").length - b.split("/").length);
    let folderFailures = 0;
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

            // `folder.id` is always the target folder. `created_folders` is
            // empty when the folder already existed (the API uses INSERT OR
            // IGNORE), so relying on it silently dropped files into the parent.
            const resolvedId = res.folder?.id
                ?? res.created_folders?.[res.created_folders.length - 1]?.id
                ?? res.id;

            if (resolvedId) {
                folderMap.set(dir, resolvedId);
            } else {
                folderFailures++;
                console.error(`Warning: could not resolve folder ID for "${dir}" - its files will go to the parent folder.`);
            }
        } catch (err) {
            folderFailures++;
            console.error(`Warning: failed to create folder "${dir}": ${(err as Error).message}`);
        }
    }

    // Upload files with promise-based concurrency limiter
    let completed = 0;
    let failed = 0;
    const results: UploadResult[] = [];
    const failures: { file: string; error: string }[] = [];
    const sem = new Semaphore(parallel);

    // N concurrent ProgressBars all rewrite the same stderr line with \r and
    // shred each other's output, so recursive uploads show one shared counter.
    const showCounter = !isJson && Boolean(process.stderr.isTTY);
    const COUNTER_WIDTH = 40;

    function renderCounter(): void {
        if (!showCounter) return;
        const line = `  ${completed + failed}/${allFiles.length} files`;
        process.stderr.write(`\r${line.padEnd(COUNTER_WIDTH)}`);
    }

    /** Blank the counter line and return the cursor, so a message starts clean. */
    function clearCounter(): void {
        if (!showCounter) return;
        process.stderr.write(`\r${" ".repeat(COUNTER_WIDTH)}\r`);
    }

    async function uploadWithLimit(fp: string): Promise<void> {
        await sem.acquire();
        try {
            const rel = relPath(fp);
            const dir = rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) : ".";
            const targetFolder = folderMap.get(dir) ?? folderId;

            const result = await uploadSingleFile(client, fp, workspaceId, targetFolder, false, 2);
            results.push(result);
            completed++;
            renderCounter();
        } catch (err) {
            const message = (err as Error).message;
            failed++;
            clearCounter();
            console.error(`Failed: ${basename(fp)}: ${message}`);
            failures.push({ file: relPath(fp), error: message });
            renderCounter();
        } finally {
            sem.release();
        }
    }

    await Promise.all(allFiles.map(f => uploadWithLimit(f)));
    if (showCounter) process.stderr.write("\n");

    if (isJson) {
        printJson({ uploaded: completed, failed, failures, files: results });
    } else {
        log(`Done. ${completed} uploaded, ${failed} failed.`);
    }

    // A partial upload must not look like success to a calling script
    if (failed > 0 || folderFailures > 0) {
        process.exit(EXIT.ERROR);
    }
}
