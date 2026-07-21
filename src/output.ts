import { formatBytes } from "@dosya-dev/shared";
import { AuthError, NetworkError } from "./errors";

export { formatBytes };

/** Global flags that affect output behavior. Set once at startup. */
let quietMode = false;
let debugMode = false;
let noColorMode = false;

export function setOutputFlags(flags: { quiet?: boolean; debug?: boolean; noColor?: boolean }): void {
    if (flags.quiet) quietMode = true;
    if (flags.debug) debugMode = true;
    if (flags.noColor) noColorMode = true;
}

export function isQuiet(): boolean {
    return quietMode;
}

export function isDebug(): boolean {
    return debugMode;
}

/** True when unicode box/bar glyphs should be replaced with ASCII. */
export function isPlain(): boolean {
    return noColorMode;
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
 * Terminal column width of a single code point.
 *
 * `String.length` counts UTF-16 units, so CJK text and emoji misreport their
 * width and knock table columns out of alignment.
 */
function charWidth(cp: number): number {
    // Zero-width: combining marks, ZWJ, variation selectors
    if (cp >= 0x0300 && cp <= 0x036f) return 0;
    if (cp === 0x200b || cp === 0x200d) return 0;
    if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
    if (cp < 0x1100) return 1;

    // East Asian Wide / Fullwidth and emoji render as two columns
    if (
        (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
        (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
        (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compatibility
        (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
        (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
        (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
        (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
        (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
        (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
        (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f64f) || // Misc symbols & pictographs, emoticons
        (cp >= 0x1f680 && cp <= 0x1f6ff) || // Transport symbols
        (cp >= 0x1f900 && cp <= 0x1f9ff) || // Supplemental symbols
        (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
    ) {
        return 2;
    }

    return 1;
}

/** Terminal column width of a string. */
export function displayWidth(text: string): number {
    let width = 0;
    for (const ch of text) width += charWidth(ch.codePointAt(0)!);
    return width;
}

/** Pad to an exact display width (no-op if already wider). */
function padTo(text: string, width: number): string {
    const current = displayWidth(text);
    return current >= width ? text : text + " ".repeat(width - current);
}

/** Truncate to a display width, appending an ellipsis, then pad to exactly `width`. */
function truncateTo(text: string, width: number): string {
    if (width <= 0) return "";
    if (displayWidth(text) <= width) return padTo(text, width);

    const ellipsis = noColorMode ? "..." : "…";
    const ellipsisWidth = displayWidth(ellipsis);
    if (width <= ellipsisWidth) return padTo(ellipsis.slice(0, width), width);

    let out = "";
    let used = 0;
    for (const ch of text) {
        const cw = charWidth(ch.codePointAt(0)!);
        if (used + cw > width - ellipsisWidth) break;
        out += ch;
        used += cw;
    }
    return padTo(out + ellipsis, width);
}

/**
 * Print a table with auto-sized columns, respecting terminal width.
 */
export function printTable(headers: string[], rows: string[][]): void {
    const termWidth = process.stdout.columns || 80;
    const colWidths = headers.map((h, i) => {
        const maxRow = rows.reduce((max, row) => Math.max(max, displayWidth(row[i] ?? "")), 0);
        return Math.max(displayWidth(h), maxRow);
    });

    // If total width exceeds terminal, shrink the widest columns
    const gap = 2; // two-space gap between columns
    const totalGaps = (colWidths.length - 1) * gap;
    const totalWidth = colWidths.reduce((s, w) => s + w, 0) + totalGaps;

    if (totalWidth > termWidth) {
        const available = Math.max(colWidths.length, termWidth - totalGaps);
        const minCol = 8;
        // Shrink columns proportionally, keeping a minimum
        const ratio = available / colWidths.reduce((s, w) => s + w, 0);
        for (let i = 0; i < colWidths.length; i++) {
            colWidths[i] = Math.max(minCol, Math.floor(colWidths[i] * ratio));
        }
    }

    const rule = noColorMode ? "-" : "─";

    console.log(headers.map((h, i) => truncateTo(h, colWidths[i])).join("  "));
    console.log(colWidths.map(w => rule.repeat(w)).join("  "));

    for (const row of rows) {
        console.log(row.map((cell, i) => truncateTo(cell ?? "", colWidths[i])).join("  "));
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
    if (diff < 0) return "just now";
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

/**
 * Print an error and exit with the code that matches its type.
 *
 * Commands must use this rather than `fatal(err.message)` so that auth and
 * network failures keep their documented exit codes (3 and 4) instead of
 * collapsing into a generic 1.
 */
export function fatalError(err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);

    const code = err instanceof AuthError ? EXIT.AUTH
        : err instanceof NetworkError ? EXIT.NETWORK
        : EXIT.ERROR;

    // Message first, then the stack — same ordering as the top-level handler
    console.error(`error: ${message}`);
    if (debugMode && err instanceof Error && err.stack) {
        console.error(err.stack);
    }
    process.exit(code);
}
