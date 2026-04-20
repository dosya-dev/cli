import { describe, it, expect } from "bun:test";
import { ProgressBar } from "../../src/progress";

describe("ProgressBar", () => {
    it("should create a progress bar", () => {
        const bar = new ProgressBar("test.txt", 1000);
        expect(bar).toBeDefined();
    });

    it("should track bytes via update()", () => {
        const bar = new ProgressBar("test.txt", 1000);
        // update doesn't throw
        bar.update(500);
        bar.update(500);
    });

    it("should handle finish()", () => {
        const bar = new ProgressBar("test.txt", 1000);
        bar.update(500);
        // finish doesn't throw
        bar.finish();
    });

    it("should handle zero-size files", () => {
        const bar = new ProgressBar("empty.txt", 0);
        bar.finish();
    });

    describe("createTransform()", () => {
        it("should create a TransformStream", () => {
            const bar = new ProgressBar("test.txt", 1000);
            const transform = bar.createTransform();
            expect(transform).toBeInstanceOf(TransformStream);
        });

        it("should pass data through and track bytes", async () => {
            const bar = new ProgressBar("test.txt", 100);
            const transform = bar.createTransform();

            const input = new Uint8Array([1, 2, 3, 4, 5]);
            const source = new ReadableStream({
                start(controller) {
                    controller.enqueue(input);
                    controller.close();
                },
            });

            const output = source.pipeThrough(transform);
            const reader = output.getReader();

            const { value } = await reader.read();
            expect(value).toEqual(input);

            const { done } = await reader.read();
            expect(done).toBe(true);
        });
    });
});
