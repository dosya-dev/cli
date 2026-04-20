import { describe, it, expect } from "bun:test";
import { runCli } from "../helpers";

describe("dosya completion", () => {
    it("should generate bash completion", async () => {
        const { stdout, exitCode } = await runCli(["completion", "bash"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("_dosya_completions");
        expect(stdout).toContain("complete -F");
        expect(stdout).toContain("upload");
        expect(stdout).toContain("download");
    });

    it("should generate zsh completion", async () => {
        const { stdout, exitCode } = await runCli(["completion", "zsh"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("#compdef dosya");
        expect(stdout).toContain("_dosya");
        expect(stdout).toContain("upload");
    });

    it("should generate fish completion", async () => {
        const { stdout, exitCode } = await runCli(["completion", "fish"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("complete -c dosya");
        expect(stdout).toContain("upload");
        expect(stdout).toContain("download");
    });

    it("should fail for unsupported shell", async () => {
        const { exitCode, stderr } = await runCli(["completion", "powershell"]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("Unsupported shell");
    });

    it("should fail without shell argument", async () => {
        const { exitCode, stderr } = await runCli(["completion"]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("Shell required");
    });

    it("should show help with --help", async () => {
        const { stdout, exitCode } = await runCli(["completion", "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
        expect(stdout).toContain("bash");
        expect(stdout).toContain("zsh");
        expect(stdout).toContain("fish");
    });
});
