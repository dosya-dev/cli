import { DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, timeAgo, fatal, log, EXIT } from "../output";
import { isValidEmail } from "@dosya-dev/shared";

const HELP = `Manage workspace members on dosya.dev.

Usage:
  dosya member list [flags]              List workspace members
  dosya member invite --email <e> [flags]  Invite a member

Flags:
  --workspace, -w <id>   Workspace ID (required if no default set)
  --email <email>        Email address to invite
  --role <role>          Member role (default: Member)
  --json, -j             Output as JSON

Examples:
  dosya member list --workspace ws_abc123
  dosya member invite --email alice@example.com --workspace ws_abc123
  dosya member invite --email bob@co.com --role Admin -w ws_abc123`;

export function memberHelp(): void {
    console.log(HELP);
}

interface Member {
    user_id: string;
    name: string;
    email: string;
    role_id: string;
    joined_at: number;
}

interface TeamResponse {
    ok: boolean;
    members: Member[];
    invites: { id: string; email: string; role_id: string; created_at: number }[];
    stats: { members: number; pending: number };
}

export async function memberList(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { memberHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const workspaceId = flags.workspace ?? flags.w ?? config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id>", EXIT.USAGE);
    }

    try {
        // Use URLSearchParams for safe encoding
        const params = new URLSearchParams({ workspace_id: workspaceId });
        const data = await client.get<TeamResponse>(`/api/team?${params}`);

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        if (data.members.length === 0) {
            log("No members found.");
            return;
        }

        const rows = data.members.map(m => [
            m.name,
            m.email,
            m.role_id,
            timeAgo(m.joined_at),
        ]);

        printTable(["NAME", "EMAIL", "ROLE", "JOINED"], rows);

        if (data.invites.length > 0) {
            log(`\n${data.invites.length} pending invite(s)`);
        }
    } catch (err) {
        fatal((err as Error).message);
    }
}

export async function memberInvite(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { memberHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = new DosyaClient(apiBase, apiKey);

    const workspaceId = flags.workspace ?? flags.w ?? config?.default_workspace;
    const email = flags.email;
    const role = flags.role ?? "Member";

    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id>", EXIT.USAGE);
    }
    if (!email) {
        fatal("Email required. Usage: dosya member invite --email <email>", EXIT.USAGE);
    }
    if (!isValidEmail(email)) {
        fatal("Invalid email address.", EXIT.USAGE);
    }

    try {
        await client.post("/api/team/invite", {
            workspace_id: workspaceId,
            email,
            role,
        });

        if (flags.json !== undefined) {
            printJson({ ok: true, email, role, workspace_id: workspaceId });
            return;
        }

        log(`Invited ${email} as ${role}`);
    } catch (err) {
        fatal((err as Error).message);
    }
}
