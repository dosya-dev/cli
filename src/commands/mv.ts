import { createClient } from "../client";
import { requireAuth } from "../config";
import { printJson, fatal, fatalError, log, EXIT } from "../output";
import { Resolver, type Resolved } from "../resolver";

const HELP = `Move or rename files and folders on dosya.dev.

Usage:
  dosya mv <target> <new-name>        Rename (single target, bare name)
  dosya mv <target...> <dest-folder>  Move into a folder

<target> and <dest-folder> may be ids or paths. A bare workspace (ws_id:) as
the destination moves into the workspace root.

Flags:
  --workspace, -w <id>   Workspace for path lookups (or set a default)
  --json, -j             Output as JSON

Examples:
  dosya mv report.pdf final.pdf              Rename
  dosya mv report.pdf reports/2026           Move into a folder
  dosya mv a.txt b.txt archive               Move both into archive
  dosya mv fld_abc ws_xyz:                    Move a folder to the root`;

export function mvHelp(): void {
    console.log(HELP);
}

/** A bare name is a rename target: no path separator, no ws prefix, not an id. */
function looksLikeName(s: string): boolean {
    return !s.includes("/") && !s.includes(":") && !/^(file|fld|ws)_/.test(s);
}

export async function mv(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { mvHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    if (args.length < 2) {
        fatal("Usage: dosya mv <target...> <dest>", EXIT.USAGE);
    }

    const dest = args[args.length - 1];
    const sources = args.slice(0, -1);
    const opts = { workspace: flags.workspace, defaultWorkspace: config?.default_workspace };
    const isJson = flags.json !== undefined;

    try {
        const resolver = new Resolver(client);

        // Rename: exactly one source and a bare-name destination.
        if (sources.length === 1 && looksLikeName(dest)) {
            const src = await resolver.resolve(sources[0], opts);
            if (src.type === "file") {
                await client.put(`/api/files/${encodeURIComponent(src.id)}/rename`, { name: dest });
            } else {
                await client.put(`/api/folders/${encodeURIComponent(src.id)}/rename`, { name: dest });
            }
            if (isJson) printJson({ ok: true, action: "rename", id: src.id, name: dest });
            else log(`Renamed to ${dest}`);
            return;
        }

        // Move: destination is a folder (id "" = workspace root).
        const destFolder = await resolver.resolve(dest, { ...opts, expect: "folder" });
        const destId = destFolder.id || null;
        const srcs: Resolved[] = await resolver.resolveMany(sources, opts);

        let moved = 0;
        const failures: { target: string; error: string }[] = [];
        for (const s of srcs) {
            try {
                if (s.type === "file") {
                    await client.put(`/api/files/${encodeURIComponent(s.id)}/move`, { folder_id: destId });
                } else {
                    await client.put(`/api/folders/${encodeURIComponent(s.id)}/move`, { parent_id: destId });
                }
                moved++;
            } catch (err) {
                failures.push({ target: s.name, error: (err as Error).message });
            }
        }

        if (isJson) {
            printJson({ ok: failures.length === 0, action: "move", moved, dest: destId, failures });
        } else {
            for (const f of failures) console.error(`Failed: ${f.target}: ${f.error}`);
            log(`Moved ${moved} item(s).`);
        }
        if (failures.length > 0) process.exit(EXIT.ERROR);
    } catch (err) {
        fatalError(err);
    }
}
