import { createClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, fatalError, log, EXIT } from "../output";
import { renderKeyValue } from "../render";
import { Resolver } from "../resolver";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `Show metadata for a file on dosya.dev, without downloading it.

Usage: dosya info <file> [flags]
       dosya stat <file>

<file> may be a file id (file_…) or a path (folder/name.ext, or ws_id:folder/name).

Flags:
  --workspace, -w <id>   Workspace for path lookups (or set a default)
  --json, -j             Output as JSON

Examples:
  dosya info file_abc123
  dosya info reports/q3.pdf -w ws_abc123
  dosya stat ws_abc123:photo.jpg --json`;

export function infoHelp(): void {
    console.log(HELP);
}

interface FileInfo {
    id: string;
    name: string;
    size_bytes: number;
    mime_type: string | null;
    extension: string | null;
    region: string | null;
    current_version: number;
    lock_mode: string;
    is_hidden: number | boolean;
    share_count: number;
    comment_count: number;
    uploader_name: string | null;
    created_at: number;
    updated_at: number;
}

function stamp(unix: number): string {
    return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export async function info(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { infoHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const target = args[0];
    if (!target) {
        fatal("File required. Usage: dosya info <file>", EXIT.USAGE);
    }

    try {
        const resolved = await new Resolver(client).resolve(target, {
            workspace: flags.workspace,
            defaultWorkspace: config?.default_workspace,
        });
        if (resolved.type !== "file") {
            fatal(`"${target}" is a folder. Use 'dosya tree' or 'dosya ls' to inspect folders.`, EXIT.USAGE);
        }

        const data = await client.get<{ ok: boolean; file: FileInfo }>(
            `/api/files/${encodeURIComponent(resolved.id)}`,
        );
        const f = data.file;

        if (flags.json !== undefined) {
            printJson(f);
            return;
        }

        log(renderKeyValue([
            ["Name", f.name],
            ["ID", f.id],
            ["Size", formatBytes(f.size_bytes)],
            ["Type", f.mime_type || "unknown"],
            ["Extension", f.extension || "-"],
            ["Region", f.region || "-"],
            ["Version", String(f.current_version)],
            ["Lock", f.lock_mode],
            ["Hidden", f.is_hidden ? "yes" : "no"],
            ["Shares", String(f.share_count)],
            ["Comments", String(f.comment_count)],
            ["Uploader", f.uploader_name || "-"],
            ["Created", stamp(f.created_at)],
            ["Updated", stamp(f.updated_at)],
        ]));
    } catch (err) {
        fatalError(err);
    }
}
