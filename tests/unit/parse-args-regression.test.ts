import { describe, it, expect } from "bun:test";
import { parseArgs } from "../../src/parse-args";

/**
 * Regression tests for the parser bug where every long flag greedily consumed
 * the next token, so `dosya ls --json ws_abc` silently swallowed the workspace
 * ID as the value of `--json`.
 */
describe("parseArgs — boolean flags must not consume positionals", () => {
    const booleans = ["json", "quiet", "debug", "recursive", "force", "permanent", "no-color"];

    for (const flag of booleans) {
        it(`--${flag} leaves the following positional alone`, () => {
            const result = parseArgs(["cmd", `--${flag}`, "positional"]);
            expect(result.flags[flag]).toBe("");
            expect(result.args).toEqual(["cmd", "positional"]);
        });
    }

    it("ls --json <workspace> keeps the workspace ID", () => {
        const result = parseArgs(["ls", "--json", "ws_abc123"]);
        expect(result.args).toEqual(["ls", "ws_abc123"]);
        expect(result.flags.json).toBe("");
    });

    it("rm --force <file> keeps the file ID", () => {
        const result = parseArgs(["rm", "--force", "fil_abc123"]);
        expect(result.args).toEqual(["rm", "fil_abc123"]);
        expect(result.flags.force).toBe("");
    });

    it("upload --recursive <dir> keeps the directory", () => {
        const result = parseArgs(["upload", "--recursive", "./project", "--workspace", "ws_1"]);
        expect(result.args).toEqual(["upload", "./project"]);
        expect(result.flags.recursive).toBe("");
        expect(result.flags.workspace).toBe("ws_1");
    });

    it("handles several booleans before a positional", () => {
        const result = parseArgs(["rm", "--permanent", "--force", "--json", "fil_x"]);
        expect(result.args).toEqual(["rm", "fil_x"]);
        expect(result.flags.permanent).toBe("");
        expect(result.flags.force).toBe("");
        expect(result.flags.json).toBe("");
    });
});

describe("parseArgs — --flag=value form", () => {
    it("parses --workspace=ws_abc", () => {
        const result = parseArgs(["ls", "--workspace=ws_abc"]);
        expect(result.args).toEqual(["ls"]);
        expect(result.flags.workspace).toBe("ws_abc");
    });

    it("keeps '=' inside the value", () => {
        const result = parseArgs(["share", "fil_1", "--password=a=b=c"]);
        expect(result.flags.password).toBe("a=b=c");
    });

    it("accepts an empty value", () => {
        const result = parseArgs(["ls", "--sort="]);
        expect(result.flags.sort).toBe("");
    });
});

describe("parseArgs — value flags", () => {
    it("accepts a negative number as a value", () => {
        const result = parseArgs(["--timeout", "-5"]);
        expect(result.flags.timeout).toBe("-5");
    });

    it("does not consume a following flag", () => {
        const result = parseArgs(["--workspace", "--json"]);
        expect(result.flags.workspace).toBe("");
        expect(result.flags.json).toBe("");
    });

    it("still parses a value that looks like a path", () => {
        const result = parseArgs(["download", "fil_1", "--output", "./out/dir"]);
        expect(result.args).toEqual(["download", "fil_1"]);
        expect(result.flags.output).toBe("./out/dir");
    });
});

describe("parseArgs — separator", () => {
    it("treats everything after -- as positional", () => {
        const result = parseArgs(["upload", "--", "--json", "-r"]);
        expect(result.args).toEqual(["upload", "--json", "-r"]);
        expect(result.flags).toEqual({});
    });

    it("allows a filename that starts with a dash after --", () => {
        const result = parseArgs(["upload", "--recursive", "--", "-weird-name.txt"]);
        expect(result.flags.recursive).toBe("");
        expect(result.args).toEqual(["upload", "-weird-name.txt"]);
    });
});
