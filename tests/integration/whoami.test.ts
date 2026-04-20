import { describe, it, expect } from "bun:test";
import { runCli } from "../helpers";

describe("dosya whoami", () => {
    it("should show user info", async () => {
        const { stdout, exitCode } = await runCli(["whoami", "-k", process.env.DOSYA_TEST_API_KEY!]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Name:");
        expect(stdout).toContain("Email:");
        expect(stdout).toContain("ID:");
        expect(stdout).toContain("Workspaces:");
    });

    it("should output JSON with --json flag", async () => {
        const { stdout, exitCode } = await runCli(["whoami", "--json", "-k", process.env.DOSYA_TEST_API_KEY!]);

        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data.id).toBeTruthy();
        expect(data.email).toBeTruthy();
        expect(data.name).toBeTruthy();
    });

    it("should fail with invalid API key", async () => {
        const { exitCode, stderr } = await runCli(["whoami", "-k", "dos_invalid_key_xyz"]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("error");
    });

    it("should show help with --help", async () => {
        const { stdout, exitCode } = await runCli(["whoami", "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
        expect(stdout).toContain("whoami");
    });
});
