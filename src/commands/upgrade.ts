import { existsSync, chmodSync, renameSync, unlinkSync, copyFileSync } from "fs";
import pkg from "../../package.json";
import { loadConfig, resolveApiBase } from "../config";
import { isCompiledBinary } from "../runtime";
import { log, fatal, EXIT } from "../output";

const HELP = `Upgrade the dosya CLI to the latest version.

Usage: dosya upgrade [flags]

Flags:
  --force, -f   Upgrade even if already on latest
  --help, -h    Show help

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

    const expectedChecksum = manifest.checksums?.[platform];
    if (!expectedChecksum) {
        fatal(
            `The server did not publish a checksum for ${platform}, so this upgrade cannot be verified. ` +
            `Download the binary manually from https://dosya.dev/developer/cli instead.`,
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
    if (actualChecksum !== expectedChecksum) {
        fatal(
            `Checksum mismatch - refusing to install.\n` +
            `  expected: ${expectedChecksum}\n` +
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
