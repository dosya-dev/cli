import { basename } from "path";
import type { DosyaClient } from "./client";
import type { FileProgress, ProgressFactory } from "./progress";
import { debug } from "./output";

/**
 * Many small files in one request, via `POST /api/upload/batch`.
 *
 * ── Why this exists ──
 *
 * The single-file door costs two requests - `POST /api/upload/init` then `PUT
 * /api/upload/:id` - and those two requests cost roughly fourteen sequential
 * D1 statements between them. D1's primary is one SQLite database in one
 * region, every statement on a write request is pinned to it, and the API
 * Worker runs at the caller's edge, so each of those statements is a full
 * intercontinental round trip for anybody not sitting next to the primary.
 *
 * Measured against production from a French VPS on 2026-09-03, mid-run, with
 * `wrangler tail`: `init` averaged 1346 ms of wall time for 6.1 ms of CPU,
 * `PUT` averaged 3975 ms for 19.5 ms. 5.3 seconds per file, 99.5% of it spent
 * waiting. A 2419-file, 173 MB upload was on course for 34 minutes at 77 KB/s
 * - a rate set entirely by the file COUNT, since a 20 KB file and a 5 MB file
 * cost the same 5.3 seconds.
 *
 * The batch door collapses up to 200 files into one request and one D1 batch,
 * which is the difference between ~14 round trips per file and ~14 per 200.
 *
 * ── Why the bytes still go through the Worker ──
 *
 * `sync` gets its speed a different way: `/api/sync/manifest` hands back
 * presigned URLs and the bytes go straight to R2, bypassing the Worker
 * entirely. That path is faster still, and it is deliberately NOT what this
 * uses, because it is also a weaker door: it does not adopt a same-name file
 * as a new version (it would create a second file with the same name), and
 * neither it nor `/api/sync/commit` applies the destination folder's lock, the
 * hidden-folder gate, or the workspace's extension policy. `upload` has always
 * had all four. Trading them for throughput would be a silent change to what
 * `dosya upload` means, so this takes the door that keeps them.
 *
 * The manifest carries no region: the server stamps every uploaded file with
 * its workspace's own location, so there is nothing for the client to pick
 * and nothing for it to get wrong.
 */

/** Server's `MAX_FILES_PER_BATCH`. */
export const BATCH_MAX_FILES = 200;
/** Server's `MAX_FILE_SIZE`. A file over this must use the single-file path. */
export const BATCH_FILE_MAX = 5 * 1024 * 1024;
/**
 * Bytes of file content per request.
 *
 * The server refuses a batch whose summed blob sizes pass 100 MB, counting
 * content only - multipart framing and the manifest are not included in its
 * total. This sits below that anyway: the ceiling is not the target. A batch is
 * one atomic unit of progress and one unit of retry, so an oversized one makes
 * the progress bar sit still and turns a single transport blip into a large
 * amount of re-sent data.
 */
export const BATCH_TOTAL_MAX = 48 * 1024 * 1024;

export interface BatchFile {
    /** Absolute local path. */
    path: string;
    /** Name to store it under. */
    name: string;
    /** Destination folder, or null for the workspace root. */
    folderId: string | null;
    size: number;
}

export interface BatchOutcome {
    file: BatchFile;
    ok: boolean;
    fileId?: string;
    /**
     * The version this landed on. Not always 1: the route adopts a file whose
     * (folder, name) is already taken as a NEW VERSION of it rather than
     * creating a duplicate, exactly as the single-file door does.
     */
    version?: number;
    error?: string;
}

/**
 * Split files into requests that respect both server ceilings.
 *
 * Greedy and order-preserving, so files from the same directory stay together
 * and the progress line reads like a walk of the tree rather than a shuffle.
 * A file at or over `BATCH_TOTAL_MAX` would produce an empty batch followed by
 * an infinite loop, so a batch always takes at least one file - callers are
 * expected to have filtered to `<= BATCH_FILE_MAX` already, and this is the
 * belt to that's braces.
 */
export function planBatches(
    files: BatchFile[],
    maxFiles = BATCH_MAX_FILES,
    maxBytes = BATCH_TOTAL_MAX,
): BatchFile[][] {
    const batches: BatchFile[][] = [];
    let current: BatchFile[] = [];
    let bytes = 0;

    for (const f of files) {
        const wouldOverflow = current.length >= maxFiles || (current.length > 0 && bytes + f.size > maxBytes);
        if (wouldOverflow) {
            batches.push(current);
            current = [];
            bytes = 0;
        }
        current.push(f);
        bytes += f.size;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/** One `Content-Disposition` part, prebuilt so the encoder stays readable. */
interface Part {
    header: string;
    /** Absent for the manifest part, which is inline text. */
    file?: BatchFile;
    /** Only for the manifest part. */
    text?: string;
    /** The progress ticket to feed while this part's bytes are on the wire. */
    ticket?: FileProgress;
}

const CRLF = "\r\n";

/**
 * A filename for the Content-Disposition line.
 *
 * The server reads the real name out of the manifest and never looks at this
 * one - but it MUST be present, because `formData.get(field)` returns a plain
 * string rather than a Blob for a part with no filename, and the route refuses
 * anything that is not a Blob with "Missing file data". So this is the field
 * name, which is `f<index>` and therefore already safe: deriving it from the
 * user's filename would mean escaping quotes, CR and LF correctly in a header
 * whose only reader ignores it.
 */
function partFilename(field: string): string {
    return field;
}

function encodeMultipart(
    boundary: string,
    parts: Part[],
): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (i >= parts.length) {
                controller.enqueue(enc.encode(`--${boundary}--${CRLF}`));
                controller.close();
                return;
            }

            const part = parts[i++];
            controller.enqueue(enc.encode(part.header));

            if (part.text !== undefined) {
                controller.enqueue(enc.encode(part.text));
            } else if (part.file) {
                // Streamed rather than read whole: a 48 MB batch must not
                // become 48 MB of resident memory on a small VPS, and with
                // several batches in flight it would be that many times over.
                const reader = Bun.file(part.file.path).stream().getReader();
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        controller.enqueue(value);
                        part.ticket?.update(value.byteLength);
                    }
                } finally {
                    reader.releaseLock();
                }
            }

            controller.enqueue(enc.encode(CRLF));
        },
    });
}

interface BatchResponse {
    ok: boolean;
    results?: { field: string; ok: boolean; fileId?: string; name?: string; version?: number; error?: string }[];
}

/**
 * Send one batch. Resolves with an outcome per input file, in input order.
 *
 * Never throws for a per-file refusal - the route answers those individually
 * and the caller reports them individually. A transport failure or a whole-
 * request refusal (a bad workspace, no permission, a body the route would not
 * parse) does throw, because that is not one file's problem.
 */
export async function uploadBatch(
    client: DosyaClient,
    workspaceId: string,
    files: BatchFile[],
    progressFor: ProgressFactory | null,
    timeoutMs: number,
): Promise<BatchOutcome[]> {
    const boundary = `----dosya${crypto.randomUUID().replace(/-/g, "")}`;

    const tickets = new Map<string, FileProgress>();
    const parts: Part[] = [];

    const manifest = {
        workspace_id: workspaceId,
        // No region here: the server stamps every file with the workspace's
        // own location, so the client has nothing to offer and nothing to get
        // wrong.
        files: files.map((f, idx) => ({
            name: f.name,
            folder_id: f.folderId,
            file_id: null,
            field: `f${idx}`,
        })),
    };

    parts.push({
        header: `--${boundary}${CRLF}`
            + `Content-Disposition: form-data; name="manifest"${CRLF}`
            + `Content-Type: application/json${CRLF}${CRLF}`,
        text: JSON.stringify(manifest),
    });

    files.forEach((f, idx) => {
        const field = `f${idx}`;
        const ticket = progressFor ? progressFor(f.name, f.size) : undefined;
        if (ticket) tickets.set(field, ticket);
        parts.push({
            header: `--${boundary}${CRLF}`
                + `Content-Disposition: form-data; name="${field}"; filename="${partFilename(field)}"${CRLF}`
                + `Content-Type: application/octet-stream${CRLF}${CRLF}`,
            file: f,
            ticket,
        });
    });

    let res;
    try {
        res = await client.request<BatchResponse>("/api/upload/batch", {
            method: "POST",
            rawBody: encodeMultipart(boundary, parts),
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
            timeout: timeoutMs,
        });
    } catch (err) {
        // Every ticket in this batch has to give its bytes back, or the
        // aggregate bar keeps counting a transfer that did not happen.
        for (const t of tickets.values()) t.clear();
        throw err;
    }

    if (!res.ok) {
        for (const t of tickets.values()) t.clear();
        const body = res.data as unknown as { error?: string };
        throw new Error(body?.error ?? `Batch upload failed: ${res.status}`);
    }

    const byField = new Map((res.data.results ?? []).map(r => [r.field, r]));

    return files.map((f, idx) => {
        const field = `f${idx}`;
        const r = byField.get(field);
        const ticket = tickets.get(field);

        // A field the server said nothing about is not a success. It has
        // happened - a route that refuses an entry before it reaches the
        // results loop - and defaulting to "uploaded" there would mark a file
        // synced that is not there.
        if (!r) {
            ticket?.clear();
            debug(`Batch response carried no result for ${f.name} (${field})`);
            return { file: f, ok: false, error: "The server did not report a result for this file" };
        }

        if (r.ok) {
            ticket?.finish();
            return { file: f, ok: true, fileId: r.fileId, version: r.version };
        }

        ticket?.clear();
        return { file: f, ok: false, error: r.error ?? "Upload failed" };
    });
}

/** Files small enough for the batch door, in the order given. */
export function batchable(files: { path: string; size: number }[]): boolean[] {
    return files.map(f => f.size <= BATCH_FILE_MAX);
}

/** Fallback name for a path, so callers do not each reimplement it. */
export function batchName(path: string): string {
    return basename(path);
}
