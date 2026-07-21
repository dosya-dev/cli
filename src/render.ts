/**
 * Pure string renderers for tree and key/value output. No direct console I/O,
 * so they are trivially unit-testable; commands `log()` the returned string.
 */

import { displayWidth } from "./output";
import type { FolderNode } from "./resolver";

/** Aligned `key: value` block. */
export function renderKeyValue(pairs: [string, string][]): string {
    const keyWidth = pairs.reduce((m, [k]) => Math.max(m, displayWidth(k)), 0);
    return pairs
        .map(([k, v]) => `${k}:${" ".repeat(keyWidth - displayWidth(k) + 1)}${v}`)
        .join("\n");
}

/**
 * Indented folder tree from a flat node list. `rootId` selects the subtree to
 * render (null = workspace root). `plain` swaps the box-drawing glyphs for
 * ASCII so `--no-color` / dumb terminals stay aligned.
 */
export function renderTree(
    nodes: FolderNode[],
    rootId: string | null = null,
    opts: { plain?: boolean } = {},
): string {
    const children = new Map<string | null, FolderNode[]>();
    for (const n of nodes) {
        const p = n.parent_id ?? null;
        if (!children.has(p)) children.set(p, []);
        children.get(p)!.push(n);
    }
    for (const arr of children.values()) arr.sort((a, b) => a.name.localeCompare(b.name));

    const tee = opts.plain ? "|- " : "├─ ";
    const last = opts.plain ? "`- " : "└─ ";
    const vert = opts.plain ? "|  " : "│  ";
    const gap = "   ";

    const lines: string[] = [];
    function walk(parentId: string | null, prefix: string): void {
        const kids = children.get(parentId) ?? [];
        kids.forEach((k, i) => {
            const isLast = i === kids.length - 1;
            const count = k.file_count !== undefined ? `  (${k.file_count})` : "";
            lines.push(`${prefix}${isLast ? last : tee}${k.name}${count}`);
            walk(k.id, prefix + (isLast ? gap : vert));
        });
    }
    walk(rootId, "");
    return lines.join("\n");
}
