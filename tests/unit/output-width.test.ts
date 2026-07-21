import { describe, it, expect } from "bun:test";
import { displayWidth } from "../../src/output";

/**
 * `String.length` counts UTF-16 units, so CJK filenames and emoji used to
 * knock table columns out of alignment.
 */
describe("displayWidth", () => {
    it("counts ASCII as one column per character", () => {
        expect(displayWidth("report.pdf")).toBe(10);
    });

    it("counts CJK as two columns per character", () => {
        expect(displayWidth("文件")).toBe(4);
        expect("文件".length).toBe(2); // what the old code measured
    });

    it("counts emoji as two columns", () => {
        expect(displayWidth("🎉")).toBe(2);
    });

    it("ignores variation selectors", () => {
        // Text-vs-emoji presentation selector adds no width
        expect(displayWidth("❤️")).toBe(displayWidth("❤"));
    });

    it("ignores combining marks", () => {
        expect(displayWidth("é")).toBe(1);
    });

    it("handles mixed scripts", () => {
        expect(displayWidth("a文b")).toBe(4);
    });

    it("returns 0 for an empty string", () => {
        expect(displayWidth("")).toBe(0);
    });
});
