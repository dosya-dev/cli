import { createClient, DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, timeAgo, fatal, fatalError, log, EXIT } from "../output";
import { confirm } from "../prompt";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `Manage the trash (soft-deleted files) on dosya.dev.

Usage:
  dosya trash list                     List files in the trash
  dosya trash restore <id-or-name...>  Restore files from the trash
  dosya trash empty [--force]          Permanently delete everything in the trash

Deleted files aren't in the folder tree, so restore takes file ids or exact
names as shown by 'dosya trash list'.

Flags:
  --workspace, -w <id>   Workspace (or set a default)
  --force, -f            Skip the confirmation on 'empty'
  --json, -j             Output as JSON

Examples:
  dosya trash list -w ws_abc123
  dosya trash restore file_abc123
  dosya trash empty --force`;

export function trashHelp(): void {
    console.log(HELP);
}

interface TrashFile {
    id: string;
    name: string;
    size_bytes: number;
    deleted_at: number | null;
}

async function fetchTrash(client: DosyaClient, workspaceId: string): Promise<TrashFile[]> {
    const params = new URLSearchParams({ workspace_id: workspaceId, deleted: "1", per_page: "500" });
    const data = await client.get<{ ok: boolean; files: TrashFile[] }>(`/api/files?${params}`);
    return data.files ?? [];
}

async function trashList(client: DosyaClient, workspaceId: string, flags: Record<string, string>): Promise<void> {
    const files = await fetchTrash(client, workspaceId);
    if (flags.json !== undefined) {
        printJson({ ok: true, files });
        return;
    }
    if (files.length === 0) {
        log("Trash is empty.");
        return;
    }
    printTable(
        ["NAME", "SIZE", "DELETED", "ID"],
        files.map(f => [f.name, formatBytes(f.size_bytes), f.deleted_at ? timeAgo(f.deleted_at) : "-", f.id]),
    );
}

async function trashRestore(client: DosyaClient, workspaceId: string, refs: string[], flags: Record<string, string>): Promise<void> {
    if (refs.length === 0) {
        fatal("Usage: dosya trash restore <id-or-name...>", EXIT.USAGE);
    }
    const files = await fetchTrash(client, workspaceId);
    const byId = new Map(files.map(f => [f.id, f]));

    let restored = 0;
    const failures: { target: string; error: string }[] = [];

    for (const ref of refs) {
        let match = byId.get(ref);
        if (!match) {
            const named = files.filter(f => f.name === ref);
            if (named.length === 1) {
                match = named[0];
            } else if (named.length > 1) {
                failures.push({ target: ref, error: `ambiguous - ids: ${named.map(n => n.id).join(", ")}` });
                continue;
            }
        }
        if (!match) {
            failures.push({ target: ref, error: "not found in trash" });
            continue;
        }
        try {
            // PUT with no body un-deletes the file.
            await client.put(`/api/files/${encodeURIComponent(match.id)}`);
            restored++;
        } catch (err) {
            failures.push({ target: ref, error: (err as Error).message });
        }
    }

    if (flags.json !== undefined) {
        printJson({ ok: failures.length === 0, restored, failures });
    } else {
        for (const f of failures) console.error(`Failed: ${f.target}: ${f.error}`);
        log(`Restored ${restored} file(s).`);
    }
    if (failures.length > 0) process.exit(EXIT.ERROR);
}

async function trashEmpty(client: DosyaClient, workspaceId: string, flags: Record<string, string>): Promise<void> {
    const files = await fetchTrash(client, workspaceId);
    if (files.length === 0) {
        log("Trash is already empty.");
        return;
    }
    const total = files.reduce((s, f) => s + f.size_bytes, 0);
    const ok = await confirm(
        `Permanently delete ${files.length} file(s) (${formatBytes(total)}) from trash? This cannot be undone.`,
        { force: flags.force !== undefined },
    );
    if (ok === null) fatal("Cannot prompt for confirmation in non-interactive mode. Use --force to skip.", EXIT.USAGE);
    if (!ok) { log("Cancelled."); return; }

    let purged = 0;
    const failures: { target: string; error: string }[] = [];
    for (const f of files) {
        try {
            // A second DELETE on an already-soft-deleted file erases it.
            await client.del(`/api/files/${encodeURIComponent(f.id)}`);
            purged++;
        } catch (err) {
            failures.push({ target: f.name, error: (err as Error).message });
        }
    }

    if (flags.json !== undefined) {
        printJson({ ok: failures.length === 0, purged, failures });
    } else {
        for (const f of failures) console.error(`Failed: ${f.target}: ${f.error}`);
        log(`Permanently deleted ${purged} file(s).`);
    }
    if (failures.length > 0) process.exit(EXIT.ERROR);
}

export async function trash(args: string[], flags: Record<string, string>): Promise<void> {
    const sub = args[0];
    if (flags.help !== undefined || sub === undefined) {
        trashHelp();
        if (sub === undefined && flags.help === undefined) process.exit(EXIT.USAGE);
        return;
    }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const workspaceId = flags.workspace || config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id> or set a default: dosya config set default_workspace <id>", EXIT.USAGE);
    }

    try {
        if (sub === "list") return await trashList(client, workspaceId, flags);
        if (sub === "restore") return await trashRestore(client, workspaceId, args.slice(1), flags);
        if (sub === "empty") return await trashEmpty(client, workspaceId, flags);
        fatal(`Unknown subcommand: trash ${sub}. Usage: dosya trash list|restore|empty`, EXIT.USAGE);
    } catch (err) {
        fatalError(err);
    }
}
