import { describe, it, expect } from "bun:test";
import { runCli } from "../helpers";

describe("dosya config", () => {
    describe("config path", () => {
        it("should show config file path", async () => {
            const { stdout, exitCode } = await runCli(["config", "path"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("config.json");
        });

        it("should show config path as JSON", async () => {
            const { stdout, exitCode } = await runCli(["config", "path", "--json"]);

            expect(exitCode).toBe(0);
            const data = JSON.parse(stdout);
            expect(data.path).toContain("config.json");
        });
    });

    describe("config get", () => {
        it("should show all config (may be empty for test env)", async () => {
            const { exitCode } = await runCli(["config", "get"]);
            // Exits 0 regardless of whether config exists
            expect(exitCode).toBe(0);
        });

        it("should get a specific key", async () => {
            const { exitCode } = await runCli(["config", "get", "api_base"]);
            expect(exitCode).toBe(0);
        });

        it("should fail for unknown config key", async () => {
            const { exitCode, stderr } = await runCli(["config", "get", "unknown_key"]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("Unknown config key");
        });
    });

    describe("config set", () => {
        it("should fail without key and value", async () => {
            const { exitCode, stderr } = await runCli(["config", "set"]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("Usage:");
        });

        it("should fail for unknown config key", async () => {
            const { exitCode, stderr } = await runCli(["config", "set", "bad_key", "value"]);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain("Unknown config key");
        });
    });

    describe("config help", () => {
        it("should show help", async () => {
            const { stdout, exitCode } = await runCli(["config", "--help"]);

            expect(exitCode).toBe(0);
            expect(stdout).toContain("Usage:");
            expect(stdout).toContain("config get");
            expect(stdout).toContain("config set");
            expect(stdout).toContain("config path");
        });
    });
});
