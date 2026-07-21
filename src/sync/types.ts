/** Shared types for the sync engine. */

export type SyncMode = "two-way" | "push" | "push-safe" | "pull" | "pull-safe";
export type ConflictStrategy = "last-write-wins" | "keep-both";

export interface SyncPair {
    id: string;
    local: string;
    remoteWorkspaceId: string;
    remoteFolderId: string | null;
    syncMode: SyncMode;
    conflictStrategy: ConflictStrategy;
    excludes: string[];
    pollIntervalMs: number;
}

export interface SyncConfig {
    pairs: SyncPair[];
}

/** One file as of the last successful sync — the third input to the diff. */
export interface SyncFileRecord {
    remoteId: string;
    remoteName: string;
    remoteFolderId: string | null;
    remoteSize: number;
    remoteUpdatedAt: number;
    remoteVersion: number;
    localPath: string;
    localSize: number;
    localMtimeMs: number;
    syncedAt: number;
}

export interface SyncPairState {
    pairId: string;
    lastFullSyncAt: number;
    files: Record<string, SyncFileRecord>;   // keyed by remoteId
    folders: Record<string, { remoteId: string }>;   // keyed by relPath
}

/** A remote file, path-resolved relative to the pair's remote root. */
export interface RemoteFile {
    id: string;
    name: string;
    folderId: string | null;
    size: number;
    updatedAt: number;
    version: number;
    relPath: string;
}

export type SyncAction =
    | { kind: "upload-new" | "upload-update"; relPath: string; localPath: string; folderId: string | null; remoteId?: string }
    | { kind: "download-new" | "download-update"; relPath: string; remoteId: string; localPath: string }
    | { kind: "delete-local"; localPath: string; remoteId: string; relPath: string }
    | { kind: "delete-remote"; remoteId: string; relPath: string }
    | { kind: "move-local"; fromPath: string; toPath: string; remoteId: string }
    | { kind: "conflict"; relPath: string; remoteId: string; localMtimeMs: number; remoteUpdatedAt: number };
