import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    planBatches, uploadBatch, BATCH_MAX_FILES, BATCH_TOTAL_MAX,
    type BatchFile,
} from "../../src/batch-upload";
import type { FileProgress } from "../../src/progress";

function file(name: string, size: number, folderId: string | null = null): BatchFile {
    return { path: `/tmp/${name}`, name, folderId, size };
}

describe("planBatches", () => {
    it("packs up to the server's file ceiling", () => {
        const files = Array.from({ length: 450 }, (_, i) => file(`f${i}.txt`, 10));
        const batches = planBatches(files);
        expect(batches.map(b => b.length)).toEqual([BATCH_MAX_FILES, BATCH_MAX_FILES, 50]);
    });

    it("splits on the byte ceiling before the file ceiling when bytes bind first", () => {
        const half = BATCH_TOTAL_MAX / 2;
        const batches = planBatches([
            file("a", half), file("b", half), file("c", half),
        ]);
        expect(batches.map(b => b.map(f => f.name))).toEqual([["a", "b"], ["c"]]);
    });

    it("preserves order, so a batch stays a contiguous walk of the tree", () => {
        const files = Array.from({ length: 5 }, (_, i) => file(`f${i}`, 10));
        expect(planBatches(files, 2).flat().map(f => f.name))
            .toEqual(["f0", "f1", "f2", "f3", "f4"]);
    });

    it("never emits an empty batch for an oversized file", () => {
        // Callers filter to <= BATCH_FILE_MAX, but an empty batch here would
        // mean an infinite loop, so the invariant is asserted rather than assumed.
        const batches = planBatches([file("huge", BATCH_TOTAL_MAX * 4), file("small", 1)]);
        expect(batches.every(b => b.length > 0)).toBe(true);
        expect(batches.flat().length).toBe(2);
    });

    it("returns nothing for no files", () => {
        expect(planBatches([])).toEqual([]);
    });
});

/** A ticket that records what the encoder and the result mapper did to it. */
function fakeTicket(log: string[], name: string): FileProgress {
    return {
        update(n: number) { log.push(`update:${name}:${n}`); },
        finish() { log.push(`finish:${name}`); },
        clear() { log.push(`clear:${name}`); },
        createTransform() { throw new Error("unused"); },
    };
}

/**
 * A DosyaClient stand-in that decodes the multipart body it is handed, so the
 * assertions are against what would actually reach the Worker rather than
 * against the encoder's own idea of itself.
 */
function fakeClient(reply: (parsed: FormData) => { ok: boolean; status: number; data: unknown }) {
    const seen: { formData?: FormData; contentType?: string } = {};
    const client = {
        async request(path: string, opts: {
            rawBody: ReadableStream; headers: Record<string, string>;
        }) {
            expect(path).toBe("/api/upload/batch");
            seen.contentType = opts.headers["Content-Type"];
            // Round-trip the hand-rolled encoding through a real parser.
            const res = new Response(opts.rawBody, { headers: { "content-type": seen.contentType! } });
            const formData = await res.formData();
            seen.formData = formData;
            const r = reply(formData);
            return { ok: r.ok, status: r.status, data: r.data, headers: new Headers() };
        },
    };
    return { client: client as never, seen };
}

describe("uploadBatch multipart encoding", () => {
    const dir = mkdtempSync(join(tmpdir(), "dosya-batch-"));

    it("produces a body the server's formData() parser accepts, with the manifest and every file", async () => {
        const a = join(dir, "a.txt"); writeFileSync(a, "hello");
        const b = join(dir, "b.bin"); writeFileSync(b, "world!!");

        const files: BatchFile[] = [
            { path: a, name: "a.txt", folderId: "fld_1", size: 5 },
            { path: b, name: "b.bin", folderId: null, size: 7 },
        ];

        const { client, seen } = fakeClient(() => ({
            ok: true, status: 200,
            data: { ok: true, results: [
                { field: "f0", ok: true, fileId: "file_a", name: "a.txt", version: 1 },
                { field: "f1", ok: true, fileId: "file_b", name: "b.bin", version: 3 },
            ] },
        }));

        const outcomes = await uploadBatch(client, "ws_1", files, null, 1000);

        const fd = seen.formData!;
        expect(seen.contentType).toContain("multipart/form-data; boundary=");

        const manifest = JSON.parse(fd.get("manifest") as string);
        expect(manifest.workspace_id).toBe("ws_1");
        expect(manifest.files).toEqual([
            { name: "a.txt", folder_id: "fld_1", file_id: null, field: "f0" },
            { name: "b.bin", folder_id: null, file_id: null, field: "f1" },
        ]);
        // The server stamps every file with the workspace's location; the
        // client no longer offers one.
        expect(Object.keys(manifest)).not.toContain("region");

        // The parts must arrive as Blobs. Without a `filename=` on the
        // Content-Disposition line they parse as plain strings and the route
        // answers "Missing file data" for every one of them.
        const f0 = fd.get("f0");
        const f1 = fd.get("f1");
        expect(f0).toBeInstanceOf(Blob);
        expect(f1).toBeInstanceOf(Blob);
        expect(await (f0 as Blob).text()).toBe("hello");
        expect(await (f1 as Blob).text()).toBe("world!!");

        expect(outcomes.map(o => [o.file.name, o.ok, o.fileId, o.version]))
            .toEqual([["a.txt", true, "file_a", 1], ["b.bin", true, "file_b", 3]]);
    });

    it("feeds each file's bytes to its own progress ticket, then finishes it", async () => {
        const a = join(dir, "p.txt"); writeFileSync(a, "1234567890");
        const log: string[] = [];

        const { client } = fakeClient(() => ({
            ok: true, status: 200,
            data: { ok: true, results: [{ field: "f0", ok: true, fileId: "file_p", version: 1 }] },
        }));

        await uploadBatch(
            client, "ws_1",
            [{ path: a, name: "p.txt", folderId: null, size: 10 }],
            (name) => fakeTicket(log, name),
            1000,
        );

        expect(log.filter(l => l.startsWith("update:")).length).toBeGreaterThan(0);
        const bytes = log.filter(l => l.startsWith("update:"))
            .reduce((s, l) => s + Number(l.split(":")[2]), 0);
        expect(bytes).toBe(10);
        expect(log.at(-1)).toBe("finish:p.txt");
    });

    it("maps a per-file refusal to that file alone and leaves the rest successful", async () => {
        const a = join(dir, "ok.txt"); writeFileSync(a, "x");
        const b = join(dir, "bad.exe"); writeFileSync(b, "y");
        const log: string[] = [];

        const { client } = fakeClient(() => ({
            ok: true, status: 200,
            data: { ok: true, results: [
                { field: "f0", ok: true, fileId: "file_ok", version: 1 },
                { field: "f1", ok: false, error: "File type .exe is not allowed in this workspace" },
            ] },
        }));

        const outcomes = await uploadBatch(
            client, "ws_1",
            [
                { path: a, name: "ok.txt", folderId: null, size: 1 },
                { path: b, name: "bad.exe", folderId: null, size: 1 },
            ],
            (name) => fakeTicket(log, name),
            1000,
        );

        expect(outcomes[0]).toMatchObject({ ok: true, fileId: "file_ok" });
        expect(outcomes[1]).toMatchObject({ ok: false, error: "File type .exe is not allowed in this workspace" });
        // The refused file gives its bytes back rather than counting as transferred.
        expect(log).toContain("finish:ok.txt");
        expect(log).toContain("clear:bad.exe");
    });

    it("does not call a file uploaded when the response says nothing about it", async () => {
        const a = join(dir, "q.txt"); writeFileSync(a, "z");

        const { client } = fakeClient(() => ({
            ok: true, status: 200, data: { ok: true, results: [] },
        }));

        const outcomes = await uploadBatch(
            client, "ws_1",
            [{ path: a, name: "q.txt", folderId: null, size: 1 }],
            null, 1000,
        );

        expect(outcomes[0].ok).toBe(false);
        expect(outcomes[0].error).toContain("did not report a result");
    });

    it("throws on a whole-request refusal, releasing every ticket first", async () => {
        const a = join(dir, "r.txt"); writeFileSync(a, "z");
        const log: string[] = [];

        const { client } = fakeClient(() => ({
            ok: false, status: 403, data: { error: "No upload permission" },
        }));

        await expect(uploadBatch(
            client, "ws_1",
            [{ path: a, name: "r.txt", folderId: null, size: 1 }],
            (name) => fakeTicket(log, name),
            1000,
        )).rejects.toThrow("No upload permission");

        // Left inflight, the aggregate bar would keep counting a transfer that
        // never landed - and the caller's per-file fallback then double-counts it.
        expect(log).toContain("clear:r.txt");
    });

    it("cleans up", () => {
        rmSync(dir, { recursive: true, force: true });
    });
});
