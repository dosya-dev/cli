import { createClient, type DosyaClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, timeAgo, fatal, fatalError, log, debug, EXIT } from "../output";
import { isValidEmail } from "@dosya-dev/shared";

const HELP = `Manage workspace members on dosya.dev.

Usage:
  dosya member list [flags]              List workspace members
  dosya member roles [flags]             List the workspace's roles (built-in and custom)
  dosya member invite --email <e> [flags]  Invite a member

Flags:
  --workspace, -w <id>   Workspace ID (required if no default set)
  --email <email>        Email address to invite
  --role <role>          Role to invite into (default: Member). A built-in name
                         (Admin, Member, Viewer), a role id, or a custom role's
                         name as shown by 'dosya member roles'
  --json, -j             Output as JSON

Examples:
  dosya member list --workspace ws_abc123
  dosya member roles --workspace ws_abc123
  dosya member invite --email alice@example.com --workspace ws_abc123
  dosya member invite --email bob@co.com --role Admin -w ws_abc123
  dosya member invite --email cat@co.com --role "Ops Lead" -w ws_abc123`;

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

/** One row of GET /api/roles: the four built-ins plus this workspace's custom roles. */
export interface RoleRow {
    id: string;
    name: string;
    is_builtin?: boolean;
    is_custom?: boolean;
    permissions: Record<string, boolean>;
}

interface RolesResponse {
    ok: boolean;
    roles: RoleRow[];
    all_permissions: string[];
}

/** The role's display name, or the id itself when the list does not know it. */
export function roleNameOf(roleId: string, roles: RoleRow[]): string {
    return roles.find(r => r.id === roleId)?.name ?? roleId;
}

/**
 * Turn a `--role` value into what the invite endpoint accepts.
 *
 * The server already resolves the built-in names (Admin, Member, Viewer) and
 * takes any role id as-is, so those pass through. What it cannot do is name a
 * CUSTOM role: "Ops Lead" had to be typed as its role_xxx id, which nothing in
 * the CLI ever showed. A value that matches exactly one custom role's name
 * (case-insensitive) becomes that role's id. Two custom roles differing only
 * in case are refused rather than guessed. Anything else passes through, so
 * the server's own "Invalid role" names the problem.
 */
export function resolveRoleFlag(role: string, roles: RoleRow[]): string {
    if (roles.some(r => r.id === role)) return role;
    const wanted = role.trim().toLowerCase();
    const custom = roles.filter(r => r.is_custom === true || r.is_builtin === false);
    const hits = custom.filter(r => r.name.trim().toLowerCase() === wanted);
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) {
        throw new Error(`Role name "${role}" is ambiguous (${hits.map(h => h.id).join(", ")}). Use the role id instead.`);
    }
    return role;
}

async function getRoles(client: DosyaClient, workspaceId: string): Promise<RolesResponse> {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return await client.get<RolesResponse>(`/api/roles?${params}`);
}

/**
 * Best-effort role list for name resolution. Listing roles is its own
 * permission; a role that may list members but not roles still gets a member
 * list, with ids where names would have been.
 */
async function tryGetRoles(client: DosyaClient, workspaceId: string): Promise<RoleRow[]> {
    try {
        return (await getRoles(client, workspaceId)).roles ?? [];
    } catch (err) {
        debug(`roles unavailable (${(err as Error).message}); showing role ids`);
        return [];
    }
}

export async function memberList(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { memberHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const workspaceId = flags.workspace || config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id>", EXIT.USAGE);
    }

    try {
        // Use URLSearchParams for safe encoding
        const params = new URLSearchParams({ workspace_id: workspaceId });
        const [data, roles] = await Promise.all([
            client.get<TeamResponse>(`/api/team?${params}`),
            tryGetRoles(client, workspaceId),
        ]);

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        if (data.members.length === 0) {
            log("No members found.");
            return;
        }

        // Names, not ids: role_c9f2... told nobody anything about a custom role.
        const rows = data.members.map(m => [
            m.name,
            m.email,
            roleNameOf(m.role_id, roles),
            timeAgo(m.joined_at),
        ]);

        printTable(["NAME", "EMAIL", "ROLE", "JOINED"], rows);

        if (data.invites.length > 0) {
            log(`\n${data.invites.length} pending invite(s)`);
        }
    } catch (err) {
        fatalError(err);
    }
}

/** `dosya member roles`: the roles `--role` can name, custom ones included. */
export async function memberRoles(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { memberHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const workspaceId = flags.workspace || config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id>", EXIT.USAGE);
    }

    try {
        const data = await getRoles(client, workspaceId);

        if (flags.json !== undefined) {
            printJson(data);
            return;
        }

        const roles = data.roles ?? [];
        if (roles.length === 0) {
            log("No roles found.");
            return;
        }

        const total = data.all_permissions?.length ?? 0;
        const rows = roles.map(r => {
            const granted = Object.values(r.permissions ?? {}).filter(Boolean).length;
            return [
                r.id,
                r.name,
                r.is_custom === true || r.is_builtin === false ? "custom" : "built-in",
                total > 0 ? `${granted} of ${total}` : String(granted),
            ];
        });

        printTable(["ID", "NAME", "TYPE", "PERMISSIONS"], rows);
    } catch (err) {
        fatalError(err);
    }
}

export async function memberInvite(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { memberHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const workspaceId = flags.workspace || config?.default_workspace;
    const email = flags.email;
    const roleFlag = flags.role || "Member";

    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id>", EXIT.USAGE);
    }
    if (!email) {
        fatal("Email required. Usage: dosya member invite --email <email>", EXIT.USAGE);
    }
    if (!isValidEmail(email)) {
        fatal("Invalid email address.", EXIT.USAGE);
    }

    // A custom role's name resolves to its id here; see resolveRoleFlag.
    const roles = await tryGetRoles(client, workspaceId);
    let role: string;
    try {
        role = resolveRoleFlag(roleFlag, roles);
    } catch (err) {
        return fatal((err as Error).message, EXIT.USAGE);
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

        log(`Invited ${email} as ${roleNameOf(role, roles)}`);
    } catch (err) {
        fatalError(err);
    }
}
