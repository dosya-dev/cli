import { join } from "path";
import { existsSync, statSync, openSync, writeSync, closeSync, ftruncateSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "fs";
import { formatBytes } from "@dosya-dev/shared";
import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { ProgressBar } from "../progress";
import { printJson, fatal, log, debug, EXIT } from "../output";

const HELP = `Download a file from dosya.dev.

Usage: dosya download <file_id> [flags]

Flags:
  --output, -o <path>       Output path (default: current directory)
  --connections, -c <num>   Parallel connections (default: 8, max: 16)
  --key, -k <key>           API key override
  --json, -j                Output as JSON

Examples:
  dosya download fil_abc123
  dosya download fil_abc123 --output ./downloads/
  dosya download fil_abc123 -c 16`;

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

class UrlExpiredError extends Error {
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
    const tmp = sidecarPath(outputPath) + ".tmp";
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, sidecarPath(outputPath));
}

function removeState(outputPath: string): void {
    try { unlinkSync(sidecarPath(outputPath)); } catch {}
}

async function getPresignedUrl(client: DosyaClient, fileId: string): Promise<string> {
    // Use redirect: "manual" to capture the presigned URL without downloading the file
    const res = await client.request<Response>(`/api/files/${encodeURIComponent(fileId)}/download`, {
        redirect: "manual",
        timeout: 30_000,
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
                signal: cancelSignal ?? AbortSignal.timeout(SEGMENT_TIMEOUT),
            });

            if (res.status === 403) {
                throw new UrlExpiredError();
            }

            if (res.status === 200) {
                throw new Error("Server does not support Range requests");
            }

            if (res.status !== 206) {
                throw new Error(`HTTP ${res.status}`);
            }

            if (!res.body) throw new Error("No response body");

            const reader = res.body.getReader();
            let offset = rangeStart;

            while (true) {
                if (cancelSignal?.aborted) { await reader.cancel(); return; }
                const { done, value } = await reader.read();
                if (done) break;
                writeSync(fd, value, 0, value.byteLength, offset);
                offset += value.byteLength;
                seg.bytesWritten += value.byteLength;
                if (bar) bar.update(value.byteLength);
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

async function downloadSingle(
    url: string,
    outputPath: string,
    totalSize: number,
    bar: ProgressBar | null,
): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const fd = openSync(outputPath, "w");
    let offset = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writeSync(fd, value, 0, value.byteLength, offset);
            offset += value.byteLength;
            if (bar) bar.update(value.byteLength);
        }
    } finally {
        closeSync(fd);
    }
}

export async function download(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { downloadHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key ?? flags.k);
    const client = new DosyaClient(apiBase, apiKey);

    const fileId = args[0];
    if (!fileId) {
        fatal("File ID required. Usage: dosya download <file_id>", EXIT.USAGE);
    }

    const numConnections = Math.min(
        Math.max(1, parseInt(flags.connections ?? flags.c ?? String(DEFAULT_CONNECTIONS), 10) || DEFAULT_CONNECTIONS),
        MAX_CONNECTIONS,
    );

    try {
        // Get file metadata
        const data = await client.get<FileMetadataResponse>(`/api/files/${encodeURIComponent(fileId)}`);
        const meta = data.file;

        // Determine output path
        const outFlag = flags.output ?? flags.o;
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
        const totalSize = meta.size_bytes;

        // Check for existing download state (resume)
        let state = loadState(outputPath);
        let resuming = false;
        if (state && state.fileId === fileId && state.totalSize === totalSize) {
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

        if (!isJson && !resuming) log(`File: ${meta.name} (${formatBytes(totalSize)})`);

        // Get presigned URL (does NOT download the file — captures redirect)
        if (!isJson) process.stderr.write("Connecting...\r");
        let presignedUrl = await getPresignedUrl(client, fileId);
        debug(`Presigned URL obtained`);

        const useParallel = totalSize >= MIN_SEGMENT_SIZE * 2 && numConnections > 1;

        if (!useParallel) {
            // Small file — single connection, no Range needed
            debug("Single connection download");
            const bar = isJson ? null : new ProgressBar(meta.name, totalSize);
            await downloadSingle(presignedUrl, outputPath, totalSize, bar);
            if (bar) bar.finish();
            finishDownload(outputPath, meta, totalSize, isJson, 1);
            return;
        }

        // Parallel download path
        // Check Range support with a tiny probe if not resuming
        if (!resuming) {
            const probe = await fetch(presignedUrl, {
                headers: { Range: "bytes=0-0" },
                signal: AbortSignal.timeout(10_000),
            });
            // Discard probe body immediately
            await probe.body?.cancel();

            if (probe.status !== 206) {
                debug("Server does not support Range requests, falling back to single connection");
                // Need a fresh URL since probe may have consumed something
                presignedUrl = await getPresignedUrl(client, fileId);
                const bar = isJson ? null : new ProgressBar(meta.name, totalSize);
                await downloadSingle(presignedUrl, outputPath, totalSize, bar);
                if (bar) bar.finish();
                finishDownload(outputPath, meta, totalSize, isJson, 1);
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

        const pendingSegments = state.segments.filter(s => !s.done);
        const alreadyDownloaded = state.segments.reduce((sum, s) => sum + s.bytesWritten, 0);

        debug(`Parallel download: ${pendingSegments.length} segments pending, ${state.segments.length} total, ${formatBytes(Math.ceil(totalSize / state.segments.length))}/segment`);

        const bar = isJson ? null : new ProgressBar(meta.name, totalSize);
        // Account for already downloaded bytes in progress bar
        if (bar && alreadyDownloaded > 0) bar.update(alreadyDownloaded);

        // Pre-allocate file
        const fd = openSync(outputPath, resuming ? "r+" : "w");
        if (!resuming) ftruncateSync(fd, totalSize);

        // Save initial state
        saveState(outputPath, state);

        const downloadStart = Date.now();

        try {
            // Download pending segments in parallel, with URL refresh on expiry
            let urlRefreshAttempts = 0;
            let remainingSegments = [...pendingSegments];

            while (remainingSegments.length > 0 && urlRefreshAttempts < 3) {
                const ac = new AbortController();
                try {
                    await Promise.all(
                        remainingSegments.map(seg =>
                            downloadSegment(presignedUrl, seg, fd, bar, state, outputPath, ac.signal)
                        ),
                    );
                    remainingSegments = state!.segments.filter(s => !s.done);
                } catch (err) {
                    ac.abort(); // cancel other in-flight segments
                    if (err instanceof UrlExpiredError) {
                        urlRefreshAttempts++;
                        debug(`Presigned URL expired, refreshing (attempt ${urlRefreshAttempts}/3)`);
                        saveState(outputPath, state!);
                        presignedUrl = await getPresignedUrl(client, fileId);
                        remainingSegments = state!.segments.filter(s => !s.done);
                        continue;
                    }
                    throw err;
                }
            }

            if (state!.segments.some(s => !s.done)) {
                throw new Error("Download incomplete after URL refresh attempts");
            }
        } finally {
            closeSync(fd);
        }

        if (bar) bar.finish();

        const elapsed = (Date.now() - downloadStart) / 1000;
        debug(`All segments complete. Total: ${formatBytes(totalSize)} in ${elapsed.toFixed(1)}s (${formatBytes(totalSize / elapsed)}/s)`);

        removeState(outputPath);
        finishDownload(outputPath, meta, totalSize, isJson, effectiveConns);
    } catch (err) {
        fatal((err as Error).message);
    }
}

function finishDownload(
    outputPath: string,
    meta: { name: string; size_bytes: number },
    totalSize: number,
    isJson: boolean,
    connections: number,
): void {
    const written = statSync(outputPath).size;
    debug(`File verified: ${written} bytes written`);

    if (isJson) {
        printJson({ ok: true, file: meta.name, path: outputPath, size: written });
    } else {
        log(`Saved to ${outputPath}`);
        if (written !== meta.size_bytes) {
            log(`Warning: expected ${formatBytes(meta.size_bytes)} but wrote ${formatBytes(written)}`);
        }
        const conns = connections > 1 ? ` (${connections} connections)` : "";
        log(`Done. ${formatBytes(written)} written${conns}.`);
    }
    process.exit(0);
}
