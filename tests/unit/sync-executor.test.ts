import { describe, it, expect } from "bun:test";
import { conflictedCopyName } from "../../src/sync/executor";

describe("conflictedCopyName", () => {
    it("inserts the tag before the extension", () => {
        expect(conflictedCopyName("report.pdf")).toBe("report (conflicted copy).pdf");
        expect(conflictedCopyName("reports/2026/q3.txt")).toBe("reports/2026/q3 (conflicted copy).txt");
    });

    it("handles files with no extension and dotfiles", () => {
        expect(conflictedCopyName("README")).toBe("README (conflicted copy)");
        expect(conflictedCopyName(".env")).toBe(".env (conflicted copy)");
    });

    it("supports a numbered tag for repeat conflicts", () => {
        expect(conflictedCopyName("a.txt", "conflicted copy 2")).toBe("a (conflicted copy 2).txt");
    });
});
