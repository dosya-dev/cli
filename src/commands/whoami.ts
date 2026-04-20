import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, log } from "../output";

const HELP = `Show information about the currently authenticated user.

Usage: dosya whoami [flags]

Flags:
  --json, -j    Output as JSON

Examples:
  dosya whoami
  dosya whoami --json`;

export function whoamiHelp(): void {
    console.log(HELP);
}

interface MeResponse {
    ok: boolean;
    user: {
        id: string;
        email: string;
        name: string;
        workspace_count: number;
        created_at: number;
    };
}

export async function whoami(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { whoamiHelp(); return; }

    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    try {
        const data = await client.get<MeResponse>("/api/me");
        const u = data.user;

        if (flags.json !== undefined) {
            printJson(u);
            return;
        }

        log(`Name:       ${u.name}`);
        log(`Email:      ${u.email}`);
        log(`ID:         ${u.id}`);
        log(`Workspaces: ${u.workspace_count}`);
    } catch (err) {
        fatal((err as Error).message);
    }
}
