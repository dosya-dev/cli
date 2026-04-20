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

export interface ParsedArgs {
    args: string[];
    flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
    const args: string[] = [];
    const flags: Record<string, string> = {};
    let seenSeparator = false;

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

        // Long flags: --flag or --flag value
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith("-")) {
                flags[key] = "";
            } else {
                flags[key] = next;
                i++;
            }
            continue;
        }

        // Short flags: -j, -k value, or combined -jq
        if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
            const chars = arg.slice(1);
            for (let c = 0; c < chars.length; c++) {
                const ch = chars[c];
                const longName = SHORT_FLAGS[ch];
                if (!longName) {
                    fatal(`Unknown flag: -${ch}. Run 'dosya --help' for usage.`, EXIT.USAGE);
                }
                // If this is the last char and the long flag expects a value, consume next arg
                const isValueFlag = ["key", "workspace", "output", "parallel", "timeout", "connections"].includes(longName);
                if (isValueFlag && c === chars.length - 1) {
                    const next = argv[i + 1];
                    if (next && !next.startsWith("-")) {
                        flags[longName] = next;
                        i++;
                    } else {
                        flags[longName] = "";
                    }
                } else {
                    flags[longName] = "";
                }
            }
            continue;
        }

        args.push(arg);
    }

    return { args, flags };
}
