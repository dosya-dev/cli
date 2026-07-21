import { describe, it, expect, beforeAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId, getClient, uploadTestFile } from "../helpers";

describe("dosya trash --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["trash", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya trash", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
    });

    it("lists, restores from, and empties the trash", async () => {
        const fileId = await uploadTestFile(workspaceId);
        await getClient().del(`/api/files/${fileId}`); // soft-delete into trash

        const list = await runCli(["trash", "list", "-w", workspaceId, "--json", "-k", apiKey]);
        expect(list.exitCode).toBe(0);
        const listed = JSON.parse(list.stdout);
        expect(listed.files.some((f: { id: string }) => f.id === fileId)).toBe(true);

        const restore = await runCli(["trash", "restore", fileId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(restore.exitCode).toBe(0);
        expect(JSON.parse(restore.stdout).restored).toBe(1);

        // now really remove it and empty the trash
        await getClient().del(`/api/files/${fileId}`);
        const empty = await runCli(["trash", "empty", "-w", workspaceId, "--force", "--json", "-k", apiKey]);
        expect(empty.exitCode).toBe(0);
        expect(JSON.parse(empty.stdout).ok).toBe(true);
    });
});
