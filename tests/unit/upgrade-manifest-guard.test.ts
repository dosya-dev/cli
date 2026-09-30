import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pkg from "../../package.json";

/**
 * The checks that need a manifest to exist: the downgrade refusal and the
 * checksum handling. A loopback origin is trusted by isTrustedUpgradeBase, so
 * a local server is enough to drive the whole command without reaching the
 * network or the real API.
 */

let binary: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let origin: string;

/** What getPlatform() will return on the machine running these tests. */
const platform = (() => {
    const key = `${process.platform}-${process.arch}`;
    const map: Record<string, string> = {
        "linux-x64": "linux",
        "darwin-arm64": "mac-arm64",
        "darwin-x64": "mac-x64",
        "win32-x64": "windows",
    };
    return map[key];
})();

/** Set by each test to whatever /api/cli/version should answer. */
let manifest: unknown = {};
/** Set by each test to the bytes /api/cli/latest should serve. */
let payload = "replacement-binary";

beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "dosya-upgrade-manifest-"));
    binary = join(home, "dosya");
    const build = Bun.spawnSync(["bun", "build", "--compile", "src/index.ts", "--outfile", binary]);
    if (build.exitCode !== 0) {
        throw new Error(`could not build test binary: ${build.stderr.toString()}`);
    }
    if (process.platform === "darwin") {
        const signed = Bun.spawnSync(["ldid", "-S", binary]);
        if (signed.exitCode !== 0) {
            throw new Error("could not sign the test binary - install ldid: brew install ldid");
        }
    }

    server = Bun.serve({
        port: 0,
        fetch(req) {
            const { pathname } = new URL(req.url);
            if (pathname === "/api/cli/version") {
                return new Response(JSON.stringify(manifest), {
                    headers: { "Content-Type": "application/json" },
                });
            }
            if (pathname === "/api/cli/latest") {
                return new Response(payload);
            }
            return new Response("not found", { status: 404 });
        },
    });
    origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
    server?.stop(true);
    rmSync(home, { recursive: true, force: true });
});

/**
 * Async on purpose: the server above lives in this process, and Bun.spawnSync
 * would block the event loop so it could never answer the request the child is
 * waiting on. That deadlock looks exactly like a hung CLI.
 */
async function runUpgrade(...args: string[]) {
    const proc = Bun.spawn([binary, "upgrade", ...args], {
        env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            XDG_CONFIG_HOME: home,
            DOSYA_API_BASE: origin,
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stderr, stdout };
}

const VALID_SUM = "a".repeat(64);

describe("dosya upgrade manifest handling", () => {
    it("refuses a version older than the installed one", async () => {
        manifest = { version: "0.0.1", checksums: { [platform]: VALID_SUM } };
        const { code, stderr } = await runUpgrade();
        expect(stderr).toContain(`Refusing to install 0.0.1 over ${pkg.version}`);
        expect(code).toBe(1);
    });

    it("lets --force past the downgrade refusal", async () => {
        manifest = { version: "0.0.1", checksums: { [platform]: VALID_SUM } };
        const { stderr } = await runUpgrade("--force");
        expect(stderr).not.toContain("Refusing to install");
    });

    it("names a malformed checksum as a broken release, not a tampered download", async () => {
        manifest = { version: "9.9.9", checksums: { [platform]: "not-a-sha256" } };
        const { code, stderr } = await runUpgrade();
        expect(stderr).toContain("malformed checksum");
        expect(stderr).not.toContain("Checksum mismatch");
        expect(code).toBe(1);
    });

    it("still refuses a release that publishes no checksum at all", async () => {
        manifest = { version: "9.9.9", checksums: {} };
        const { code, stderr } = await runUpgrade();
        expect(stderr).toContain("did not publish a checksum");
        expect(code).toBe(1);
    });

    it("refuses bytes that do not match the published checksum, and leaves the binary alone", async () => {
        manifest = { version: "9.9.9", checksums: { [platform]: VALID_SUM } };
        payload = "this is not the advertised binary";
        const before = statSync(binary);

        const { code, stderr } = await runUpgrade();

        expect(stderr).toContain("Checksum mismatch");
        expect(code).toBe(1);
        const after = statSync(binary);
        expect(after.size).toBe(before.size);
        expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it("accepts bytes that do match, proving the guards do not block a real upgrade", async () => {
        payload = "a genuine new build";
        const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
        manifest = { version: "9.9.9", checksums: { [platform]: digest } };

        const { code, stdout } = await runUpgrade();

        expect(stdout).toContain("Checksum verified.");
        expect(stdout).toContain("Upgraded to 9.9.9.");
        expect(code).toBe(0);
        expect(await Bun.file(binary).text()).toBe(payload);
    });
});
