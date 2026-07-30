import { createClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, timeAgo, fatal, fatalError, log, EXIT } from "../output";
import { Resolver } from "../resolver";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `List or restore versions of a file on dosya.dev.

Usage:
  dosya versions <file>                 List a file's versions
  dosya versions restore <file> <n>     Restore version <n> as a new version

Upload a new version with: dosya upload <local-file> --version-of <file>

Flags:
  --workspace, -w <id>   Workspace for path lookups (or set a default)
  --json, -j             Output as JSON

Examples:
  dosya versions report.pdf
  dosya versions restore file_abc123 2`;

export function versionsHelp(): void {
    console.log(HELP);
}

interface VersionRow {
    id: string;
    version_number: number;
    size_bytes: number;
    uploaded_by: string | null;
    uploader_name: string | null;
    created_at: number;
}

interface VersionsResponse {
    ok: boolean;
    file_name: string;
    current_version: number;
    versions: VersionRow[];
}

export async function versions(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { versionsHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);
    const opts = { workspace: flags.workspace, defaultWorkspace: config?.default_workspace };

    try {
        const resolver = new Resolver(client);

        if (args[0] === "restore") {
            const target = args[1];
            const n = args[2];
            if (!target || !n) {
                fatal("Usage: dosya versions restore <file> <version>", EXIT.USAGE);
            }
            const num = Number(n);
            if (!Number.isInteger(num) || num < 1) {
                fatal("Version must be a positive integer.", EXIT.USAGE);
            }
            const r = await resolver.resolve(target, opts);
            if (r.type !== "file") fatal("versions restore targets a file.", EXIT.USAGE);

            const res = await client.post<{ ok: boolean; version: number; restored_from: number }>(
                `/api/files/${encodeURIComponent(r.id)}/versions/restore`,
                { version_number: num },
            );
            if (flags.json !== undefined) {
                printJson(res);
            } else {
                log(`Restored version ${res.restored_from} - the file is now at version ${res.version}.`);
            }
            return;
        }

        const target = args[0];
        if (!target) {
            fatal("Usage: dosya versions <file>", EXIT.USAGE);
        }
        const r = await resolver.resolve(target, opts);
        if (r.type !== "file") fatal("versions lists a file's versions.", EXIT.USAGE);

        const data = await client.get<VersionsResponse>(`/api/files/${encodeURIComponent(r.id)}/versions`);
        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        log(`${data.file_name} - current version ${data.current_version}`);
        printTable(
            ["VERSION", "SIZE", "UPLOADER", "CREATED"],
            data.versions.map(v => [
                v.version_number === data.current_version ? `${v.version_number} *` : String(v.version_number),
                formatBytes(v.size_bytes),
                v.uploader_name || v.uploaded_by || "-",
                timeAgo(v.created_at),
            ]),
        );
    } catch (err) {
        fatalError(err);
    }
}
