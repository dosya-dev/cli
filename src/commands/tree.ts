import { createClient } from "../client";
import { requireAuth } from "../config";
import { printJson, isPlain, fatal, fatalError, log, EXIT } from "../output";
import { renderTree } from "../render";
import { Resolver, type FolderNode } from "../resolver";

const HELP = `Print the folder tree of a workspace on dosya.dev.

Usage: dosya tree [path] [flags]

With no path, prints the whole workspace. A path (folder id or folder/sub, or
ws_id:folder/sub) prints that subtree.

Flags:
  --workspace, -w <id>   Workspace (or set a default)
  --json, -j             Output as JSON (nested)

Examples:
  dosya tree -w ws_abc123
  dosya tree reports -w ws_abc123
  dosya tree ws_abc123:reports/2026`;

export function treeHelp(): void {
    console.log(HELP);
}

interface NestedFolder {
    id: string;
    name: string;
    file_count?: number;
    children: NestedFolder[];
}

function buildNested(folders: FolderNode[], rootId: string | null): NestedFolder[] {
    const children = new Map<string | null, FolderNode[]>();
    for (const f of folders) {
        const p = f.parent_id ?? null;
        if (!children.has(p)) children.set(p, []);
        children.get(p)!.push(f);
    }
    function build(parentId: string | null): NestedFolder[] {
        return (children.get(parentId) ?? [])
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(f => ({ id: f.id, name: f.name, file_count: f.file_count, children: build(f.id) }));
    }
    return build(rootId);
}

export async function tree(args: string[], flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { treeHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    let workspaceId = flags.workspace || config?.default_workspace;
    let rootId: string | null = null;

    try {
        const target = args[0];
        if (target) {
            const r = await new Resolver(client).resolve(target, {
                workspace: flags.workspace,
                defaultWorkspace: config?.default_workspace,
                expect: "folder",
            });
            workspaceId = r.workspaceId;
            rootId = r.id || null;
        }

        if (!workspaceId) {
            fatal("Workspace ID required. Use --workspace <id> or set a default: dosya config set default_workspace <id>", EXIT.USAGE);
        }

        const data = await client.get<{ ok: boolean; folders: FolderNode[] }>(
            `/api/folders/tree?workspace_id=${encodeURIComponent(workspaceId)}`,
        );
        const folders = data.folders ?? [];

        if (flags.json !== undefined) {
            printJson(buildNested(folders, rootId));
            return;
        }

        const rendered = renderTree(folders, rootId, { plain: isPlain() });
        log(rendered || "(no folders)");
    } catch (err) {
        fatalError(err);
    }
}
