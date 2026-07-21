import { dirname } from "path";
import { existsSync, rmSync } from "fs";
import { getConfigPath } from "../config";
import { isCompiledBinary } from "../runtime";
import { log, fatal, EXIT } from "../output";

const HELP = `Uninstall the dosya CLI.

Usage: dosya uninstall [flags]

Flags:
  --force, -f   Skip confirmation prompt
  --help, -h    Show help

This removes the dosya binary and its config directory.`;

export function uninstallHelp(): void {
    console.log(HELP);
}

export async function uninstall(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { uninstallHelp(); return; }

    const isForce = flags.force !== undefined;

    // process.execPath is the bun interpreter when running from source —
    // deleting it would remove the user's Bun installation.
    const compiled = isCompiledBinary();
    const binaryPath = compiled ? process.execPath : null;
    const configDir = dirname(getConfigPath());

    if (!compiled) {
        log("Running from source — only the config directory will be removed.");
    }

    if (!isForce) {
        if (!process.stdin.isTTY) {
            fatal("Cannot prompt for confirmation in non-interactive mode. Use --force to skip.", EXIT.USAGE);
        }

        const target = binaryPath ? `the dosya binary and ${configDir}` : configDir;
        process.stdout.write(`This will remove ${target}. Continue? [y/N] `);

        const reader = Bun.stdin.stream().getReader();
        const { value } = await reader.read();
        reader.releaseLock();
        const answer = new TextDecoder().decode(value ?? new Uint8Array()).trim().toLowerCase();

        if (answer !== "y" && answer !== "yes") {
            log("Cancelled.");
            return;
        }
    }

    // Remove config directory
    if (existsSync(configDir)) {
        rmSync(configDir, { recursive: true, force: true });
        log(`Removed ${configDir}`);
    }

    if (!binaryPath) {
        log("dosya config removed.");
        return;
    }

    try {
        rmSync(binaryPath, { force: true });
        log(`Removed ${binaryPath}`);
    } catch {
        console.error(`Could not remove ${binaryPath} — try: sudo rm ${binaryPath}`);
        process.exit(EXIT.ERROR);
    }

    log("dosya CLI uninstalled.");
}
