import { describe, it, expect, beforeAll } from "bun:test";
import { runCli, getWorkspaceId, uploadTestFile } from "../helpers";

describe("dosya rm", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
    });

    it("should soft-delete a file", async () => {
        const fileId = await uploadTestFile(workspaceId);

        const { stdout, exitCode } = await runCli([
            "rm", fileId,
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.ok).toBe(true);
        expect(data.id).toBe(fileId);
    });

    it("should permanently delete a file with --permanent --force", async () => {
        const fileId = await uploadTestFile(workspaceId);

        const { stdout, exitCode } = await runCli([
            "rm", fileId,
            "--permanent", "--force",
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.ok).toBe(true);
        expect(data.permanent).toBe(true);
    });

    it("should accept -f shorthand for --force", async () => {
        const fileId = await uploadTestFile(workspaceId);

        const { stdout, exitCode } = await runCli([
            "rm", fileId,
            "--permanent", "-f",
            "--json",
            "-k", apiKey,
        ]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.permanent).toBe(true);
    });

    it("should fail without file ID", async () => {
        const { exitCode, stderr } = await runCli(["rm", "-k", apiKey]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("File ID required");
    });

    it("should show help with --help", async () => {
        const { stdout, exitCode } = await runCli(["rm", "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
        expect(stdout).toContain("--permanent");
    });
});
