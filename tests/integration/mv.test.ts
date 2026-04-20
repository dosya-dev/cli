import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { runCli, getWorkspaceId, getClient, uploadTestFile, deleteFile } from "../helpers";

describe("dosya mv", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let fileId: string;
    let folderId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        fileId = await uploadTestFile(workspaceId);

        // Create a folder
        const client = getClient();
        const data = await client.post<{ ok: boolean; folder: { id: string } }>("/api/folders", {
            workspace_id: workspaceId,
            name: `mv-test-${Date.now()}`,
        });
        folderId = data.folder.id;
    });

    afterAll(async () => {
        await deleteFile(fileId);
        const client = getClient();
        try {
            await client.del(`/api/folders/${folderId}`);
        } catch { /* already cleaned up */ }
    });

    it("should rename a file", async () => {
        const newName = `renamed-${Date.now()}.txt`;
        const { stdout, exitCode } = await runCli([
            "mv", fileId, newName,
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.ok).toBe(true);
        expect(data.action).toBe("rename");
        expect(data.name).toBe(newName);
    });

    it("should move a file to a folder", async () => {
        const { stdout, exitCode } = await runCli([
            "mv", fileId, folderId,
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.ok).toBe(true);
        expect(data.action).toBe("move");
        expect(data.folder_id).toBe(folderId);
    });

    it("should fail without file ID and target", async () => {
        const { exitCode, stderr } = await runCli(["mv", "-k", apiKey]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("Usage:");
    });

    it("should fail with only file ID (no target)", async () => {
        const { exitCode, stderr } = await runCli(["mv", fileId, "-k", apiKey]);

        // -k will be consumed as the key flag, so effectively no target
        // This should fail
        expect(exitCode).not.toBe(0);
    });

    it("should show help with --help", async () => {
        const { stdout, exitCode } = await runCli(["mv", "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
        expect(stdout).toContain("Move or rename");
    });
});
