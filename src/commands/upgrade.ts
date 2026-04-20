import { existsSync } from "fs";
import pkg from "../../package.json";
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

function getPlatform(): string {
    const os = process.platform;
    const arch = process.arch;

    if (os === "linux" && arch === "x64") return "linux";
    if (os === "darwin" && arch === "arm64") return "mac-arm64";
    if (os === "darwin" && arch === "x64") return "mac-x64";
    if (os === "win32" && arch === "x64") return "windows";

    fatal(`Unsupported platform: ${os}-${arch}`, EXIT.ERROR);
    return "";
}

export async function upgrade(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { upgradeHelp(); return; }

    const currentVersion = pkg.version;
    const binaryPath = process.execPath;
    const platform = getPlatform();

    // Fetch latest version info
    log(`Current version: ${currentVersion}`);
    log("Checking for updates...");

    let latestVersion: string;
    try {
        const res = await fetch("https://dosya.dev/api/cli/version");
        if (!res.ok) {
            fatal("Could not check for updates. Try again later.", EXIT.NETWORK);
        }
        const data = (await res.json()) as { version: string };
        latestVersion = data.version;
    } catch {
        fatal("Could not reach dosya.dev. Check your connection.", EXIT.NETWORK);
        return;
    }

    if (latestVersion === currentVersion && flags.force === undefined && flags.f === undefined) {
        log(`Already on latest version (${currentVersion}).`);
        return;
    }

    log(`Latest version:  ${latestVersion}`);
    log(`Downloading...`);

    // Download new binary
    const downloadUrl = `https://dosya.dev/api/cli/latest?platform=${platform}`;
    let binary: ArrayBuffer;
    try {
        const res = await fetch(downloadUrl);
        if (!res.ok) {
            fatal(`Download failed: ${res.status}`, EXIT.NETWORK);
        }
        binary = await res.arrayBuffer();
    } catch {
        fatal("Download failed. Check your connection.", EXIT.NETWORK);
        return;
    }

    // Write to temp file, then replace
    const tmpPath = binaryPath + ".tmp";
    try {
        await Bun.write(tmpPath, binary);

        // Make executable
        const { chmodSync } = await import("fs");
        chmodSync(tmpPath, 0o755);

        // Sign on macOS
        if (process.platform === "darwin") {
            try {
                const proc = Bun.spawnSync(["ldid", "-S", tmpPath]);
                if (proc.exitCode !== 0) {
                    // ldid not available, try xattr
                    Bun.spawnSync(["xattr", "-d", "com.apple.quarantine", tmpPath]);
                }
            } catch {
                // Signing not available, continue anyway
            }
        }

        // Replace old binary
        const { renameSync, unlinkSync } = await import("fs");
        try {
            renameSync(tmpPath, binaryPath);
        } catch {
            // rename may fail across filesystems, try copy
            const { copyFileSync } = await import("fs");
            copyFileSync(tmpPath, binaryPath);
            unlinkSync(tmpPath);
        }
    } catch (err) {
        // Clean up tmp file
        if (existsSync(tmpPath)) {
            const { unlinkSync } = await import("fs");
            try { unlinkSync(tmpPath); } catch {}
        }

        const msg = (err as Error).message;
        if (msg.includes("permission") || msg.includes("EACCES")) {
            fatal(`Permission denied. Try: sudo dosya upgrade`, EXIT.ERROR);
        }
        fatal(`Upgrade failed: ${msg}`, EXIT.ERROR);
    }

    log(`Upgraded to ${latestVersion}.`);
}
