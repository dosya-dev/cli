import { createClient, DosyaClient } from "../client";
import { requireAuth } from "../config";
import { ApiError } from "../errors";
import { printTable, printJson, fatal, fatalError, log, EXIT } from "../output";
import { Resolver } from "../resolver";
import { isValidEmail } from "@dosya-dev/shared";

/** Lock modes accepted by POST /api/files/:id/share. */
const LOCK_MODES = ["none", "view_only", "full_lock"] as const;

const HELP = `Create and manage share links on dosya.dev.

Usage:
  dosya share <file> [flags]              Create a share link
  dosya share list [flags]                List the workspace's share links
  dosya share revoke <link_id>            Revoke a share link
  dosya share email <file> --email <e>    Create a link and email it
  dosya share bundle <file...> [flags]    Share several files as one link

Create flags:
  --password <pwd>     Password-protect the link
  --expires <days>     Expiration (e.g. "7d" or "30")
  --lock <mode>        Lock mode: none, view_only, full_lock (full_lock needs --password)

Shared flags:
  --workspace, -w <id> Workspace for path lookups / listing
  --message <text>     Message body (email)
  --json, -j           Output as JSON

Examples:
  dosya share report.pdf --expires 7d --password secret
  dosya share list -w ws_abc123
  dosya share revoke lnk_abc123
  dosya share email report.pdf --email a@b.com
  dosya share bundle a.pdf b.pdf --expires 14d`;

export function shareHelp(): void {
    console.log(HELP);
}

/** Parse `7d` / `30` into a day count. */
function parseExpires(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const match = raw.match(/^(\d+)d?$/);
    if (!match) fatal("Invalid --expires format. Use e.g. '7d' or '30'.", EXIT.USAGE);
    const days = parseInt(match[1], 10);
    if (days < 1) fatal("--expires must be at least 1 day.", EXIT.USAGE);
    return days;
}

interface ShareLink {
    id: string;
    token: string;
    url: string;
    lock_mode: string;
    expires_at: number | null;
    created_at: number;
}

async function shareCreate(args: string[], flags: Record<string, string>, client: DosyaClient, defaultWorkspace?: string): Promise<void> {
    const target = args[0];
    if (!target) {
        fatal("File required. Usage: dosya share <file>", EXIT.USAGE);
    }

    const expiresInDays = parseExpires(flags.expires);
    if (flags.lock && !(LOCK_MODES as readonly string[]).includes(flags.lock)) {
        fatal(`Invalid --lock value: ${flags.lock}. Must be one of: ${LOCK_MODES.join(", ")}.`, EXIT.USAGE);
    }
    if (flags.lock === "full_lock" && !flags.password) {
        fatal("--lock full_lock requires --password.", EXIT.USAGE);
    }

    const resolved = await new Resolver(client).resolve(target, { workspace: flags.workspace, defaultWorkspace });
    if (resolved.type !== "file") {
        fatal("share creates a link for a file. Use 'dosya share bundle' for many, or share a folder from the web.", EXIT.USAGE);
    }

    const body: Record<string, unknown> = {};
    if (flags.password) body.password = flags.password;
    if (expiresInDays) body.expires_in_days = expiresInDays;
    if (flags.lock) body.lock_mode = flags.lock;

    const data = await client.post<{ ok: boolean; link: ShareLink }>(
        `/api/files/${encodeURIComponent(resolved.id)}/share`,
        body,
    );

    if (flags.json !== undefined) {
        printJson(data);
        return;
    }
    log(data.link.url);
    if (data.link.expires_at) {
        log(`Expires: ${new Date(data.link.expires_at * 1000).toLocaleDateString()}`);
    }
}

interface ShareListItem {
    link_id: string;
    display_name: string;
    status: string;
    expires_at: number | null;
    view_count: number;
    download_count: number;
    url: string;
}

async function shareList(flags: Record<string, string>, client: DosyaClient, defaultWorkspace?: string): Promise<void> {
    const workspaceId = flags.workspace || defaultWorkspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id> or set a default: dosya config set default_workspace <id>", EXIT.USAGE);
    }

    const data = await client.get<{ ok: boolean; links: ShareListItem[]; stats: { total: number; active: number; expiring: number; total_views: number } }>(
        `/api/shares?workspace_id=${encodeURIComponent(workspaceId)}`,
    );

    if (flags.json !== undefined) {
        printJson(data);
        return;
    }

    const links = data.links ?? [];
    if (links.length === 0) {
        log("No share links.");
        return;
    }

    printTable(
        ["NAME", "STATUS", "EXPIRES", "VIEWS", "LINK ID"],
        links.map(l => [
            l.display_name,
            l.status,
            l.expires_at ? new Date(l.expires_at * 1000).toLocaleDateString() : "never",
            String(l.view_count),
            l.link_id,
        ]),
    );
    if (data.stats) {
        log(`\n${data.stats.total} link(s), ${data.stats.active} active, ${data.stats.total_views} total views`);
    }
}

async function shareRevoke(args: string[], flags: Record<string, string>, client: DosyaClient): Promise<void> {
    const linkId = args[0];
    if (!linkId) {
        fatal("Link id required. Usage: dosya share revoke <link_id>", EXIT.USAGE);
    }
    try {
        await client.post(`/api/shares/${encodeURIComponent(linkId)}/revoke`);
    } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
            if (flags.json !== undefined) printJson({ ok: true, already_revoked: true });
            else log("Link was already revoked.");
            return;
        }
        throw err;
    }
    if (flags.json !== undefined) printJson({ ok: true, revoked: linkId });
    else log(`Revoked ${linkId}`);
}

async function shareEmail(args: string[], flags: Record<string, string>, client: DosyaClient, defaultWorkspace?: string): Promise<void> {
    const target = args[0];
    if (!target) {
        fatal("File required. Usage: dosya share email <file> --email <address>", EXIT.USAGE);
    }
    if (!flags.email) {
        fatal("Email required. Use --email <address>.", EXIT.USAGE);
    }
    if (!isValidEmail(flags.email)) {
        fatal("Invalid email address.", EXIT.USAGE);
    }

    const resolved = await new Resolver(client).resolve(target, { workspace: flags.workspace, defaultWorkspace });
    if (resolved.type !== "file") fatal("share email targets a file.", EXIT.USAGE);

    const body: Record<string, unknown> = { email: flags.email };
    if (flags.message) body.message = flags.message;
    if (flags.password) body.password = flags.password;

    const data = await client.post<{ ok: boolean; share_url: string }>(
        `/api/files/${encodeURIComponent(resolved.id)}/share-email`,
        body,
    );

    if (flags.json !== undefined) printJson(data);
    else log(`Emailed ${flags.email}: ${data.share_url}`);
}

async function shareBundle(args: string[], flags: Record<string, string>, client: DosyaClient, defaultWorkspace?: string): Promise<void> {
    if (args.length === 0) {
        fatal("Usage: dosya share bundle <file...>", EXIT.USAGE);
    }
    const expiresInDays = parseExpires(flags.expires);
    const resolver = new Resolver(client);
    const resolved = await resolver.resolveMany(args, { workspace: flags.workspace, defaultWorkspace });
    const nonFile = resolved.find(r => r.type !== "file");
    if (nonFile) fatal(`share bundle takes files only; "${nonFile.name}" is a folder.`, EXIT.USAGE);

    const body: Record<string, unknown> = { file_ids: resolved.map(r => r.id) };
    if (expiresInDays) body.expires_in_days = expiresInDays;
    if (flags.password) body.password = flags.password;

    const data = await client.post<{ ok: boolean; link: ShareLink & { file_count: number } }>(
        "/api/files/share-bundle",
        body,
    );

    if (flags.json !== undefined) printJson(data);
    else log(`${data.link.url}  (${data.link.file_count} files)`);
}

export async function share(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { shareHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);
    const defaultWorkspace = config?.default_workspace;

    const sub = args[0];
    try {
        if (sub === "list") return await shareList(flags, client, defaultWorkspace);
        if (sub === "revoke") return await shareRevoke(args.slice(1), flags, client);
        if (sub === "email") return await shareEmail(args.slice(1), flags, client, defaultWorkspace);
        if (sub === "bundle") return await shareBundle(args.slice(1), flags, client, defaultWorkspace);
        // Default: create a link for the given file.
        return await shareCreate(args, flags, client, defaultWorkspace);
    } catch (err) {
        fatalError(err);
    }
}
