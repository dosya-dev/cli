import { homedir } from "os";
import { join } from "path";
import { existsSync, rmSync } from "fs";
import { log, fatal, EXIT } from "../output";

const HELP = `Uninstall the dosya CLI.

Usage: dosya uninstall [flags]

Flags:
  --force, -f   Skip confirmation prompt
  --help, -h    Show help

This removes the dosya binary and config directory (~/.dosya/).`;

export function uninstallHelp(): void {
    console.log(HELP);
}

export async function uninstall(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { uninstallHelp(); return; }

    const binaryPath = process.execPath;
    const configDir = join(homedir(), ".dosya");

    if (flags.force === undefined && flags.f === undefined) {
        process.stdout.write("This will remove the dosya binary and config directory. Continue? [y/N] ");

        const response = await new Promise<string>((resolve) => {
            const buf = Buffer.alloc(16);
            const n = require("fs").readSync(0, buf, 0, buf.length, null);
            resolve(buf.toString("utf8", 0, n).trim().toLowerCase());
        });

        if (response !== "y" && response !== "yes") {
            log("Cancelled.");
            return;
        }
    }

    // Remove config directory
    if (existsSync(configDir)) {
        rmSync(configDir, { recursive: true, force: true });
        log(`Removed ${configDir}`);
    }

    // Remove the binary
    try {
        rmSync(binaryPath, { force: true });
        log(`Removed ${binaryPath}`);
    } catch {
        console.error(`Could not remove ${binaryPath} — try: sudo rm ${binaryPath}`);
        process.exit(EXIT.ERROR);
    }

    log("dosya CLI uninstalled.");
}
