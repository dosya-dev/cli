import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, fatal, log, EXIT } from "../output";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `Manage workspaces on dosya.dev.

Usage:
  dosya workspace list                 List all workspaces
  dosya workspace create --name <n>    Create a new workspace
  dosya workspace delete <id>          Delete a workspace

Flags:
  --name <name>     Workspace name (required for create)
  --id <id>         Workspace ID (alternative for delete)
  --force, -f       Skip confirmation prompt
  --json, -j        Output as JSON

Examples:
  dosya workspace list
  dosya workspace create --name "My Project"
  dosya workspace delete ws_abc123 --force`;

export function workspaceHelp(): void {
    console.log(HELP);
}

interface Workspace {
    id: string;
    name: string;
    slug: string;
    total_storage_used?: number;
}

interface WorkspacesResponse {
    ok: boolean;
    workspaces: Workspace[];
}

export async function workspaceList(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { workspaceHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

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

        const rows = data.workspaces.map(ws => [
            ws.id,
            ws.name,
            ws.total_storage_used ? formatBytes(ws.total_storage_used) : "-",
        ]);

        printTable(["ID", "NAME", "STORAGE"], rows);
    } catch (err) {
        fatal((err as Error).message);
    }
}

export async function workspaceCreate(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { workspaceHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const name = flags.name;
    if (!name) {
        fatal("Workspace name required. Usage: dosya workspace create --name <name>", EXIT.USAGE);
    }

    try {
        const data = await client.post<{ ok: boolean; id: string; name: string; slug: string }>("/api/workspaces", { name });

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        log(`Created workspace: ${data.name} (${data.id})`);
    } catch (err) {
        fatal((err as Error).message);
    }
}

export async function workspaceDelete(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { workspaceHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const wsId = args[0] ?? flags.id;
    if (!wsId) {
        fatal("Workspace ID required. Usage: dosya workspace delete <workspace_id>", EXIT.USAGE);
    }

    const isForce = flags.force !== undefined || flags.f !== undefined;

    // Confirm unless --force
    if (!isForce) {
        if (!process.stdin.isTTY) {
            fatal("Cannot prompt for confirmation in non-interactive mode. Use --force to skip.", EXIT.USAGE);
        }

        process.stdout.write(`Delete workspace ${wsId}? This cannot be undone. [y/N] `);
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
        await client.del(`/api/workspaces/${encodeURIComponent(wsId)}`);

        if (flags.json !== undefined) {
            printJson({ ok: true, deleted: wsId });
            return;
        }

        log(`Deleted workspace ${wsId}`);
    } catch (err) {
        fatal((err as Error).message);
    }
}
