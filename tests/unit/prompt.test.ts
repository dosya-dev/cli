import { describe, it, expect } from "bun:test";
import { decideConfirm } from "../../src/prompt";

describe("decideConfirm", () => {
    it("accepts y / yes case-insensitively, trimming whitespace", () => {
        expect(decideConfirm("y")).toBe(true);
        expect(decideConfirm("Y")).toBe(true);
        expect(decideConfirm("yes")).toBe(true);
        expect(decideConfirm(" Yes ")).toBe(true);
    });

    it("rejects everything else", () => {
        expect(decideConfirm("n")).toBe(false);
        expect(decideConfirm("no")).toBe(false);
        expect(decideConfirm("")).toBe(false);
        expect(decideConfirm("yolo")).toBe(false);
    });
});
