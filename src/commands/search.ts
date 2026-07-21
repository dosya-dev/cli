import { createClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, timeAgo, fatal, fatalError, log, EXIT } from "../output";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `Search files, folders, and shares on dosya.dev.

Usage: dosya search <query> [flags]

Flags:
  --workspace, -w <id>   Workspace to search (or set a default)
  --type <kind>          Filter files by kind: documents, images, videos
  --page <n>             Result page (default: 1)
  --json, -j             Output as JSON

Examples:
  dosya search invoice -w ws_abc123
  dosya search vacation --type images
  dosya search report.pdf --json`;

export function searchHelp(): void {
    console.log(HELP);
}

interface SearchFile {
    id: string;
    name: string;
    size_bytes: number;
    mime_type: string | null;
    extension: string | null;
    folder_id: string | null;
    created_at: number;
    uploader_name?: string;
}

interface SearchResponse {
    ok: boolean;
    query: string;
    files: SearchFile[];
    folders: { id: string; name: string; parent_id: string | null; created_at: number; file_count: number }[];
    shared: { link_id: string; token: string; file_name?: string; folder_name?: string; status: string }[];
    pagination: {
        page: number;
        per_page: number;
        total_files: number;
        total_folders: number;
        total_shares: number;
        has_more: boolean;
    };
}

/** Client-side kind filter mirroring the API's documents/images/videos buckets. */
function matchesType(mime: string | null, kind: string): boolean {
    const m = mime ?? "";
    if (kind === "images") return m.startsWith("image/");
    if (kind === "videos") return m.startsWith("video/");
    if (kind === "documents") return !m.startsWith("image/") && !m.startsWith("video/");
    return true;
}

export async function search(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { searchHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const query = args[0];
    if (!query) {
        fatal("Search query required. Usage: dosya search <query>", EXIT.USAGE);
    }

    const workspaceId = flags.workspace || config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id> or set a default: dosya config set default_workspace <id>", EXIT.USAGE);
    }

    try {
        const params = new URLSearchParams({ workspace_id: workspaceId, q: query, page: flags.page || "1" });
        const data = await client.get<SearchResponse>(`/api/search?${params}`);

        let files = data.files ?? [];
        if (flags.type) files = files.filter(f => matchesType(f.mime_type, flags.type));

        if (flags.json !== undefined) {
            printJson({ ...data, files });
            return;
        }

        const folders = data.folders ?? [];
        const shared = data.shared ?? [];

        if (files.length === 0 && folders.length === 0 && shared.length === 0) {
            log(`No results for "${query}".`);
            return;
        }

        if (folders.length > 0) {
            log("Folders:");
            printTable(["NAME", "FILES", "ID"], folders.map(f => [f.name + "/", String(f.file_count), f.id]));
            log("");
        }
        if (files.length > 0) {
            log("Files:");
            printTable(
                ["NAME", "SIZE", "MODIFIED", "ID"],
                files.map(f => [f.name, formatBytes(f.size_bytes), timeAgo(f.created_at), f.id]),
            );
            log("");
        }
        if (shared.length > 0) {
            log("Shared:");
            printTable(
                ["NAME", "STATUS", "LINK"],
                shared.map(s => [s.file_name || s.folder_name || "(link)", s.status, s.link_id]),
            );
            log("");
        }

        if (data.pagination?.has_more) {
            log(`More results — rerun with --page ${(data.pagination.page ?? 1) + 1}`);
        }
    } catch (err) {
        fatalError(err);
    }
}
