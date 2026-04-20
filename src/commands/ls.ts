import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, timeAgo, fatal, log, EXIT } from "../output";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `List files in a workspace on dosya.dev.

Usage: dosya ls [workspace_id] [flags]

Flags:
  --workspace, -w <id>   Workspace ID (or pass as first argument)
  --folder <id>          Folder ID to list
  --page <n>             Page number (default: 1)
  --sort <order>         Sort order (default: newest)
  --json, -j             Output as JSON

Examples:
  dosya ls ws_abc123
  dosya ls --workspace ws_abc123 --folder fld_xyz
  dosya ls ws_abc123 --sort oldest --page 2`;

export function lsHelp(): void {
    console.log(HELP);
}

interface FilesResponse {
    ok: boolean;
    folders: { id: string; name: string; created_at: number; file_count: number }[];
    files: { id: string; name: string; size_bytes: number; updated_at: number; extension: string | null }[];
    pagination: { page: number; total_files: number; total_pages: number };
}

export async function ls(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { lsHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const workspaceId = args[0] ?? flags.workspace ?? flags.w ?? config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Usage: dosya ls <workspace_id> or set default: dosya config set default_workspace <id>", EXIT.USAGE);
    }

    const folderId = args[1] ?? flags.folder ?? "";
    const page = flags.page ?? "1";
    const sort = flags.sort ?? "newest";

    try {
        // Use URLSearchParams for safe encoding
        const params = new URLSearchParams({
            workspace_id: workspaceId,
            per_page: "500",
            page,
            sort,
        });
        if (folderId) params.set("folder_id", folderId);

        const data = await client.get<FilesResponse>(`/api/files?${params}`);

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        const rows: string[][] = [];

        for (const folder of data.folders) {
            rows.push([
                folder.name + "/",
                "-",
                timeAgo(folder.created_at),
                folder.id,
            ]);
        }

        for (const file of data.files) {
            rows.push([
                file.name,
                formatBytes(file.size_bytes),
                timeAgo(file.updated_at),
                file.id,
            ]);
        }

        if (rows.length === 0) {
            log("No files found.");
            return;
        }

        printTable(["NAME", "SIZE", "MODIFIED", "ID"], rows);

        if (data.pagination.total_pages > 1) {
            log(`\nPage ${data.pagination.page} of ${data.pagination.total_pages} (${data.pagination.total_files} files total)`);
        }
    } catch (err) {
        fatal((err as Error).message);
    }
}
