import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, chmodSync, unlinkSync, renameSync, writeFileSync } from "fs";
import { EXIT } from "./output";

export interface DosyaConfig {
    api_key: string;
    api_base: string;
    default_workspace?: string;
}

/**
 * The API is served by a dedicated Worker on `api.dosya.dev`; the apex domain
 * hosts the marketing site and has no /api routes.
 */
export const DEFAULT_API_BASE = "https://api.dosya.dev";

export function getConfigDir(): string {
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
    // Write to a per-process temp file first, then atomic rename — this avoids
    // two concurrent writers sharing one temp path, and never leaves a
    // half-written config in place.
    //
    // The mode is passed to open() rather than chmod'ed afterwards: creating
    // the file 0644 and fixing it up leaves a window where the API key is
    // world-readable, which matters whenever the config dir itself is not 0700
    // (e.g. a `~/.dosya` the user created by hand).
    const tmpFile = `${CONFIG_FILE}.${process.pid}.tmp`;
    try {
        writeFileSync(tmpFile, JSON.stringify(config, null, 2), { mode: 0o600 });
        // writeFileSync honours mode only when creating; enforce it either way
        chmodSync(tmpFile, 0o600);
        renameSync(tmpFile, CONFIG_FILE);
    } catch (err) {
        try { unlinkSync(tmpFile); } catch { /* nothing to clean up */ }
        throw err;
    }
}

/**
 * Merge updates into the stored config, preserving unrelated keys.
 *
 * `auth login` used to overwrite the whole file, silently dropping the user's
 * `default_workspace`.
 */
export async function updateConfig(updates: Partial<DosyaConfig>): Promise<DosyaConfig> {
    const existing = await loadConfig();
    const merged = { ...existing, ...updates } as DosyaConfig;
    await saveConfig(merged);
    return merged;
}

export function deleteConfig(): void {
    try {
        unlinkSync(CONFIG_FILE);
    } catch {
        // already gone
    }
}

/** Resolve the API base URL. Precedence: env > config file > default. */
export function resolveApiBase(config: DosyaConfig | null): string {
    return process.env.DOSYA_API_BASE ?? config?.api_base ?? DEFAULT_API_BASE;
}

/**
 * Get config or exit with error if not authenticated.
 * Precedence: --key flag > DOSYA_API_KEY env > config file.
 */
export async function requireAuth(flagKey?: string): Promise<{ apiKey: string; apiBase: string; config: DosyaConfig | null }> {
    const config = await loadConfig();
    const apiKey = (flagKey || undefined) ?? process.env.DOSYA_API_KEY ?? config?.api_key;

    if (!apiKey) {
        console.error("Not authenticated. Run: dosya auth login");
        process.exit(EXIT.AUTH);
    }

    return { apiKey, apiBase: resolveApiBase(config), config };
}
