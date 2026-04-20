import { formatBytes } from "@dosya-dev/shared";

export { formatBytes };

/** Global flags that affect output behavior. Set once at startup. */
let quietMode = false;
let debugMode = false;

export function setOutputFlags(flags: { quiet?: boolean; debug?: boolean }): void {
    if (flags.quiet) quietMode = true;
    if (flags.debug) debugMode = true;
}

export function isQuiet(): boolean {
    return quietMode;
}

export function isDebug(): boolean {
    return debugMode;
}

/**
 * Print a message to stdout (suppressed in quiet mode).
 */
export function log(message: string): void {
    if (!quietMode) console.log(message);
}

/**
 * Print a debug message to stderr (only in debug mode).
 */
export function debug(message: string): void {
    if (debugMode) console.error(`[debug] ${message}`);
}

/**
 * Print a table with auto-sized columns, respecting terminal width.
 */
export function printTable(headers: string[], rows: string[][]): void {
    const termWidth = process.stdout.columns || 80;
    const colWidths = headers.map((h, i) => {
        const maxRow = rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), 0);
        return Math.max(h.length, maxRow);
    });

    // If total width exceeds terminal, truncate the widest columns
    const gap = 2; // two-space gap between columns
    const totalGaps = (colWidths.length - 1) * gap;
    let totalWidth = colWidths.reduce((s, w) => s + w, 0) + totalGaps;

    if (totalWidth > termWidth) {
        const available = termWidth - totalGaps;
        const minCol = 8;
        // Shrink columns proportionally, keeping a minimum
        const ratio = available / colWidths.reduce((s, w) => s + w, 0);
        for (let i = 0; i < colWidths.length; i++) {
            colWidths[i] = Math.max(minCol, Math.floor(colWidths[i] * ratio));
        }
    }

    function truncate(text: string, width: number): string {
        if (text.length <= width) return text.padEnd(width);
        return text.slice(0, width - 1) + "…";
    }

    const line = headers.map((h, i) => truncate(h, colWidths[i])).join("  ");
    console.log(line);
    console.log(colWidths.map(w => "─".repeat(w)).join("  "));

    for (const row of rows) {
        const formatted = row.map((cell, i) => truncate(cell ?? "", colWidths[i])).join("  ");
        console.log(formatted);
    }
}

/**
 * Print as JSON (for --json flag).
 */
export function printJson(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
}

/**
 * Format a unix timestamp as relative time.
 */
export function timeAgo(unix: number): string {
    const diff = Math.floor(Date.now() / 1000) - unix;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(unix * 1000).toLocaleDateString();
}

/** Exit codes used across the CLI. */
export const EXIT = {
    OK: 0,
    ERROR: 1,
    USAGE: 2,
    AUTH: 3,
    NETWORK: 4,
} as const;

/**
 * Print an error message and exit.
 */
export function fatal(message: string, code: number = EXIT.ERROR): never {
    console.error(`error: ${message}`);
    process.exit(code);
}
