import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, log, EXIT } from "../output";

const HELP = `Generate a share link for a file on dosya.dev.

Usage: dosya share <file_id> [flags]

Flags:
  --password <pwd>     Password-protect the share link
  --expires <days>     Expiration (e.g. "7d" or "30")
  --lock <mode>        Lock mode for the share
  --json, -j           Output as JSON

Examples:
  dosya share fil_abc123
  dosya share fil_abc123 --expires 7d --password secret
  dosya share fil_abc123 --lock view`;

export function shareHelp(): void {
    console.log(HELP);
}

interface ShareResponse {
    ok: boolean;
    link: {
        id: string;
        token: string;
        url: string;
        lock_mode: string;
        expires_at: number | null;
        created_at: number;
    };
}

export async function share(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { shareHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const fileId = args[0];
    if (!fileId) {
        fatal("File ID required. Usage: dosya share <file_id>", EXIT.USAGE);
    }

    // Parse expires flag: "7d" -> 7, "30d" -> 30
    let expiresInDays: number | undefined;
    if (flags.expires) {
        const match = flags.expires.match(/^(\d+)d?$/);
        if (!match) fatal("Invalid --expires format. Use e.g. '7d' or '30'.", EXIT.USAGE);
        expiresInDays = parseInt(match[1], 10);
    }

    const body: Record<string, unknown> = {};
    if (flags.password) body.password = flags.password;
    if (expiresInDays) body.expires_in_days = expiresInDays;
    if (flags.lock) body.lock_mode = flags.lock;

    try {
        const data = await client.post<ShareResponse>(`/api/files/${encodeURIComponent(fileId)}/share`, body);

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        log(data.link.url);
        if (data.link.expires_at) {
            const date = new Date(data.link.expires_at * 1000).toLocaleDateString();
            log(`Expires: ${date}`);
        }
    } catch (err) {
        fatal((err as Error).message);
    }
}
