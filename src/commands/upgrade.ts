import { existsSync, chmodSync, renameSync, unlinkSync, copyFileSync } from "fs";
import pkg from "../../package.json";
import { loadConfig, resolveApiBase } from "../config";
import { isCompiledBinary } from "../runtime";
import { log, warn, fatal, EXIT } from "../output";
import { isTrustedUpgradeBase, isDowngrade, isValidChecksum, TRUSTED_UPGRADE_ORIGIN } from "./upgrade-policy";

const HELP = `Upgrade the dosya CLI to the latest version.

Usage: dosya upgrade [flags]

Flags:
  --force, -f          Upgrade even if already on latest, or to an older version
  --allow-custom-host  Install from an api_base other than the official API
  --help, -h           Show help

The binary is downloaded from ${TRUSTED_UPGRADE_ORIGIN} regardless of api_base,
unless you pass --allow-custom-host. The published checksum comes from the same
host as the download, so it shows the bytes arrived intact - not who sent them.

Examples:
  dosya upgrade
  dosya upgrade --force`;

export function upgradeHelp(): void {
    console.log(HELP);
}

interface VersionManifest {
    version: string;
    /** sha256 hex digests keyed by platform, published by the release workflow. */
    checksums?: Record<string, string>;
}

function getPlatform(): string {
    const os = process.platform;
    const arch = process.arch;

    if (os === "linux" && arch === "x64") return "linux";
    if (os === "darwin" && arch === "arm64") return "mac-arm64";
    if (os === "darwin" && arch === "x64") return "mac-x64";
    if (os === "win32" && arch === "x64") return "windows";

    fatal(`Unsupported platform: ${os}-${arch}`, EXIT.ERROR);
}

function sha256(bytes: ArrayBuffer): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function upgrade(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { upgradeHelp(); return; }

    if (!isCompiledBinary()) {
        fatal(
            "dosya upgrade only works on an installed dosya binary. " +
            "You are running from source - use git to update this checkout instead.",
            EXIT.USAGE,
        );
    }

    const currentVersion = pkg.version;
    const binaryPath = process.execPath;
    const platform = getPlatform();
    const apiBase = resolveApiBase(await loadConfig()).replace(/\/$/, "");

    // Before anything is fetched. This command writes an executable over the
    // running binary, and the checksum it verifies is published by the same
    // host that serves the download, so the host is the trust anchor - not the
    // checksum. api_base is set by DOSYA_API_BASE, `dosya config set api_base`
    // or `dosya auth login --api`, none of which validate it.
    if (!isTrustedUpgradeBase(apiBase)) {
        if (flags["allow-custom-host"] === undefined) {
            fatal(
                `Refusing to upgrade from ${apiBase}.\n` +
                `  This installs a binary over ${binaryPath}, and the checksum that would\n` +
                `  verify it is published by that same host, so it cannot vouch for itself.\n` +
                `  Only ${TRUSTED_UPGRADE_ORIGIN} (or a loopback address) is trusted here.\n` +
                `  Unset DOSYA_API_BASE, or run: dosya config set api_base ${TRUSTED_UPGRADE_ORIGIN}\n` +
                `  If you deliberately host your own builds, pass --allow-custom-host.`,
                EXIT.USAGE,
            );
        }
        warn(
            `Installing from ${apiBase}, not ${TRUSTED_UPGRADE_ORIGIN}. ` +
            `--allow-custom-host means you are trusting that host to replace ${binaryPath}.`,
        );
    }

    log(`Current version: ${currentVersion}`);
    log("Checking for updates...");

    let manifest: VersionManifest;
    try {
        const res = await fetch(`${apiBase}/api/cli/version`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) {
            fatal(`Could not check for updates (HTTP ${res.status}). Try again later.`, EXIT.NETWORK);
        }
        manifest = (await res.json()) as VersionManifest;
    } catch {
        fatal(`Could not reach ${apiBase}. Check your connection.`, EXIT.NETWORK);
    }

    const latestVersion = manifest.version;
    const isForce = flags.force !== undefined;

    if (latestVersion === currentVersion && !isForce) {
        log(`Already on latest version (${currentVersion}).`);
        return;
    }

    if (isDowngrade(currentVersion, latestVersion) && !isForce) {
        fatal(
            `Refusing to install ${latestVersion} over ${currentVersion} - that is not an upgrade.\n` +
            `  Moving backwards would reinstall bugs this version already fixed.\n` +
            `  Pass --force if you meant to do this.`,
            EXIT.ERROR,
        );
    }

    const expectedChecksum = manifest.checksums?.[platform];
    if (!expectedChecksum) {
        fatal(
            `The server did not publish a checksum for ${platform}, so this upgrade cannot be verified. ` +
            `Download the binary manually from https://dosya.dev/developer/cli instead.`,
            EXIT.ERROR,
        );
    }

    if (!isValidChecksum(expectedChecksum)) {
        fatal(
            `The server published a malformed checksum for ${platform}, so this upgrade ` +
            `cannot be verified. This is a broken release rather than a tampered download - ` +
            `report it, and install manually from https://dosya.dev/developer/cli meanwhile.`,
            EXIT.ERROR,
        );
    }

    log(`Latest version:  ${latestVersion}`);
    log("Downloading...");

    let binary: ArrayBuffer;
    try {
        const res = await fetch(`${apiBase}/api/cli/latest?platform=${platform}`, {
            signal: AbortSignal.timeout(300_000),
        });
        if (!res.ok) {
            fatal(`Download failed: HTTP ${res.status}`, EXIT.NETWORK);
        }
        binary = await res.arrayBuffer();
    } catch {
        fatal("Download failed. Check your connection.", EXIT.NETWORK);
    }

    // Verify before anything touches disk
    const actualChecksum = sha256(binary);
    // Lowercased on both sides: the digest we compute is lowercase hex, and a
    // release that published uppercase would otherwise never match.
    const wantChecksum = expectedChecksum.toLowerCase();
    if (actualChecksum !== wantChecksum) {
        fatal(
            `Checksum mismatch - refusing to install.\n` +
            `  expected: ${wantChecksum}\n` +
            `  actual:   ${actualChecksum}`,
            EXIT.ERROR,
        );
    }
    log("Checksum verified.");

    const tmpPath = binaryPath + ".tmp";
    try {
        await Bun.write(tmpPath, binary);
        chmodSync(tmpPath, 0o755);

        // Sign on macOS so Gatekeeper doesn't kill the replaced binary
        if (process.platform === "darwin") {
            try {
                const proc = Bun.spawnSync(["ldid", "-S", tmpPath]);
                if (proc.exitCode !== 0) {
                    // ldid not available, try clearing the quarantine attribute
                    Bun.spawnSync(["xattr", "-d", "com.apple.quarantine", tmpPath]);
                }
            } catch {
                // Signing not available, continue anyway
            }
        }

        try {
            renameSync(tmpPath, binaryPath);
        } catch {
            // rename may fail across filesystems, try copy
            copyFileSync(tmpPath, binaryPath);
            unlinkSync(tmpPath);
        }
    } catch (err) {
        if (existsSync(tmpPath)) {
            try { unlinkSync(tmpPath); } catch {}
        }

        const msg = (err as Error).message;
        if (msg.includes("permission") || msg.includes("EACCES") || msg.includes("EPERM")) {
            fatal(`Permission denied writing to ${binaryPath}. Try: sudo dosya upgrade`, EXIT.ERROR);
        }
        fatal(`Upgrade failed: ${msg}`, EXIT.ERROR);
    }

    log(`Upgraded to ${latestVersion}.`);
}
