import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, log, EXIT } from "../output";

const HELP = `Move or rename a file on dosya.dev.

Usage: dosya mv <file_id> <folder_id|new_name>

If the target starts with "fld_", the file is moved to that folder.
Otherwise, the file is renamed.

Flags:
  --json, -j    Output as JSON

Examples:
  dosya mv fil_abc123 fld_xyz789       Move to folder
  dosya mv fil_abc123 "new-name.pdf"   Rename file`;

export function mvHelp(): void {
    console.log(HELP);
}

export async function mv(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { mvHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const fileId = args[0];
    const target = args[1];

    if (!fileId || !target) {
        fatal("Usage: dosya mv <file_id> <folder_id|new_name>", EXIT.USAGE);
    }

    try {
        // If target looks like a folder ID (fld_xxx), move the file
        // Otherwise, treat it as a rename
        if (target.startsWith("fld_")) {
            await client.put(`/api/files/${encodeURIComponent(fileId)}/move`, { folder_id: target });

            if (flags.json !== undefined) {
                printJson({ ok: true, action: "move", id: fileId, folder_id: target });
            } else {
                log(`Moved ${fileId} to ${target}`);
            }
        } else {
            await client.put(`/api/files/${encodeURIComponent(fileId)}/rename`, { name: target });

            if (flags.json !== undefined) {
                printJson({ ok: true, action: "rename", id: fileId, name: target });
            } else {
                log(`Renamed ${fileId} to ${target}`);
            }
        }
    } catch (err) {
        fatal((err as Error).message);
    }
}
