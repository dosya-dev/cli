import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    uploadMultipart, loadUploadSession, saveUploadSession, removeUploadSession, makeSidecar,
    type ResumableInfo,
} from "../../src/multipart";

let dir: string;
let filePath: string;
const SIZE = 25;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dosya-mp-"));
    filePath = join(dir, "payload.bin");
    writeFileSync(filePath, "a".repeat(SIZE));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const resumable = (): ResumableInfo => ({
    part_size: 10,
    total_parts: 3,
    part_upload_url: "/api/upload/upl_1/part",
    complete_url: "/api/upload/upl_1/complete",
    status_url: "/api/upload/upl_1/status",
});

/** Minimal stand-in for DosyaClient that records the parts it was asked to send. */
function fakeClient(opts: { uploadedParts?: number[]; etagFor?: (n: number) => string } = {}) {
    const sentParts: number[] = [];
    const seenHeaders: Record<string, string>[] = [];
    let completed = false;

    const client = {
        async get(path: string) {
            if (path.endsWith("/status")) {
                return {
                    ok: true, status: "uploading", size_bytes: SIZE,
                    part_size: 10, total_parts: 3,
                    bytes_uploaded: (opts.uploadedParts?.length ?? 0) * 10,
                    uploaded_parts: opts.uploadedParts ?? [],
                    has_multipart: true,
                };
            }
            throw new Error(`unexpected GET ${path}`);
        },
        async request(path: string, init: { rawBody?: Uint8Array; headers?: Record<string, string> }) {
            seenHeaders.push(init.headers ?? {});
            // The complete call now goes through request() (so it can carry the
            // X-Dosya-Sync header), not post().
            if (path.endsWith("/complete")) {
                completed = true;
                return {
                    ok: true, status: 200, headers: new Headers(),
                    data: { ok: true, file: { id: "file_1", name: "payload.bin", size_bytes: SIZE, version: 1 } },
                };
            }
            const n = Number(path.split("/").pop());
            sentParts.push(n);
            return {
                ok: true, status: 201, headers: new Headers(),
                data: { ok: true, part_number: n, etag: opts.etagFor?.(n) ?? `opaque-token-${n}` },
            };
        },
    };

    return { client, sentParts, seenHeaders, isCompleted: () => completed };
}

describe("uploadMultipart", () => {
    it("uploads every part when nothing is stored yet", async () => {
        const { client, sentParts, isCompleted } = fakeClient();

        const file = await uploadMultipart({
            client: client as never, filePath, size: SIZE, sessionId: "upl_1",
            resumable: resumable(), concurrency: 3, bar: null,
        });

        expect(sentParts.sort((a, b) => a - b)).toEqual([1, 2, 3]);
        expect(isCompleted()).toBe(true);
        expect(file.id).toBe("file_1");
    });

    it("resumes by sending only the missing parts", async () => {
        const { client, sentParts } = fakeClient({ uploadedParts: [1, 2] });

        await uploadMultipart({
            client: client as never, filePath, size: SIZE, sessionId: "upl_1",
            resumable: resumable(), concurrency: 3, bar: null,
        });

        // The whole point: an interrupted upload must not restart from zero
        expect(sentParts).toEqual([3]);
    });

    it("sends part 1 first so only one R2 multipart upload is created", async () => {
        const { client, sentParts } = fakeClient();

        await uploadMultipart({
            client: client as never, filePath, size: SIZE, sessionId: "upl_1",
            resumable: resumable(), concurrency: 3, bar: null,
        });

        expect(sentParts[0]).toBe(1);
    });

    it("fails when a part's MD5 etag does not match the bytes sent", async () => {
        const { client } = fakeClient({ etagFor: () => "0".repeat(32) });

        await expect(uploadMultipart({
            client: client as never, filePath, size: SIZE, sessionId: "upl_1",
            resumable: resumable(), concurrency: 1, bar: null,
        })).rejects.toThrow(/Integrity check failed/);
    });

    it("accepts an opaque etag without raising a false alarm", async () => {
        // R2's Workers binding returns an opaque token, not the part MD5
        const { client, isCompleted } = fakeClient({ etagFor: n => `i-opaque-token-${n}` });

        await uploadMultipart({
            client: client as never, filePath, size: SIZE, sessionId: "upl_1",
            resumable: resumable(), concurrency: 2, bar: null,
        });

        expect(isCompleted()).toBe(true);
    });

    it("threads caller headers onto every part + the complete call", async () => {
        const { client, seenHeaders } = fakeClient();

        await uploadMultipart({
            client: client as never, filePath, size: SIZE, sessionId: "upl_1",
            resumable: resumable(), concurrency: 3, bar: null,
            headers: { "X-Dosya-Sync": "1" },
        });

        // 3 parts + 1 complete, all carry the sync header (so the upload event
        // is suppressed just like the batch path).
        expect(seenHeaders).toHaveLength(4);
        expect(seenHeaders.every(h => h["X-Dosya-Sync"] === "1")).toBe(true);
    });
});

describe("upload session sidecar", () => {
    it("round-trips a session", () => {
        saveUploadSession(filePath, makeSidecar(filePath, "upl_9", SIZE, resumable()));
        const loaded = loadUploadSession(filePath, SIZE);
        expect(loaded?.session_id).toBe("upl_9");
    });

    it("rejects a sidecar when the file size changed", () => {
        saveUploadSession(filePath, makeSidecar(filePath, "upl_9", SIZE, resumable()));
        expect(loadUploadSession(filePath, SIZE + 1)).toBeNull();
    });

    it("rejects a sidecar when the file was modified", () => {
        saveUploadSession(filePath, makeSidecar(filePath, "upl_9", SIZE, resumable()));
        // Resuming against edited content would assemble a corrupt object
        const future = new Date(Date.now() + 60_000);
        utimesSync(filePath, future, future);
        expect(loadUploadSession(filePath, SIZE)).toBeNull();
    });

    it("returns null once removed", () => {
        saveUploadSession(filePath, makeSidecar(filePath, "upl_9", SIZE, resumable()));
        removeUploadSession(filePath);
        expect(loadUploadSession(filePath, SIZE)).toBeNull();
    });
});
