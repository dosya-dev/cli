import { createClient } from "../client";
import { requireAuth } from "../config";
import { printJson, isPlain, fatal, fatalError, log, EXIT } from "../output";
import { formatBytes } from "@dosya-dev/shared";

const HELP = `Show storage usage and quota for a workspace on dosya.dev.

Usage: dosya usage [flags]
       dosya df

Flags:
  --workspace, -w <id>   Workspace (or set a default)
  --json, -j             Output as JSON

Examples:
  dosya usage -w ws_abc123
  dosya df --json`;

export function usageHelp(): void {
    console.log(HELP);
}

interface DashboardResponse {
    ok: boolean;
    stats: {
        total_files: number;
        files_this_week: number;
        shared_externally: number;
        total_bytes: number;
        storage_cap_bytes: number;
        plan: string;
    };
    storage_breakdown: { name: string; bytes: number }[];
    region_breakdown: { region: string; file_count: number; bytes: number }[];
}

/** A fixed-width usage bar; ASCII under --no-color. */
function bar(fraction: number, width = 24): string {
    const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
    const full = isPlain() ? "#" : "█";
    const empty = isPlain() ? "-" : "░";
    return full.repeat(filled) + empty.repeat(width - filled);
}

export async function usage(flags: Record<string, string>): Promise<void> {
    if (flags.help !== undefined) { usageHelp(); return; }

    const { apiKey, apiBase, config } = await requireAuth(flags.key);
    const client = createClient(apiBase, apiKey);

    const workspaceId = flags.workspace || config?.default_workspace;
    if (!workspaceId) {
        fatal("Workspace ID required. Use --workspace <id> or set a default: dosya config set default_workspace <id>", EXIT.USAGE);
    }

    try {
        const params = new URLSearchParams({ workspace_id: workspaceId });
        const data = await client.get<DashboardResponse>(`/api/dashboard?${params}`);
        const s = data.stats;

        if (flags.json !== undefined) {
            printJson({ stats: s, storage_breakdown: data.storage_breakdown, region_breakdown: data.region_breakdown });
            return;
        }

        const used = s.total_bytes;
        const cap = s.storage_cap_bytes;
        const frac = cap > 0 ? used / cap : 0;
        const pct = cap > 0 ? Math.round(frac * 100) : 0;

        log(`Plan:    ${s.plan}`);
        log(`Storage: ${formatBytes(used)} / ${formatBytes(cap)}  (${pct}%)`);
        log(`         ${bar(frac)}`);
        log(`Files:   ${s.total_files}  (+${s.files_this_week} this week)`);
        log(`Shared:  ${s.shared_externally}`);

        const breakdown = (data.storage_breakdown ?? []).filter(b => b.bytes > 0);
        if (breakdown.length > 0) {
            log("\nBy category:");
            for (const b of breakdown) log(`  ${b.name.padEnd(12)} ${formatBytes(b.bytes)}`);
        }

        const regions = (data.region_breakdown ?? []).filter(r => r.bytes > 0);
        if (regions.length > 0) {
            log("\nBy region:");
            for (const r of regions) log(`  ${r.region.padEnd(12)} ${formatBytes(r.bytes)}  (${r.file_count} files)`);
        }
    } catch (err) {
        fatalError(err);
    }
}
