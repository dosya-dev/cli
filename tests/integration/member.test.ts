import { describe, it, expect, beforeAll } from "bun:test";
import { runCli, getWorkspaceId } from "../helpers";

describe("dosya member", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
    });

    describe("member list", () => {
        it("should list members", async () => {
            const { stdout, exitCode } = await runCli([
                "member", "list",
                "-w", workspaceId,
                "-k", apiKey,
            ]);

            expect(exitCode).toBe(0);
            // Should show table or "No members"
            const hasContent = stdout.includes("NAME") || stdout.includes("No members");
            expect(hasContent).toBe(true);
        });

        it("should list members as JSON", async () => {
            const { stdout, exitCode } = await runCli([
                "member", "list",
                "-w", workspaceId,
                "--json",
                "-k", apiKey,
            ]);

            expect(exitCode).toBe(0);
            const data = JSON.parse(stdout);
            expect(data.members).toBeDefined();
            expect(Array.isArray(data.members)).toBe(true);
        });

        it("should fail without workspace ID", async () => {
            const { exitCode, stderr } = await runCli([
                "member", "list",
                "-k", apiKey,
            ]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("Workspace ID required");
        });
    });

    describe("member invite", () => {
        it("should fail without email", async () => {
            const { exitCode, stderr } = await runCli([
                "member", "invite",
                "-w", workspaceId,
                "-k", apiKey,
            ]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("Email required");
        });

        it("should fail with invalid email", async () => {
            const { exitCode, stderr } = await runCli([
                "member", "invite",
                "--email", "not-an-email",
                "-w", workspaceId,
                "-k", apiKey,
            ]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("Invalid email");
        });

        it("should fail without workspace ID", async () => {
            const { exitCode, stderr } = await runCli([
                "member", "invite",
                "--email", "test@example.com",
                "-k", apiKey,
            ]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("Workspace ID required");
        });
    });

    describe("member help", () => {
        it("should show help", async () => {
            const { stdout, exitCode } = await runCli(["member", "--help"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Usage:");
            expect(stdout).toContain("member list");
            expect(stdout).toContain("member invite");
        });
    });
});
