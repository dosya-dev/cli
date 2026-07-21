import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, renameSync, unlinkSync, readFileSync } from "fs";
import { getConfigDir } from "../config";
import type { SyncConfig } from "./types";

/** Names never synced, regardless of a pair's user excludes. */
export const DEFAULT_IGNORES = [
    ".git",
    ".DS_Store",
    "Thumbs.db",
    "*.dosya-upload",
    "*.dosya-download",
    "*.dosya-partial",
];

export function syncDir(): string {
    return join(getConfigDir(), "sync");
}

export function syncConfigPath(): string {
    return join(syncDir(), "config.json");
}

export function syncStateDir(): string {
    return join(syncDir(), "state");
}

/** Stable id for a pair, derived from its local+remote so it never depends on a clock. */
export function pairId(local: string, remote: string): string {
    const h = new Bun.CryptoHasher("sha256");
    h.update(`${local}\0${remote}`);
    return h.digest("hex").slice(0, 12);
}

export function loadSyncConfig(): SyncConfig {
    try {
        const text = readFileSync(syncConfigPath(), "utf8");
        const parsed = JSON.parse(text) as SyncConfig;
        return { pairs: parsed.pairs ?? [] };
    } catch {
        return { pairs: [] };
    }
}

export function saveSyncConfig(config: SyncConfig): void {
    const dir = syncDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${syncConfigPath()}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
        renameSync(tmp, syncConfigPath());
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        throw err;
    }
}

/** Translate one glob (`*`, `**`, `?`) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") { re += ".*"; i++; }
            else re += "[^/]*";
        } else if (c === "?") {
            re += "[^/]";
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(`^${re}$`);
}

/**
 * Build an "is excluded" predicate. A path is excluded when the whole
 * root-relative path matches a glob, or any single segment does (so
 * `node_modules` catches `node_modules/x/y`).
 */
export function compileExcludes(globs: string[]): (relPath: string) => boolean {
    const regexes = globs.filter(Boolean).map(globToRegExp);
    if (regexes.length === 0) return () => false;
    return (relPath: string): boolean => {
        const segments = relPath.split("/");
        return regexes.some(re => re.test(relPath) || segments.some(seg => re.test(seg)));
    };
}
