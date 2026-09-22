import { updateConfig, deleteConfig, loadConfig, resolveApiBase, getConfigPath, DEFAULT_API_BASE } from "../config";
import { createClient, AuthError } from "../client";
import { fatal, fatalError, log, warn, EXIT } from "../output";

const HELP = `Authenticate with the dosya.dev API.

Usage:
  dosya auth login [flags]    Authenticate with an API key
  dosya auth logout [flags]   Clear stored credentials

Flags:
  --key -         Read the API key from stdin (safe for scripts)
  --key <key>     API key as an argument - see the note below
  --api <url>     API base URL (default: ${DEFAULT_API_BASE})
  --revoke        On logout, also revoke the key server-side

Environment:
  DOSYA_API_KEY   Used by every command when set, and never written to disk.

Examples:
  dosya auth login
  echo "$MY_KEY" | dosya auth login --key -
  dosya auth logout
  dosya auth logout --revoke

A key passed as an argument is recorded in your shell history and is visible
to anyone who can list processes on this machine. Prefer DOSYA_API_KEY or
--key - for anything non-interactive.`;

export function authHelp(): void {
    console.log(HELP);
}

/** Read a line from stdin without echoing it back to the terminal. */
async function promptHidden(prompt: string): Promise<string> {
    process.stdout.write(prompt);

    if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
    }

    const chunks: Uint8Array[] = [];
    const reader = Bun.stdin.stream().getReader();

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done || !value) break;

            // Check for Ctrl+C
            if (value.includes(3)) {
                process.stdout.write("\n");
                process.exit(130);
            }

            // Check for Enter key (CR or LF)
            const cr = value.indexOf(13);
            const lf = value.indexOf(10);
            const enterIdx = cr !== -1 && lf !== -1 ? Math.min(cr, lf) : Math.max(cr, lf);
            if (enterIdx !== -1) {
                if (enterIdx > 0) chunks.push(value.slice(0, enterIdx));
                break;
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
        if (process.stdin.setRawMode) {
            process.stdin.setRawMode(false);
        }
    }

    process.stdout.write("\n");
    return Buffer.concat(chunks).toString("utf-8").trim();
}

/**
 * Read the key from stdin, the way `-` conventionally means everywhere else.
 *
 * The alternative - `--key <literal>` - writes the credential to the shell
 * history file and publishes it in the process list, where `ps` shows it to
 * every other user on a stock Linux box. A pipe is visible to neither.
 */
async function readKeyFromStdin(): Promise<string> {
    const key = (await Bun.stdin.text()).trim();
    if (!key) {
        fatal("No API key on stdin. Pipe one in: echo \"$MY_KEY\" | dosya auth login --key -", EXIT.USAGE);
    }
    return key;
}

export async function login(flags: Record<string, string>): Promise<void> {
    let apiKey = flags.key;

    if (apiKey === "-") {
        apiKey = await readKeyFromStdin();
    } else if (apiKey) {
        // Said even on success: by the time we get here the key is already in
        // the history file, so the useful moment to mention it is now, while
        // the user still has the chance to rotate it and switch forms.
        warn(
            "a key passed as an argument is saved in your shell history and visible " +
            "in the process list. Prefer DOSYA_API_KEY, or pipe it in with --key -.",
        );
    } else {
        if (!process.stdin.isTTY) {
            fatal(
                "Cannot prompt for API key in non-interactive mode. Set DOSYA_API_KEY, " +
                "or pipe the key in with: dosya auth login --key -",
                EXIT.USAGE,
            );
        }
        apiKey = await promptHidden("Enter API key: ");
    }

    if (!apiKey || !apiKey.startsWith("dos_")) {
        fatal("Invalid API key. Keys start with 'dos_'. Get yours at https://dosya.dev/settings/api-keys", EXIT.USAGE);
    }

    const apiBase = flags.api || process.env.DOSYA_API_BASE || DEFAULT_API_BASE;
    const client = createClient(apiBase, apiKey);

    try {
        const data = await client.get<{ ok: boolean; user: { id: string; email: string; name: string } }>("/api/me");
        // Merge rather than overwrite, so an existing default_workspace survives
        await updateConfig({ api_key: apiKey, api_base: apiBase });
        log(`Authenticated as ${data.user.name} (${data.user.email})`);
    } catch (err) {
        if (err instanceof AuthError) {
            fatal("Authentication failed: invalid API key.", EXIT.AUTH);
        }
        fatalError(err);
    }
}

/**
 * Clear the stored credential, and with --revoke destroy it server-side too.
 *
 * Without the flag this only ever deleted the local file, which reads as "the
 * key is dead" to anyone logging out of a borrowed or shared machine and is
 * not: the credential stayed valid until they remembered to open the dashboard.
 */
export async function logout(flags: Record<string, string> = {}): Promise<void> {
    if (flags.revoke === undefined) {
        deleteConfig();
        log("Logged out.");
        return;
    }

    const config = await loadConfig();
    const storedKey = config?.api_key;

    if (!storedKey) {
        // DOSYA_API_KEY is not what `logout` deletes, so revoking it would be a
        // side effect nobody asked for - but letting the user believe a key died
        // when nothing happened is worse. Name the credential that is in play.
        if (process.env.DOSYA_API_KEY) {
            log(
                `No API key stored in ${getConfigPath()}. DOSYA_API_KEY is set in your ` +
                "environment; this command does not manage it - revoke it at " +
                "https://dosya.dev/settings/api-keys",
            );
        } else {
            log("Not authenticated - nothing to revoke.");
        }
        deleteConfig();
        return;
    }

    const client = createClient(resolveApiBase(config), storedKey);

    try {
        await client.del("/api/me/api-keys/current");
    } catch (err) {
        // Only 401 proves the key is dead. A 403 - an IP allowlist, an
        // active-hours window - means it is alive and merely refused from here.
        if (err instanceof AuthError && err.status === 401) {
            deleteConfig();
            log("Stored API key is no longer valid. Cleared local credentials.");
            return;
        }
        // The local copy is the only handle left on a key that is still live -
        // deleting it here would leave the user unable to retry the revoke.
        const message = err instanceof Error ? err.message : String(err);
        fatal(
            `Could not revoke the API key: ${message}\n` +
            "  Credentials were left in place so you can retry.\n" +
            "  To clear them locally without revoking: dosya auth logout",
        );
    }

    deleteConfig();
    log("API key revoked. Logged out.");
}
