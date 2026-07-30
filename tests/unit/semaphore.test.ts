import { describe, it, expect } from "bun:test";
import { Semaphore } from "../../src/commands/upload";

/** Resolve to a sentinel if `promise` hasn't settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | "TIMED_OUT"> {
    return Promise.race([
        promise,
        new Promise<"TIMED_OUT">(resolve => setTimeout(() => resolve("TIMED_OUT"), ms)),
    ]);
}

/**
 * `parseInt("abc")` is NaN, and `new Semaphore(NaN)` never granted a slot -
 * `dosya upload ./dir -r --parallel abc` hung forever with no output.
 */
describe("Semaphore - invalid limits must not deadlock", () => {
    for (const bad of [NaN, 0, -1, 1.5, Infinity]) {
        it(`rejects ${bad} instead of hanging`, () => {
            expect(() => new Semaphore(bad)).toThrow(RangeError);
        });
    }
});

describe("Semaphore - normal operation", () => {
    it("grants up to the limit immediately", async () => {
        const sem = new Semaphore(2);
        expect(await withDeadline(sem.acquire(), 200)).not.toBe("TIMED_OUT");
        expect(await withDeadline(sem.acquire(), 200)).not.toBe("TIMED_OUT");
    });

    it("queues beyond the limit and releases in order", async () => {
        const sem = new Semaphore(1);
        await sem.acquire();

        const queued = sem.acquire();
        expect(await withDeadline(queued, 100)).toBe("TIMED_OUT");

        sem.release();
        expect(await withDeadline(queued, 200)).not.toBe("TIMED_OUT");
    });

    it("caps concurrency across many tasks", async () => {
        const sem = new Semaphore(3);
        let active = 0;
        let peak = 0;

        await Promise.all(
            Array.from({ length: 20 }, () => (async () => {
                await sem.acquire();
                active++;
                peak = Math.max(peak, active);
                await Bun.sleep(1);
                active--;
                sem.release();
            })()),
        );

        expect(peak).toBeLessThanOrEqual(3);
        expect(active).toBe(0);
    });
});
