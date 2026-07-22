import { loadConfig, updateConfig, getConfigPath, type DosyaConfig } from "../config";
import { printJson, fatal, log, EXIT } from "../output";

const HELP = `Manage CLI configuration.

Usage:
  dosya config get [key]         Show config value (or all if no key)
  dosya config set <key> <value> Set a config value
  dosya config path              Print config file location

Keys:
  api_base              API base URL (default: https://dosya.dev)
  default_workspace     Default workspace ID for commands
  sync_delta            "true" to enable block-level delta sync uploads (opt-in)
  sync_parallel         Max concurrent sync transfers (default 8, max 16)

Flags:
  --json, -j            Output as JSON

Examples:
  dosya config set default_workspace ws_abc123
  dosya config get default_workspace
  dosya config set sync_delta true
  dosya config set sync_parallel 12
  dosya config path`;

export function configHelp(): void {
    console.log(HELP);
}

const ALLOWED_KEYS = ["api_base", "default_workspace", "sync_delta", "sync_parallel"] as const;
type ConfigKey = (typeof ALLOWED_KEYS)[number];

function isAllowedKey(key: string): key is ConfigKey {
    return (ALLOWED_KEYS as readonly string[]).includes(key);
}

/**
 * Never print the stored API key.
 *
 * `config get --json` used to dump the raw config, so piping it anywhere —
 * a log, a bug report, CI output — leaked the credential.
 */
function redact(config: DosyaConfig | null): Record<string, unknown> {
    if (!config) return {};
    const { api_key, ...rest } = config;
    return { ...rest, api_key: api_key ? "<redacted>" : undefined };
}

export async function configGet(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { configHelp(); return; }

    const config = await loadConfig();
    const key = args[0];

    if (key) {
        if (!isAllowedKey(key)) {
            fatal(`Unknown config key: ${key}. Available keys: ${ALLOWED_KEYS.join(", ")}`, EXIT.USAGE);
        }
        const value = config?.[key] ?? "";

        if (flags.json !== undefined) {
            printJson({ key, value });
        } else {
            log(value || "(not set)");
        }
        return;
    }

    // Show all config
    if (flags.json !== undefined) {
        printJson(redact(config));
    } else if (!config) {
        log("No configuration found. Run: dosya auth login");
    } else {
        log(`api_base:           ${config.api_base}`);
        log(`default_workspace:  ${config.default_workspace ?? "(not set)"}`);
        log(`sync_delta:         ${config.sync_delta ?? "(not set)"}`);
        log(`sync_parallel:      ${config.sync_parallel ?? "(not set, default 8)"}`);
    }
}

export async function configSet(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { configHelp(); return; }

    const [key, value] = args;
    if (!key || value === undefined) {
        fatal("Usage: dosya config set <key> <value>", EXIT.USAGE);
    }
    if (!isAllowedKey(key)) {
        fatal(`Unknown config key: ${key}. Available keys: ${ALLOWED_KEYS.join(", ")}`, EXIT.USAGE);
    }

    const config = await loadConfig();
    if (!config) {
        fatal("Not authenticated. Run: dosya auth login", EXIT.AUTH);
    }

    await updateConfig({ [key]: value });

    if (flags.json !== undefined) {
        printJson({ ok: true, key, value });
    } else {
        log(`Set ${key} = ${value}`);
    }
}

export async function configPath(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { configHelp(); return; }

    const p = getConfigPath();
    if (flags.json !== undefined) {
        printJson({ path: p });
    } else {
        log(p);
    }
}
