import { describe, it, expect, afterAll } from "bun:test";
import { runCli, getClient } from "../helpers";

describe("dosya workspace", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let createdWorkspaceId: string;

    afterAll(async () => {
        if (createdWorkspaceId) {
            const client = getClient();
            try {
                await client.del(`/api/workspaces/${createdWorkspaceId}`);
            } catch { /* already cleaned up */ }
        }
    });

    describe("workspace list", () => {
        it("should list workspaces", async () => {
            const { stdout, exitCode } = await runCli(["workspace", "list", "-k", apiKey]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("ID");
            expect(stdout).toContain("NAME");
        });

        it("should list workspaces as JSON", async () => {
            const { stdout, exitCode } = await runCli(["workspace", "list", "--json", "-k", apiKey]);

            expect(exitCode).toBe(0);
            const data = JSON.parse(stdout);
            expect(data.workspaces).toBeDefined();
            expect(Array.isArray(data.workspaces)).toBe(true);
        });
    });

    describe("workspace create", () => {
        it("should create a workspace", async () => {
            const name = `CLI Test ${Date.now()}`;
            const { stdout, exitCode } = await runCli([
                "workspace", "create", "--name", name, "--json", "-k", apiKey,
            ]);

            expect(exitCode).toBe(0);
            const data = JSON.parse(stdout);
            expect(data.id).toBeTruthy();
            expect(data.name).toBe(name);
            createdWorkspaceId = data.id;
        });

        it("should fail without --name", async () => {
            const { exitCode, stderr } = await runCli(["workspace", "create", "-k", apiKey]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("name");
        });
    });

    describe("workspace delete", () => {
        it("should delete a workspace with --force", async () => {
            // Create a workspace to delete
            const client = getClient();
            const data = await client.post<{ ok: boolean; id: string }>("/api/workspaces", {
                name: `Delete Test ${Date.now()}`,
            });

            const { stdout, exitCode } = await runCli([
                "workspace", "delete", data.id, "--force", "--json", "-k", apiKey,
            ]);

            expect(exitCode).toBe(0);
            const result = JSON.parse(stdout);
            expect(result.ok).toBe(true);
            expect(result.deleted).toBe(data.id);
        });
    });

    describe("workspace help", () => {
        it("should show help with --help", async () => {
            const { stdout, exitCode } = await runCli(["workspace", "--help"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Usage:");
            expect(stdout).toContain("workspace list");
            expect(stdout).toContain("workspace create");
            expect(stdout).toContain("workspace delete");
        });

        it("should show help with no subcommand", async () => {
            const { stdout, exitCode } = await runCli(["workspace"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Usage:");
        });
    });
});
