import { describe, it, expect, beforeAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId } from "../helpers";

describe("dosya tree --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["tree", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya tree", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
    });

    it("returns a nested folder array as JSON", async () => {
        const { stdout, exitCode } = await runCli(["tree", "-w", workspaceId, "--json", "-k", apiKey]);
        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(Array.isArray(data)).toBe(true);
    });
});
