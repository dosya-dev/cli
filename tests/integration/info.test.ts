import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId, uploadTestFile, deleteFile } from "../helpers";

describe("dosya info --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["info", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya info", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let fileId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        fileId = await uploadTestFile(workspaceId);
    });

    afterAll(async () => {
        if (fileId) await deleteFile(fileId);
    });

    it("shows metadata as JSON for a file id", async () => {
        const { stdout, exitCode } = await runCli(["info", fileId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.id).toBe(fileId);
        expect(typeof data.size_bytes).toBe("number");
    });

    it("shows a human-readable block", async () => {
        const { stdout, exitCode } = await runCli(["info", fileId, "-w", workspaceId, "-k", apiKey]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Name:");
        expect(stdout).toContain("Size:");
    });
});
