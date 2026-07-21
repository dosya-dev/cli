import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { LIVE_API, runCli, getWorkspaceId, uploadTestFile, deleteFile } from "../helpers";

describe("dosya versions --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["versions", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});

describe.skipIf(!LIVE_API)("dosya versions + upload --version-of", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let fileId: string;
    let tmpPath: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        fileId = await uploadTestFile(workspaceId);
        tmpPath = join(process.env.TMPDIR || "/tmp", `dosya-version-${Date.now()}.txt`);
        await Bun.write(tmpPath, `new version body ${Date.now()}`);
    });

    afterAll(async () => {
        if (fileId) await deleteFile(fileId);
    });

    it("uploads a new version, lists versions, and restores an old one", async () => {
        const up = await runCli(["upload", tmpPath, "--version-of", fileId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(up.exitCode).toBe(0);

        const list = await runCli(["versions", fileId, "-w", workspaceId, "--json", "-k", apiKey]);
        expect(list.exitCode).toBe(0);
        const data = JSON.parse(list.stdout);
        expect(data.current_version).toBeGreaterThanOrEqual(2);
        expect(data.versions.length).toBeGreaterThanOrEqual(2);

        const restore = await runCli(["versions", "restore", fileId, "1", "-w", workspaceId, "--json", "-k", apiKey]);
        expect(restore.exitCode).toBe(0);
        expect(JSON.parse(restore.stdout).restored_from).toBe(1);
    });
});
