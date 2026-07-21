import { createClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, fatalError, log, EXIT } from "../output";
import { parseRef } from "../resolver";

const HELP = `Create a folder on dosya.dev.

Usage: dosya mkdir <path> [flags]

<path> may be nested (a/b/c) — every missing segment is created. It may carry a
workspace prefix (ws_id:reports/2026).

Flags:
  --workspace, -w <id>   Workspace (or set a default)
  --json, -j             Output as JSON

Examples:
  dosya mkdir reports -w ws_abc123
  dosya mkdir reports/2026/q3 -w ws_abc123
  dosya mkdir ws_abc123:archive`;

export function mkdirHelp(): void {
    console.log(HELP);
}

interface FolderResponse {
    ok: boolean;
    folder?: { id: string; name: string; parent_id: string | null };
    created_count?: number;
}

export async function mkdir(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { mkdirHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const target = args[0];
    if (!target) {
        fatal("Path required. Usage: dosya mkdir <path>", EXIT.USAGE);
    }

    const parsed = parseRef(target, { workspace: flags.workspace, defaultWorkspace: config?.default_workspace });
    if (!parsed.workspaceId) {
        fatal("Workspace ID required. Use ws_id:path, --workspace <id>, or set a default.", EXIT.USAGE);
    }
    if (parsed.segments.length === 0) {
        fatal("Folder name required.", EXIT.USAGE);
    }

    // The API splits a nested `a/b/c` name and creates each segment idempotently.
    const name = parsed.segments.join("/");

    try {
        const res = await client.post<FolderResponse>("/api/folders", {
            workspace_id: parsed.workspaceId,
            parent_id: null,
            name,
        });

        if (flags.json !== undefined) {
            printJson(res);
            return;
        }

        const id = res.folder?.id;
        log(id ? `Created ${name}/ (${id})` : `Created ${name}/`);
    } catch (err) {
        fatalError(err);
    }
}
