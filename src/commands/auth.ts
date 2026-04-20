import { loadConfig, saveConfig, deleteConfig } from "../config";
import { DosyaClient, AuthError } from "../client";
import { fatal, EXIT } from "../output";

const HELP = `Authenticate with the dosya.dev API.

Usage:
  dosya auth login [flags]    Authenticate with an API key
  dosya auth logout            Clear stored credentials

Flags:
  --key <key>     API key (skip interactive prompt)
  --api <url>     API base URL (default: https://dosya.dev)

Examples:
  dosya auth login
  dosya auth login --key dos_abc123
  dosya auth logout`;

export function authHelp(): void {
    console.log(HELP);
}

export async function login(flags: Record<string, string>): Promise<void> {
    let apiKey = flags.key;

    if (!apiKey) {
        if (!process.stdin.isTTY) {
            fatal("Cannot prompt for API key in non-interactive mode. Use --key <key> or set DOSYA_API_KEY.", EXIT.USAGE);
        }

        // Hide input: use raw mode to avoid echoing the API key
        process.stdout.write("Enter API key: ");

        if (process.stdin.setRawMode) {
            process.stdin.setRawMode(true);
        }

        const chunks: Uint8Array[] = [];
        const reader = Bun.stdin.stream().getReader();

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done || !value) break;

                // Check for Enter key (CR or LF)
                const enterIdx = value.indexOf(13) !== -1 ? value.indexOf(13) : value.indexOf(10);
                if (enterIdx !== -1) {
                    if (enterIdx > 0) chunks.push(value.slice(0, enterIdx));
                    break;
                }
                // Check for Ctrl+C
                if (value.includes(3)) {
                    process.stdout.write("\n");
                    process.exit(130);
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
        apiKey = Buffer.concat(chunks).toString("utf-8").trim();
    }

    if (!apiKey || !apiKey.startsWith("dos_")) {
        fatal("Invalid API key. Keys start with 'dos_'. Get yours at https://dosya.dev/settings/api-keys", EXIT.USAGE);
    }

    const apiBase = flags.api ?? "https://dosya.dev";
    const client = new DosyaClient(apiBase, apiKey);

    try {
        const data = await client.get<{ ok: boolean; user: { id: string; email: string; name: string } }>("/api/me");
        await saveConfig({ api_key: apiKey, api_base: apiBase });
        console.log(`Authenticated as ${data.user.name} (${data.user.email})`);
    } catch (err) {
        if (err instanceof AuthError) {
            fatal(`Authentication failed: invalid API key.`, EXIT.AUTH);
        }
        fatal(`Authentication failed: ${(err as Error).message}`);
    }
}

export async function logout(): Promise<void> {
    deleteConfig();
    console.log("Logged out.");
}
