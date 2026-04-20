import { loadConfig, saveConfig, getConfigPath } from "../config";
import { printJson, fatal, log, EXIT } from "../output";

const HELP = `Manage CLI configuration.

Usage:
  dosya config get [key]         Show config value (or all if no key)
  dosya config set <key> <value> Set a config value
  dosya config path              Print config file location

Keys:
  api_base              API base URL (default: https://dosya.dev)
  default_workspace     Default workspace ID for commands

Flags:
  --json, -j            Output as JSON

Examples:
  dosya config set default_workspace ws_abc123
  dosya config get default_workspace
  dosya config path`;

export function configHelp(): void {
    console.log(HELP);
}

const ALLOWED_KEYS = ["api_base", "default_workspace"] as const;
type ConfigKey = (typeof ALLOWED_KEYS)[number];

function isAllowedKey(key: string): key is ConfigKey {
    return (ALLOWED_KEYS as readonly string[]).includes(key);
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
        printJson(config ?? {});
    } else if (!config) {
        log("No configuration found. Run: dosya auth login");
    } else {
        log(`api_base:           ${config.api_base}`);
        log(`default_workspace:  ${config.default_workspace ?? "(not set)"}`);
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

    config[key] = value;
    await saveConfig(config);

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
