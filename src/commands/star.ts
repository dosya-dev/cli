import { createClient } from "../client";
import { requireAuth } from "../config";
import { ApiError } from "../errors";
import { printTable, printJson, timeAgo, fatal, fatalError, log, EXIT } from "../output";
import { Resolver } from "../resolver";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `Manage favourites (starred items) on dosya.dev.

Usage:
  dosya star <target...>      Add files/folders to favourites
  dosya unstar <target...>    Remove them from favourites
  dosya starred               List favourites

<target> may be a file/folder id or a path.

Flags:
  --workspace, -w <id>   Workspace for path lookups (or set a default)
  --json, -j             Output as JSON

Examples:
  dosya star report.pdf notes.txt
  dosya unstar file_abc123
  dosya starred -w ws_abc123`;

export function starHelp(): void {
    console.log(HELP);
}

async function toggle(mode: "add" | "remove", args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { starHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    if (args.length === 0) {
        fatal(`Target required. Usage: dosya ${mode === "add" ? "star" : "unstar"} <target...>`, EXIT.USAGE);
    }

    const resolver = new Resolver(client);
    let targets;
    try {
        targets = await resolver.resolveMany(args, {
            workspace: flags.workspace,
            defaultWorkspace: config?.default_workspace,
        });
    } catch (err) {
        return fatalError(err);
    }

    let done = 0;
    const failures: { target: string; error: string }[] = [];

    for (const t of targets) {
        if (t.type === "folder" && t.id === "") {
            failures.push({ target: t.name, error: "cannot star the workspace root" });
            continue;
        }
        const key = t.type === "file" ? "file_id" : "folder_id";
        try {
            if (mode === "add") {
                await client.post("/api/favourites", { workspace_id: t.workspaceId, [key]: t.id });
            } else {
                const params = new URLSearchParams({ workspace_id: t.workspaceId, [key]: t.id });
                await client.del(`/api/favourites?${params}`);
            }
            done++;
        } catch (err) {
            // Adding something already favourited is a no-op success.
            if (mode === "add" && err instanceof ApiError && err.status === 409) {
                done++;
                continue;
            }
            failures.push({ target: t.name, error: (err as Error).message });
        }
    }

    if (flags.json !== undefined) {
        printJson({ ok: failures.length === 0, count: done, failures });
    } else {
        for (const f of failures) console.error(`Failed: ${f.target}: ${f.error}`);
        log(`${mode === "add" ? "Starred" : "Unstarred"} ${done} item(s).`);
    }
    if (failures.length > 0) process.exit(EXIT.ERROR);
}

export async function star(args: string[], flags: Record<string, string>): Promise<void> {
    return toggle("add", args, flags);
}

export async function unstar(args: string[], flags: Record<string, string>): Promise<void> {
    return toggle("remove", args, flags);
}

interface FavouritesResponse {
    ok: boolean;
    folders: { folder_id: string; folder_name: string; created_at: number }[];
    files: { file_id: string; file_name: string; size_bytes: number; created_at: number }[];
}

export async function starred(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { starHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const workspaceId = flags.workspace || config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id> or set a default: dosya config set default_workspace <id>", EXIT.USAGE);
    }

    try {
        const params = new URLSearchParams({ workspace_id: workspaceId });
        const data = await client.get<FavouritesResponse>(`/api/favourites?${params}`);

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        const folders = data.folders ?? [];
        const files = data.files ?? [];
        if (folders.length === 0 && files.length === 0) {
            log("No favourites.");
            return;
        }

        if (folders.length > 0) {
            log("Folders:");
            printTable(["NAME", "ADDED", "ID"], folders.map(f => [f.folder_name + "/", timeAgo(f.created_at), f.folder_id]));
            log("");
        }
        if (files.length > 0) {
            log("Files:");
            printTable(
                ["NAME", "SIZE", "ADDED", "ID"],
                files.map(f => [f.file_name, formatBytes(f.size_bytes), timeAgo(f.created_at), f.file_id]),
            );
        }
    } catch (err) {
        fatalError(err);
    }
}
