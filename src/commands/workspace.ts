import { createClient } from "../client";
import { requireAuth, updateConfig } from "../config";
import { printTable, printJson, fatal, fatalError, log, EXIT } from "../output";
import { confirm } from "../prompt";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `Manage workspaces on dosya.dev.

Usage:
  dosya workspace list                 List all workspaces
  dosya workspace use <id>             Set the default workspace
  dosya workspace create --name <n>    Create a new workspace
  dosya workspace delete <id>          Delete a workspace

Flags:
  --name <name>     Workspace name (required for create)
  --id <id>         Workspace ID (alternative for delete)
  --force, -f       Skip confirmation prompt
  --json, -j        Output as JSON

Examples:
  dosya workspace list
  dosya workspace use ws_abc123
  dosya workspace create --name "My Project"
  dosya workspace delete ws_abc123 --force`;

export function workspaceHelp(): void {
    console.log(HELP);
}

interface Workspace {
    id: string;
    name: string;
    slug: string;
    /** The API reports usage as `storage_used_bytes`, plus a `storage` summary. */
    storage_used_bytes?: number;
    storage?: { used?: number; total?: number };
}

interface WorkspacesResponse {
    ok: boolean;
    workspaces: Workspace[];
}

function storageUsed(ws: Workspace): number | undefined {
    return ws.storage?.used ?? ws.storage_used_bytes;
}

export async function workspaceList(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { workspaceHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    try {
        const data = await client.get<WorkspacesResponse>("/api/workspaces");

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        if (data.workspaces.length === 0) {
            log("No workspaces found.");
            return;
        }

        const rows = data.workspaces.map(ws => {
            const used = storageUsed(ws);
            return [ws.id, ws.name, used === undefined ? "-" : formatBytes(used)];
        });

        printTable(["ID", "NAME", "STORAGE"], rows);
    } catch (err) {
        fatalError(err);
    }
}

export async function workspaceCreate(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { workspaceHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const name = flags.name;
    if (!name) {
        fatal("Workspace name required. Usage: dosya workspace create --name <name>", EXIT.USAGE);
    }

    try {
        // The API nests the new record under `workspace`
        const data = await client.post<{ ok: boolean; workspace: Workspace }>("/api/workspaces", { name });

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        const ws = data.workspace;
        if (!ws?.id) {
            fatal("Workspace created but the server returned an unexpected response.");
        }

        log(`Created workspace: ${ws.name} (${ws.id})`);
    } catch (err) {
        fatalError(err);
    }
}

export async function workspaceUse(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { workspaceHelp(); return; }

    const wsId = args[0] || flags.id;
    if (!wsId) {
        fatal("Workspace ID required. Usage: dosya workspace use <workspace_id>", EXIT.USAGE);
    }

    await updateConfig({ default_workspace: wsId });

    if (flags.json !== undefined) {
        printJson({ ok: true, default_workspace: wsId });
    } else {
        log(`Default workspace set to ${wsId}`);
    }
}

export async function workspaceDelete(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { workspaceHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const wsId = args[0] || flags.id;
    if (!wsId) {
        fatal("Workspace ID required. Usage: dosya workspace delete <workspace_id>", EXIT.USAGE);
    }

    const isForce = flags.force !== undefined;

    // Confirm unless --force
    const confirmed = await confirm(`Delete workspace ${wsId}? This cannot be undone.`, { force: isForce });
    if (confirmed === null) {
        fatal("Cannot prompt for confirmation in non-interactive mode. Use --force to skip.", EXIT.USAGE);
    }
    if (!confirmed) {
        console.log("Cancelled.");
        return;
    }

    try {
        await client.del(`/api/workspaces/${encodeURIComponent(wsId)}`);

        if (flags.json !== undefined) {
            printJson({ ok: true, deleted: wsId });
            return;
        }

        log(`Deleted workspace ${wsId}`);
    } catch (err) {
        fatalError(err);
    }
}
