import { describe, it, expect } from "bun:test";
import { resolveParallel, clampToWorkspaceLimit, parseParallel } from "../../src/commands/upload";

/**
 * `-c 16` on an upload did nothing at all.
 *
 * `-c` is the short alias for `--connections`, which `download` reads;
 * `upload` reads `--parallel`. The parser could not object - `connections` is a
 * real flag - so `dosya upload . -r -c 16` parsed cleanly, silently ran at the
 * default 3, and the user watched a 2419-file upload crawl at a third of the
 * concurrency they asked for.
 */
describe("resolveParallel", () => {
    it("honours -c / --connections, which upload used to ignore entirely", () => {
        expect(resolveParallel({ connections: "16" })).toBe(16);
    });

    it("still honours --parallel", () => {
        expect(resolveParallel({ parallel: "8" })).toBe(8);
    });

    it("lets --parallel win when both are given", () => {
        expect(resolveParallel({ parallel: "4", connections: "16" })).toBe(4);
    });

    it("falls back to the default when neither is given", () => {
        expect(resolveParallel({})).toBe(3);
    });

    it("caps at the CLI maximum", () => {
        expect(resolveParallel({ connections: "999" })).toBe(16);
    });
});

describe("parseParallel", () => {
    it("floors a fractional value rather than handing NaN to the semaphore", () => {
        expect(parseParallel("2.9")).toBe(2);
    });
});

/**
 * The other half of the same bug: `--parallel 16` DID work and made things
 * worse. A workspace's `max_concurrent_uploads` is 5 by default, upload/init
 * enforces it per file, and 7 of 20 files came back "You have 5 uploads in
 * progress" - reported as failures on a run that then claimed the other 13
 * were uploaded.
 */
describe("clampToWorkspaceLimit", () => {
    it("clamps a request above the workspace ceiling", () => {
        expect(clampToWorkspaceLimit(16, 5)).toBe(5);
    });

    it("leaves a request below the ceiling alone", () => {
        expect(clampToWorkspaceLimit(3, 5)).toBe(3);
    });

    it("treats 0 as 'no limit', which is the server's own sentinel", () => {
        // upload/init.ts guards the gate with `if (max_concurrent_uploads > 0)`,
        // so reading 0 as a ceiling would pin every upload to one file at a time
        // on exactly the workspaces that have no limit at all.
        expect(clampToWorkspaceLimit(16, 0)).toBe(16);
    });

    it("treats null as 'no limit' - an older API does not report the field", () => {
        expect(clampToWorkspaceLimit(16, null)).toBe(16);
        expect(clampToWorkspaceLimit(16, undefined)).toBe(16);
    });

    it("never clamps below 1, which a Semaphore would reject", () => {
        expect(clampToWorkspaceLimit(4, -3)).toBe(4);
    });
});
