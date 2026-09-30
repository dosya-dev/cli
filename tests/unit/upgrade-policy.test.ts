import { describe, it, expect } from "bun:test";
import { isTrustedUpgradeBase, isDowngrade, isValidChecksum } from "../../src/commands/upgrade-policy";

/**
 * `dosya upgrade` downloads a binary, chmods it 0755 and renames it over the
 * running executable. The sha256 it checks comes from the same host as the
 * binary, so it proves only that the bytes arrived intact from whoever
 * answered - it says nothing about who answered.
 *
 * `api_base` is whatever DOSYA_API_BASE, `dosya config set api_base` or
 * `dosya auth login --api` last put there, with no scheme or host check, so
 * "whoever answered" was previously unconstrained.
 *
 * The install script at apps/api/src/pages/api/cli/install.ts already pins its
 * download origin for exactly this reason, and says so in a comment. These
 * tests hold `upgrade` to the same invariant.
 */
describe("isTrustedUpgradeBase", () => {
    it("accepts the production API origin", () => {
        expect(isTrustedUpgradeBase("https://api.dosya.dev")).toBe(true);
        expect(isTrustedUpgradeBase("https://api.dosya.dev/")).toBe(true);
    });

    it("rejects http for the production host, so a cleartext base cannot be substituted in flight", () => {
        expect(isTrustedUpgradeBase("http://api.dosya.dev")).toBe(false);
    });

    it("rejects every other host", () => {
        expect(isTrustedUpgradeBase("https://evil.example")).toBe(false);
        expect(isTrustedUpgradeBase("https://dosya.dev")).toBe(false);
        expect(isTrustedUpgradeBase("https://staging.dosya.dev")).toBe(false);
    });

    it("rejects a lookalike that merely starts or ends with the real host", () => {
        expect(isTrustedUpgradeBase("https://api.dosya.dev.evil.example")).toBe(false);
        expect(isTrustedUpgradeBase("https://notapi.dosya.dev")).toBe(false);
    });

    it("rejects embedded credentials rather than handing them to the download", () => {
        expect(isTrustedUpgradeBase("https://user:pw@api.dosya.dev")).toBe(false);
    });

    it("allows localhost over either scheme, so running against a local API still works", () => {
        for (const base of [
            "http://localhost:4322",
            "https://localhost:4322",
            "http://127.0.0.1:8788",
            "http://[::1]:4322",
        ]) {
            expect(isTrustedUpgradeBase(base)).toBe(true);
        }
    });

    it("rejects a LAN address that is not loopback", () => {
        expect(isTrustedUpgradeBase("http://192.168.1.10:4322")).toBe(false);
    });

    it("rejects an unparseable base instead of assuming it is fine", () => {
        expect(isTrustedUpgradeBase("not a url")).toBe(false);
        expect(isTrustedUpgradeBase("")).toBe(false);
    });
});

/**
 * The old code compared versions only for equality, so any version that was
 * not the installed one was installed - including an older one. A host that
 * can answer at all could therefore roll a user back onto a build whose bugs
 * are public.
 */
describe("isDowngrade", () => {
    it("allows a newer version at any level", () => {
        expect(isDowngrade("0.0.2", "0.0.3")).toBe(false);
        expect(isDowngrade("0.0.2", "0.1.0")).toBe(false);
        expect(isDowngrade("0.9.9", "1.0.0")).toBe(false);
    });

    it("flags an older version at any level", () => {
        expect(isDowngrade("0.0.3", "0.0.2")).toBe(true);
        expect(isDowngrade("0.1.0", "0.0.9")).toBe(true);
        expect(isDowngrade("1.0.0", "0.9.9")).toBe(true);
    });

    it("compares numerically, not as text", () => {
        // "10" sorts before "9" as a string; it must not here.
        expect(isDowngrade("0.0.9", "0.0.10")).toBe(false);
        expect(isDowngrade("0.0.10", "0.0.9")).toBe(true);
    });

    it("does not flag the same version", () => {
        expect(isDowngrade("0.0.2", "0.0.2")).toBe(false);
    });

    it("treats a prerelease as older than the release it precedes", () => {
        expect(isDowngrade("0.0.3", "0.0.3-rc.1")).toBe(true);
        expect(isDowngrade("0.0.2", "0.0.3-rc.1")).toBe(false);
    });

    it("fails closed when either version cannot be parsed", () => {
        expect(isDowngrade("0.0.2", "latest")).toBe(true);
        expect(isDowngrade("0.0.2", "")).toBe(true);
        expect(isDowngrade("garbage", "0.0.3")).toBe(true);
    });
});

/**
 * A malformed checksum already failed the comparison, so this is about the
 * error the user sees: "the server published a checksum we cannot use" is a
 * different problem from "the bytes were tampered with", and conflating them
 * sends people looking for an attacker when a release is simply broken.
 */
describe("isValidChecksum", () => {
    it("accepts a 64-character hex digest in either case", () => {
        expect(isValidChecksum("a".repeat(64))).toBe(true);
        expect(isValidChecksum("A".repeat(64))).toBe(true);
    });

    it("rejects the wrong length", () => {
        expect(isValidChecksum("a".repeat(63))).toBe(false);
        expect(isValidChecksum("a".repeat(65))).toBe(false);
        expect(isValidChecksum("")).toBe(false);
    });

    it("rejects non-hex characters", () => {
        expect(isValidChecksum("g".repeat(64))).toBe(false);
        expect(isValidChecksum(`${" ".repeat(1)}${"a".repeat(63)}`)).toBe(false);
    });

    it("rejects a value that is not a string at all", () => {
        // manifest.checksums comes from parsed JSON, so this is reachable.
        expect(isValidChecksum(undefined)).toBe(false);
        expect(isValidChecksum({} as unknown as string)).toBe(false);
    });
});
