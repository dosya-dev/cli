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

    // Files: batch-delete when more than one (grouped by workspace), else a
    // single DELETE (with the second DELETE for --permanent).
    try {
        if (files.length > 1) {
            const byWs = new Map<string, string[]>();
            for (const f of files) {
                const list = byWs.get(f.workspaceId) ?? [];
                list.push(f.id);
                byWs.set(f.workspaceId, list);
            }
            for (const [ws, ids] of byWs) {
                const res = await client.post<{ ok: boolean; deleted: number }>(
                    "/api/files/batch-delete",
                    { workspace_id: ws, file_ids: ids },
                );
                deleted += res.deleted ?? ids.length;
                if (isPermanent) {
                    for (const id of ids) await client.del(`/api/files/${encodeURIComponent(id)}`);
                }
            }
        } else if (files.length === 1) {
            const f = files[0];
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
