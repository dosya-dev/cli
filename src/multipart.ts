import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, statSync } from "fs";
import type { DosyaClient } from "./client";
import type { ProgressBar } from "./progress";
import { debug } from "./output";

/**
 * Resumable multipart upload.
 *
 * A single streamed PUT cannot be retried - a ReadableStream is consumed once -
 * so a large upload that failed at 90% used to restart from zero. The API
 * exposes a part-based protocol where every part is idempotent, which makes
 * both per-part retry and resume-across-runs possible.
 */

export interface ResumableInfo {
    part_size: number;
    total_parts: number;
    part_upload_url: string;
    complete_url: string;
    status_url: string;
}

export interface UploadedFile {
    id: string;
    name: string;
    size_bytes: number;
    version: number;
    /** Server row timestamp (== the row's updated_at); absent on older servers. */
    created_at?: number;
}

interface StatusResponse {
    ok: boolean;
    status: string;
    size_bytes: number;
    part_size: number | null;
    total_parts: number | null;
    bytes_uploaded: number;
    uploaded_parts: number[];
    has_multipart: boolean;
}

interface PartResponse {
    ok: boolean;
    part_number: number;
    etag: string;
    already_uploaded?: boolean;
}

interface CompleteResponse {
    ok: boolean;
    file: UploadedFile;
}

/** Sidecar recording an in-progress session so a later run can resume it. */
interface UploadSidecar {
    session_id: string;
    file_size: number;
    mtime_ms: number;
    resumable: ResumableInfo;
}

function sidecarPath(filePath: string): string {
    return `${filePath}.dosya-upload`;
}

/**
 * Load a resumable session for this exact file.
 *
 * Size and mtime must both match - resuming against edited content would
 * assemble a corrupt object from parts of two different files.
 */
export function loadUploadSession(filePath: string, size: number): UploadSidecar | null {
    const p = sidecarPath(filePath);
    if (!existsSync(p)) return null;

    try {
        const sidecar = JSON.parse(readFileSync(p, "utf8")) as UploadSidecar;
        const stat = statSync(filePath);
        if (sidecar.file_size !== size || sidecar.mtime_ms !== Math.floor(stat.mtimeMs)) {
            debug(`Ignoring stale upload sidecar for ${filePath} (file changed)`);
            removeUploadSession(filePath);
            return null;
        }
        return sidecar;
    } catch {
        return null;
    }
}

export function saveUploadSession(filePath: string, sidecar: UploadSidecar): void {
    const tmp = `${sidecarPath(filePath)}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(sidecar));
        renameSync(tmp, sidecarPath(filePath));
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        debug(`Could not persist upload session: ${(err as Error).message}`);
    }
}

export function removeUploadSession(filePath: string): void {
    try { unlinkSync(sidecarPath(filePath)); } catch {}
}

export function makeSidecar(filePath: string, sessionId: string, size: number, resumable: ResumableInfo): UploadSidecar {
    return {
        session_id: sessionId,
        file_size: size,
        mtime_ms: Math.floor(statSync(filePath).mtimeMs),
        resumable,
    };
}

/** R2 returns part etags quoted; normalize for comparison. */
function normalizeEtag(etag: string): string {
    return etag.replace(/^"|"$/g, "").toLowerCase();
}

/**
 * Bound concurrent part uploads.
 *
 * Each in-flight part holds its whole slice in memory, so this also caps peak
 * memory at roughly `limit * part_size`.
 */
class PartLimiter {
    private available: number;
    private queue: (() => void)[] = [];

    constructor(limit: number) {
        if (!Number.isInteger(limit) || limit < 1) {
            throw new RangeError(`Part concurrency must be a positive integer, got ${limit}`);
        }
        this.available = limit;
    }

    async acquire(): Promise<void> {
        if (this.available > 0) { this.available--; return; }
        await new Promise<void>(resolve => this.queue.push(resolve));
    }

    release(): void {
        const next = this.queue.shift();
        if (next) next();
        else this.available++;
    }
}

export interface MultipartOptions {
    client: DosyaClient;
    filePath: string;
    size: number;
    sessionId: string;
    resumable: ResumableInfo;
    /** Max parts in flight. Peak memory is roughly this times part_size. */
    concurrency: number;
    bar: ProgressBar | null;
    /** Verify each part against the etag R2 returns (default true). */
    verify?: boolean;
    /**
     * Extra headers for the API-side calls (parts + complete). The sync engine
     * passes `X-Dosya-Sync: 1` so a large sync upload's `file_uploaded` event is
     * suppressed like the batch path - otherwise every big file spams activity.
     */
    headers?: Record<string, string>;
}

/**
 * Upload every part not already stored, then finalize the object.
 *
 * Parts already present server-side are skipped, so this doubles as the resume
 * path: an interrupted upload re-runs and only transfers what is missing.
 */
export async function uploadMultipart(opts: MultipartOptions): Promise<UploadedFile> {
    const { client, filePath, size, resumable, bar } = opts;
    const partSize = resumable.part_size;
    const totalParts = resumable.total_parts;
    const verify = opts.verify !== false;

    // Ask the server which parts it already has
    let uploaded = new Set<number>();
    try {
        const status = await client.get<StatusResponse>(resumable.status_url);
        uploaded = new Set(status.uploaded_parts ?? []);
        if (uploaded.size > 0) {
            debug(`Resuming upload: ${uploaded.size}/${totalParts} parts already stored`);
            if (bar) bar.update(Math.min(status.bytes_uploaded, size));
        }
    } catch (err) {
        // A missing/expired session just means we start from part 1
        debug(`Could not read upload status: ${(err as Error).message}`);
    }

    const missing: number[] = [];
    for (let n = 1; n <= totalParts; n++) {
        if (!uploaded.has(n)) missing.push(n);
    }

    const limiter = new PartLimiter(opts.concurrency);
    const file = Bun.file(filePath);
    let firstError: Error | null = null;

    async function sendPart(partNumber: number): Promise<void> {
        await limiter.acquire();
        try {
            if (firstError) return; // another part already failed; stop early

            const start = (partNumber - 1) * partSize;
            const end = Math.min(start + partSize, size);
            const data = new Uint8Array(await file.slice(start, end).arrayBuffer());

            // A Uint8Array body is replayable, so the client's 5xx/429 retries
            // apply here - unlike the single streamed PUT.
            const res = await client.request<PartResponse>(`${resumable.part_upload_url}/${partNumber}`, {
                method: "PUT",
                rawBody: data,
                headers: { "Content-Length": String(data.byteLength), ...opts.headers },
            });

            if (!res.ok) {
                const err = res.data as unknown as { error?: string };
                throw new Error(err?.error ?? `Part ${partNumber} failed: HTTP ${res.status}`);
            }

            if (verify && res.data.etag && !res.data.already_uploaded) {
                // S3-style multipart returns the part's MD5 as its ETag, but
                // R2's Workers binding returns an opaque token instead. Verify
                // only when the value is actually an MD5, so this never raises
                // a false alarm against a backend that uses another format.
                const remote = normalizeEtag(res.data.etag);
                if (/^[0-9a-f]{32}$/.test(remote)) {
                    const local = new Bun.CryptoHasher("md5").update(data).digest("hex");
                    if (remote !== local) {
                        throw new Error(
                            `Integrity check failed on part ${partNumber}: server stored ${remote}, expected ${local}`,
                        );
                    }
                    debug(`Part ${partNumber} verified (md5 ${local})`);
                } else {
                    debug(`Part ${partNumber} etag is opaque - skipping per-part verification`);
                }
            }

            if (bar) bar.update(data.byteLength);
            debug(`Part ${partNumber}/${totalParts} stored${res.data.already_uploaded ? " (already present)" : ""}`);
        } catch (err) {
            firstError ??= err as Error;
        } finally {
            limiter.release();
        }
    }

    // The first part is what creates the R2 multipart upload and fixes the
    // object key. Racing several parts into that would have them each create a
    // separate MPU, so establish it with one part before fanning out.
    if (missing.length > 0) {
        const [first, ...rest] = missing;
        await sendPart(first);
        if (firstError) throw firstError;
        await Promise.all(rest.map(sendPart));
    }
    if (firstError) throw firstError;

    const completeRes = await client.request<CompleteResponse>(resumable.complete_url, {
        method: "POST",
        headers: opts.headers,
    });
    if (!completeRes.ok) {
        const err = completeRes.data as unknown as { error?: string };
        throw new Error(err?.error ?? `Completing upload failed: HTTP ${completeRes.status}`);
    }
    return completeRes.data.file;
}
