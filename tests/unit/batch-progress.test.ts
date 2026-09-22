import { describe, it, expect } from "bun:test";
import { BatchProgress } from "../../src/progress";

/** Capture everything the renderer writes so assertions can inspect it. */
function makeOut() {
    const chunks: string[] = [];
    return {
        chunks,
        out: { write: (s: string) => { chunks.push(s); return true; } },
    };
}

function last(chunks: string[]): string {
    return chunks[chunks.length - 1] ?? "";
}

const MB = 1_048_576;

/** A batch renderer with an injected clock and captured output. */
function makeBatch(totalFiles: number, totalBytes: number) {
    const { chunks, out } = makeOut();
    let t = 1000;
    const clock = { advance: (ms: number) => { t += ms; } };
    const batch = new BatchProgress(totalFiles, totalBytes, {
        out, isTTY: true, columns: 220, now: () => t,
    });
    return { batch, chunks, clock };
}

describe("BatchProgress", () => {
    it("renders file counts and the current file name on start", () => {
        const { batch, chunks } = makeBatch(3, 3 * MB);
        batch.startFile("a.txt", MB);
        expect(last(chunks)).toContain("0/3 files");
        expect(last(chunks)).toContain("a.txt");
    });

    it("aggregates bytes across concurrent files", () => {
        const { batch, chunks, clock } = makeBatch(4, 4 * MB);
        const a = batch.startFile("a.bin", MB);
        const b = batch.startFile("b.bin", MB);
        clock.advance(200);
        a.update(MB / 4);
        clock.advance(200);
        b.update(MB / 4);
        expect(last(chunks)).toContain("512.0 KB/4.0 MB");
    });

    it("shows the most recent in-flight file plus an overflow count", () => {
        const { batch, chunks } = makeBatch(5, 5 * MB);
        batch.startFile("a.bin", MB);
        batch.startFile("b.bin", MB);
        batch.startFile("c.bin", MB);
        expect(last(chunks)).toContain("c.bin");
        expect(last(chunks)).toContain("+2");
    });

    it("finish() counts the file done at its declared size", () => {
        const { batch, chunks, clock } = makeBatch(4, 4 * MB);
        const a = batch.startFile("a.bin", MB);
        clock.advance(200);
        a.update(100); // partial byte reports must not survive into the done total
        a.finish();
        expect(last(chunks)).toContain("1/4 files");
        expect(last(chunks)).toContain("1.0 MB/4.0 MB");
    });

    it("clear() rolls back the attempt's bytes and in-flight entry", () => {
        const { batch, chunks, clock } = makeBatch(4, 4 * MB);
        const a = batch.startFile("a.bin", MB);
        clock.advance(200);
        a.update(MB / 2);
        a.clear();
        expect(last(chunks)).toContain("0 B/4.0 MB");
        expect(last(chunks)).not.toContain("a.bin");
    });

    it("fileFailed() removes the file's weight so the batch can still reach 100%", () => {
        const { batch, chunks } = makeBatch(2, 2 * MB);
        const a = batch.startFile("a.bin", MB);
        a.finish();
        const b = batch.startFile("b.bin", MB);
        b.clear();
        batch.fileFailed(MB);
        expect(last(chunks)).toContain("2/2 files");
        expect(last(chunks)).toContain("1.0 MB/1.0 MB");
        expect(last(chunks)).toContain("100%");
    });

    it("shows speed and ETA once transfer speed is known", () => {
        const { batch, chunks, clock } = makeBatch(4, 4 * MB);
        const a = batch.startFile("a.bin", MB);
        clock.advance(10_000);
        a.update(MB);
        expect(last(chunks)).toContain("/s");
        expect(last(chunks)).toContain("left");
    });

    it("renders nothing when not a TTY", () => {
        const { chunks, out } = makeOut();
        const batch = new BatchProgress(2, 2 * MB, { out, isTTY: false, now: () => 1000 });
        const a = batch.startFile("a.bin", MB);
        a.update(100);
        a.finish();
        batch.done();
        expect(chunks).toEqual([]);
    });

    it("throttles byte updates but not state transitions", () => {
        const { batch, chunks, clock } = makeBatch(2, 2 * MB);
        const a = batch.startFile("a.bin", MB); // forced render
        a.update(100); // within 100ms: skipped
        clock.advance(50);
        a.update(100); // still within 100ms: skipped
        clock.advance(60);
        a.update(100); // 110ms elapsed: rendered
        expect(chunks.length).toBe(2);
    });

    it("done() forces a final render and ends the line", () => {
        const { batch, chunks } = makeBatch(1, MB);
        const a = batch.startFile("a.bin", MB);
        a.finish();
        batch.done();
        expect(last(chunks)).toBe("\n");
        expect(chunks[chunks.length - 2]).toContain("1/1 files");
    });

    it("survives a zero-byte batch without NaN", () => {
        const { batch, chunks } = makeBatch(2, 0);
        const a = batch.startFile("empty.txt", 0);
        a.finish();
        expect(last(chunks)).not.toContain("NaN");
        expect(last(chunks)).toContain("1/2 files");
    });

    it("tickets pass data through createTransform() and track bytes", async () => {
        const { batch, chunks, clock } = makeBatch(1, 100);
        const a = batch.startFile("t.bin", 100);
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const source = new ReadableStream({
            start(controller) { controller.enqueue(input); controller.close(); },
        });
        clock.advance(200);
        const reader = source.pipeThrough(a.createTransform()).getReader();
        const { value } = await reader.read();
        expect(value).toEqual(input);
        const { done } = await reader.read();
        expect(done).toBe(true);
        clock.advance(200);
        a.update(0); // flush a render so the streamed bytes show up
        expect(last(chunks)).toContain("5 B/100 B");
    });
});
