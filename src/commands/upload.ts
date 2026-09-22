import { basename, join, relative, resolve, sep } from "path";
import { readdirSync, statSync } from "fs";
import { createClient, DosyaClient } from "../client";
import { ApiError } from "../errors";
import {
    planBatches, uploadBatch, BATCH_FILE_MAX,
    type BatchFile, type BatchOutcome,
} from "../batch-upload";
import { requireAuth } from "../config";
import { Resolver } from "../resolver";
import { ProgressBar, BatchProgress, type FileProgress, type ProgressFactory } from "../progress";
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
 * `UploadLimits` plus the one rule that is not a per-file rule: how many upload
 * sessions this member may hold open at once. Kept out of the shared type
 * because `checkUploadFile` has no use for it - it bounds the RUN, not a file.
 */
type FetchedLimits = UploadLimits & { max_concurrent_uploads?: number | null };

/**
 * The workspace's upload rules, or "no rules known" if they cannot be read.
 *
 * Failing open is deliberate and is the same choice the web client makes: this
 * check exists only to move a refusal earlier, so an unreachable endpoint must
 * restore the old behaviour (upload and let the server decide) rather than
 * block an upload that would have succeeded.
 */
async function fetchUploadLimits(client: DosyaClient, workspaceId: string): Promise<FetchedLimits> {
    try {
        const res = await client.get<FetchedLimits & { ok: boolean }>(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/upload-limits`,
        );
        return {
            allowed_extensions: res.allowed_extensions ?? null,
            blocked_extensions: res.blocked_extensions ?? null,
            max_file_size_gb: res.max_file_size_gb ?? null,
            storage_remaining_bytes: res.storage_remaining_bytes ?? null,
            // Absent on an API older than this field; `clampToWorkspaceLimit`
            // reads that as "no limit", which is the pre-existing behaviour.
            max_concurrent_uploads: res.max_concurrent_uploads ?? null,
        };
    } catch (err) {
        debug(`upload-limits unavailable, proceeding without a pre-check: ${String(err)}`);
        return {};
    }
}

interface ScreenedPaths {
    accepted: string[];
    rejected: { name: string; reason: string }[];
    /** Total size of the accepted files. */
    acceptedBytes: number;
    /** Size of each accepted file, so later reporting never re-stats. */
    sizes: Map<string, number>;
    /** Bytes past the remaining space, or 0. A warning, never a refusal. */
    quotaOver: number;
}

function screenPaths(paths: string[], limits: UploadLimits): ScreenedPaths {
    const accepted: string[] = [];
    const rejected: { name: string; reason: string }[] = [];
    const sizes = new Map<string, number>();
    let total = 0;

    for (const p of paths) {
        const size = statSync(p).size;
        const reason = checkUploadFile({ name: basename(p), size }, limits);
        if (reason) { rejected.push({ name: p, reason }); continue; }
        accepted.push(p);
        sizes.set(p, size);
        total += size;
    }

    const fit = checkBatchFitsQuota(total, limits);
    return { accepted, rejected, acceptedBytes: total, sizes, quotaOver: fit.fits ? 0 : fit.over };
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
  --recursive, -r        Upload a directory recursively (into a folder named
                         after it, e.g. "Downloads")
  --contents             With --recursive: skip that folder and upload the
                         directory's contents directly into the target
  --parallel, -c <n>     Max concurrent uploads (default: 3, max: 16). Clamped
                         to the workspace's concurrent-upload limit.
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
    makeBar: (() => FileProgress) | null,
): Promise<UploadedFile> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= SINGLE_PUT_RETRIES; attempt++) {
        // A fresh stream and a fresh bar on every attempt
        const bar = makeBar ? makeBar() : null;
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

/** How long to wait for a session slot, per attempt, before giving up. */
const SLOT_WAIT_DELAYS = [500, 1500, 3000, 5000, 8000];

/**
 * Open an upload session, waiting rather than failing when the workspace's
 * concurrent-session ceiling is momentarily full.
 *
 * Concurrency is clamped to the ceiling before the run starts, so this should
 * rarely fire - but "rarely" is not "never": another device, another tab, or a
 * previous run's sessions still ageing out of `pending` all consume the same
 * budget, and the ceiling can be lowered mid-run. Without this the loser of
 * that race was a hard per-file failure and a non-zero exit on an otherwise
 * complete upload.
 *
 * Keyed on the server's `error_code`, never its prose - see ApiError.code.
 * Every other refusal is rethrown untouched on the first attempt: a blocked
 * extension does not become allowed by asking again.
 */
async function initWithSlotWait(
    client: DosyaClient,
    body: Record<string, unknown>,
    name: string,
): Promise<InitResponse> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await client.post<InitResponse>("/api/upload/init", body);
        } catch (err) {
            const isSlotLimit = err instanceof ApiError && err.code === "concurrent_upload_limit";
            if (!isSlotLimit || attempt >= SLOT_WAIT_DELAYS.length) throw err;
            debug(`No upload slot for ${name}; waiting ${SLOT_WAIT_DELAYS[attempt]}ms`);
            await Bun.sleep(SLOT_WAIT_DELAYS[attempt]);
        }
    }
}

async function uploadSingleFile(
    client: DosyaClient,
    filePath: string,
    workspaceId: string,
    folderId: string | null,
    progressFor: ProgressFactory | null,
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
        const init = await initWithSlotWait(client, {
            workspace_id: workspaceId,
            file_name: name,
            file_size: size,
            mime_type: mime,
            folder_id: folderId,
            // When set, the server records this upload as a new version of the file.
            ...(versionOfFileId ? { file_id: versionOfFileId } : {}),
        }, name);
        sessionId = init.session_id;
        uploadUrl = init.upload_url;
        resumable = init.resumable;

        // Record the session before sending bytes, so an interrupt mid-upload
        // is still resumable on the next run
        if (resumable) saveUploadSession(filePath, makeSidecar(filePath, sessionId, size, resumable));
    }

    if (resumable) {
        const bar = progressFor ? progressFor(name, size) : null;
        try {
            const uploaded = await uploadMultipart({
                client, filePath, size, sessionId, resumable,
                concurrency: parallelParts, bar,
            });
            if (bar) bar.finish();
            removeUploadSession(filePath);
            return { ok: true, file: uploaded };
        } catch (err) {
            bar?.clear();
            // Keep the sidecar: the whole point is that the next run resumes
            throw err;
        }
    }

    // Small file - a single streamed PUT, retried by reopening the stream
    const uploaded = await putWholeFile(
        client, filePath, uploadUrl, size, name,
        progressFor ? () => progressFor(name, size) : null,
    );
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
 * The workspace folder name for a recursively uploaded directory: the
 * directory's own name, however the user spelled the path (`.`, trailing
 * slash, relative segments).
 */
export function uploadRootName(dirPath: string): string {
    return basename(resolve(dirPath));
}

/**
 * Every folder path a set of files needs, ancestors included.
 *
 * Exported for its own test: this used to be an inline one-liner collecting
 * only each file's immediate parent, which silently flattened any level that
 * held no files of its own. See the call site for what that cost.
 */
export function requiredFolderPaths(relPaths: string[]): Set<string> {
    const dirs = new Set<string>();
    for (const rel of relPaths) {
        if (!rel.includes("/")) continue;
        const dir = rel.substring(0, rel.lastIndexOf("/"));
        const parts = dir.split("/");
        for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
}

/**
 * Group directories by depth, shallowest first. A folder needs only its parent
 * to exist, and every parent is exactly one level shallower, so each level can
 * be created concurrently once the previous one is done.
 */
export function planFolderLevels(subdirs: Set<string>): string[][] {
    const byDepth = new Map<number, string[]>();
    for (const dir of subdirs) {
        const depth = dir.split("/").length;
        const level = byDepth.get(depth);
        if (level) level.push(dir);
        else byDepth.set(depth, [dir]);
    }
    return [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([, dirs]) => dirs);
}

/**
 * `parseInt("abc")` is NaN and `new Semaphore(NaN)` never grants a slot, so an
 * unparseable --parallel used to hang the CLI forever.
 */
export function parseParallel(raw: string | undefined): number {
    if (!raw) return DEFAULT_PARALLEL;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
        fatal(`Invalid --parallel value: ${raw}. Must be an integer between 1 and ${MAX_PARALLEL}.`, EXIT.USAGE);
    }
    return Math.min(Math.floor(n), MAX_PARALLEL);
}

/**
 * The concurrency this run will actually use.
 *
 * `-c` is the short flag for `--connections`, which is the DOWNLOAD flag; this
 * command reads `--parallel`. So `dosya upload . -r -c 16` parsed cleanly,
 * meant nothing, and ran at the default 3 - the parser could not object,
 * because `connections` is a real flag, just not one this command had ever
 * read. Accepting it here is the fix that matches what the user typed; the two
 * cannot conflict in practice, and `--parallel` wins if both are given.
 */
export function resolveParallel(flags: Record<string, string>): number {
    return parseParallel(flags.parallel ?? flags.connections);
}

/**
 * Clamp the requested concurrency to what the workspace will actually allow.
 *
 * `max_concurrent_uploads` bounds how many upload SESSIONS one member may hold
 * open, and `/api/upload/init` enforces it per file with a 400. Asking for more
 * than the ceiling does not go faster, it fails: `--parallel 16` against a
 * workspace allowing 5 lost 7 of 20 files to "You have 5 uploads in progress"
 * and still exited reporting the other 13 as uploaded.
 *
 * 0 and null both mean "no limit" - 0 is the server's own sentinel
 * (`if (settings.max_concurrent_uploads > 0)` is what guards the gate), and
 * null means the workspace has no settings row or an older API that does not
 * report the field.
 */
export function clampToWorkspaceLimit(requested: number, ceiling: number | null | undefined): number {
    if (ceiling === null || ceiling === undefined || ceiling <= 0) return requested;
    return Math.max(1, Math.min(requested, ceiling));
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
    const requestedParallel = resolveParallel(flags);
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

            const singleBar: ProgressFactory | null = isJson ? null : (n, s) => new ProgressBar(n, s);
            // One file: `--parallel` here means multipart PART concurrency
            // within that file, which the workspace's session ceiling does not
            // bound (one file is one session), so it is used unclamped.
            const result = await uploadSingleFile(client, filePath, workspaceId, folderId, singleBar, requestedParallel, versionOfFileId);
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
    // Asking for more concurrency than the workspace allows does not go faster,
    // it fails - see clampToWorkspaceLimit. Only the single-file path is bound
    // by it: /api/upload/batch opens no session and is not gated on the ceiling.
    const parallel = clampToWorkspaceLimit(requestedParallel, limits.max_concurrent_uploads);
    if (parallel < requestedParallel && !isJson) {
        log(`Using ${parallel} concurrent uploads: this workspace allows ${limits.max_concurrent_uploads} at a time.`);
    }
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

    // By default the upload lands inside a folder named after the directory,
    // the way Finder or Drive would copy it. --contents restores the old
    // behaviour of spilling the directory's contents into the target itself.
    const contentsOnly = flags.contents !== undefined;
    const rootName = contentsOnly ? null : uploadRootName(filePath);
    if (rootName === "") {
        fatal(`Cannot derive a folder name from "${filePath}". Use --contents to upload into the target directly.`, EXIT.USAGE);
    }

    if (!isJson) {
        const into = rootName ? ` into "${rootName}"` : "";
        log(`Uploading ${allFiles.length} files (${humanBytes(screened.acceptedBytes)})${into}...`);
    }

    /** Where files with no surviving parent folder go. */
    let rootTargetId = folderId;
    if (rootName) {
        try {
            const res = await client.post<FolderResponse>("/api/folders", {
                workspace_id: workspaceId,
                parent_id: folderId,
                name: rootName,
            });
            const id = res.folder?.id
                ?? res.created_folders?.[res.created_folders.length - 1]?.id
                ?? res.id;
            if (!id) throw new Error("the server returned no folder ID");
            rootTargetId = id;
        } catch (err) {
            const message = `Could not create folder "${rootName}": ${(err as Error).message}`;
            if (isJson) {
                printJson({ ok: false, error: message });
                process.exit(EXIT.ERROR);
            }
            fatal(message);
        }
    }

    /** Path relative to the upload root, normalized to forward slashes. */
    function relPath(fp: string): string {
        return relative(filePath, fp).split(sep).join("/");
    }

    // Build unique subdirectory set and create folders
    const folderMap = new Map<string, string>(); // relative dir path -> folder ID
    if (rootTargetId) folderMap.set(".", rootTargetId);

    // Every ANCESTOR of every file's directory, not just the directories that
    // hold files directly.
    //
    // This set used to collect only the immediate parent of each file, so a
    // level containing nothing but other directories was never created - and
    // `createFolder` resolves a missing parent as `?? rootTargetId`. Uploading
    // src/{a/deep/x.h, b/deep/y.h} therefore created ONE `deep` folder at the
    // root and put both files in it: the tree was silently flattened, and where
    // two branches held the same filename the second upload silently landed as
    // a new VERSION of the first. Files went missing and no error was printed.
    //
    // It stayed invisible because it needs a directory with no direct files of
    // its own, which a flat "upload this folder of photos" never has. The batch
    // door is what surfaced it: two same-named files in one request hit
    // `idx_files_ws_folder_name_active` and the whole batch 500s, where the
    // one-at-a-time door quietly versioned them instead.
    const subdirs = requiredFolderPaths(allFiles.map(relPath));

    // Create folders level by level: a level's folders only need the previous
    // level's IDs, so siblings go concurrently. A Downloads-scale tree (26k+
    // dirs) used to be hours of strictly sequential round trips - and silent
    // ones, which read as a hang, so the phase now has its own counter too.
    const levels = planFolderLevels(subdirs);
    const totalFolders = subdirs.size;
    let foldersDone = 0;
    let folderFailures = 0;
    const showFolderCounter = !isJson && Boolean(process.stderr.isTTY);
    const FOLDER_LINE_WIDTH = 44;
    let lastFolderRender = 0;

    function renderFolderCounter(force: boolean): void {
        if (!showFolderCounter) return;
        const now = Date.now();
        if (!force && now - lastFolderRender < 100) return;
        lastFolderRender = now;
        process.stderr.write(`\r${`Creating folders ${foldersDone}/${totalFolders}...`.padEnd(FOLDER_LINE_WIDTH)}`);
    }

    /** Blank the counter line so a warning starts on a clean row. */
    function clearFolderCounter(): void {
        if (!showFolderCounter) return;
        process.stderr.write(`\r${" ".repeat(FOLDER_LINE_WIDTH)}\r`);
    }

    async function createFolder(dir: string): Promise<void> {
        try {
            const parentDir = dir.includes("/") ? dir.substring(0, dir.lastIndexOf("/")) : ".";
            const parentFolderId = folderMap.get(parentDir) ?? rootTargetId;
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
                clearFolderCounter();
                console.error(`Warning: could not resolve folder ID for "${dir}" - its files will go to the parent folder.`);
            }
        } catch (err) {
            folderFailures++;
            clearFolderCounter();
            console.error(`Warning: failed to create folder "${dir}": ${(err as Error).message}`);
        } finally {
            settledFolders.add(dir);
            foldersDone++;
            renderFolderCounter(false);
        }
    }

    /**
     * Create one depth level through `POST /api/folders/batch`.
     *
     * That route is set-based - one IN() sweep to validate every distinct
     * parent, one DB.batch() carrying every insert, one sweep to resolve the
     * ones INSERT OR IGNORE skipped - so a level of 300 sibling folders costs
     * a handful of D1 round trips instead of 300 requests' worth. It exists for
     * the desktop sync engine's initial scan; `upload` was still creating
     * folders one request at a time, which stopped being a rounding error the
     * moment the file phase got fast: on a 500-file tree the folder phase went
     * from invisible to the largest remaining cost.
     *
     * Returns false if the route is unusable (an older API, no permission),
     * so the caller can fall back rather than fail the whole upload.
     */
    /** Folders this run has already counted and reported on, however it did so. */
    const settledFolders = new Set<string>();

    async function createFolderLevel(level: string[]): Promise<boolean> {
        const payload = level.map(dir => ({
            name: dir.includes("/") ? dir.substring(dir.lastIndexOf("/") + 1) : dir,
            parent_id: folderMap.get(dir.includes("/") ? dir.substring(0, dir.lastIndexOf("/")) : ".") ?? rootTargetId,
            dir,
        }));

        // The route caps a request at 500 folders.
        const CHUNK = 500;
        for (let i = 0; i < payload.length; i += CHUNK) {
            const slice = payload.slice(i, i + CHUNK);
            let res: { folders?: { name: string; parent_id: string | null; id: string }[] };
            try {
                res = await client.post<{ ok: boolean; folders?: { name: string; parent_id: string | null; id: string }[] }>(
                    "/api/folders/batch",
                    { workspace_id: workspaceId, folders: slice.map(({ name, parent_id }) => ({ name, parent_id })) },
                );
            } catch (err) {
                debug(`Folder batch failed (${(err as Error).message}); falling back to one request per folder`);
                return false;
            }

            // Answers come back keyed by (name, parent_id), not by request
            // order, and a tree can legitimately hold two folders with the same
            // name under different parents - so the key has to carry both.
            const byKey = new Map(
                (res.folders ?? []).map(f => [`${f.parent_id ?? ""} ${f.name}`, f.id]),
            );
            for (const { dir, name, parent_id } of slice) {
                const id = byKey.get(`${parent_id ?? ""} ${name}`);
                if (id) {
                    folderMap.set(dir, id);
                } else {
                    folderFailures++;
                    clearFolderCounter();
                    console.error(`Warning: could not resolve folder ID for "${dir}" - its files will go to the parent folder.`);
                }
                // Recorded as settled as well as counted: a LATER chunk of the
                // same level can still fail and send the whole level to the
                // fallback, which must not re-warn and re-count what this chunk
                // already answered for.
                settledFolders.add(dir);
                foldersDone++;
            }
            renderFolderCounter(false);
        }
        return true;
    }

    if (totalFolders > 0) {
        renderFolderCounter(true);
        // Still level by level: a folder needs its parent's real id, and the
        // batch route takes parent ids, not paths.
        for (const level of levels) {
            if (await createFolderLevel(level)) continue;

            // Fallback: the per-folder door, at the old concurrency.
            const folderSem = new Semaphore(parallel);
            await Promise.all(level.map(async dir => {
                if (settledFolders.has(dir)) return;
                await folderSem.acquire();
                try { await createFolder(dir); } finally { folderSem.release(); }
            }));
        }
        clearFolderCounter();
    }

    // Upload files with promise-based concurrency limiter
    let completed = 0;
    let failed = 0;
    const results: UploadResult[] = [];
    const failures: { file: string; error: string }[] = [];
    const sem = new Semaphore(parallel);

    // N concurrent ProgressBars all rewrite the same stderr line with \r and
    // shred each other's output, so recursive uploads feed one aggregate line
    // with file counts, bytes, speed, ETA, and the file(s) currently in flight.
    const batch = !isJson && process.stderr.isTTY
        ? new BatchProgress(allFiles.length, screened.acceptedBytes)
        : null;
    const batchTicket: ProgressFactory | null = batch ? (n, s) => batch.startFile(n, s) : null;

    async function uploadWithLimit(fp: string): Promise<void> {
        await sem.acquire();
        try {
            const rel = relPath(fp);
            const dir = rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) : ".";
            const targetFolder = folderMap.get(dir) ?? rootTargetId;

            const result = await uploadSingleFile(client, fp, workspaceId, targetFolder, batchTicket, 2);
            results.push(result);
            completed++;
        } catch (err) {
            recordFailure(fp, (err as Error).message);
        } finally {
            sem.release();
        }
    }

    /** Record a per-file failure identically however it was uploaded. */
    function recordFailure(fp: string, message: string): void {
        failed++;
        batch?.clearLine();
        console.error(`Failed: ${basename(fp)}: ${message}`);
        failures.push({ file: relPath(fp), error: message });
        batch?.fileFailed(screened.sizes.get(fp) ?? 0);
    }

    // ── Route each file to the door that suits it ──
    //
    // Small files go through /api/upload/batch, up to 200 per request: the
    // single-file door costs two requests and ~14 sequential D1 statements per
    // file, which is ~5 seconds of pure waiting whether the file is 20 KB or
    // 5 MB (see batch-upload.ts for the measurement). Anything the batch door
    // will not take keeps the door it has always used.
    const smallFiles: BatchFile[] = [];
    const largeFiles: string[] = [];
    // (destination folder, name) pairs already claimed by a batched file.
    //
    // Two files can still collide on one destination even with the ancestor fix
    // above - a name that sanitises into an existing one, or a `--folder` that
    // aims two source directories at the same place. Within ONE batch that is a
    // unique-index violation that fails all 200 entries; across concurrent
    // batches it is a race. The single-file door has no such problem: it adopts
    // whatever is already at that (folder, name) as a new version. So the first
    // claim on a destination is batched and every repeat is sent through that
    // door instead, AFTER the batches land - which is exactly the sequence, and
    // exactly the result, that uploading one at a time always produced.
    const claimed = new Set<string>();
    for (const fp of allFiles) {
        const size = screened.sizes.get(fp) ?? 0;
        if (size > BATCH_FILE_MAX) { largeFiles.push(fp); continue; }
        const rel = relPath(fp);
        const dir = rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) : ".";
        const folderId = folderMap.get(dir) ?? rootTargetId;
        const name = basename(fp);
        const key = `${folderId ?? ""} ${name}`;
        if (claimed.has(key)) { largeFiles.push(fp); continue; }
        claimed.add(key);
        smallFiles.push({ path: fp, name, folderId, size });
    }

    function recordBatchOutcome(o: BatchOutcome): void {
        if (!o.ok || !o.fileId) {
            recordFailure(o.file.path, o.error ?? "Upload failed");
            return;
        }
        results.push({
            ok: true,
            file: {
                id: o.fileId,
                name: o.file.name,
                size_bytes: o.file.size,
                // The route reports the version it landed on, because a
                // same-name file is ADOPTED as a new version rather than
                // duplicated - assuming 1 here would misreport every overwrite.
                version: o.version ?? 1,
            },
        });
        completed++;
    }

    // Batches are large requests; several in flight saturates an uplink well
    // before `--parallel` would, and the server does the same 200 R2 writes
    // either way. Bounded separately from the per-file limiter for that reason.
    const MAX_BATCH_CONCURRENCY = 4;
    const packs = planBatches(smallFiles);
    const packSem = new Semaphore(Math.max(1, Math.min(parallel, MAX_BATCH_CONCURRENCY)));

    await Promise.all(packs.map(pack => packSem.run(async () => {
        try {
            const outcomes = await uploadBatch(client, workspaceId, pack, batchTicket, getLongTimeout(600_000));
            for (const o of outcomes) recordBatchOutcome(o);
        } catch (err) {
            // The batch door refused or could not be reached as a WHOLE - an
            // older API without the route, a proxy that will not pass the body,
            // a transport failure. That is not these files' fault, so they fall
            // back to the door that has always worked rather than being
            // reported as N failures.
            debug(`Batch of ${pack.length} failed (${(err as Error).message}); falling back to per-file uploads`);
            await Promise.all(pack.map(f => uploadWithLimit(f.path)));
        }
    })));

    // After the batches, not alongside them: this list holds both the files too
    // big for the batch door AND the repeat claims on a destination, and a
    // repeat has to land second for the adoption to mean what it meant before.
    await Promise.all(largeFiles.map(f => uploadWithLimit(f)));
    batch?.done();

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
