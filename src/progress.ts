import { formatBytes } from "@dosya-dev/shared";
import { isPlain } from "./output";

const BAR_WIDTH = 30;

/**
 * Byte-level progress for one file transfer. `ProgressBar` implements this for
 * a file that owns the terminal line; `BatchProgress.startFile()` returns one
 * that feeds a shared line instead, so concurrent uploads can report without
 * shredding each other's output.
 */
export interface FileProgress {
    update(bytes: number): void;
    finish(): void;
    clear(): void;
    createTransform(): TransformStream<Uint8Array, Uint8Array>;
}

/** How an upload obtains a progress reporter for a file it is about to send. */
export type ProgressFactory = (name: string, size: number) => FileProgress;

function formatTime(seconds: number): string {
    if (seconds < 1) return "<1s";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m${s.toString().padStart(2, "0")}s`;
}

export class ProgressBar {
    private total: number;
    private current = 0;
    private startTime: number;
    private label: string;
    private isTTY: boolean;
    private lastRender = 0;

    constructor(label: string, total: number) {
        this.label = label;
        this.total = total;
        this.startTime = Date.now();
        this.isTTY = Boolean(process.stderr.isTTY);
    }

    update(bytes: number): void {
        this.current += bytes;
        // Throttle renders to every 100ms
        const now = Date.now();
        if (now - this.lastRender < 100) return;
        this.lastRender = now;
        this.render();
    }

    finish(): void {
        this.current = this.total;
        this.render();
        if (this.isTTY) {
            process.stderr.write("\n");
        }
    }

    private render(): void {
        if (!this.isTTY) return;

        const pct = this.total > 0 ? Math.min(this.current / this.total, 1) : 0;
        const filled = Math.round(BAR_WIDTH * pct);
        const [full, empty] = isPlain() ? ["#", "-"] : ["█", "░"];
        const bar = full.repeat(filled) + empty.repeat(BAR_WIDTH - filled);

        const elapsed = (Date.now() - this.startTime) / 1000;
        const speed = elapsed > 0 ? this.current / elapsed : 0;
        const remaining = speed > 0 && pct < 1 ? (this.total - this.current) / speed : 0;

        const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
        const sizeStr = `${formatBytes(this.current)}/${formatBytes(this.total)}`;
        const speedStr = `${formatBytes(speed)}/s`;
        const timeStr = pct >= 1 ? formatTime(elapsed) : `${formatTime(remaining)} left`;

        const line = `${this.label} [${bar}] ${pctStr} | ${sizeStr} | ${speedStr} | ${timeStr}`;
        const cols = process.stderr.columns || 120;
        // Clamp so an over-long line never wraps and leaves stale rows behind
        const clamped = line.length > cols ? line.slice(0, cols) : line.padEnd(cols);
        process.stderr.write(`\r${clamped}`);
    }

    /** Erase the bar - used when an interrupt or error takes over the terminal. */
    clear(): void {
        if (!this.isTTY) return;
        const cols = process.stderr.columns || 120;
        process.stderr.write(`\r${" ".repeat(cols)}\r`);
    }

    /**
     * Create a TransformStream that tracks bytes passing through.
     */
    createTransform(): TransformStream<Uint8Array, Uint8Array> {
        const bar = this;
        return new TransformStream({
            transform(chunk, controller) {
                bar.update(chunk.byteLength);
                controller.enqueue(chunk);
            },
        });
    }
}

const BATCH_BAR_WIDTH = 20;

interface Writer {
    write(chunk: string): boolean | void;
}

/** Injection points so tests can drive the clock and read the output. */
interface BatchProgressOptions {
    out?: Writer;
    isTTY?: boolean;
    columns?: number;
    now?: () => number;
}

interface InflightFile {
    name: string;
    bytes: number;
}

/**
 * One shared progress line for a multi-file upload.
 *
 * Concurrent per-file ProgressBars all rewrite the same stderr row with \r and
 * destroy each other, so a batch renders a single aggregate line instead:
 *
 *   [██████░░░░]  34% | 12/48 files | 156 MB/450 MB | 12.4 MB/s | 24s left | photo.jpg +2
 *
 * Each file reports through the ticket `startFile()` returns. A ticket's
 * `clear()` rolls its bytes back out of the aggregate, so a retried attempt
 * never double-counts; `finish()` commits the file at its declared size, so
 * partial-report drift cannot accumulate. A failed file's weight leaves the
 * denominator via `fileFailed()`, otherwise the bar could never reach 100%.
 */
export class BatchProgress {
    private readonly totalFiles: number;
    private totalBytes: number;
    private doneFiles = 0;
    private failedFiles = 0;
    private doneBytes = 0;
    private readonly inflight = new Set<InflightFile>();
    private readonly out: Writer;
    private readonly isTTY: boolean;
    private readonly fixedColumns: number | undefined;
    private readonly now: () => number;
    private readonly startTime: number;
    private lastRender = 0;

    constructor(totalFiles: number, totalBytes: number, opts: BatchProgressOptions = {}) {
        this.totalFiles = totalFiles;
        this.totalBytes = totalBytes;
        this.out = opts.out ?? process.stderr;
        this.isTTY = opts.isTTY ?? Boolean(process.stderr.isTTY);
        this.fixedColumns = opts.columns;
        this.now = opts.now ?? Date.now;
        this.startTime = this.now();
    }

    /** Register a file as uploading and get its progress ticket. */
    startFile(name: string, size: number): FileProgress {
        const entry: InflightFile = { name, bytes: 0 };
        this.inflight.add(entry);
        this.render(true);

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const batch = this;
        const ticket: FileProgress = {
            update(bytes: number): void {
                entry.bytes += bytes;
                batch.render(false);
            },
            finish(): void {
                batch.inflight.delete(entry);
                batch.doneFiles++;
                batch.doneBytes += size;
                batch.render(true);
            },
            clear(): void {
                batch.inflight.delete(entry);
                entry.bytes = 0;
                batch.render(true);
            },
            createTransform(): TransformStream<Uint8Array, Uint8Array> {
                return new TransformStream({
                    transform(chunk, controller) {
                        ticket.update(chunk.byteLength);
                        controller.enqueue(chunk);
                    },
                });
            },
        };
        return ticket;
    }

    /**
     * Record a file as failed for good. Its bytes leave the total so the
     * remaining files can still bring the bar to 100%.
     */
    fileFailed(size: number): void {
        this.failedFiles++;
        this.totalBytes = Math.max(0, this.totalBytes - size);
        this.render(true);
    }

    /** Blank the line and return the cursor, so a message starts clean. */
    clearLine(): void {
        if (!this.isTTY) return;
        this.out.write(`\r${" ".repeat(this.columns())}\r`);
    }

    /** Final render plus newline, leaving the finished state on screen. */
    done(): void {
        if (!this.isTTY) return;
        this.render(true);
        this.out.write("\n");
    }

    private columns(): number {
        return this.fixedColumns ?? process.stderr.columns ?? 120;
    }

    private render(force: boolean): void {
        if (!this.isTTY) return;
        const now = this.now();
        if (!force && now - this.lastRender < 100) return;
        this.lastRender = now;

        let inflightBytes = 0;
        for (const f of this.inflight) inflightBytes += f.bytes;
        const transferred = this.doneBytes + inflightBytes;
        const settled = this.doneFiles + this.failedFiles;

        // A batch of only empty files still deserves a moving bar
        const pct = this.totalBytes > 0
            ? Math.min(transferred / this.totalBytes, 1)
            : (this.totalFiles > 0 ? settled / this.totalFiles : 0);

        const filled = Math.round(BATCH_BAR_WIDTH * pct);
        const [full, empty] = isPlain() ? ["#", "-"] : ["█", "░"];
        const bar = full.repeat(filled) + empty.repeat(BATCH_BAR_WIDTH - filled);
        const pctStr = `${Math.round(pct * 100)}%`.padStart(4);

        let line = `[${bar}] ${pctStr} | ${settled}/${this.totalFiles} files`
            + ` | ${formatBytes(transferred)}/${formatBytes(this.totalBytes)}`;

        const elapsed = (now - this.startTime) / 1000;
        const speed = elapsed > 0 ? transferred / elapsed : 0;
        if (speed > 0) {
            line += ` | ${formatBytes(speed)}/s`;
            if (pct < 1) {
                line += ` | ${formatTime((this.totalBytes - transferred) / speed)} left`;
            }
        }

        // The name goes last so column clamping truncates it, not the numbers
        const current = [...this.inflight].pop();
        if (current) {
            line += ` | ${current.name}`;
            if (this.inflight.size > 1) line += ` +${this.inflight.size - 1}`;
        }

        const cols = this.columns();
        const clamped = line.length > cols ? line.slice(0, cols) : line.padEnd(cols);
        this.out.write(`\r${clamped}`);
    }
}
