/**
 * Permanent (permission) failures in sync.
 *
 * A 403 means the server has decided this key may not do this to this path -
 * upload into a folder the role can't write, delete a file it may not delete.
 * Nothing the next cycle does changes that answer, yet the executor treated it
 * like any other failure: the file's state record was carried forward, the
 * reconciler planned the same action again, and `sync watch` retried it and
 * logged the same line on every cycle, forever, for every refused file.
 *
 * The desktop app already separates "permission" from transient errors and
 * stops retrying (apps/desktop/src/main/sync/index.ts, isPermanentUploadError).
 * This is the CLI's equivalent, done on the typed error rather than message
 * text: a refusal is recorded ONCE in the pair's state, keyed by path, and the
 * action is skipped until the file changes locally (a new mtime or size is a
 * new request, which may well be allowed) or the user runs `dosya sync run`
 * explicitly, which is the "try again now" the watcher can't infer.
 */
import { ApiError, AuthError } from "../errors";
import type { LocalEntry } from "./scan";
import type { PermanentFailure, SyncAction } from "./types";

/** Appended to the one report a refusal gets, so the silence afterwards is explained. */
export const PERMANENT_HINT = "not retried until the file changes or you run 'dosya sync run'";

/**
 * Only a 403. A 401 is a dead credential, which re-auth fixes for every path
 * at once; a presigned R2 PUT answering 403 is a plain Error (an expired
 * signature, transient); everything else is left to the normal retry.
 */
export function isPermanentSyncError(err: unknown): boolean {
    if (err instanceof AuthError) return err.status === 403;
    if (err instanceof ApiError) return err.status === 403;
    return false;
}

/** A refusal the executor saw this cycle, before it is fingerprinted into state. */
export interface RefusedAction {
    relPath: string;
    action: string;
    message: string;
}

function fingerprint(entry: LocalEntry | undefined): PermanentFailure["local"] {
    return entry && !entry.isDir ? { size: entry.size, mtimeMs: entry.mtimeMs } : null;
}

function sameFingerprint(a: PermanentFailure["local"], b: PermanentFailure["local"]): boolean {
    if (a === null || b === null) return a === b;
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The local path an upload/delete-remote action is about; null for actions this never gates. */
function gatedPath(a: SyncAction): string | null {
    switch (a.kind) {
        case "upload-new":
        case "upload-update":
        case "delete-remote":
            return a.relPath;
        default:
            return null;
    }
}

/**
 * Merge this cycle's refusals into the recorded map, stamping each with the
 * local file's identity at the time (null when the action needed no local
 * file, as a remote delete does not).
 */
export function recordPermanentFailures(
    prev: Record<string, PermanentFailure>,
    refused: RefusedAction[],
    local: Map<string, LocalEntry>,
    now: number,
): Record<string, PermanentFailure> {
    const next = { ...prev };
    for (const r of refused) {
        next[r.relPath] = { action: r.action, message: r.message, failedAt: now, local: fingerprint(local.get(r.relPath)) };
    }
    return next;
}

/**
 * Drop the planned actions that would only repeat a recorded refusal, and
 * prune the records that no longer apply.
 *
 * - retry (an explicit `sync run`): every record is cleared and every action
 *   goes through; whatever is still refused is recorded afresh.
 * - the local file changed since the refusal: the record is cleared and the
 *   action goes through.
 * - the local file is gone: the record is dropped (there is nothing left to
 *   retry; a remote delete's null fingerprint is kept, it needs no file).
 * - otherwise: the action is suppressed and the record kept.
 */
export function suppressPermanentFailures(
    actions: SyncAction[],
    prev: Record<string, PermanentFailure>,
    local: Map<string, LocalEntry>,
    retry: boolean,
): { actions: SyncAction[]; permanent: Record<string, PermanentFailure>; suppressed: string[] } {
    if (retry) return { actions, permanent: {}, suppressed: [] };

    const permanent: Record<string, PermanentFailure> = {};
    for (const [relPath, rec] of Object.entries(prev)) {
        if (rec.local !== null && !local.has(relPath)) continue; // file gone
        permanent[relPath] = rec;
    }

    const kept: SyncAction[] = [];
    const suppressed: string[] = [];
    for (const a of actions) {
        const path = gatedPath(a);
        const rec = path === null ? undefined : permanent[path];
        if (!rec) { kept.push(a); continue; }
        if (sameFingerprint(rec.local, fingerprint(local.get(path!)))) {
            suppressed.push(path!);
            continue;
        }
        delete permanent[path!];
        kept.push(a);
    }
    return { actions: kept, permanent, suppressed };
}
