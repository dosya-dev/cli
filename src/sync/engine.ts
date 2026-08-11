import { nowUnix } from "@dosya-dev/shared";
import { DosyaClient } from "../client";
import { compileExcludes, DEFAULT_IGNORES, loadDosyaIgnore } from "./config";
import { loadState, saveState } from "./state";
import { scanLocal, type ScanResult } from "./scan";
import { SyncRemote, buildRemotePaths } from "./remote";
import { reconcile } from "./reconcile";
import { applyActions, type SyncResults } from "./executor";
import type { SyncPair, SyncPairState, SyncFileRecord, RemoteFile, SyncAction, SyncProgressFn } from "./types";

/**
 * Rebuild the "last synced" snapshot from the post-cycle local + remote state:
 * every file present on both sides at the same path becomes a record. Anything
 * that failed to transfer is absent from one side and simply retried next cycle.
 */
function buildState(pairId: string, scan: ScanResult, remoteById: Map<string, RemoteFile>): SyncPairState {
    const files: Record<string, SyncFileRecord> = {};
    const now = nowUnix();
    for (const r of remoteById.values()) {
        const l = scan.entries.get(r.relPath);
        if (l && !l.isDir) {
            files[r.id] = {
                remoteId: r.id, remoteName: r.name, remoteFolderId: r.folderId,
                remoteSize: r.size, remoteUpdatedAt: r.updatedAt, remoteVersion: r.version,
                localPath: r.relPath, localSize: l.size, localMtimeMs: l.mtimeMs, syncedAt: now,
            };
        }
    }
    return { pairId, lastFullSyncAt: now, files, folders: {} };
}

/**
 * Build the next "last synced" state from what this cycle actually DID -
 * initial scan + initial snapshot + per-action results - instead of re-scanning
 * and re-fetching a full snapshot (which doubled the two most expensive
 * operations per cycle, and, being an eventually-consistent read-back, could
 * record a FAILED download as synced and freeze it forever).
 *
 * Rules, per remote file in the initial snapshot:
 * - action failed        → carry the previous record forward, so it retries;
 * - deleted remotely     → drop;
 * - downloaded           → record remote (snapshot) + local (post-write stat);
 * - version uploaded     → record remote (server result) + local (scan);
 * - moved locally        → record under the new path (rename keeps mtime);
 * - otherwise            → present on both sides ⇒ record scan + snapshot.
 * Plus one record per successfully committed NEW upload (server timestamp).
 *
 * Returns null when any upload result lacks the server timestamp (an older
 * API during rollout) - the caller then falls back to the read-back path
 * rather than guessing a timestamp and causing churn.
 */
function buildStateFromResults(
    pairId: string,
    scan: ScanResult,
    remoteById: Map<string, RemoteFile>,
    prev: SyncPairState,
    res: SyncResults,
): SyncPairState | null {
    for (const u of res.uploadedNew) if (u.updatedAt === null) return null;
    for (const v of res.uploadedVersion) if (v.updatedAt === null) return null;

    const now = nowUnix();
    const files: Record<string, SyncFileRecord> = {};
    const failed = new Set(res.failedRemoteIds);
    const deletedRemote = new Set(res.deletedRemoteIds);
    const moved = new Map(res.movedLocal.map(m => [m.remoteId, m]));
    const versioned = new Map(res.uploadedVersion.map(v => [v.remoteId, v]));
    const pulled = new Map(res.downloaded.map(d => [d.remoteId, d]));

    for (const r of remoteById.values()) {
        if (failed.has(r.id)) {
            const old = prev.files[r.id];
            if (old) files[r.id] = old;
            continue;
        }
        if (deletedRemote.has(r.id)) continue;

        const pull = pulled.get(r.id);
        if (pull) {
            files[r.id] = {
                remoteId: r.id, remoteName: r.name, remoteFolderId: r.folderId,
                remoteSize: r.size, remoteUpdatedAt: r.updatedAt, remoteVersion: r.version,
                localPath: pull.relPath, localSize: pull.size, localMtimeMs: pull.mtimeMs, syncedAt: now,
            };
            continue;
        }

        const move = moved.get(r.id);
        const localPath = move ? move.toPath : r.relPath;
        // The scan predates a local move, so look the entry up at the old path.
        const l = scan.entries.get(move ? move.fromPath : localPath);
        if (!l || l.isDir) continue; // not present locally (e.g. just deleted) → not synced

        const ver = versioned.get(r.id);
        files[r.id] = {
            remoteId: r.id, remoteName: r.name, remoteFolderId: r.folderId,
            remoteSize: ver ? ver.size : r.size,
            remoteUpdatedAt: ver ? ver.updatedAt! : r.updatedAt,
            remoteVersion: ver ? ver.version : r.version,
            localPath, localSize: l.size, localMtimeMs: l.mtimeMs, syncedAt: now,
        };
    }

    // Uploads the withheld-subtree guard skipped. Their ids are absent from
    // remoteById - that absence is the whole reason they were skipped - so the
    // loop above cannot reach them, and without this they would drop out of
    // state and come back next cycle as untracked local files, which upload
    // and create their folders like any new file. Carrying the previous record
    // forward keeps them tracked, so the guard fires again rather than once.
    // The record is dropped as normal once the local file is gone.
    for (const id of res.skippedWithheldIds) {
        const old = prev.files[id];
        if (!old) continue;
        const l = scan.entries.get(old.localPath);
        if (!l || l.isDir) continue;
        files[id] = old;
    }

    for (const u of res.uploadedNew) {
        const l = scan.entries.get(u.relPath);
        if (!l || l.isDir) continue;
        files[u.fileId] = {
            remoteId: u.fileId, remoteName: u.name, remoteFolderId: u.folderId,
            remoteSize: u.size, remoteUpdatedAt: u.updatedAt!, remoteVersion: u.version,
            localPath: u.relPath, localSize: l.size, localMtimeMs: l.mtimeMs, syncedAt: now,
        };
    }

    return { pairId, lastFullSyncAt: now, files, folders: {} };
}

export interface CycleResult {
    plan: SyncAction[];
    applied: number;
    conflicts: number;
    failures: { action: string; error: string }[];
}

/** One full reconcile+apply cycle for a pair. `dryRun` plans without transferring. */
export async function runCycle(
    client: DosyaClient,
    pair: SyncPair,
    dryRun: boolean,
    onProgress?: SyncProgressFn,
): Promise<CycleResult> {
    const remote = new SyncRemote(client, pair.remoteWorkspaceId);
    const isExcluded = compileExcludes([...DEFAULT_IGNORES, ...pair.excludes, ...loadDosyaIgnore(pair.local)]);

    onProgress?.({ kind: "scan" });
    const scan = await scanLocal(pair.local, isExcluded, { oneFileSystem: pair.oneFileSystem });
    onProgress?.({ kind: "snapshot" });
    const snap = await remote.snapshot(pair.remoteFolderId);
    const remoteById = buildRemotePaths(snap.files, snap.folders, pair.remoteFolderId);
    const state = loadState(pair.id);

    const actions = reconcile({
        local: scan.entries,
        remote: remoteById,
        state,
        mode: pair.syncMode,
        conflictStrategy: pair.conflictStrategy,
        localIncomplete: scan.incomplete,
        remoteIncomplete: snap.truncated,
    });

    if (dryRun) {
        return { plan: actions, applied: 0, conflicts: actions.filter(a => a.kind === "conflict").length, failures: [] };
    }

    // No actions → local and remote already agree. Persist state from the scan
    // and snapshot we already have and skip the finalize re-scan + re-snapshot
    // entirely - this is the common steady-state (e.g. a cron re-run of an
    // unchanged tree), where re-fetching a full paginated snapshot is pure waste.
    if (actions.length === 0) {
        saveState(buildState(pair.id, scan, remoteById));
        return { plan: actions, applied: 0, conflicts: 0, failures: [] };
    }

    onProgress?.({
        kind: "plan",
        uploads: actions.filter(a => a.kind === "upload-new" || a.kind === "upload-update").length,
        downloads: actions.filter(a => a.kind === "download-new" || a.kind === "download-update" || a.kind === "conflict").length,
        deletes: actions.filter(a => a.kind === "delete-local" || a.kind === "delete-remote").length,
    });

    const result = await applyActions(remote, pair, actions, snap.folders, onProgress);

    onProgress?.({ kind: "finalize" });

    // Build the next state from what this cycle actually did - no second scan,
    // no second snapshot. See buildStateFromResults.
    const built = buildStateFromResults(pair.id, scan, remoteById, state, result.results);
    if (built) {
        saveState(built);
    } else {
        // The server didn't return result timestamps (older API during rollout)
        // - fall back to the read-back: re-scan + re-snapshot and record what
        // both sides look like now.
        const scan2 = await scanLocal(pair.local, isExcluded, { oneFileSystem: pair.oneFileSystem });
        const snap2 = await remote.snapshot(pair.remoteFolderId);
        const remoteById2 = buildRemotePaths(snap2.files, snap2.folders, pair.remoteFolderId);
        saveState(buildState(pair.id, scan2, remoteById2));
    }

    return { plan: actions, applied: result.applied, conflicts: result.conflicts, failures: result.failures };
}
