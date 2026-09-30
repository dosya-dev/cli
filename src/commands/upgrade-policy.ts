/**
 * Trust rules for `dosya upgrade`.
 *
 * Upgrading is the one command that writes an executable over the running
 * binary, so it is the one command where `api_base` stops being a convenience
 * setting and becomes a trust anchor. The published sha256 travels with the
 * download, which makes it an integrity check against the wire and nothing
 * more: a host that serves the binary also serves its checksum.
 *
 * `apps/api/src/pages/api/cli/install.ts` already pins its download origin for
 * this reason and documents why. These rules hold the upgrade path to the same
 * invariant, rather than leaving it to whatever DOSYA_API_BASE or
 * `dosya config set api_base` happens to hold.
 */

/** The only remote origin an upgrade will install from without an opt-in. */
export const TRUSTED_UPGRADE_ORIGIN = "https://api.dosya.dev";

/**
 * Loopback spellings, allowed so that developing against a local apps/api
 * still works. Anyone who can answer on your loopback is already you.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True when `apiBase` is somewhere an upgrade may be downloaded from.
 *
 * Anything unparseable is untrusted: failing towards the refusal keeps a
 * malformed base from silently becoming a download host.
 */
export function isTrustedUpgradeBase(apiBase: string): boolean {
    let url: URL;
    try {
        url = new URL(apiBase);
    } catch {
        return false;
    }

    // Credentials in the base would be sent to the download host. Nothing we
    // publish needs them, so their presence means this is not our endpoint.
    if (url.username !== "" || url.password !== "") return false;

    // Compare origins rather than hostnames: this rejects http://api.dosya.dev
    // along with every other host, so a cleartext base cannot be substituted
    // in flight by anyone on the path.
    if (url.origin === TRUSTED_UPGRADE_ORIGIN) return true;

    if ((url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTNAMES.has(url.hostname)) {
        return true;
    }

    return false;
}

interface ParsedVersion {
    core: [number, number, number];
    prerelease: boolean;
}

function parseVersion(value: string): ParsedVersion | null {
    if (typeof value !== "string") return null;
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
    if (!m) return null;
    return {
        core: [Number(m[1]), Number(m[2]), Number(m[3])],
        prerelease: m[4] !== undefined,
    };
}

/**
 * True when installing `latest` would move the user backwards.
 *
 * The previous check was `latest === current`, which meant every version that
 * was not the installed one was installed, older ones included. An unparseable
 * version on either side counts as a downgrade: we would rather refuse a
 * strange release than roll someone onto a build whose bugs are public.
 */
export function isDowngrade(current: string, latest: string): boolean {
    const from = parseVersion(current);
    const to = parseVersion(latest);
    if (!from || !to) return true;

    for (let i = 0; i < 3; i++) {
        if (to.core[i] < from.core[i]) return true;
        if (to.core[i] > from.core[i]) return false;
    }

    // Same core version: 0.0.3-rc.1 precedes 0.0.3, so it is a step back.
    return to.prerelease && !from.prerelease;
}

/** True when `value` is a well-formed sha256 hex digest. */
export function isValidChecksum(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}
