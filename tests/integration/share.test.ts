import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { runCli, getWorkspaceId, uploadTestFile, deleteFile } from "../helpers";

describe("dosya share", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let fileId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        fileId = await uploadTestFile(workspaceId);
    });

    afterAll(async () => {
        await deleteFile(fileId);
    });

    it("should create a share link", async () => {
        const { stdout, exitCode } = await runCli([
            "share", fileId,
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("http");
    });

    it("should create a share link with JSON output", async () => {
        const { stdout, exitCode } = await runCli([
            "share", fileId,
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.link).toBeDefined();
        expect(data.link.token).toBeTruthy();
        expect(data.link.url).toBeTruthy();
    });

    it("should create a share link with expiration", async () => {
        const { stdout, exitCode } = await runCli([
            "share", fileId,
            "--expires", "7d",
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.link.expires_at).toBeTruthy();
    });

    it("should create a share link with password", async () => {
        const { stdout, exitCode } = await runCli([
            "share", fileId,
            "--password", "test1234",
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.link).toBeDefined();
    });

    it("should accept expires without 'd' suffix", async () => {
        const { exitCode } = await runCli([
            "share", fileId,
            "--expires", "30",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
    });

    it("should fail without file ID", async () => {
        const { exitCode, stderr } = await runCli(["share", "-k", apiKey]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("File ID required");
    });

    it("should show help with --help", async () => {
        const { stdout, exitCode } = await runCli(["share", "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});
