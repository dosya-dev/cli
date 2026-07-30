import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { chunkBuffer, chunkFile, diffChunks, type Chunk } from "../../src/sync/chunker";

// Small params so a few hundred KB yields many chunks (fast, still exercises the algorithm).
const OPTS = { minSize: 1024, avgSize: 4096, maxSize: 16384 };

/** Deterministic pseudo-random bytes (LCG) - no RNG, so tests are stable. */
function lcgBytes(n: number, seed: number): Uint8Array {
    const out = new Uint8Array(n);
    let s = seed >>> 0;
    for (let i = 0; i < n; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        out[i] = (s >>> 24) & 0xff;
    }
    return out;
}

describe("chunker", () => {
    it("is deterministic", () => {
        const data = lcgBytes(200_000, 1);
        expect(chunkBuffer(data, OPTS)).toEqual(chunkBuffer(data, OPTS));
    });

    it("covers the whole buffer with contiguous chunks", () => {
        const data = lcgBytes(200_000, 2);
        const chunks = chunkBuffer(data, OPTS);
        expect(chunks.length).toBeGreaterThan(5);
        let offset = 0;
        for (const c of chunks) {
            expect(c.offset).toBe(offset);
            offset += c.size;
        }
        expect(offset).toBe(data.length);
    });

    it("streaming chunkFile matches in-memory chunkBuffer", async () => {
        const data = lcgBytes(180_000, 3);
        const dir = mkdtempSync(join(tmpdir(), "dosya-chunk-"));
        const path = join(dir, "data.bin");
        writeFileSync(path, data);
        expect(await chunkFile(path, OPTS)).toEqual(chunkBuffer(data, OPTS));
    });

    it("localises an edit - most chunks survive (the delta property)", () => {
        const a = lcgBytes(300_000, 4);
        const b = a.slice();
        // Overwrite ~100 bytes in the middle.
        b.set(lcgBytes(100, 999), 150_000);

        const ca = chunkBuffer(a, OPTS);
        const cb = chunkBuffer(b, OPTS);
        const setA = new Set(ca.map((c: Chunk) => c.hash));
        const shared = cb.filter((c: Chunk) => setA.has(c.hash)).length;

        // A one-spot edit must not invalidate the whole file.
        expect(shared).toBeGreaterThan(cb.length / 2);
    });

    it("diffChunks reports reused vs to-upload", () => {
        const chunks: Chunk[] = [
            { offset: 0, size: 10, hash: "a" },
            { offset: 10, size: 20, hash: "b" },
            { offset: 30, size: 5, hash: "c" },
        ];
        const d = diffChunks(new Set(["a", "c"]), chunks);
        expect(d.toUpload.map(c => c.hash)).toEqual(["b"]);
        expect(d.uploadBytes).toBe(20);
        expect(d.reusedBytes).toBe(15);
        expect(d.totalChunks).toBe(3);
    });
});
