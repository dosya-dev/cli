import { createClient, DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, timeAgo, fatal, fatalError, log, EXIT } from "../output";
import { confirm } from "../prompt";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `Manage the trash (soft-deleted files and folders) on dosya.dev.

Usage:
  dosya trash list                     List files and folders in the trash
  dosya trash restore <id-or-name...>  Restore files or folders from the trash
  dosya trash empty [--force]          Permanently delete everything in the trash

Deleted files and folders aren't in the folder tree, so restore takes ids or
exact names as shown by 'dosya trash list'. Restoring a folder brings back
everything that was deleted with it.

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

interface TrashFolder {
    id: string;
    name: string;
    deleted_at: number | null;
    file_count: number;
    total_size_bytes: number;
}

async function fetchTrash(client: DosyaClient, workspaceId: string): Promise<{ files: TrashFile[]; folders: TrashFolder[] }> {
    const params = new URLSearchParams({ workspace_id: workspaceId, deleted: "1", per_page: "500" });
    const data = await client.get<{ ok: boolean; files: TrashFile[]; folders?: TrashFolder[] }>(`/api/files?${params}`);
    return { files: data.files ?? [], folders: data.folders ?? [] };
}

async function trashList(client: DosyaClient, workspaceId: string, flags: Record<string, string>): Promise<void> {
    const { files, folders } = await fetchTrash(client, workspaceId);
    if (flags.json !== undefined) {
        printJson({ ok: true, files, folders });
        return;
    }
    if (files.length === 0 && folders.length === 0) {
        log("Trash is empty.");
        return;
    }
    printTable(
        ["KIND", "NAME", "SIZE", "DELETED", "ID"],
        [
            ...folders.map(f => ["folder", f.name, `${f.file_count} item${f.file_count === 1 ? "" : "s"}`, f.deleted_at ? timeAgo(f.deleted_at) : "-", f.id]),
            ...files.map(f => ["file", f.name, formatBytes(f.size_bytes), f.deleted_at ? timeAgo(f.deleted_at) : "-", f.id]),
        ],
    );
}

type TrashEntry = ({ kind: "file" } & TrashFile) | ({ kind: "folder" } & TrashFolder);

async function trashRestore(client: DosyaClient, workspaceId: string, refs: string[], flags: Record<string, string>): Promise<void> {
    if (refs.length === 0) {
        fatal("Usage: dosya trash restore <id-or-name...>", EXIT.USAGE);
    }
    const { files, folders } = await fetchTrash(client, workspaceId);
    const entries: TrashEntry[] = [
        ...folders.map(f => ({ kind: "folder" as const, ...f })),
        ...files.map(f => ({ kind: "file" as const, ...f })),
    ];
    const byId = new Map(entries.map(e => [e.id, e]));

    let restored = 0;
    const failures: { target: string; error: string }[] = [];

    for (const ref of refs) {
        let match = byId.get(ref);
        if (!match) {
            const named = entries.filter(e => e.name === ref);
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
            // PUT with no body un-deletes the file or folder.
            const path = match.kind === "folder" ? "/api/folders/" : "/api/files/";
            await client.put(`${path}${encodeURIComponent(match.id)}`);
            restored++;
        } catch (err) {
            failures.push({ target: ref, error: (err as Error).message });
        }
    }

    if (flags.json !== undefined) {
        printJson({ ok: failures.length === 0, restored, failures });
    } else {
        for (const f of failures) console.error(`Failed: ${f.target}: ${f.error}`);
        log(`Restored ${restored} item${restored === 1 ? "" : "s"}.`);
    }
    if (failures.length > 0) process.exit(EXIT.ERROR);
}

async function trashEmpty(client: DosyaClient, workspaceId: string, flags: Record<string, string>): Promise<void> {
    const { files, folders } = await fetchTrash(client, workspaceId);
    const itemCount = files.length + folders.length;
    if (itemCount === 0) {
        log("Trash is already empty.");
        return;
    }
    const total = files.reduce((s, f) => s + f.size_bytes, 0) + folders.reduce((s, f) => s + f.total_size_bytes, 0);
    const ok = await confirm(
        `Permanently delete ${itemCount} item(s) (${formatBytes(total)}) from trash? This cannot be undone.`,
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
    for (const f of folders) {
        try {
            // A second DELETE on an already-soft-deleted folder purges it and
            // everything swept in with it. Without this loop, "empty" left
            // every trashed folder behind while claiming the trash was empty.
            await client.del(`/api/folders/${encodeURIComponent(f.id)}`);
            purged++;
        } catch (err) {
            failures.push({ target: f.name, error: (err as Error).message });
        }
    }

    if (flags.json !== undefined) {
        printJson({ ok: failures.length === 0, purged, failures });
    } else {
        for (const f of failures) console.error(`Failed: ${f.target}: ${f.error}`);
        log(`Permanently deleted ${purged} item${purged === 1 ? "" : "s"}.`);
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
