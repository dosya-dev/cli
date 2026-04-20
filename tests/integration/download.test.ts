import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { runCli, getWorkspaceId, uploadTestFile, deleteFile } from "../helpers";

describe("dosya download", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let fileId: string;
    const tmpDir = join(import.meta.dir, "../.tmp-download-test");

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        fileId = await uploadTestFile(workspaceId);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(async () => {
        await deleteFile(fileId);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should download a file", async () => {
        const outputPath = join(tmpDir, "downloaded.txt");
        const { exitCode } = await runCli([
            "download", fileId,
            "-o", outputPath,
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        expect(existsSync(outputPath)).toBe(true);
    });

    it("should download to a directory (auto filename)", async () => {
        const { exitCode } = await runCli([
            "download", fileId,
            "-o", tmpDir,
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
    });

    it("should download with JSON output", async () => {
        const outputPath = join(tmpDir, "json-download.txt");
        const { stdout, exitCode } = await runCli([
            "download", fileId,
            "-o", outputPath,
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.ok).toBe(true);
        expect(data.file).toBeTruthy();
        expect(data.path).toBeTruthy();
    });

    it("should fail without file ID", async () => {
        const { exitCode, stderr } = await runCli(["download", "-k", apiKey]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("File ID required");
    });

    it("should fail with invalid file ID", async () => {
        const { exitCode, stderr } = await runCli([
            "download", "fil_nonexistent_xyz",
            "-o", tmpDir,
            "-k", apiKey,
        ]);

        expect(exitCode).not.toBe(0);
    });

    it("should show help with --help", async () => {
        const { stdout, exitCode } = await runCli(["download", "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
        expect(stdout).toContain("--connections");
    });
});
