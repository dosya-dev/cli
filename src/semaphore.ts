/**
 * Promise-based counting semaphore for controlled concurrency (no busy-wait).
 *
 * Used to bound how many uploads/downloads run at once so we saturate bandwidth
 * without opening thousands of sockets. `acquire()` resolves immediately if a
 * slot is free, otherwise queues FIFO until one is `release()`d.
 */
export class Semaphore {
    private available: number;
    private queue: (() => void)[] = [];

    constructor(max: number) {
        if (!Number.isInteger(max) || max < 1) {
            throw new RangeError(`Semaphore requires a positive integer, got ${max}`);
        }
        this.available = max;
    }

    async acquire(): Promise<void> {
        if (this.available > 0) {
            this.available--;
            return;
        }
        await new Promise<void>(resolve => this.queue.push(resolve));
    }

    release(): void {
        const next = this.queue.shift();
        if (next) {
            next();
        } else {
            this.available++;
        }
    }

    /** Run `fn` while holding a slot, releasing even if it throws. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}
