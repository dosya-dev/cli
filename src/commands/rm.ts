import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, log, EXIT } from "../output";

const HELP = `Delete a file on dosya.dev.

Usage: dosya rm <file_id> [flags]

Flags:
  --permanent       Permanently delete (cannot be undone)
  --force, -f       Skip confirmation prompt
  --json, -j        Output as JSON

Examples:
  dosya rm fil_abc123
  dosya rm fil_abc123 --permanent --force`;

export function rmHelp(): void {
    console.log(HELP);
}

export async function rm(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { rmHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const fileId = args[0];
    if (!fileId) {
        fatal("File ID required. Usage: dosya rm <file_id>", EXIT.USAGE);
    }

    const isPermanent = flags.permanent !== undefined;
    const isForce = flags.force !== undefined || flags.f !== undefined;

    // Confirmation for permanent delete
    if (isPermanent && !isForce) {
        if (!process.stdin.isTTY) {
            fatal("Cannot prompt for confirmation in non-interactive mode. Use --force to skip.", EXIT.USAGE);
        }

        process.stdout.write(`Permanently delete ${fileId}? This cannot be undone. [y/N] `);
        const reader = Bun.stdin.stream().getReader();
        const { value } = await reader.read();
        reader.releaseLock();
        const answer = new TextDecoder().decode(value).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
            console.log("Cancelled.");
            return;
        }
    }

    try {
        // First delete (soft delete)
        const result = await client.del<{ ok: boolean; permanent: boolean }>(`/api/files/${encodeURIComponent(fileId)}`);

        if (isPermanent && !result.permanent) {
            // Second delete (permanent)
            await client.del(`/api/files/${encodeURIComponent(fileId)}`);
        }

        if (flags.json !== undefined) {
            printJson({ ok: true, id: fileId, permanent: isPermanent });
            return;
        }

        log(isPermanent ? `Permanently deleted ${fileId}` : `Deleted ${fileId} (recoverable)`);
    } catch (err) {
        fatal((err as Error).message);
    }
}
