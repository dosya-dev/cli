import { resolve as resolvePath } from "path";
import { statSync } from "fs";
import { createClient } from "../client";
import { requireAuth } from "../config";
import { printTable, printJson, fatal, fatalError, log, EXIT } from "../output";
import { confirm } from "../prompt";
import { Resolver } from "../resolver";
import { pairId, loadSyncConfig, saveSyncConfig } from "../sync/config";
import { loadState, removeState } from "../sync/state";
import { runCycle } from "../sync/engine";
import { watchPair } from "../sync/watch";
import type { SyncPair, SyncMode, ConflictStrategy, SyncAction } from "../sync/types";

const MODES: SyncMode[] = ["two-way", "push", "push-safe", "pull", "pull-safe"];
const CONFLICTS: ConflictStrategy[] = ["last-write-wins", "keep-both"];

const HELP = `Sync a local folder with a dosya.dev workspace folder (bidirectional).

Usage:
  dosya sync add <local-dir> <ws_id:remote/path> [flags]   Create a sync pair
  dosya sync list                                          List sync pairs
  dosya sync status [pair-id]                              Show pair status
  dosya sync run [pair-id] [--dry-run]                     Sync once
  dosya sync watch [pair-id]                               Sync continuously
  dosya sync remove <pair-id> [--force]                    Remove a pair

Add flags:
  --mode <m>         two-way (default), push, push-safe, pull, pull-safe
  --conflict <c>     last-write-wins (default), keep-both
  --exclude <glob>   Ignore matching paths (repeatable)

Modes:
  two-way     Mirror both directions
  push        Upload local changes; mirror local deletions to the cloud
  push-safe   Upload only; never delete on the cloud
  pull        Download cloud changes; mirror cloud deletions locally
  pull-safe   Download only; never delete locally

Examples:
  dosya sync add ~/Documents ws_abc123:Docs
  dosya sync add ./photos ws_abc123:Photos --mode push-safe --exclude '*.tmp'
  dosya sync run --dry-run
  dosya sync watch`;

export function syncHelp(): void {
    console.log(HELP);
}

function describeAction(a: SyncAction): string {
    if (a.kind === "move-local") return `${a.fromPath} -> ${a.toPath}`;
    if (a.kind === "delete-remote" || a.kind === "conflict") return a.relPath;
    if (a.kind === "delete-local") return a.localPath;
    return a.relPath;
}

async function syncAdd(rest: string[], flags: Record<string, string>, multi: Record<string, string[]>): Promise<void> {
    const localArg = rest[0];
    const remoteRef = rest[1];
    if (!localArg || !remoteRef) {
        fatal("Usage: dosya sync add <local-dir> <ws_id:remote/path>", EXIT.USAGE);
    }

    const local = resolvePath(localArg);
    const st = statSync(local, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) {
        fatal(`Not a directory: ${localArg}`, EXIT.USAGE);
    }

    const mode = (flags.mode || "two-way") as SyncMode;
    if (!MODES.includes(mode)) fatal(`Invalid --mode: ${flags.mode}. One of: ${MODES.join(", ")}.`, EXIT.USAGE);
    const conflict = (flags.conflict || "last-write-wins") as ConflictStrategy;
    if (!CONFLICTS.includes(conflict)) fatal(`Invalid --conflict: ${flags.conflict}. One of: ${CONFLICTS.join(", ")}.`, EXIT.USAGE);
    const excludes = multi.exclude ?? (flags.exclude ? [flags.exclude] : []);

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    try {
        const resolved = await new Resolver(client).resolve(remoteRef, {
            workspace: flags.workspace,
            defaultWorkspace: config?.default_workspace,
            expect: "folder",
        });

        const id = pairId(local, `${resolved.workspaceId}:${resolved.id}`);
        const cfg = loadSyncConfig();
        if (cfg.pairs.some(p => p.id === id)) {
            fatal("A sync pair for this local folder and remote already exists.", EXIT.USAGE);
        }

        const pair: SyncPair = {
            id,
            local,
            remoteWorkspaceId: resolved.workspaceId,
            remoteFolderId: resolved.id || null,
            syncMode: mode,
            conflictStrategy: conflict,
            excludes,
            pollIntervalMs: 15000,
        };
        cfg.pairs.push(pair);
        saveSyncConfig(cfg);

        if (flags.json !== undefined) printJson(pair);
        else log(`Added sync pair ${id}: ${local} <-> ${remoteRef} (${mode})`);
    } catch (err) {
        fatalError(err);
    }
}

function syncList(flags: Record<string, string>): void {
    const cfg = loadSyncConfig();
    if (flags.json !== undefined) { printJson(cfg); return; }
    if (cfg.pairs.length === 0) {
        log("No sync pairs. Add one: dosya sync add <local-dir> <ws_id:remote/path>");
        return;
    }
    printTable(
        ["ID", "LOCAL", "MODE", "REMOTE"],
        cfg.pairs.map(p => [p.id, p.local, p.syncMode, `${p.remoteWorkspaceId}:${p.remoteFolderId ?? ""}`]),
    );
}

function syncStatus(rest: string[], flags: Record<string, string>): void {
    const cfg = loadSyncConfig();
    const pairs = rest[0] ? cfg.pairs.filter(p => p.id === rest[0]) : cfg.pairs;
    if (pairs.length === 0) {
        fatal(rest[0] ? `No such pair: ${rest[0]}` : "No sync pairs configured.", EXIT.USAGE);
    }
    const rows = pairs.map(p => {
        const s = loadState(p.id);
        return {
            id: p.id, local: p.local, mode: p.syncMode,
            tracked: Object.keys(s.files).length,
            lastSync: s.lastFullSyncAt ? new Date(s.lastFullSyncAt * 1000).toISOString() : null,
        };
    });
    if (flags.json !== undefined) { printJson(rows); return; }
    printTable(
        ["ID", "LOCAL", "MODE", "TRACKED", "LAST SYNC"],
        rows.map(r => [r.id, r.local, r.mode, String(r.tracked), r.lastSync ?? "never"]),
    );
}

async function syncRun(rest: string[], flags: Record<string, string>): Promise<void> {
    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const cfg = loadSyncConfig();
    const pairs = rest[0] ? cfg.pairs.filter(p => p.id === rest[0]) : cfg.pairs;
    if (pairs.length === 0) {
        fatal(rest[0] ? `No such pair: ${rest[0]}` : "No sync pairs configured. Add one with: dosya sync add", EXIT.USAGE);
    }
    const dryRun = flags["dry-run"] !== undefined;

    let anyFail = false;
    const summary: unknown[] = [];
    try {
        for (const p of pairs) {
            const res = await runCycle(client, p, dryRun);
            if (dryRun) {
                if (flags.json === undefined) {
                    log(`[${p.id}] plan: ${res.plan.length} action(s)`);
                    for (const a of res.plan) log(`  ${a.kind}  ${describeAction(a)}`);
                }
                summary.push({ pair: p.id, plan: res.plan });
            } else {
                if (flags.json === undefined) {
                    log(`[${p.id}] applied ${res.applied}, ${res.conflicts} conflict(s), ${res.failures.length} failure(s)`);
                    for (const f of res.failures) console.error(`  failed: ${f.action}: ${f.error}`);
                }
                if (res.failures.length > 0) anyFail = true;
                summary.push({ pair: p.id, applied: res.applied, conflicts: res.conflicts, failures: res.failures });
            }
        }
    } catch (err) {
        return fatalError(err);
    }

    if (flags.json !== undefined) printJson(summary);
    if (anyFail) process.exit(EXIT.ERROR);
}

async function syncWatch(rest: string[], flags: Record<string, string>): Promise<void> {
    const { apiKey, apiBase } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const cfg = loadSyncConfig();
    const pairs = rest[0] ? cfg.pairs.filter(p => p.id === rest[0]) : cfg.pairs;
    if (pairs.length === 0) {
        fatal(rest[0] ? `No such pair: ${rest[0]}` : "No sync pairs configured. Add one with: dosya sync add", EXIT.USAGE);
    }
    await Promise.all(pairs.map(p => watchPair(client, p)));
}

async function syncRemove(rest: string[], flags: Record<string, string>): Promise<void> {
    const id = rest[0];
    if (!id) fatal("Usage: dosya sync remove <pair-id>", EXIT.USAGE);

    const cfg = loadSyncConfig();
    const idx = cfg.pairs.findIndex(p => p.id === id);
    if (idx === -1) fatal(`No such pair: ${id}`, EXIT.USAGE);

    const ok = await confirm(`Remove sync pair ${id}? Files are left in place.`, { force: flags.force !== undefined });
    if (ok === null) fatal("Cannot prompt for confirmation in non-interactive mode. Use --force to skip.", EXIT.USAGE);
    if (!ok) { log("Cancelled."); return; }

    cfg.pairs.splice(idx, 1);
    saveSyncConfig(cfg);
    removeState(id);
    if (flags.json !== undefined) printJson({ ok: true, removed: id });
    else log(`Removed ${id}`);
}

export async function sync(args: string[], flags: Record<string, string>, multi: Record<string, string[]> = {}): Promise<void> {
    const sub = args[0];
    if (flags.help !== undefined || sub === undefined) {
        syncHelp();
        if (sub === undefined && flags.help === undefined) process.exit(EXIT.USAGE);
        return;
    }

    const rest = args.slice(1);
    switch (sub) {
        case "add": return syncAdd(rest, flags, multi);
        case "list": return syncList(flags);
        case "status": return syncStatus(rest, flags);
        case "run": return syncRun(rest, flags);
        case "watch": return syncWatch(rest, flags);
        case "remove": return syncRemove(rest, flags);
        default:
            fatal(`Unknown subcommand: sync ${sub}. Usage: dosya sync add|list|status|run|watch|remove`, EXIT.USAGE);
    }
}
