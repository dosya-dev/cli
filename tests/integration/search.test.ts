import { describe, it, expect, beforeAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId } from "../helpers";

describe("dosya search --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["search", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya search", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
    });

    it("returns grouped JSON results", async () => {
        const { stdout, exitCode } = await runCli(["search", "test", "-w", workspaceId, "--json", "-k", apiKey]);
        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.files).toBeDefined();
        expect(data.folders).toBeDefined();
        expect(data.pagination).toBeDefined();
    });

    it("requires a query", async () => {
        const { exitCode, stderr } = await runCli(["search", "-w", workspaceId, "-k", apiKey]);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("query required");
    });
});
