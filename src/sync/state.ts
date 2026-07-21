import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, renameSync, unlinkSync, readFileSync } from "fs";
import { syncStateDir } from "./config";
import type { SyncPairState } from "./types";

function statePath(pairId: string): string {
    return join(syncStateDir(), `${pairId}.json`);
}

export function loadState(pairId: string): SyncPairState {
    try {
        const text = readFileSync(statePath(pairId), "utf8");
        const parsed = JSON.parse(text) as SyncPairState;
        return {
            pairId,
            lastFullSyncAt: parsed.lastFullSyncAt ?? 0,
            files: parsed.files ?? {},
            folders: parsed.folders ?? {},
        };
    } catch {
        return { pairId, lastFullSyncAt: 0, files: {}, folders: {} };
    }
}

export function saveState(state: SyncPairState): void {
    const dir = syncStateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = statePath(state.pairId);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        renameSync(tmp, target);
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        throw err;
    }
}

export function removeState(pairId: string): void {
    try { unlinkSync(statePath(pairId)); } catch { /* already gone */ }
}
