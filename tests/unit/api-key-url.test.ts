import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Where `dosya auth` tells people to get an API key.
 *
 * It said https://dosya.dev/settings/api-keys in two places, and both parts
 * of that were wrong in ways that hide each other:
 *
 *   Wrong host. Keys live in the dashboard at app.dosya.dev. dosya.dev is the
 *   marketing site and answers a real HTTP 404 for that path.
 *
 *   Wrong path. The dashboard has no /settings child routes either, so even
 *   on the right host it renders the not-found page. The dashboard is an SPA,
 *   so the server answers 200 for every path.
 *
 * Read from source rather than exercised through the commands, because both
 * call sites are inside branches that either exit the process or depend on a
 * stored config, and the thing worth pinning is the string itself.
 */
const SOURCE = readFileSync(resolve(import.meta.dir, "../../src/commands/auth.ts"), "utf8");
const README = readFileSync(resolve(import.meta.dir, "../../README.md"), "utf8");

describe("the API key URL the CLI prints", () => {
    it("points at the dashboard route that serves API keys", () => {
        expect(SOURCE).toContain('const API_KEYS_URL = "https://app.dosya.dev/profile/api"');
    });

    it("names no path the dashboard has no route for", () => {
        // The comment above the constant explains the old URL; strip comments
        // first so documenting the trap does not read as using it.
        const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        expect(code).not.toContain("/settings/api-keys");
    });

    it("never sends people to the marketing site for a key", () => {
        const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        expect(code).not.toMatch(/https:\/\/dosya\.dev\/(profile|settings)/);
    });

    /**
     * Two call sites print this, and they drifted for as long as they were
     * two literals. One constant, used by both.
     */
    it("prints the same URL from every place that prints one", () => {
        const uses = SOURCE.match(/API_KEYS_URL/g) ?? [];
        // One declaration plus at least the two call sites.
        expect(uses.length).toBeGreaterThanOrEqual(3);
    });

    it("documents the same URL in the README", () => {
        expect(README).toContain("app.dosya.dev/profile/api");
        expect(README).not.toContain("settings/api-keys");
    });
});
