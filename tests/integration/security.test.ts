import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runCli } from "../helpers";

const SECRET = "dos_SUPERSECRETKEY1234567890";

let configHome: string;

beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), "dosya-sec-"));
    mkdirSync(join(configHome, "dosya"), { recursive: true });
    writeFileSync(
        join(configHome, "dosya", "config.json"),
        JSON.stringify({
            api_key: SECRET,
            api_base: "https://api.dosya.dev",
            default_workspace: "ws_test",
        }),
    );
});

afterEach(() => {
    rmSync(configHome, { recursive: true, force: true });
});

/**
 * `config get --json` used to print the raw config file, so piping it into a
 * log or a bug report leaked the API key.
 */
describe("config get does not leak the API key", () => {
    it("omits the key from --json output", async () => {
        const { stdout, exitCode } = await runCli(["config", "get", "--json"], {
            XDG_CONFIG_HOME: configHome,
        });

        expect(exitCode).toBe(0);
        expect(stdout).not.toContain(SECRET);

        const data = JSON.parse(stdout);
        expect(data.api_key).toBe("<redacted>");
        expect(data.default_workspace).toBe("ws_test");
    });

    it("omits the key from text output", async () => {
        const { stdout, exitCode } = await runCli(["config", "get"], {
            XDG_CONFIG_HOME: configHome,
        });

        expect(exitCode).toBe(0);
        expect(stdout).not.toContain(SECRET);
    });

    it("refuses to read api_key as a config key", async () => {
        const { stdout, stderr, exitCode } = await runCli(["config", "get", "api_key"], {
            XDG_CONFIG_HOME: configHome,
        });

        expect(exitCode).not.toBe(0);
        expect(stdout).not.toContain(SECRET);
        expect(stderr).toContain("Unknown config key");
    });
});

describe("config file permissions", () => {
    it("writes the config file as owner-read/write only", async () => {
        const { exitCode } = await runCli(["config", "set", "default_workspace", "ws_other"], {
            XDG_CONFIG_HOME: configHome,
        });

        expect(exitCode).toBe(0);
        const mode = statSync(join(configHome, "dosya", "config.json")).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it("preserves other keys when setting one", async () => {
        await runCli(["config", "set", "default_workspace", "ws_other"], {
            XDG_CONFIG_HOME: configHome,
        });

        const { stdout } = await runCli(["config", "get", "--json"], {
            XDG_CONFIG_HOME: configHome,
        });

        const data = JSON.parse(stdout);
        expect(data.default_workspace).toBe("ws_other");
        // The credential must survive an unrelated config write
        expect(data.api_key).toBe("<redacted>");
        expect(data.api_base).toBe("https://api.dosya.dev");
    });
});

describe("destructive commands are guarded when running from source", () => {
    it("upgrade refuses to replace the bun interpreter", async () => {
        const { stderr, exitCode } = await runCli(["upgrade"], { XDG_CONFIG_HOME: configHome });

        expect(exitCode).toBe(2);
        expect(stderr).toContain("running from source");
    });
});

describe("usage errors exit with code 2", () => {
    it("rejects an unparseable --parallel instead of hanging", async () => {
        const { stderr, exitCode } = await runCli(
            ["upload", ".", "--recursive", "--parallel", "abc", "--workspace", "ws_x"],
            { XDG_CONFIG_HOME: configHome },
        );

        expect(exitCode).toBe(2);
        expect(stderr).toContain("Invalid --parallel");
    });

    it("rejects an unknown long flag", async () => {
        const { stderr, exitCode } = await runCli(["ls", "--bogus"], {
            XDG_CONFIG_HOME: configHome,
        });

        expect(exitCode).toBe(2);
        expect(stderr).toContain("Unknown flag");
    });

    it("rejects an invalid --lock mode without a round trip", async () => {
        const { stderr, exitCode } = await runCli(["share", "fil_x", "--lock", "view"], {
            XDG_CONFIG_HOME: configHome,
        });

        expect(exitCode).toBe(2);
        expect(stderr).toContain("Invalid --lock");
    });
});
