import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, chmodSync, unlinkSync, renameSync } from "fs";
import { EXIT } from "./output";

export interface DosyaConfig {
    api_key: string;
    api_base: string;
    default_workspace?: string;
}

function getConfigDir(): string {
    // Respect XDG_CONFIG_HOME on Linux/macOS
    if (process.env.XDG_CONFIG_HOME) {
        return join(process.env.XDG_CONFIG_HOME, "dosya");
    }
    return join(homedir(), ".dosya");
}

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function getConfigPath(): string {
    return CONFIG_FILE;
}

function ensureDir(): void {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
}

export async function loadConfig(): Promise<DosyaConfig | null> {
    try {
        const text = await Bun.file(CONFIG_FILE).text();
        return JSON.parse(text) as DosyaConfig;
    } catch {
        return null;
    }
}

export async function saveConfig(config: DosyaConfig): Promise<void> {
    ensureDir();
    // Write to temp file first, set permissions, then atomic rename
    // to avoid a TOCTOU window where the file is world-readable
    const tmpFile = CONFIG_FILE + ".tmp";
    await Bun.write(tmpFile, JSON.stringify(config, null, 2));
    chmodSync(tmpFile, 0o600);
    renameSync(tmpFile, CONFIG_FILE);
}

export function deleteConfig(): void {
    try {
        unlinkSync(CONFIG_FILE);
    } catch {
        // already gone
    }
}

/**
 * Get config or exit with error if not authenticated.
 * Precedence: --key flag > DOSYA_API_KEY env > config file.
 */
export async function requireAuth(flagKey?: string): Promise<{ apiKey: string; apiBase: string; config: DosyaConfig | null }> {
    const config = await loadConfig();
    const apiKey = flagKey ?? process.env.DOSYA_API_KEY ?? config?.api_key;

    if (!apiKey) {
        console.error("Not authenticated. Run: dosya auth login");
        process.exit(EXIT.AUTH);
    }

    const apiBase = config?.api_base ?? "https://dosya.dev";
    return { apiKey, apiBase, config };
}
