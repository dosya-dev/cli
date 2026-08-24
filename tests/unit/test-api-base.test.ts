import { describe, it, expect } from "bun:test";

// Importing ../helpers evaluates a top-level `await probeLiveApi()`. Setting
// this BEFORE the import makes that probe return immediately instead of doing a
// live fetch with a 3s timeout, which is the difference between a unit test and
// a network test.
process.env.DOSYA_SKIP_INTEGRATION = "1";

const { DEFAULT_TEST_API_BASE, isRemoteTarget } = await import("../helpers");

/**
 * The default used to be https://api.dosya.dev. These tests create workspaces,
 * upload files and delete things with whatever DOSYA_TEST_API_KEY is in scope,
 * and the only thing preventing that against the live API was an untracked,
 * gitignored apps/cli/.env. A fresh clone got production.
 */
describe("integration-test target", () => {
    it("defaults to localhost, never to production", () => {
        expect(DEFAULT_TEST_API_BASE).toBe("http://localhost:4322");
        expect(isRemoteTarget(DEFAULT_TEST_API_BASE)).toBe(false);
    });

    it("matches the port apps/api dev actually serves", () => {
        // apps/api package.json: "dev": "astro dev --port 4322". A default
        // pointing at the wrong port is a default nobody can use, which is how
        // the previous .env drifted to 4321 and stopped working.
        expect(new URL(DEFAULT_TEST_API_BASE).port).toBe("4322");
    });

    it("recognises every local spelling as local", () => {
        for (const base of ["http://localhost:4322", "http://127.0.0.1:8788", "http://[::1]:4322"]) {
            expect(isRemoteTarget(base)).toBe(false);
        }
    });

    it("treats anything else as remote, including production", () => {
        for (const base of ["https://api.dosya.dev", "https://staging.dosya.dev", "http://192.168.1.10:4322"]) {
            expect(isRemoteTarget(base)).toBe(true);
        }
    });

    it("treats an unparseable base as remote rather than assuming local", () => {
        // Fail towards the loud banner, not away from it.
        expect(isRemoteTarget("not a url")).toBe(true);
        expect(isRemoteTarget("")).toBe(true);
    });
});
