import { createClient, type DosyaClient } from "../client";
import { requireAuth } from "../config";
import { ApiError } from "../errors";
import { printTable, printJson, timeAgo, fatal, fatalError, log, EXIT } from "../output";
import { Resolver, type Resolved } from "../resolver";
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

/**
 * A bare id resolves with workspaceId: "" when addressed with no -w flag
 * and no default workspace (see resolver.ts - deliberate: a raw id needs no
 * workspace to address it alone). /api/favourites has no endpoint variant
 * that skips workspace_id though - POST and DELETE both require it
 * unconditionally (apps/api/src/pages/api/favourites.ts:105-108, 183-187),
 * because a favourite row is scoped by (user_id, workspace_id,
 * file_id/folder_id) with no alternate lookup path. So `dosya star
 * <bare-id>` with no -w/default carried the same "" workspace_id rm's
 * batch-delete bug had - but rm's fix (fall back to DELETE /api/files/:id,
 * which never needed a workspace) has no equivalent here. The honest fix is
 * to look the object's real workspace up: one GET /api/files/:id or
 * /api/folders/:id, which - like DELETE /api/files/:id - finds the
 * object's workspace_id from the DB and needs no workspace_id from the
 * caller. Skipped entirely (no network call) whenever the workspace is
 * already known.
 */
export async function resolveFavouriteWorkspaceId(client: DosyaClient, t: Resolved): Promise<string> {
    if (t.workspaceId) return t.workspaceId;
    if (t.type === "file") {
        const data = await client.get<{ ok: boolean; file: { workspace_id: string } }>(
            `/api/files/${encodeURIComponent(t.id)}`,
        );
        return data.file.workspace_id;
    }
    const data = await client.get<{ ok: boolean; folder: { workspace_id: string } }>(
        `/api/folders/${encodeURIComponent(t.id)}`,
    );
    return data.folder.workspace_id;
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
            const workspaceId = await resolveFavouriteWorkspaceId(client, t);
            if (mode === "add") {
                await client.post("/api/favourites", { workspace_id: workspaceId, [key]: t.id });
            } else {
                const params = new URLSearchParams({ workspace_id: workspaceId, [key]: t.id });
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
