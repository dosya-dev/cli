import { describe, it, expect, beforeAll } from "bun:test";
import { runCli, getWorkspaceId } from "../helpers";

describe("dosya ls", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
    });

    it("should list files in workspace", async () => {
        const { stdout, exitCode } = await runCli(["ls", workspaceId, "-k", apiKey]);

        expect(exitCode).toBe(0);
        // Should show table headers or "No files found."
        const hasContent = stdout.includes("NAME") || stdout.includes("No files found");
        expect(hasContent).toBe(true);
    });

    it("should list files as JSON", async () => {
        const { stdout, exitCode } = await runCli(["ls", workspaceId, "--json", "-k", apiKey]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.files).toBeDefined();
        expect(data.folders).toBeDefined();
        expect(data.pagination).toBeDefined();
    });

    it("should support --workspace flag", async () => {
        const { stdout, exitCode } = await runCli(["ls", "--workspace", workspaceId, "--json", "-k", apiKey]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.files).toBeDefined();
    });

    it("should support -w shorthand", async () => {
        const { stdout, exitCode } = await runCli(["ls", "-w", workspaceId, "-j", "-k", apiKey]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.files).toBeDefined();
    });

    it("should support --sort flag", async () => {
        const { exitCode } = await runCli(["ls", workspaceId, "--sort", "oldest", "-k", apiKey]);
        expect(exitCode).toBe(0);
    });

    it("should support --page flag", async () => {
        const { exitCode } = await runCli(["ls", workspaceId, "--page", "1", "-k", apiKey]);
        expect(exitCode).toBe(0);
    });

    it("should fail without workspace ID", async () => {
        const { exitCode, stderr } = await runCli(["ls", "-k", apiKey]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("Workspace ID required");
    });

    it("should show help with --help", async () => {
        const { stdout, exitCode } = await runCli(["ls", "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
    });
});
