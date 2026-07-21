import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { LIVE_API, runCli, getWorkspaceId, uploadTestFile, deleteFile } from "../helpers";

describe.skipIf(!LIVE_API)("dosya share lifecycle", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let fileId: string;
    let fileId2: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        fileId = await uploadTestFile(workspaceId);
        fileId2 = await uploadTestFile(workspaceId);
    });

    afterAll(async () => {
        await deleteFile(fileId);
        await deleteFile(fileId2);
    });

    it("creates, lists, and revokes a link", async () => {
        const create = await runCli(["share", fileId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(create.exitCode).toBe(0);
        const linkId = JSON.parse(create.stdout).link.id;

        const list = await runCli(["share", "list", "-w", workspaceId, "--json", "-k", apiKey]);
        expect(list.exitCode).toBe(0);
        const listed = JSON.parse(list.stdout);
        expect(listed.links.some((l: { link_id: string }) => l.link_id === linkId)).toBe(true);

        const revoke = await runCli(["share", "revoke", linkId, "--json", "-k", apiKey]);
        expect(revoke.exitCode).toBe(0);
        expect(JSON.parse(revoke.stdout).ok).toBe(true);
    });

    it("shares a bundle of files", async () => {
        const { stdout, exitCode } = await runCli([
            "share", "bundle", fileId, fileId2, "-w", workspaceId, "--json", "-k", apiKey,
        ]);
        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.link.file_count).toBe(2);
        expect(data.link.url).toBeTruthy();
    });
});
