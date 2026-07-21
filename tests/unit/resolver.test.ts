import { describe, it, expect } from "bun:test";
import { parseRef, buildFolderIndex, hasGlob, globToRegExp } from "../../src/resolver";

describe("parseRef", () => {
    it("passes a raw file id through", () => {
        const r = parseRef("file_abc", { defaultWorkspace: "ws_1" });
        expect(r.rawId).toEqual({ type: "file", id: "file_abc" });
        expect(r.workspaceId).toBe("ws_1");
    });

    it("passes a raw folder id through", () => {
        expect(parseRef("fld_x", { defaultWorkspace: "ws_1" }).rawId).toEqual({ type: "folder", id: "fld_x" });
    });

    it("treats a bare workspace id as that workspace's root folder", () => {
        const r = parseRef("ws_9", { defaultWorkspace: "ws_1" });
        expect(r.workspaceId).toBe("ws_9");
        expect(r.rawId).toEqual({ type: "folder", id: "" });
        expect(r.segments).toEqual([]);
    });

    it("honours an explicit ws prefix over the default", () => {
        const r = parseRef("ws_9:docs/a.pdf", { defaultWorkspace: "ws_1" });
        expect(r.workspaceId).toBe("ws_9");
        expect(r.segments).toEqual(["docs", "a.pdf"]);
        expect(r.rawId).toBeNull();
    });

    it("strips a leading slash and splits segments", () => {
        expect(parseRef("/a/b", { defaultWorkspace: "ws_1" }).segments).toEqual(["a", "b"]);
        expect(parseRef("./a/b", { defaultWorkspace: "ws_1" }).segments).toEqual(["a", "b"]);
    });

    it("leaves a colon inside a filename alone", () => {
        const r = parseRef("my:file.txt", { defaultWorkspace: "ws_1" });
        expect(r.workspaceId).toBe("ws_1");
        expect(r.segments).toEqual(["my:file.txt"]);
    });
});

describe("buildFolderIndex", () => {
    it("builds nested root-relative paths in both directions", () => {
        const idx = buildFolderIndex([
            { id: "fld_a", name: "docs", parent_id: null },
            { id: "fld_b", name: "2026", parent_id: "fld_a" },
        ]);
        expect(idx.pathToId.get("docs")).toBe("fld_a");
        expect(idx.pathToId.get("docs/2026")).toBe("fld_b");
        expect(idx.idToPath.get("fld_b")).toBe("docs/2026");
    });

    it("does not loop on a parent cycle", () => {
        const idx = buildFolderIndex([
            { id: "fld_a", name: "a", parent_id: "fld_b" },
            { id: "fld_b", name: "b", parent_id: "fld_a" },
        ]);
        expect(idx.idToPath.size).toBe(2);
    });
});

describe("glob helpers", () => {
    it("detects wildcards", () => {
        expect(hasGlob("*.log")).toBe(true);
        expect(hasGlob("q?.pdf")).toBe(true);
        expect(hasGlob("report.pdf")).toBe(false);
    });

    it("compiles a filename glob to an anchored regexp (escaping dots)", () => {
        const re = globToRegExp("*.log");
        expect(re.test("app.log")).toBe(true);
        expect(re.test("app.log.bak")).toBe(false);
        expect(re.test("applog")).toBe(false);
        expect(globToRegExp("q?.pdf").test("q3.pdf")).toBe(true);
        expect(globToRegExp("q?.pdf").test("q33.pdf")).toBe(false);
    });
});
