import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { runCli, getWorkspaceId, deleteFile } from "../helpers";

describe("dosya upload", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    const tmpDir = join(import.meta.dir, "../.tmp-upload-test");
    const filesToCleanup: string[] = [];

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();

        // Create temp test files
        mkdirSync(tmpDir, { recursive: true });
        writeFileSync(join(tmpDir, "test-file.txt"), "Hello from CLI test!");
        mkdirSync(join(tmpDir, "subdir"), { recursive: true });
        writeFileSync(join(tmpDir, "subdir", "nested.txt"), "Nested file content");
    });

    afterAll(async () => {
        // Cleanup uploaded files
        for (const id of filesToCleanup) {
            await deleteFile(id);
        }
        // Cleanup temp dir
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should upload a single file", async () => {
        const { stdout, exitCode } = await runCli([
            "upload", join(tmpDir, "test-file.txt"),
            "-w", workspaceId,
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.file).toBeDefined();
        expect(data.file.id).toBeTruthy();
        expect(data.file.name).toBe("test-file.txt");
        filesToCleanup.push(data.file.id);
    });

    it("should upload a directory recursively", async () => {
        const { stdout, exitCode } = await runCli([
            "upload", tmpDir,
            "-w", workspaceId,
            "--recursive",
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.uploaded).toBeGreaterThanOrEqual(2);
        expect(data.failed).toBe(0);
        expect(Array.isArray(data.files)).toBe(true);

        // Cleanup uploaded files
        for (const f of data.files) {
            filesToCleanup.push(f.file.id);
        }
    });

    it("should fail without file path", async () => {
        const { exitCode, stderr } = await runCli([
            "upload",
            "-w", workspaceId,
            "-k", apiKey,
        ]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("File path required");
    });

    it("should fail without workspace ID", async () => {
        const { exitCode, stderr } = await runCli([
            "upload", join(tmpDir, "test-file.txt"),
            "-k", apiKey,
        ]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("Workspace ID required");
    });

    it("should fail for non-existent file", async () => {
        const { exitCode, stderr } = await runCli([
            "upload", "/tmp/nonexistent-file-xyz.txt",
            "-w", workspaceId,
            "-k", apiKey,
        ]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("File not found");
    });

    it("should fail for directory without --recursive", async () => {
        const { exitCode, stderr } = await runCli([
            "upload", tmpDir,
            "-w", workspaceId,
            "-k", apiKey,
        ]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("--recursive");
    });

    it("should show help with --help", async () => {
        const { stdout, exitCode } = await runCli(["upload", "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});
