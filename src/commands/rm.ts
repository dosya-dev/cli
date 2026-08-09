import { createClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, fatalError, log, EXIT } from "../output";
import { confirm } from "../prompt";
import { Resolver, type Resolved } from "../resolver";

const HELP = `Delete files or folders on dosya.dev.

Usage: dosya rm <target...> [flags]

<target> may be a file/folder id or a path; multiple targets are allowed.
Files go to the trash (recoverable) unless --permanent is given. Deleting a
folder removes it and moves its files to the trash.

Flags:
  --permanent       Permanently delete files (cannot be undone; files only)
  --force, -f       Skip confirmation prompts
  --workspace, -w   Workspace for path lookups
  --json, -j        Output as JSON

Examples:
  dosya rm file_abc123
  dosya rm reports/old.pdf notes.txt
  dosya rm ws_abc123:archive --force
  dosya rm file_abc123 --permanent --force`;

export function rmHelp(): void {
    console.log(HELP);
}

/**
 * Split resolved file targets ahead of deletion: files with a known
 * workspace batch together (one /api/files/batch-delete call per
 * workspace); files whose workspace is unknown fall back to singles,
 * deleted one at a time via DELETE /api/files/:id - the same call
 * `dosya rm <id>` already makes alone, which needs no workspace at all
 * because the server looks the file's workspace up itself.
 *
 * A bare id resolved with no `-w` flag and no default workspace comes back
 * from resolver.ts with `workspaceId: ""` (deliberately - a raw id is
 * globally unique and addressable without a workspace). Grouping those by
 * that empty string and POSTing `{ workspace_id: "" }` to batch-delete gets
 * rejected by the server ("workspace_id is required"), which is what made
 * `dosya rm a b` fail while `dosya rm a; dosya rm b` worked fine.
 *
 * A lone target ALWAYS takes the single-DELETE path, even when its
 * workspace is known. DELETE /api/files/:id enforces a lock_mode check and
 * (for folder-confined members) an isFileWithinSubtree containment check;
 * /api/files/batch-delete's bulk UPDATE enforces neither. Routing a single
 * known-workspace file through batch-delete would silently drop those two
 * checks - the UPDATE just matches zero rows and the CLI reports success -
 * so batching only ever happens for genuinely multiple files. This
 * invariant lives here (not at the call site) so every caller gets it for
 * free instead of having to remember a `files.length > 1` guard themselves.
 */
export function partitionFilesForDelete(files: Resolved[]): { batches: Map<string, string[]>; singles: Resolved[] } {
    const batches = new Map<string, string[]>();
    const singles: Resolved[] = [];

    if (files.length <= 1) {
        singles.push(...files);
        return { batches, singles };
    }

    for (const f of files) {
        if (!f.workspaceId) {
            singles.push(f);
            continue;
        }
        const list = batches.get(f.workspaceId) ?? [];
        list.push(f.id);
        batches.set(f.workspaceId, list);
    }
    return { batches, singles };
}

export async function rm(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { rmHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    if (args.length === 0) {
        fatal("Target required. Usage: dosya rm <target...>", EXIT.USAGE);
    }

    const isPermanent = flags.permanent !== undefined;
    const isForce = flags.force !== undefined;
    const isJson = flags.json !== undefined;

    let targets: Resolved[];
    try {
        targets = await new Resolver(client).resolveMany(args, {
            workspace: flags.workspace,
            defaultWorkspace: config?.default_workspace,
        });
    } catch (err) {
        return fatalError(err);
    }

    const files = targets.filter(t => t.type === "file");
    const folders = targets.filter(t => t.type === "folder" && t.id !== "");

    if (isPermanent && folders.length > 0) {
        fatal("--permanent applies to files only; delete folders without it.", EXIT.USAGE);
    }

    // Confirm destructive actions: any permanent file delete, or any folder
    // delete (folders are removed recursively).
    if (isPermanent && files.length > 0) {
        const ok = await confirm(`Permanently delete ${files.length} file(s)? This cannot be undone.`, { force: isForce });
        if (ok === null) fatal("Cannot prompt for confirmation in non-interactive mode. Use --force to skip.", EXIT.USAGE);
        if (!ok) { log("Cancelled."); return; }
    } else if (folders.length > 0) {
        const ok = await confirm(`Delete ${folders.length} folder(s) and move their files to trash?`, { force: isForce });
        if (ok === null) fatal("Cannot prompt for confirmation in non-interactive mode. Use --force to skip.", EXIT.USAGE);
        if (!ok) { log("Cancelled."); return; }
    }

    let deleted = 0;
    const failures: { target: string; error: string }[] = [];

    // Files: batch-delete groups with a known workspace (grouped by
    // workspace), else a single DELETE per file (with the second DELETE for
    // --permanent) - including files whose workspace is unknown, which can
    // never go through the batch endpoint. See partitionFilesForDelete.
    try {
        const { batches, singles } = partitionFilesForDelete(files);
        for (const [ws, ids] of batches) {
            const res = await client.post<{ ok: boolean; deleted: number }>(
                "/api/files/batch-delete",
                { workspace_id: ws, file_ids: ids },
            );
            deleted += res.deleted ?? ids.length;
            if (isPermanent) {
                for (const id of ids) await client.del(`/api/files/${encodeURIComponent(id)}`);
            }
        }
        for (const f of singles) {
            const res = await client.del<{ ok: boolean; permanent: boolean }>(`/api/files/${encodeURIComponent(f.id)}`);
            if (isPermanent && !res.permanent) {
                await client.del(`/api/files/${encodeURIComponent(f.id)}`);
            }
            deleted++;
        }
    } catch (err) {
        failures.push({ target: "files", error: (err as Error).message });
    }

    // Folders: one DELETE each (recursive soft-delete server-side).
    for (const fld of folders) {
        try {
            await client.del(`/api/folders/${encodeURIComponent(fld.id)}`);
            deleted++;
        } catch (err) {
            failures.push({ target: fld.name, error: (err as Error).message });
        }
    }

    if (isJson) {
        printJson({ ok: failures.length === 0, deleted, permanent: isPermanent, failures });
    } else {
        for (const fail of failures) console.error(`Failed: ${fail.target}: ${fail.error}`);
        log(isPermanent ? `Permanently deleted ${deleted} item(s).` : `Deleted ${deleted} item(s) (recoverable).`);
    }

    if (failures.length > 0) process.exit(EXIT.ERROR);
}
