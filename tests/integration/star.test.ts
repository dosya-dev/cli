import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId, uploadTestFile, deleteFile } from "../helpers";

describe("dosya star --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["star", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya star / unstar / starred", () => {
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

    it("stars, lists, and unstars a file", async () => {
        const star = await runCli(["star", fileId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(star.exitCode).toBe(0);
        expect(JSON.parse(star.stdout).count).toBe(1);

        const list = await runCli(["starred", "-w", workspaceId, "--json", "-k", apiKey]);
        expect(list.exitCode).toBe(0);
        const listed = JSON.parse(list.stdout);
        expect(listed.files.some((f: { file_id: string }) => f.file_id === fileId)).toBe(true);

        const unstar = await runCli(["unstar", fileId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(unstar.exitCode).toBe(0);
        expect(JSON.parse(unstar.stdout).ok).toBe(true);
    });

    it("treats double-star as success (idempotent)", async () => {
        await runCli(["star", fileId, "-w", workspaceId, "-k", apiKey]);
        const again = await runCli(["star", fileId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(again.exitCode).toBe(0);
        expect(JSON.parse(again.stdout).ok).toBe(true);
    });
});
