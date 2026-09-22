import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runCli } from "../helpers";

const SECRET = "dos_STOREDKEY1234567890abcdef";

/**
 * These exercise the credential handling itself, so they run against a stub API
 * rather than `LIVE_API`: the behaviour under test is which bytes the CLI reads,
 * writes and sends, and none of it should need a real account to verify.
 */
interface StubRequest {
    method: string;
    path: string;
    authorization: string | null;
}

interface Stub {
    server: ReturnType<typeof Bun.serve>;
    url: string;
    requests: StubRequest[];
    /** Status returned by DELETE /api/me/api-keys/current. */
    revokeStatus: number;
}

function startStub(): Stub {
    const requests: StubRequest[] = [];
    const stub = {
        requests,
        revokeStatus: 200,
    } as Stub;

    stub.server = Bun.serve({
        port: 0,
        fetch(req) {
            const { pathname } = new URL(req.url);
            requests.push({
                method: req.method,
                path: pathname,
                authorization: req.headers.get("authorization"),
            });

            if (pathname === "/api/me" && req.method === "GET") {
                return Response.json({
                    ok: true,
                    user: { id: "usr_1", email: "u@example.com", name: "Test User" },
                });
            }

            if (pathname === "/api/me/api-keys/current" && req.method === "DELETE") {
                if (stub.revokeStatus !== 200) {
                    return Response.json(
                        { ok: false, error: "revoke failed" },
                        { status: stub.revokeStatus },
                    );
                }
                return Response.json({ ok: true });
            }

            return Response.json({ ok: false, error: "not found" }, { status: 404 });
        },
    });
    stub.url = `http://localhost:${stub.server.port}`;
    return stub;
}

let configHome: string;
let stub: Stub;

const configPath = () => join(configHome, "dosya", "config.json");
const readConfig = () => JSON.parse(readFileSync(configPath(), "utf-8"));

/** Env every case shares: point at the stub, never at the developer's key. */
const cliEnv = () => ({ XDG_CONFIG_HOME: configHome, DOSYA_API_BASE: stub.url });
const NO_AMBIENT_KEY = { unsetEnv: ["DOSYA_API_KEY"] };

beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), "dosya-auth-"));
    mkdirSync(join(configHome, "dosya"), { recursive: true });
    stub = startStub();
});

afterEach(() => {
    stub.server.stop(true);
    rmSync(configHome, { recursive: true, force: true });
});

/** Pre-authenticate, as `auth login` would have. */
function seedConfig(): void {
    writeFileSync(
        configPath(),
        JSON.stringify({ api_key: SECRET, api_base: stub.url, default_workspace: "ws_test" }),
        { mode: 0o600 },
    );
}

/**
 * argv is the loudest way to leak a credential: it is visible to `ps` for every
 * other user on stock Linux, it is written to shell history verbatim, and it is
 * echoed into CI logs. stdin is visible to nobody.
 */
describe("auth login accepts the key on stdin", () => {
    it("reads the key from stdin when --key is '-'", async () => {
        const { stdout, exitCode } = await runCli(
            ["auth", "login", "--key", "-"],
            cliEnv(),
            { ...NO_AMBIENT_KEY, stdin: "dos_FROMSTDIN0987654321\n" },
        );

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Test User");
        expect(readConfig().api_key).toBe("dos_FROMSTDIN0987654321");
        expect(stub.requests[0].authorization).toBe("Bearer dos_FROMSTDIN0987654321");
    });

    it("ignores surrounding whitespace from the pipe", async () => {
        const { exitCode } = await runCli(
            ["auth", "login", "--key", "-"],
            cliEnv(),
            { ...NO_AMBIENT_KEY, stdin: "  dos_PADDED1234567890abc  \n\n" },
        );

        expect(exitCode).toBe(0);
        expect(readConfig().api_key).toBe("dos_PADDED1234567890abc");
    });

    it("fails cleanly when stdin is empty", async () => {
        const { stderr, exitCode } = await runCli(
            ["auth", "login", "--key", "-"],
            cliEnv(),
            { ...NO_AMBIENT_KEY, stdin: "" },
        );

        expect(exitCode).toBe(2);
        expect(stderr).toContain("No API key on stdin");
        expect(existsSync(configPath())).toBe(false);
    });
});

describe("auth login discourages the key on the command line", () => {
    it("warns when the key is passed as an argv value", async () => {
        const { stderr, exitCode } = await runCli(
            ["auth", "login", "--key", "dos_ONARGV1234567890abcd"],
            cliEnv(),
            NO_AMBIENT_KEY,
        );

        expect(exitCode).toBe(0);
        expect(stderr).toContain("shell history");
        // The warning must never quote the key it is warning about
        expect(stderr).not.toContain("dos_ONARGV1234567890abcd");
    });

    it("does not warn when the key arrived on stdin", async () => {
        const { stderr } = await runCli(
            ["auth", "login", "--key", "-"],
            cliEnv(),
            { ...NO_AMBIENT_KEY, stdin: "dos_FROMSTDIN0987654321\n" },
        );

        expect(stderr).not.toContain("shell history");
    });

    it("recommends the environment variable ahead of --key when it cannot prompt", async () => {
        const { stderr, exitCode } = await runCli(["auth", "login"], cliEnv(), NO_AMBIENT_KEY);

        expect(exitCode).toBe(2);
        expect(stderr).toContain("DOSYA_API_KEY");
        expect(stderr).toContain("--key -");
        // Recommended first, not as the afterthought
        expect(stderr.indexOf("DOSYA_API_KEY")).toBeLessThan(stderr.indexOf("--key -"));
    });

    it("documents the safe forms in help without printing a copyable key", async () => {
        const { stdout } = await runCli(["auth", "--help"], cliEnv(), NO_AMBIENT_KEY);

        expect(stdout).toContain("--key -");
        expect(stdout).toContain("DOSYA_API_KEY");
        expect(stdout).not.toContain("--key dos_");
    });
});

/**
 * `auth logout` only ever deleted the local file. Someone logging out of a
 * borrowed or shared machine reasonably reads that as "this key is now dead",
 * and it was not: the credential stayed valid until they remembered to open the
 * dashboard. `--revoke` makes the reading true.
 */
describe("auth logout --revoke", () => {
    it("revokes the stored key server-side and clears the config", async () => {
        seedConfig();

        const { stdout, exitCode } = await runCli(
            ["auth", "logout", "--revoke"],
            cliEnv(),
            NO_AMBIENT_KEY,
        );

        expect(exitCode).toBe(0);
        expect(stub.requests).toEqual([
            {
                method: "DELETE",
                path: "/api/me/api-keys/current",
                authorization: `Bearer ${SECRET}`,
            },
        ]);
        expect(existsSync(configPath())).toBe(false);
        expect(stdout).toContain("revoked");
    });

    it("leaves the key alone without the flag", async () => {
        seedConfig();

        const { exitCode } = await runCli(["auth", "logout"], cliEnv(), NO_AMBIENT_KEY);

        expect(exitCode).toBe(0);
        expect(stub.requests).toEqual([]);
        expect(existsSync(configPath())).toBe(false);
    });

    /**
     * Deleting the local copy after a failed revoke destroys the only thing that
     * could retry it - the user is then left with a live key and no way to name
     * it from the CLI.
     */
    it("keeps the credential when the server refuses the revoke", async () => {
        seedConfig();
        stub.revokeStatus = 500;

        const { stderr, exitCode } = await runCli(
            ["auth", "logout", "--revoke"],
            cliEnv(),
            NO_AMBIENT_KEY,
        );

        expect(exitCode).not.toBe(0);
        expect(existsSync(configPath())).toBe(true);
        expect(readConfig().api_key).toBe(SECRET);
        // and it must say how to give up on revoking
        expect(stderr).toContain("dosya auth logout");
    });

    it("still clears the config when the key was already invalid", async () => {
        seedConfig();
        stub.revokeStatus = 401;

        const { stdout, exitCode } = await runCli(
            ["auth", "logout", "--revoke"],
            cliEnv(),
            NO_AMBIENT_KEY,
        );

        expect(exitCode).toBe(0);
        expect(existsSync(configPath())).toBe(false);
        expect(stdout).toContain("no longer valid");
    });

    it("is a no-op when nothing is stored", async () => {
        const { exitCode } = await runCli(["auth", "logout", "--revoke"], cliEnv(), NO_AMBIENT_KEY);

        expect(exitCode).toBe(0);
        expect(stub.requests).toEqual([]);
    });

    /**
     * An environment key is not what `logout` deletes, so revoking it here would
     * be a side effect nobody asked for - but silently doing nothing while the
     * user believes a key was killed is worse. Say which key is in play.
     */
    it("explains that an environment key is out of its reach", async () => {
        const { stdout, exitCode } = await runCli(
            ["auth", "logout", "--revoke"],
            { ...cliEnv(), DOSYA_API_KEY: "dos_FROMENV1234567890abcd" },
            {},
        );

        expect(exitCode).toBe(0);
        expect(stub.requests).toEqual([]);
        expect(stdout).toContain("DOSYA_API_KEY");
    });
});

/**
 * 401 and 403 both mean "this request was refused", but only 401 means the key
 * is dead. A key refused because of an IP allowlist or an active-hours window is
 * still live, and throwing away the local copy would strip the only handle the
 * user has on it.
 */
describe("auth logout --revoke distinguishes a refused key from a dead one", () => {
    it("keeps the credential when the key is refused but still live", async () => {
        seedConfig();
        stub.revokeStatus = 403;

        const { exitCode } = await runCli(
            ["auth", "logout", "--revoke"],
            cliEnv(),
            NO_AMBIENT_KEY,
        );

        expect(exitCode).not.toBe(0);
        expect(readConfig().api_key).toBe(SECRET);
    });
});

/**
 * `auth logout --help` used to log the user out and then print nothing: the
 * dispatcher matched the subcommand before it looked at --help. Asking a
 * destructive command to explain itself must never perform it.
 */
describe("auth logout --help", () => {
    it("prints help without clearing the credential", async () => {
        seedConfig();

        const { stdout, exitCode } = await runCli(
            ["auth", "logout", "--help"],
            cliEnv(),
            NO_AMBIENT_KEY,
        );

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
        expect(existsSync(configPath())).toBe(true);
    });
});

describe("auth login --help", () => {
    it("prints help instead of trying to authenticate", async () => {
        const { stdout, exitCode } = await runCli(
            ["auth", "login", "--help"],
            cliEnv(),
            NO_AMBIENT_KEY,
        );

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
        expect(stub.requests).toEqual([]);
    });
});
