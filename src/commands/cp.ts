import { createClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, fatalError, log, EXIT } from "../output";
import { Resolver } from "../resolver";

const HELP = `Copy a file into a folder on dosya.dev.

Usage: dosya cp <file> <dest-folder> [flags]

<file> and <dest-folder> may be ids or paths. Use a bare workspace (ws_id:) as
the destination to copy into the workspace root.

Flags:
  --workspace, -w <id>   Workspace for path lookups (or set a default)
  --json, -j             Output as JSON

Examples:
  dosya cp file_abc123 reports/2026
  dosya cp report.pdf ws_abc123:archive`;

export function cpHelp(): void {
    console.log(HELP);
}

export async function cp(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { cpHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const source = args[0];
    const dest = args[1];
    if (!source || !dest) {
        fatal("Usage: dosya cp <file> <dest-folder>", EXIT.USAGE);
    }

    const opts = { workspace: flags.workspace, defaultWorkspace: config?.default_workspace };

    try {
        const resolver = new Resolver(client);
        const src = await resolver.resolve(source, opts);
        if (src.type !== "file") {
            fatal("cp copies files; folders aren't supported.", EXIT.USAGE);
        }
        const destFolder = await resolver.resolve(dest, { ...opts, expect: "folder" });
        const folderId = destFolder.id || null;

        const res = await client.post<{ ok: boolean; file_id: string; name: string }>(
            `/api/files/${encodeURIComponent(src.id)}/copy`,
            { folder_id: folderId },
        );

        if (flags.json !== undefined) {
            printJson(res);
            return;
        }

        log(`Copied to ${res.name} (${res.file_id})`);
    } catch (err) {
        fatalError(err);
    }
}
