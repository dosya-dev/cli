import { describe, it, expect, beforeAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId, getClient } from "../helpers";

describe("dosya mkdir --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["mkdir", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya mkdir", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
    });

    it("creates a folder and returns its id", async () => {
        const name = `cli-mkdir-${Date.now()}`;
        const { stdout, exitCode } = await runCli(["mkdir", name, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.ok).toBe(true);
        expect(data.folder.id).toBeDefined();

        // cleanup
        try { await getClient().del(`/api/folders/${data.folder.id}`); } catch { /* ignore */ }
    });
});
