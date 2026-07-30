import type { RemoteFile, SyncAction, SyncMode, ConflictStrategy, SyncPairState, SyncFileRecord } from "./types";
import type { LocalEntry } from "./scan";

export interface ReconcileInput {
    local: Map<string, LocalEntry>;
    remote: Map<string, RemoteFile>;   // keyed by remoteId
    state: SyncPairState;
    mode: SyncMode;
    conflictStrategy: ConflictStrategy;
    /** A local dir failed to read - suppress deletions (see the safety valve). */
    localIncomplete: boolean;
    /** The remote snapshot was truncated - suppress deletions for the same reason. */
    remoteIncomplete?: boolean;
}

function remoteChanged(r: RemoteFile, rec: SyncFileRecord): boolean {
    return r.updatedAt !== rec.remoteUpdatedAt || r.size !== rec.remoteSize || r.version !== rec.remoteVersion;
}

function localChanged(l: LocalEntry, rec: SyncFileRecord): boolean {
    return l.mtimeMs !== rec.localMtimeMs || l.size !== rec.localSize;
}

/** Decide the action when both sides changed, honouring mode then strategy. */
function resolveBothChanged(
    path: string,
    remoteId: string,
    remote: RemoteFile,
    local: LocalEntry,
    mode: SyncMode,
    strategy: ConflictStrategy,
): SyncAction {
    if (mode === "push" || mode === "push-safe") {
        return { kind: "upload-update", relPath: path, localPath: path, folderId: null, remoteId };
    }
    if (mode === "pull" || mode === "pull-safe") {
        return { kind: "download-update", relPath: path, remoteId, localPath: path, size: remote.size };
    }
    if (strategy === "keep-both") {
        return { kind: "conflict", relPath: path, remoteId, localMtimeMs: local.mtimeMs, remoteUpdatedAt: remote.updatedAt, remoteSize: remote.size };
    }
    // last-write-wins: the newer side wins (remote seconds vs local ms→s).
    return remote.updatedAt >= Math.floor(local.mtimeMs / 1000)
        ? { kind: "download-update", relPath: path, remoteId, localPath: path, size: remote.size }
        : { kind: "upload-update", relPath: path, localPath: path, folderId: null, remoteId };
}

function allowedInMode(kind: SyncAction["kind"], mode: SyncMode): boolean {
    const isDownload = kind === "download-new" || kind === "download-update" || kind === "move-local";
    const isUpload = kind === "upload-new" || kind === "upload-update";
    const isDeleteLocal = kind === "delete-local";
    const isDeleteRemote = kind === "delete-remote";
    switch (mode) {
        case "two-way": return true;
        case "push": return isUpload || isDeleteRemote;
        case "push-safe": return isUpload;
        case "pull": return isDownload || isDeleteLocal;
        case "pull-safe": return isDownload;
        default: return true;
    }
}

/**
 * Three-way reconcile: local scan vs remote snapshot vs last-synced state.
 * Pure - no I/O. Emits the actions the executor should apply.
 */
export function reconcile(input: ReconcileInput): SyncAction[] {
    const { state, mode, conflictStrategy } = input;

    const localFiles = new Map<string, LocalEntry>();
    for (const [rel, e] of input.local) if (!e.isDir) localFiles.set(rel, e);
    const remoteByPath = new Map<string, RemoteFile>();
    for (const r of input.remote.values()) remoteByPath.set(r.relPath, r);

    const actions: SyncAction[] = [];
    const processedPaths = new Set<string>();
    const processedRemoteIds = new Set<string>();

    // 1) Tracked records (state keyed by remoteId).
    for (const [remoteId, rec] of Object.entries(state.files)) {
        processedRemoteIds.add(remoteId);
        const remote = input.remote.get(remoteId);
        const oldPath = rec.localPath;

        // Remote moved/renamed since last sync.
        if (remote && remote.relPath !== oldPath) {
            const localAtOld = localFiles.get(oldPath);
            if (localAtOld && !localFiles.has(remote.relPath)) {
                actions.push({ kind: "move-local", fromPath: oldPath, toPath: remote.relPath, remoteId });
            } else if (!localAtOld && !localFiles.has(remote.relPath)) {
                // local gone entirely - pull it back at the new path
                actions.push({ kind: "download-new", relPath: remote.relPath, remoteId, localPath: remote.relPath, size: remote.size });
            }
            processedPaths.add(oldPath);
            processedPaths.add(remote.relPath);
            continue;
        }

        const local = localFiles.get(oldPath);
        if (remote && local) {
            const rC = remoteChanged(remote, rec);
            const lC = localChanged(local, rec);
            if (rC && lC) {
                actions.push(resolveBothChanged(oldPath, remoteId, remote, local, mode, conflictStrategy));
            } else if (rC) {
                actions.push({ kind: "download-update", relPath: oldPath, remoteId, localPath: oldPath, size: remote.size });
            } else if (lC) {
                actions.push({ kind: "upload-update", relPath: oldPath, localPath: oldPath, folderId: null, remoteId });
            }
            processedPaths.add(oldPath);
        } else if (remote && !local) {
            // Local deleted since last sync.
            if (remoteChanged(remote, rec)) {
                actions.push({ kind: "download-new", relPath: remote.relPath, remoteId, localPath: remote.relPath, size: remote.size });
            } else {
                actions.push({ kind: "delete-remote", remoteId, relPath: oldPath });
            }
            processedPaths.add(oldPath);
            processedPaths.add(remote.relPath);
        } else if (!remote && local) {
            // Remote deleted since last sync.
            if (localChanged(local, rec)) {
                actions.push({ kind: "upload-new", relPath: oldPath, localPath: oldPath, folderId: null });
            } else {
                actions.push({ kind: "delete-local", localPath: oldPath, remoteId, relPath: oldPath });
            }
            processedPaths.add(oldPath);
        }
        // !remote && !local: both gone - nothing to do.
    }

    // 2) Untracked local files.
    for (const [rel, entry] of localFiles) {
        if (processedPaths.has(rel)) continue;
        const remoteHere = remoteByPath.get(rel);
        if (remoteHere && !processedRemoteIds.has(remoteHere.id)) {
            // Both sides introduced a file at the same path - treat as a conflict.
            actions.push(resolveBothChanged(rel, remoteHere.id, remoteHere, entry, mode, conflictStrategy));
            processedRemoteIds.add(remoteHere.id);
        } else {
            actions.push({ kind: "upload-new", relPath: rel, localPath: rel, folderId: null });
        }
        processedPaths.add(rel);
    }

    // 3) Untracked remote files.
    for (const r of input.remote.values()) {
        if (processedRemoteIds.has(r.id) || processedPaths.has(r.relPath)) continue;
        actions.push({ kind: "download-new", relPath: r.relPath, remoteId: r.id, localPath: r.relPath, size: r.size });
        processedRemoteIds.add(r.id);
    }

    // 4) Mode gating.
    const gated = actions.filter(a => allowedInMode(a.kind, mode));

    // 5) Deletion safety valve - never let a transient read failure or a
    //    suspicious mass-delete wipe a side.
    const deleteCount = gated.filter(a => a.kind === "delete-local" || a.kind === "delete-remote").length;
    const storedCount = Object.keys(state.files).length;
    const massDelete = storedCount > 10 && deleteCount > 5 && deleteCount > storedCount * 0.5;
    if (input.localIncomplete || input.remoteIncomplete || massDelete) {
        return gated.filter(a => a.kind !== "delete-local" && a.kind !== "delete-remote");
    }
    return gated;
}
