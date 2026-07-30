import { fatal, EXIT } from "./output";

/** Short flag aliases -> long flag names */
const SHORT_FLAGS: Record<string, string> = {
    j: "json",
    q: "quiet",
    k: "key",
    w: "workspace",
    o: "output",
    r: "recursive",
    f: "force",
    c: "connections",
    v: "version",
    h: "help",
};

/**
 * Flags that take a value.
 *
 * Anything not listed here is a boolean and must NEVER consume the following
 * token - otherwise `dosya ls --json ws_abc` silently swallows the workspace
 * ID as the value of `--json`.
 */
const VALUE_FLAGS = new Set([
    "api",
    "conflict",
    "connections",
    "email",
    "exclude",
    "expires",
    "folder",
    "id",
    "key",
    "lock",
    "message",
    "mode",
    "name",
    "output",
    "page",
    "parallel",
    "password",
    "query",
    "role",
    "sort",
    "timeout",
    "type",
    "version-of",
    "workspace",
]);

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
    "daemon",
    "debug",
    "dry-run",
    "force",
    "help",
    "json",
    "no-color",
    "no-verify",
    "one-file-system",
    "permanent",
    "quiet",
    "recursive",
    "version",
    "watch",
    "zip",
]);

/**
 * Value flags whose repeats accumulate instead of last-wins. `--exclude a
 * --exclude b` yields `multi.exclude === ["a", "b"]` (and `flags.exclude`
 * still holds the last value, for callers that only want one).
 */
const MULTI_FLAGS = new Set(["exclude"]);

export interface ParsedArgs {
    args: string[];
    flags: Record<string, string>;
    /** Accumulated values for repeatable flags (see MULTI_FLAGS). */
    multi: Record<string, string[]>;
}

/** Negative numbers are legitimate flag values, unlike `-x` style flags. */
function isNegativeNumber(text: string): boolean {
    return /^-\d/.test(text);
}

/** A value flag may consume the next token unless it looks like another flag. */
function canConsume(next: string | undefined): next is string {
    if (next === undefined) return false;
    // A bare "-" is the conventional stdin/stdout placeholder, not a flag
    if (next === "-") return true;
    return !next.startsWith("-") || isNegativeNumber(next);
}

export function parseArgs(argv: string[]): ParsedArgs {
    const args: string[] = [];
    const flags: Record<string, string> = {};
    const multi: Record<string, string[]> = {};
    let seenSeparator = false;

    /** Record a value flag, accumulating repeats for MULTI_FLAGS. */
    const setFlag = (key: string, value: string): void => {
        flags[key] = value;
        if (MULTI_FLAGS.has(key) && value !== "") {
            (multi[key] ??= []).push(value);
        }
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        // After --, everything is a positional argument
        if (arg === "--" && !seenSeparator) {
            seenSeparator = true;
            continue;
        }

        if (seenSeparator) {
            args.push(arg);
            continue;
        }

        // Long flags: --flag, --flag value, or --flag=value
        if (arg.startsWith("--")) {
            const body = arg.slice(2);
            const eq = body.indexOf("=");
            const key = eq === -1 ? body : body.slice(0, eq);
            const inlineValue = eq === -1 ? null : body.slice(eq + 1);

            if (BOOLEAN_FLAGS.has(key)) {
                if (inlineValue !== null) {
                    fatal(`Flag --${key} does not take a value.`, EXIT.USAGE);
                }
                flags[key] = "";
                continue;
            }

            if (!VALUE_FLAGS.has(key)) {
                fatal(`Unknown flag: --${key}. Run 'dosya --help' for usage.`, EXIT.USAGE);
            }

            if (inlineValue !== null) {
                setFlag(key, inlineValue);
                continue;
            }

            const next = argv[i + 1];
            if (canConsume(next)) {
                setFlag(key, next);
                i++;
            } else {
                // Left empty so the command can report a domain-specific error
                flags[key] = "";
            }
            continue;
        }

        // Short flags: -j, -k value, or combined -jq
        if (arg.startsWith("-") && arg.length > 1) {
            const chars = arg.slice(1);
            for (let c = 0; c < chars.length; c++) {
                const ch = chars[c];
                const longName = SHORT_FLAGS[ch];
                if (!longName) {
                    fatal(`Unknown flag: -${ch}. Run 'dosya --help' for usage.`, EXIT.USAGE);
                }

                if (!VALUE_FLAGS.has(longName)) {
                    flags[longName] = "";
                    continue;
                }

                // Only the last char of a combined group can take a value
                if (c !== chars.length - 1) {
                    fatal(
                        `Flag -${ch} takes a value and must come last in a combined group (e.g. -${chars.replace(ch, "")}${ch} <value>).`,
                        EXIT.USAGE,
                    );
                }

                const next = argv[i + 1];
                if (canConsume(next)) {
                    setFlag(longName, next);
                    i++;
                } else {
                    flags[longName] = "";
                }
            }
            continue;
        }

        args.push(arg);
    }

    return { args, flags, multi };
}
