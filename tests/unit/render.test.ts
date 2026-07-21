import { describe, it, expect } from "bun:test";
import { renderTree, renderKeyValue } from "../../src/render";

describe("renderKeyValue", () => {
    it("aligns values past the widest key", () => {
        expect(renderKeyValue([["Name", "x"], ["ID", "file_1"]])).toBe("Name: x\nID:   file_1");
    });
});

describe("renderTree", () => {
    it("renders a nested tree in ascii (plain) mode", () => {
        const out = renderTree(
            [
                { id: "fld_a", name: "docs", parent_id: null },
                { id: "fld_b", name: "2026", parent_id: "fld_a" },
            ],
            null,
            { plain: true },
        );
        expect(out).toBe("`- docs\n   `- 2026");
    });

    it("shows file counts when present and sorts siblings by name", () => {
        const out = renderTree(
            [
                { id: "fld_b", name: "beta", parent_id: null, file_count: 2 },
                { id: "fld_a", name: "alpha", parent_id: null, file_count: 0 },
            ],
            null,
            { plain: true },
        );
        expect(out).toBe("|- alpha  (0)\n`- beta  (2)");
    });
});
