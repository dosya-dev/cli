import { join, dirname } from "path";
import { existsSync, statSync, mkdirSync, openSync, writeSync, closeSync, ftruncateSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "fs";
import { formatBytes } from "@dosya-dev/shared";
import { createClient, DosyaClient } from "../client";
import { requireAuth, type DosyaConfig } from "../config";
import { ProgressBar } from "../progress";
import { getLongTimeout, onInterrupt } from "../runtime";
import { Resolver } from "../resolver";
import { SyncRemote, buildRemotePaths } from "../sync/remote";
import { printJson, fatal, fatalError, log, debug, EXIT } from "../output";

const HELP = `Download a file from dosya.dev.

Usage: dosya download <file> [flags]
       dosya download --recursive <folder> -o ./dir/
       dosya download --zip <file...> -o out.zip

<file>/<folder> may be an id or a path (folder/name, or ws_id:folder/name).

Flags:
  --output, -o <path>       Output path (default: current directory)
  --recursive, -r           Download a whole folder tree, preserving structure
  --zip                     Download several files as one server-built zip
  --connections, -c <num>   Parallel connections (default: 8, max: 16)
  --force, -f               Overwrite an existing file without asking
      --no-verify           Skip the ETag content-integrity check
  --workspace, -w <id>      Workspace for path lookups
  --key, -k <key>           API key override
  --json, -j                Output as JSON

Examples:
  dosya download file_abc123
  dosya download reports/q3.pdf --output ./downloads/
  dosya download --recursive reports -o ./reports-backup/
  dosya download --zip a.pdf b.pdf -o bundle.zip`;

export function downloadHelp(): void {
    console.log(HELP);
}

interface FileMetadataResponse {
    ok: boolean;
    file: {
        id: string;
        name: string;
        size_bytes: number;
        mime_type: string;
    };
}

interface SegmentState {
    index: number;
    start: number;
    end: number;
    bytesWritten: number;
    done: boolean;
}

interface DownloadState {
    fileId: string;
    totalSize: number;
    outputPath: string;
    connections: number;
    segments: SegmentState[];
}

const DEFAULT_CONNECTIONS = 8;
const MAX_CONNECTIONS = 16;
const MIN_SEGMENT_SIZE = 5 * 1024 * 1024; // 5 MB
const SEGMENT_TIMEOUT = 120_000; // 2 min per segment attempt
const RETRY_DELAYS = [1000, 3000, 8000];
const STATE_FLUSH_INTERVAL = 2000; // persist resume state at most every 2s

/**
 * Signals that the presigned URL died mid-transfer and must be re-fetched.
 * Exported so callers of `runSegmentedDownload` can drive that path.
 */
export class UrlExpiredError extends Error {
    constructor() { super("Presigned URL expired"); this.name = "UrlExpiredError"; }
}

function sidecarPath(outputPath: string): string {
    return outputPath + ".dosya-download";
}

function loadState(outputPath: string): DownloadState | null {
    const p = sidecarPath(outputPath);
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

function saveState(outputPath: string, state: DownloadState): void {
    const tmp = `${sidecarPath(outputPath)}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(state));
        renameSync(tmp, sidecarPath(outputPath));
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        debug(`Could not persist resume state: ${(err as Error).message}`);
    }
}

function removeState(outputPath: string): void {
    try { unlinkSync(sidecarPath(outputPath)); } catch {}
}

/**
 * Abort when either the caller cancels or the per-attempt timeout elapses.
 *
 * Passing only the cancel signal (as this used to) meant a stalled connection
 * had no timeout at all and the download hung forever.
 */
function withTimeout(cancelSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!cancelSignal) return timeout;
    // AbortSignal.any is available in Bun and Node >= 20
    return AbortSignal.any([cancelSignal, timeout]);
}

async function getPresignedUrl(client: DosyaClient, fileId: string): Promise<string> {
    // Use redirect: "manual" to capture the presigned URL without downloading the file
    const res = await client.request<Response>(`/api/files/${encodeURIComponent(fileId)}/download`, {
        redirect: "manual",
    });

    // 302 redirect — extract Location header
    if (res.status === 302 || res.status === 301 || res.status === 307 || res.status === 308) {
        const location = res.headers.get("location");
        if (!location) throw new Error("Redirect response missing Location header");
        return location;
    }

    // If server returned an error
    if (!res.ok) {
        const err = res.data as unknown as { error?: string };
        throw new Error(err?.error ?? `Failed to get download URL: ${res.status}`);
    }

    throw new Error(`Unexpected response: ${res.status}`);
}

async function downloadSegment(
    url: string,
    seg: SegmentState,
    fd: number,
    bar: ProgressBar | null,
    state: DownloadState | null,
    outputPath: string,
    cancelSignal?: AbortSignal,
): Promise<void> {
    let attempts = 0;

    while (attempts <= RETRY_DELAYS.length) {
        if (cancelSignal?.aborted) return;

        try {
            const rangeStart = seg.start + seg.bytesWritten;
            if (rangeStart > seg.end) { seg.done = true; return; }

            debug(`Seg ${seg.index}: ${attempts > 0 ? `retry ${attempts}, ` : ""}range ${rangeStart}-${seg.end}`);

            const segStart = Date.now();
            const res = await fetch(url, {
                headers: { Range: `bytes=${rangeStart}-${seg.end}` },
                signal: withTimeout(cancelSignal, SEGMENT_TIMEOUT),
            });

            if (res.status === 403) {
                await res.body?.cancel().catch(() => {});
                throw new UrlExpiredError();
            }

            if (res.status === 200) {
                await res.body?.cancel().catch(() => {});
                throw new Error("Server does not support Range requests");
            }

            if (res.status !== 206) {
                await res.body?.cancel().catch(() => {});
                throw new Error(`HTTP ${res.status}`);
            }

            if (!res.body) throw new Error("No response body");

            const reader = res.body.getReader();
            let offset = rangeStart;
            let lastFlush = Date.now();

            while (true) {
                if (cancelSignal?.aborted) { await reader.cancel().catch(() => {}); return; }
                const { done, value } = await reader.read();
                if (done) break;
                writeSync(fd, value, 0, value.byteLength, offset);
                offset += value.byteLength;
                seg.bytesWritten += value.byteLength;
                if (bar) bar.update(value.byteLength);

                // Flush resume state as we go. Persisting only on segment
                // completion meant an interrupted download always restarted
                // from zero.
                if (state && Date.now() - lastFlush >= STATE_FLUSH_INTERVAL) {
                    lastFlush = Date.now();
                    saveState(outputPath, state);
                }
            }

            const elapsed = (Date.now() - segStart) / 1000;
            const segBytes = seg.bytesWritten;
            debug(`Seg ${seg.index}: ${formatBytes(segBytes)} in ${elapsed.toFixed(1)}s (${formatBytes(segBytes / elapsed)}/s)`);

            seg.done = true;
            if (state) saveState(outputPath, state);
            return;
        } catch (err) {
            if (cancelSignal?.aborted) return;
            if (err instanceof UrlExpiredError) throw err;
            attempts++;
            if (attempts > RETRY_DELAYS.length) throw err;
            debug(`Seg ${seg.index}: retry ${attempts}/${RETRY_DELAYS.length} after: ${(err as Error).message}`);
            await Bun.sleep(RETRY_DELAYS[attempts - 1]);
        }
    }
}

export interface SegmentRunOptions {
    segments: SegmentState[];
    /** Transfer one segment; must honour `signal` and set `seg.done` on success. */
    runSegment: (seg: SegmentState, signal: AbortSignal) => Promise<void>;
    /** Obtain a fresh presigned URL after the current one expires. */
    refreshUrl: () => Promise<void>;
    /** Persist resume state at each checkpoint. */
    onCheckpoint: () => void;
    maxUrlRefreshes?: number;
}

/**
 * Drive all pending segments to completion, refreshing the presigned URL when
 * it expires mid-transfer.
 *
 * Extracted from `download()` so the abort/restart ordering can be tested:
 * `Promise.all` rejects on the first failure while its siblings are still
 * reading, and restarting a segment that still has a live writer lets that
 * writer call writeSync() on an fd the caller has already closed (EBADF, or a
 * write into a recycled descriptor). Every in-flight promise must settle
 * before the next round starts.
 */
export async function runSegmentedDownload(opts: SegmentRunOptions): Promise<void> {
    const maxRefreshes = opts.maxUrlRefreshes ?? 3;
    let urlRefreshAttempts = 0;
    let remaining = opts.segments.filter(s => !s.done);

    while (remaining.length > 0 && urlRefreshAttempts <= maxRefreshes) {
        const ac = new AbortController();
        const inFlight = remaining.map(seg => opts.runSegment(seg, ac.signal));

        try {
            await Promise.all(inFlight);
            remaining = opts.segments.filter(s => !s.done);
        } catch (err) {
            ac.abort();
            // Never leave a writer running against a segment we are about to
            // restart, or against an fd the caller is about to close.
            await Promise.allSettled(inFlight);
            opts.onCheckpoint();

            if (err instanceof UrlExpiredError && urlRefreshAttempts < maxRefreshes) {
                urlRefreshAttempts++;
                debug(`Presigned URL expired, refreshing (attempt ${urlRefreshAttempts}/${maxRefreshes})`);
                await opts.refreshUrl();
                remaining = opts.segments.filter(s => !s.done);
                continue;
            }
            throw err;
        }
    }

    if (opts.segments.some(s => !s.done)) {
        throw new Error("Download incomplete after URL refresh attempts");
    }
}

async function downloadSingle(
    url: string,
    outputPath: string,
    bar: ProgressBar | null,
): Promise<string | null> {
    const res = await fetch(url, { signal: AbortSignal.timeout(getLongTimeout(600_000)) });
    // Presigned URLs live ~5 minutes; a slow single-connection transfer can
    // outlast one, and the caller needs to tell that apart from a real failure.
    if (res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw new UrlExpiredError();
    }
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    // Download to a temp path so an aborted transfer never clobbers a good file
    const tmpPath = `${outputPath}.dosya-partial`;
    const fd = openSync(tmpPath, "w");
    let offset = 0;

    const releaseCleanup = onInterrupt(() => {
        try { closeSync(fd); } catch {}
        try { unlinkSync(tmpPath); } catch {}
    });

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writeSync(fd, value, 0, value.byteLength, offset);
            offset += value.byteLength;
            if (bar) bar.update(value.byteLength);
        }
        closeSync(fd);
        renameSync(tmpPath, outputPath);
        return normalizeEtag(res.headers.get("etag"));
    } catch (err) {
        try { closeSync(fd); } catch {}
        try { unlinkSync(tmpPath); } catch {}
        throw err;
    } finally {
        releaseCleanup();
    }
}

/**
 * Run a single-connection download, re-presigning if the URL expires.
 *
 * There is no Range support on this path, so an expiry restarts the transfer —
 * but restarting beats failing outright, which is what a bare 403 used to do.
 */
async function downloadSingleWithRefresh(
    initialUrl: string,
    outputPath: string,
    makeBar: () => ProgressBar | null,
    refreshUrl: () => Promise<string>,
    maxRefreshes = 3,
): Promise<string | null> {
    let url = initialUrl;

    for (let attempt = 0; ; attempt++) {
        const bar = makeBar();
        try {
            const etag = await downloadSingle(url, outputPath, bar);
            if (bar) bar.finish();
            return etag;
        } catch (err) {
            bar?.clear();
            if (!(err instanceof UrlExpiredError) || attempt >= maxRefreshes) throw err;
            debug(`Presigned URL expired, refreshing (attempt ${attempt + 1}/${maxRefreshes})`);
            url = await refreshUrl();
        }
    }
}

/**
 * Determine whether the origin honours Range requests.
 *
 * A 403 here means the presigned URL expired, NOT that Range is unsupported —
 * conflating the two sent large downloads down the single-connection fallback,
 * where they immediately failed with "Download failed: HTTP 403".
 */
export async function probeRangeSupport(
    initialUrl: string,
    refreshUrl: () => Promise<string>,
    maxRefreshes = 3,
): Promise<{ supported: boolean; url: string; etag: string | null }> {
    let url = initialUrl;

    for (let attempt = 0; ; attempt++) {
        const probe = await fetch(url, {
            headers: { Range: "bytes=0-0" },
            signal: AbortSignal.timeout(10_000),
        });
        await probe.body?.cancel().catch(() => {});

        if (probe.status === 403) {
            if (attempt >= maxRefreshes) throw new UrlExpiredError();
            debug(`Range probe got 403, refreshing URL (attempt ${attempt + 1}/${maxRefreshes})`);
            url = await refreshUrl();
            continue;
        }

        return { supported: probe.status === 206, url, etag: normalizeEtag(probe.headers.get("etag")) };
    }
}

/** Must match MULTIPART PART_SIZE in apps/api/src/pages/api/upload/init.ts. */
const MULTIPART_PART_SIZE = 10 * 1024 * 1024;

/** Strip the quotes and weak-validator prefix R2/S3 put around ETags. */
function normalizeEtag(raw: string | null): string | null {
    if (!raw) return null;
    return raw.replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase();
}

async function md5File(path: string): Promise<string> {
    const hasher = new Bun.CryptoHasher("md5");
    // Stream so a multi-GB file never lands in memory
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
    return hasher.digest("hex");
}

/**
 * Recompute the S3 composite ETag: MD5 of the concatenated part MD5s, then
 * "-<partCount>".
 */
async function compositeEtag(path: string, partSize: number, partCount: number): Promise<string> {
    const outer = new Bun.CryptoHasher("md5");
    const file = Bun.file(path);

    for (let i = 0; i < partCount; i++) {
        const slice = file.slice(i * partSize, Math.min((i + 1) * partSize, file.size));
        const partMd5 = new Bun.CryptoHasher("md5")
            .update(new Uint8Array(await slice.arrayBuffer()))
            .digest();
        outer.update(partMd5);
    }

    return `${outer.digest("hex")}-${partCount}`;
}

/**
 * Verify downloaded bytes against the origin's ETag.
 *
 * Size alone cannot catch silent corruption, which is the failure a backup tool
 * most needs to detect. R2 gives an MD5 ETag for single-part objects and a
 * composite for multipart ones; anything else is skipped rather than guessed at,
 * so this never produces a false alarm.
 */
async function verifyIntegrity(outputPath: string, size: number, etag: string | null): Promise<void> {
    if (!etag) {
        debug("No ETag from origin — skipping content verification");
        return;
    }

    if (/^[0-9a-f]{32}$/.test(etag)) {
        const actual = await md5File(outputPath);
        if (actual !== etag) {
            fatal(`Integrity check failed: content MD5 ${actual} does not match origin ETag ${etag}.`);
        }
        debug(`Content verified against ETag (md5 ${actual})`);
        return;
    }

    const composite = /^([0-9a-f]{32})-(\d+)$/.exec(etag);
    if (composite) {
        const partCount = Number(composite[2]);
        // Only verify when the object's layout matches what this API produces
        if (Math.ceil(size / MULTIPART_PART_SIZE) !== partCount) {
            debug(`Composite ETag with an unknown part layout (${partCount} parts) — skipping verification`);
            return;
        }
        const actual = await compositeEtag(outputPath, MULTIPART_PART_SIZE, partCount);
        if (actual !== etag) {
            fatal(`Integrity check failed: computed ETag ${actual} does not match origin ETag ${etag}.`);
        }
        debug(`Content verified against composite ETag (${actual})`);
        return;
    }

    debug(`Unrecognized ETag format (${etag}) — skipping content verification`);
}

/**
 * Stream the object straight to stdout for shell pipelines.
 *
 * stdout is not seekable, so this is always a single ordered connection — no
 * segments, no resume, no sidecar. Progress stays on stderr so it does not
 * corrupt the piped bytes.
 */
async function downloadToStdout(
    initialUrl: string,
    refreshUrl: () => Promise<string>,
    maxRefreshes = 3,
): Promise<void> {
    let url = initialUrl;

    for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { signal: AbortSignal.timeout(getLongTimeout(600_000)) });

        if (res.status === 403 && attempt < maxRefreshes) {
            await res.body?.cancel().catch(() => {});
            debug(`Presigned URL expired, refreshing (attempt ${attempt + 1}/${maxRefreshes})`);
            url = await refreshUrl();
            continue;
        }
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
        if (!res.body) throw new Error("No response body");

        // Bun.write(Bun.stdout, response) never settles when stdout is a pipe
        // or redirect, so pump explicitly and respect backpressure from a slow
        // consumer (e.g. `| tar xz`).
        const reader = res.body.getReader();
        let written = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!process.stdout.write(value)) {
                    await new Promise<void>(resolve => process.stdout.once("drain", resolve));
                }
                written += value.byteLength;
            }
        } finally {
            reader.releaseLock();
        }

        debug(`stdout: wrote ${written} bytes`);
        return;
    }
}

/** Ask before clobbering an existing file, unless --force or resuming. */
async function confirmOverwrite(outputPath: string, force: boolean, isJson: boolean): Promise<void> {
    if (force || !existsSync(outputPath)) return;

    if (isJson || !process.stdin.isTTY) {
        fatal(`${outputPath} already exists. Use --force to overwrite.`, EXIT.USAGE);
    }

    process.stdout.write(`${outputPath} already exists. Overwrite? [y/N] `);
    const reader = Bun.stdin.stream().getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const answer = new TextDecoder().decode(value ?? new Uint8Array()).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
        log("Cancelled.");
        process.exit(EXIT.OK);
    }
}

/** Download several files as one server-built zip stream. */
async function downloadZip(
    args: string[],
    flags: Record<string, string>,
    client: DosyaClient,
    defaultWorkspace: string | undefined,
): Promise<void> {
    if (args.length === 0) {
        fatal("Usage: dosya download --zip <file...> -o out.zip", EXIT.USAGE);
    }

    const resolved = await new Resolver(client).resolveMany(args, { workspace: flags.workspace, defaultWorkspace });
    const nonFile = resolved.find(r => r.type !== "file");
    if (nonFile) fatal(`--zip takes files only; "${nonFile.name}" is a folder.`, EXIT.USAGE);
    const fileIds = resolved.map(r => r.id);

    const res = await client.request<Response>("/api/files/download-zip", {
        method: "POST",
        body: { file_ids: fileIds },
        timeout: getLongTimeout(600_000),
    });
    if (!res.ok) {
        const e = res.data as unknown as { error?: string };
        throw new Error(e?.error ?? `Download failed: HTTP ${res.status}`);
    }
    const response = res.data as unknown as Response;
    if (!response.body) throw new Error("No response body");

    // Stream to stdout for pipelines: dosya download --zip a b -o - | tar t
    if (flags.output === "-") {
        const reader = response.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!process.stdout.write(value)) {
                    await new Promise<void>(resolve => process.stdout.once("drain", resolve));
                }
            }
        } finally {
            reader.releaseLock();
        }
        return;
    }

    let outputPath = flags.output || "dosya-download.zip";
    if (flags.output && existsSync(flags.output) && statSync(flags.output).isDirectory()) {
        outputPath = join(flags.output, "dosya-download.zip");
    }
    if (flags.force === undefined && existsSync(outputPath)) {
        fatal(`${outputPath} already exists. Use --force to overwrite.`, EXIT.USAGE);
    }

    // Write to a temp path so an aborted transfer never clobbers a good file.
    const tmp = `${outputPath}.dosya-partial`;
    const fd = openSync(tmp, "w");
    const release = onInterrupt(() => {
        try { closeSync(fd); } catch {}
        try { unlinkSync(tmp); } catch {}
    });
    try {
        const reader = response.body.getReader();
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writeSync(fd, value, 0, value.byteLength, total);
            total += value.byteLength;
        }
        closeSync(fd);
        renameSync(tmp, outputPath);
        if (flags.json !== undefined) {
            printJson({ ok: true, path: outputPath, size: total, files: fileIds.length });
        } else {
            log(`Saved ${fileIds.length} file(s) to ${outputPath} (${formatBytes(total)}).`);
        }
    } catch (err) {
        try { closeSync(fd); } catch {}
        try { unlinkSync(tmp); } catch {}
        throw err;
    } finally {
        release();
    }
}

/** Download a whole folder tree to disk, preserving structure. */
async function downloadRecursive(
    args: string[],
    flags: Record<string, string>,
    client: DosyaClient,
    config: DosyaConfig | null,
): Promise<void> {
    const target = args[0];
    if (!target) {
        fatal("Folder required. Usage: dosya download --recursive <folder> -o ./dir/", EXIT.USAGE);
    }
    const isJson = flags.json !== undefined;

    const folder = await new Resolver(client).resolve(target, {
        workspace: flags.workspace,
        defaultWorkspace: config?.default_workspace,
        expect: "folder",
    });

    const outDir = flags.output && flags.output !== "-" ? flags.output : ".";
    const remote = new SyncRemote(client, folder.workspaceId);
    const snap = await remote.snapshot(folder.id || null);
    const files = [...buildRemotePaths(snap.files, snap.folders, folder.id || null).values()];

    if (files.length === 0) {
        if (isJson) printJson({ ok: true, downloaded: 0 });
        else log("No files to download.");
        return;
    }

    let downloaded = 0;
    const failures: { file: string; error: string }[] = [];
    const CHUNK = 500; // download-manifest caps at 500 ids per request

    for (let i = 0; i < files.length; i += CHUNK) {
        const batch = files.slice(i, i + CHUNK);
        const urls = await remote.downloadUrls(batch.map(f => f.id));
        const byId = new Map(urls.map(u => [u.fileId, u]));
        for (const f of batch) {
            try {
                const u = byId.get(f.id);
                if (!u) throw new Error("no download url returned");
                const full = join(outDir, f.relPath);
                mkdirSync(dirname(full), { recursive: true });
                const res = await fetch(u.url, { signal: AbortSignal.timeout(getLongTimeout(600_000)) });
                // Check res.ok only — touching res.body before Bun.write(res) hangs it.
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const tmp = `${full}.dosya-partial`;
                await Bun.write(tmp, res);
                renameSync(tmp, full);
                downloaded++;
                if (!isJson && process.stderr.isTTY) process.stderr.write(`\r  ${downloaded}/${files.length} files`);
            } catch (err) {
                failures.push({ file: f.relPath, error: (err as Error).message });
            }
        }
    }
    if (!isJson && process.stderr.isTTY) process.stderr.write("\n");

    if (isJson) {
        printJson({ ok: failures.length === 0, downloaded, failures });
    } else {
        for (const fl of failures) console.error(`Failed: ${fl.file}: ${fl.error}`);
        log(`Downloaded ${downloaded} file(s) to ${outDir}/`);
    }
    if (failures.length > 0) process.exit(EXIT.ERROR);
}

export async function download(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { downloadHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const target = args[0];
    if (flags.zip === undefined && flags.recursive === undefined && !target) {
        fatal("File required. Usage: dosya download <file>", EXIT.USAGE);
    }

    const numConnections = Math.min(
        Math.max(1, parseInt(flags.connections || String(DEFAULT_CONNECTIONS), 10) || DEFAULT_CONNECTIONS),
        MAX_CONNECTIONS,
    );

    try {
        // --recursive: pull a whole folder tree, preserving structure.
        if (flags.recursive !== undefined) {
            return await downloadRecursive(args, flags, client, config);
        }

        // --zip: a single server-built zip of several files.
        if (flags.zip !== undefined) {
            return await downloadZip(args, flags, client, config?.default_workspace);
        }

        // Resolve the target (id or path) to a concrete file id.
        const resolved = await new Resolver(client).resolve(target, {
            workspace: flags.workspace,
            defaultWorkspace: config?.default_workspace,
        });
        if (resolved.type !== "file") {
            fatal("download targets a file. Use --zip for many files, or 'dosya tree' to browse.", EXIT.USAGE);
        }
        const fileId = resolved.id;

        // Get file metadata
        const data = await client.get<FileMetadataResponse>(`/api/files/${encodeURIComponent(fileId)}`);
        const meta = data.file;

        // `-o -` streams to stdout for pipelines: dosya download <id> -o - | tar xz
        if (flags.output === "-") {
            const toStdout = async (): Promise<string> => {
                presignedUrl = await getPresignedUrl(client, fileId);
                return presignedUrl;
            };
            let presignedUrl = await getPresignedUrl(client, fileId);
            await downloadToStdout(presignedUrl, toStdout);
            return;
        }

        // Determine output path
        const outFlag = flags.output;
        let outputPath: string;
        if (outFlag) {
            const outStat = existsSync(outFlag) ? statSync(outFlag) : null;
            if (outStat?.isDirectory()) {
                outputPath = join(outFlag, meta.name);
            } else {
                outputPath = outFlag;
            }
        } else {
            outputPath = join(process.cwd(), meta.name);
        }

        const isJson = flags.json !== undefined;
        const isForce = flags.force !== undefined;
        const verify = flags["no-verify"] === undefined;
        let originEtag: string | null = null;
        const totalSize = meta.size_bytes;

        // Check for existing download state (resume)
        let state = loadState(outputPath);
        let resuming = false;
        if (state && state.fileId === fileId && state.totalSize === totalSize && existsSync(outputPath)) {
            const completedBytes = state.segments.reduce((sum, s) => sum + s.bytesWritten, 0);
            if (completedBytes > 0 && completedBytes < totalSize) {
                resuming = true;
                if (!isJson) log(`Resuming download: ${formatBytes(completedBytes)}/${formatBytes(totalSize)} already downloaded`);
            } else {
                state = null;
            }
        } else {
            state = null;
        }

        if (!resuming) {
            await confirmOverwrite(outputPath, isForce, isJson);
            // A stale sidecar from an unrelated attempt would confuse the next run
            removeState(outputPath);
        }

        if (!isJson && !resuming) log(`File: ${meta.name} (${formatBytes(totalSize)})`);

        // Get presigned URL (does NOT download the file — captures redirect)
        if (!isJson) process.stderr.write("Connecting...\r");
        let presignedUrl = await getPresignedUrl(client, fileId);
        debug(`Presigned URL obtained`);

        const refreshUrl = async (): Promise<string> => {
            presignedUrl = await getPresignedUrl(client, fileId);
            return presignedUrl;
        };
        const makeBar = () => (isJson ? null : new ProgressBar(meta.name, totalSize));

        const useParallel = totalSize >= MIN_SEGMENT_SIZE * 2 && numConnections > 1;

        if (!useParallel) {
            // Small file — single connection, no Range needed
            debug("Single connection download");
            const etag = await downloadSingleWithRefresh(presignedUrl, outputPath, makeBar, refreshUrl);
            await finishDownload(outputPath, meta, isJson, 1, etag, verify);
            return;
        }

        // Parallel download path
        // Check Range support with a tiny probe if not resuming
        if (!resuming) {
            const probe = await probeRangeSupport(presignedUrl, refreshUrl);
            presignedUrl = probe.url;
            originEtag = probe.etag;

            if (!probe.supported) {
                debug("Server does not support Range requests, falling back to single connection");
                // The probe consumed part of the object; start from a fresh URL
                const etag = await downloadSingleWithRefresh(await refreshUrl(), outputPath, makeBar, refreshUrl);
                await finishDownload(outputPath, meta, isJson, 1, etag, verify);
                return;
            }
        }

        // Build or reuse segments
        const effectiveConns = Math.min(
            numConnections,
            Math.max(1, Math.floor(totalSize / MIN_SEGMENT_SIZE)),
        );

        if (!state) {
            const segmentSize = Math.ceil(totalSize / effectiveConns);
            const segments: SegmentState[] = [];
            for (let i = 0; i < effectiveConns; i++) {
                const start = i * segmentSize;
                const end = Math.min(start + segmentSize - 1, totalSize - 1);
                segments.push({ index: i, start, end, bytesWritten: 0, done: false });
            }
            state = { fileId, totalSize, outputPath, connections: effectiveConns, segments };
        }

        const activeState = state;
        const pendingSegments = activeState.segments.filter(s => !s.done);
        const alreadyDownloaded = activeState.segments.reduce((sum, s) => sum + s.bytesWritten, 0);

        debug(`Parallel download: ${pendingSegments.length} segments pending, ${activeState.segments.length} total, ${formatBytes(Math.ceil(totalSize / activeState.segments.length))}/segment`);

        const bar = isJson ? null : new ProgressBar(meta.name, totalSize);
        // Account for already downloaded bytes in progress bar
        if (bar && alreadyDownloaded > 0) bar.update(alreadyDownloaded);

        // Pre-allocate file
        const fd = openSync(outputPath, resuming ? "r+" : "w");
        if (!resuming) ftruncateSync(fd, totalSize);

        // Save initial state
        saveState(outputPath, activeState);

        // On Ctrl+C, flush progress so the next run can actually resume
        const releaseCleanup = onInterrupt(() => {
            bar?.clear();
            saveState(outputPath, activeState);
            try { closeSync(fd); } catch {}
        });

        const downloadStart = Date.now();

        try {
            await runSegmentedDownload({
                segments: activeState.segments,
                runSegment: (seg, signal) =>
                    downloadSegment(presignedUrl, seg, fd, bar, activeState, outputPath, signal),
                refreshUrl: async () => { presignedUrl = await getPresignedUrl(client, fileId); },
                onCheckpoint: () => saveState(outputPath, activeState),
            });
        } finally {
            releaseCleanup();
            closeSync(fd);
        }

        if (bar) bar.finish();

        const elapsed = (Date.now() - downloadStart) / 1000;
        debug(`All segments complete. Total: ${formatBytes(totalSize)} in ${elapsed.toFixed(1)}s (${formatBytes(totalSize / elapsed)}/s)`);

        await finishDownload(outputPath, meta, isJson, effectiveConns, originEtag, verify);
    } catch (err) {
        fatalError(err);
    }
}

async function finishDownload(
    outputPath: string,
    meta: { name: string; size_bytes: number },
    isJson: boolean,
    connections: number,
    etag: string | null,
    verify: boolean,
): Promise<void> {
    const written = statSync(outputPath).size;
    debug(`File verified: ${written} bytes written`);

    if (written !== meta.size_bytes) {
        // A short file is a failed download, not a warning. Keep the resume
        // sidecar — telling the user to re-run only helps if the state that
        // makes resuming possible is still on disk.
        fatal(
            `Incomplete download: expected ${formatBytes(meta.size_bytes)} but wrote ${formatBytes(written)}. ` +
            `Re-run to resume.`,
        );
    }

    if (verify) {
        await verifyIntegrity(outputPath, meta.size_bytes, etag);
    } else {
        debug("Content verification disabled via --no-verify");
    }

    // Only now is the download provably complete
    removeState(outputPath);

    if (isJson) {
        printJson({ ok: true, file: meta.name, path: outputPath, size: written });
        return;
    }

    log(`Saved to ${outputPath}`);
    const conns = connections > 1 ? ` (${connections} connections)` : "";
    log(`Done. ${formatBytes(written)} written${conns}.`);
}
