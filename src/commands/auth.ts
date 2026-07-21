import { updateConfig, deleteConfig, DEFAULT_API_BASE } from "../config";
import { createClient, AuthError } from "../client";
import { fatal, fatalError, log, EXIT } from "../output";

const HELP = `Authenticate with the dosya.dev API.

Usage:
  dosya auth login [flags]    Authenticate with an API key
  dosya auth logout            Clear stored credentials

Flags:
  --key <key>     API key (skip interactive prompt)
  --api <url>     API base URL (default: ${DEFAULT_API_BASE})

Examples:
  dosya auth login
  dosya auth login --key dos_abc123
  dosya auth logout`;

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

export async function login(flags: Record<string, string>): Promise<void> {
    let apiKey = flags.key;

    if (!apiKey) {
        if (!process.stdin.isTTY) {
            fatal("Cannot prompt for API key in non-interactive mode. Use --key <key> or set DOSYA_API_KEY.", EXIT.USAGE);
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

export async function logout(): Promise<void> {
    deleteConfig();
    log("Logged out.");
}
