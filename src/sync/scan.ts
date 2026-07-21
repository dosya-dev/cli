import { readdirSync, statSync, type Dirent } from "fs";
import { join, relative, sep } from "path";

export interface LocalEntry {
    size: number;
    mtimeMs: number;
    isDir: boolean;
}

export interface ScanResult {
    entries: Map<string, LocalEntry>;
    /** True if any directory could not be read — deletes are suppressed this cycle. */
    incomplete: boolean;
}

const MAX_DEPTH = 50;
const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB

/**
 * Walk a local directory into a `relPath -> entry` map (forward-slash paths,
 * root-relative). Excluded paths are skipped; symlinks/sockets/devices are
 * ignored. A directory that cannot be read sets `incomplete`, which the
 * reconciler uses to suppress deletions.
 */
export function scanLocal(root: string, isExcluded: (relPath: string) => boolean): ScanResult {
    const entries = new Map<string, LocalEntry>();
    let incomplete = false;

    function walk(dir: string, depth: number): void {
        if (depth > MAX_DEPTH) return;
        let items: Dirent[];
        try {
            items = readdirSync(dir, { withFileTypes: true }) as Dirent[];
        } catch {
            incomplete = true;
            return;
        }
        for (const item of items) {
            const full = join(dir, item.name);
            const rel = relative(root, full).split(sep).join("/");
            if (isExcluded(rel)) continue;

            if (item.isDirectory()) {
                entries.set(rel, { size: 0, mtimeMs: 0, isDir: true });
                walk(full, depth + 1);
            } else if (item.isFile()) {
                let st;
                try {
                    st = statSync(full);
                } catch {
                    incomplete = true;
                    continue;
                }
                if (st.size > MAX_FILE_SIZE) continue;
                entries.set(rel, { size: st.size, mtimeMs: st.mtimeMs, isDir: false });
            }
            // Non-regular entries (symlinks, sockets, devices) are skipped.
        }
    }

    walk(root, 0);
    return { entries, incomplete };
}
