import { formatBytes } from "@dosya-dev/shared";

const BAR_WIDTH = 30;

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
        const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);

        const elapsed = (Date.now() - this.startTime) / 1000;
        const speed = elapsed > 0 ? this.current / elapsed : 0;
        const remaining = speed > 0 && pct < 1 ? (this.total - this.current) / speed : 0;

        const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
        const sizeStr = `${formatBytes(this.current)}/${formatBytes(this.total)}`;
        const speedStr = `${formatBytes(speed)}/s`;
        const timeStr = pct >= 1 ? formatTime(elapsed) : `${formatTime(remaining)} left`;

        const line = `${this.label} [${bar}] ${pctStr} | ${sizeStr} | ${speedStr} | ${timeStr}`;
        const cols = process.stderr.columns || 120;
        process.stderr.write(`\r${line.padEnd(cols)}`);
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
