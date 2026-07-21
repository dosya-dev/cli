import { describe, it, expect, beforeAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId } from "../helpers";

describe("dosya usage --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["usage", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya usage", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
    });

    it("returns storage stats as JSON", async () => {
        const { stdout, exitCode } = await runCli(["usage", "-w", workspaceId, "--json", "-k", apiKey]);
        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(typeof data.stats.total_bytes).toBe("number");
        expect(typeof data.stats.storage_cap_bytes).toBe("number");
        expect(data.stats.plan).toBeDefined();
    });
});
