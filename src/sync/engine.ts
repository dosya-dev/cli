import { nowUnix } from "@dosya-dev/shared";
import { DosyaClient } from "../client";
import { compileExcludes, DEFAULT_IGNORES } from "./config";
import { loadState, saveState } from "./state";
import { scanLocal, type ScanResult } from "./scan";
import { SyncRemote, buildRemotePaths } from "./remote";
import { reconcile } from "./reconcile";
import { applyActions } from "./executor";
import type { SyncPair, SyncPairState, SyncFileRecord, RemoteFile, SyncAction } from "./types";

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

export interface CycleResult {
    plan: SyncAction[];
    applied: number;
    conflicts: number;
    failures: { action: string; error: string }[];
}

/** One full reconcile+apply cycle for a pair. `dryRun` plans without transferring. */
export async function runCycle(client: DosyaClient, pair: SyncPair, dryRun: boolean): Promise<CycleResult> {
    const remote = new SyncRemote(client, pair.remoteWorkspaceId);
    const isExcluded = compileExcludes([...DEFAULT_IGNORES, ...pair.excludes]);

    const scan = scanLocal(pair.local, isExcluded);
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
    });

    if (dryRun) {
        return { plan: actions, applied: 0, conflicts: actions.filter(a => a.kind === "conflict").length, failures: [] };
    }

    const result = await applyActions(remote, pair, actions, snap.folders);

    // Re-scan + re-snapshot so the persisted state reflects reality (commit is
    // INSERT-only and doesn't return updated_at/version, so we must re-read).
    const scan2 = scanLocal(pair.local, isExcluded);
    const snap2 = await remote.snapshot(pair.remoteFolderId);
    const remoteById2 = buildRemotePaths(snap2.files, snap2.folders, pair.remoteFolderId);
    saveState(buildState(pair.id, scan2, remoteById2));

    return { plan: actions, applied: result.applied, conflicts: result.conflicts, failures: result.failures };
}
