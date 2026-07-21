import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId, getClient, uploadTestFile, deleteFile } from "../helpers";

describe("dosya cp --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["cp", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya cp", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let fileId: string;
    let folderId: string;
    let copyId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        fileId = await uploadTestFile(workspaceId);
        const data = await getClient().post<{ ok: boolean; folder: { id: string } }>("/api/folders", {
            workspace_id: workspaceId,
            name: `cli-cp-${Date.now()}`,
        });
        folderId = data.folder.id;
    });

    afterAll(async () => {
        await deleteFile(fileId);
        if (copyId) await deleteFile(copyId);
        try { await getClient().del(`/api/folders/${folderId}`); } catch { /* ignore */ }
    });

    it("copies a file into a folder", async () => {
        const { stdout, exitCode } = await runCli(["cp", fileId, folderId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.ok).toBe(true);
        expect(data.file_id).toBeDefined();
        copyId = data.file_id;
    });
});
