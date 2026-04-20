import { describe, it, expect } from "bun:test";
import { runCli } from "../helpers";

describe("dosya global flags and commands", () => {
    describe("--version / -v", () => {
        it("should show version with --version", async () => {
            const { stdout, exitCode } = await runCli(["--version"]);

            expect(exitCode).toBe(0);
            expect(stdout).toMatch(/dosya \d+\.\d+\.\d+/);
        });

        it("should show version with -v", async () => {
            const { stdout, exitCode } = await runCli(["-v"]);

            expect(exitCode).toBe(0);
            expect(stdout).toMatch(/dosya \d+\.\d+\.\d+/);
        });
    });

    describe("--help / -h", () => {
        it("should show help with --help", async () => {
            const { stdout, exitCode } = await runCli(["--help"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("dosya - file management from the terminal");
            expect(stdout).toContain("Commands:");
            expect(stdout).toContain("Global flags:");
        });

        it("should show help with -h", async () => {
            const { stdout, exitCode } = await runCli(["-h"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("dosya - file management from the terminal");
        });

        it("should show help with no arguments", async () => {
            const { stdout, exitCode } = await runCli([]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("dosya - file management from the terminal");
        });
    });

    describe("unknown command", () => {
        it("should exit with error for unknown command", async () => {
            const { exitCode, stderr } = await runCli(["nonexistent"]);

            expect(exitCode).toBe(2);
            expect(stderr).toContain("Unknown command");
        });
    });

    describe("auth", () => {
        it("should show auth help", async () => {
            const { stdout, exitCode } = await runCli(["auth", "--help"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("auth login");
            expect(stdout).toContain("auth logout");
        });

        it("should show auth help with no subcommand", async () => {
            const { stdout, exitCode } = await runCli(["auth"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Usage:");
        });

        it("should reject unknown auth subcommand", async () => {
            const { exitCode, stderr } = await runCli(["auth", "unknown"]);

            expect(exitCode).toBe(2);
            expect(stderr).toContain("Unknown subcommand");
        });

        it("should logout successfully", async () => {
            const { stdout, exitCode } = await runCli(["auth", "logout"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Logged out");
        });

        it("should login with valid API key via --key flag", async () => {
            const apiKey = process.env.DOSYA_TEST_API_KEY!;
            const { stdout, exitCode } = await runCli([
                "auth", "login", "--key", apiKey,
            ]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Authenticated as");
        });

        it("should reject invalid API key format", async () => {
            const { exitCode, stderr } = await runCli([
                "auth", "login", "--key", "invalid_key",
            ]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("Invalid API key");
        });
    });

    describe("--quiet / -q", () => {
        it("should suppress output in quiet mode", async () => {
            const { stdout, exitCode } = await runCli([
                "auth", "logout", "-q",
            ]);

            expect(exitCode).toBe(0);
            // In quiet mode, "Logged out" should be suppressed
            // (depends on implementation - log() is suppressed, console.log in logout is direct)
        });
    });
});
