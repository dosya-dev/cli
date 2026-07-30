/**
 * Content-defined chunking (FastCDC-style) for block-level delta sync.
 *
 * Ported byte-for-byte from apps/desktop/src/main/sync/chunker.ts - the gear
 * table, masks, and cut logic MUST stay identical or chunks won't dedup across
 * the desktop and CLI clients. Pure and deterministic (no RNG): the same bytes
 * always produce the same chunk boundaries and hashes on every machine.
 */

/** Reassembly cap - must match MAX_BYTES in apps/api/src/pages/api/sync/chunks/commit.ts. */
export const DELTA_MAX_BYTES = 64 * 1024 * 1024;

export interface Chunk {
    offset: number;
    size: number;
    /** sha256 hex - the chunk's identity for dedup. */
    hash: string;
}

export interface ChunkOptions {
    minSize?: number;
    avgSize?: number;
    maxSize?: number;
}

interface ResolvedParams {
    min: number;
    avg: number;
    max: number;
    maskS: number;
    maskL: number;
}

const DEFAULTS = { min: 256 * 1024, avg: 1024 * 1024, max: 4 * 1024 * 1024 };

/** Deterministic 256-entry gear table (xorshift32 from a fixed seed). */
const GEAR: Uint32Array = (() => {
    const g = new Uint32Array(256);
    let s = 0x9e3779b9 >>> 0;
    for (let i = 0; i < 256; i++) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        g[i] = s >>> 0;
    }
    return g;
})();

function resolveParams(opts?: ChunkOptions): ResolvedParams {
    const avg = opts?.avgSize ?? DEFAULTS.avg;
    const min = opts?.minSize ?? DEFAULTS.min;
    const max = opts?.maxSize ?? DEFAULTS.max;
    const bits = Math.round(Math.log2(avg));
    const maskS = ((1 << Math.min(31, bits + 2)) - 1) >>> 0;
    const maskL = ((1 << Math.max(1, bits - 2)) - 1) >>> 0;
    return { min, avg, max, maskS, maskL };
}

function sha256(buf: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

/** Chunk an in-memory buffer - the reference implementation of the cut algorithm. */
export function chunkBuffer(buf: Uint8Array, opts?: ChunkOptions): Chunk[] {
    const { min, avg, max, maskS, maskL } = resolveParams(opts);
    const n = buf.length;
    const chunks: Chunk[] = [];
    let start = 0;

    while (start < n) {
        const hardEnd = Math.min(start + max, n);
        let fp = 0 >>> 0;
        let end = hardEnd;
        for (let i = start; i < hardEnd; i++) {
            fp = ((fp << 1) + GEAR[buf[i]!]) >>> 0;
            const len = i - start + 1;
            if (len < min) continue;
            const mask = len < avg ? maskS : maskL;
            if ((fp & mask) === 0) { end = i + 1; break; }
        }
        chunks.push({ offset: start, size: end - start, hash: sha256(buf.subarray(start, end)) });
        start = end;
    }
    return chunks;
}

/** Chunk a file on disk by streaming - identical output to chunkBuffer. */
export async function chunkFile(path: string, opts?: ChunkOptions): Promise<Chunk[]> {
    const { min, avg, max, maskS, maskL } = resolveParams(opts);
    const chunks: Chunk[] = [];

    let fp = 0 >>> 0;
    let chunkStart = 0;
    let chunkLen = 0;
    let hasher = new Bun.CryptoHasher("sha256");

    const finalize = (): void => {
        chunks.push({ offset: chunkStart, size: chunkLen, hash: hasher.digest("hex") });
        chunkStart += chunkLen;
        chunkLen = 0;
        fp = 0 >>> 0;
        hasher = new Bun.CryptoHasher("sha256");
    };

    const reader = Bun.file(path).stream().getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const buf = value as Uint8Array;
            let sliceStart = 0;
            for (let j = 0; j < buf.length; j++) {
                fp = ((fp << 1) + GEAR[buf[j]!]) >>> 0;
                chunkLen++;
                if (chunkLen < min) continue;
                const mask = chunkLen < avg ? maskS : maskL;
                if ((fp & mask) === 0 || chunkLen >= max) {
                    hasher.update(buf.subarray(sliceStart, j + 1));
                    sliceStart = j + 1;
                    finalize();
                }
            }
            if (sliceStart < buf.length) hasher.update(buf.subarray(sliceStart));
        }
    } finally {
        reader.releaseLock();
    }
    if (chunkLen > 0) finalize();
    return chunks;
}

export interface ChunkDiff {
    toUpload: Chunk[];
    uploadBytes: number;
    reusedBytes: number;
    totalChunks: number;
}

/** Which chunks the server doesn't already have - the only bytes to send. */
export function diffChunks(known: Set<string>, chunks: Chunk[]): ChunkDiff {
    const toUpload: Chunk[] = [];
    let uploadBytes = 0;
    let reusedBytes = 0;
    for (const c of chunks) {
        if (known.has(c.hash)) reusedBytes += c.size;
        else { toUpload.push(c); uploadBytes += c.size; }
    }
    return { toUpload, uploadBytes, reusedBytes, totalChunks: chunks.length };
}
