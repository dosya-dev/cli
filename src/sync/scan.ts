import { readdir, stat } from "fs/promises";
import { join, relative, sep } from "path";

export interface LocalEntry {
    size: number;
    mtimeMs: number;
    isDir: boolean;
}

export interface ScanResult {
    entries: Map<string, LocalEntry>;
    /** True if any directory could not be read - deletes are suppressed this cycle. */
    incomplete: boolean;
}

export interface ScanOptions {
    /**
     * Stay on the sync root's filesystem: skip any directory whose device id
     * differs from the root's. This excludes pseudo-filesystems (/proc, /sys,
     * /dev, /run - each a distinct mount whose files can block on read) and
     * other mounted disks / network shares. Essential for whole-disk backups.
     */
    oneFileSystem?: boolean;
}

const MAX_DEPTH = 50;
const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB
const DIR_CONCURRENCY = 16;   // directories read in parallel per level
const STAT_BATCH = 256;       // files statted in parallel per batch

/**
 * Walk a local directory into a `relPath -> entry` map (forward-slash paths,
 * root-relative). Excluded paths are skipped; symlinks/sockets/devices are
 * ignored. A directory that cannot be read sets `incomplete`, which the
 * reconciler uses to suppress deletions.
 *
 * Async and bounded-parallel so it scales to 100k+ files: directory reads and
 * file `stat`s run concurrently (throughput on high-latency/network mounts) and
 * every `await` yields the event loop, so a huge scan never freezes the process
 * (Ctrl-C stays responsive, progress can still render). The old synchronous
 * `readdirSync`/`statSync` walk blocked the loop for the whole traversal.
 */
export async function scanLocal(
    root: string,
    isExcluded: (relPath: string) => boolean,
    opts: ScanOptions = {},
): Promise<ScanResult> {
    const entries = new Map<string, LocalEntry>();
    let incomplete = false;

    // For --one-file-system, remember the root's device id so we can skip any
    // directory that lives on a different filesystem (a mount or pseudo-fs).
    let rootDev: number | null = null;
    if (opts.oneFileSystem) {
        try { rootDev = (await stat(root)).dev; } catch { /* fall back to no boundary */ }
    }

    // Phase 1 - discover the tree breadth-first, reading directories in bounded-
    // concurrency batches. Directories are recorded immediately; files are queued
    // for statting (readdir alone can't give a reliable size/mtime).
    const files: { full: string; rel: string }[] = [];
    let frontier: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

    while (frontier.length > 0) {
        const nextFrontier: { dir: string; depth: number }[] = [];

        for (let i = 0; i < frontier.length; i += DIR_CONCURRENCY) {
            const batch = frontier.slice(i, i + DIR_CONCURRENCY);
            const listings = await Promise.all(batch.map(async ({ dir, depth }) => {
                if (depth > MAX_DEPTH) return null;
                try {
                    return { entries: await readdir(dir, { withFileTypes: true }), dir, depth };
                } catch {
                    incomplete = true;
                    return null;
                }
            }));

            for (const listing of listings) {
                if (!listing) continue;
                for (const item of listing.entries) {
                    const full = join(listing.dir, item.name);
                    const rel = relative(root, full).split(sep).join("/");
                    if (isExcluded(rel)) continue;

                    if (item.isDirectory()) {
                        // --one-file-system: don't cross into a mount / pseudo-fs.
                        // A boundary is intentional, so it does NOT set `incomplete`
                        // (that would needlessly suppress deletions this cycle).
                        if (rootDev !== null) {
                            let dev: number | null = null;
                            try { dev = (await stat(full)).dev; } catch { incomplete = true; continue; }
                            if (dev !== rootDev) continue;
                        }
                        entries.set(rel, { size: 0, mtimeMs: 0, isDir: true });
                        nextFrontier.push({ dir: full, depth: listing.depth + 1 });
                    } else if (item.isFile()) {
                        files.push({ full, rel });
                    }
                    // Non-regular entries (symlinks, sockets, devices) are skipped.
                }
            }
        }

        frontier = nextFrontier;
    }

    // Phase 2 - stat files in bounded-parallel batches. Awaiting each batch caps
    // both in-flight file handles and peak memory, and yields between batches.
    for (let i = 0; i < files.length; i += STAT_BATCH) {
        await Promise.all(files.slice(i, i + STAT_BATCH).map(async ({ full, rel }) => {
            try {
                const st = await stat(full);
                if (st.size > MAX_FILE_SIZE) return;
                entries.set(rel, { size: st.size, mtimeMs: st.mtimeMs, isDir: false });
            } catch {
                incomplete = true;
            }
        }));
    }

    return { entries, incomplete };
}
