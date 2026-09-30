import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * The guard in upgrade-policy.ts only protects anyone if `dosya upgrade`
 * actually calls it, and the call site sits behind `isCompiledBinary()` - a
 * source run exits before reaching it. So this compiles a real binary (about
 * 200ms) and runs the command the way a user would.
 *
 * Nothing here touches the network on purpose: the whole point of the host
 * check is that it refuses *before* contacting the host, and the cases that do
 * get past it are pointed at a closed loopback port.
 */

let binary: string;
let home: string;

beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "dosya-upgrade-guard-"));
    binary = join(home, "dosya");
    const build = Bun.spawnSync(["bun", "build", "--compile", "src/index.ts", "--outfile", binary]);
    if (build.exitCode !== 0) {
        throw new Error(`could not build test binary: ${build.stderr.toString()}`);
    }

    // An unsigned Bun executable is SIGKILLed on arm64 macOS with no message
    // (exit 137), which would make every assertion below fail against an empty
    // stderr. scripts/sign.ts exists for the same reason.
    if (process.platform === "darwin") {
        const signed = Bun.spawnSync(["ldid", "-S", binary]);
        if (signed.exitCode !== 0) {
            throw new Error("could not sign the test binary - install ldid: brew install ldid");
        }
    }
});

afterAll(() => {
    rmSync(home, { recursive: true, force: true });
});

/**
 * Run `dosya upgrade` with an isolated config dir, so the developer's real
 * ~/.dosya (and its API key) is never read and never written.
 */
function runUpgrade(apiBase: string, ...args: string[]) {
    const proc = Bun.spawnSync([binary, "upgrade", ...args], {
        env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            XDG_CONFIG_HOME: home,
            DOSYA_API_BASE: apiBase,
        },
    });
    return { code: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() };
}

describe("dosya upgrade host guard", () => {
    it("refuses an untrusted api_base, and says so rather than downloading", () => {
        const { code, stderr } = runUpgrade("https://evil.example");
        expect(stderr).toContain("Refusing to upgrade from https://evil.example");
        expect(stderr).toContain("https://api.dosya.dev");
        expect(code).toBe(2);
    });

    it("refuses before it contacts the host at all", () => {
        // 203.0.113.0/24 is TEST-NET-3 and routes nowhere, so a fetch would
        // stall until the 30s timeout. Returning promptly is the evidence that
        // no request was made.
        const started = Date.now();
        const { code, stderr } = runUpgrade("https://203.0.113.1");
        expect(stderr).toContain("Refusing to upgrade");
        expect(code).toBe(2);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("refuses http even for the real API host, so the scheme cannot be downgraded", () => {
        const { code, stderr } = runUpgrade("http://api.dosya.dev");
        expect(stderr).toContain("Refusing to upgrade");
        expect(code).toBe(2);
    });

    it("lets --allow-custom-host through, with a warning instead of a refusal", () => {
        // .invalid never resolves (RFC 2606), so this gets past the guard and
        // then fails at the network step - which is what proves it passed.
        const { code, stderr } = runUpgrade("https://untrusted.invalid", "--allow-custom-host");
        expect(stderr).not.toContain("Refusing to upgrade");
        expect(stderr).toContain("warning:");
        expect(stderr).toContain("you are trusting that host");
        expect(code).toBe(4);
    });

    it("allows a loopback base with no opt-in, so local development still works", () => {
        const { code, stderr } = runUpgrade("http://127.0.0.1:1");
        expect(stderr).not.toContain("Refusing to upgrade");
        expect(code).toBe(4);
    });
});
