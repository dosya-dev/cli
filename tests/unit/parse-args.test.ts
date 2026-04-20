import { describe, it, expect } from "bun:test";
import { parseArgs } from "../../src/parse-args";

describe("parseArgs", () => {
    // ─── Positional arguments ───────────────────────────

    it("should parse positional arguments", () => {
        const result = parseArgs(["upload", "file.txt"]);
        expect(result.args).toEqual(["upload", "file.txt"]);
        expect(result.flags).toEqual({});
    });

    it("should handle no arguments", () => {
        const result = parseArgs([]);
        expect(result.args).toEqual([]);
        expect(result.flags).toEqual({});
    });

    it("should handle single positional argument", () => {
        const result = parseArgs(["whoami"]);
        expect(result.args).toEqual(["whoami"]);
    });

    it("should handle multiple positional arguments", () => {
        const result = parseArgs(["mv", "fil_abc", "fld_xyz"]);
        expect(result.args).toEqual(["mv", "fil_abc", "fld_xyz"]);
    });

    // ─── Long flags ─────────────────────────────────────

    it("should parse long boolean flags", () => {
        const result = parseArgs(["--json", "--debug"]);
        expect(result.flags.json).toBe("");
        expect(result.flags.debug).toBe("");
    });

    it("should parse long flags with values", () => {
        const result = parseArgs(["--key", "dos_abc123"]);
        expect(result.flags.key).toBe("dos_abc123");
    });

    it("should treat flag followed by another flag as boolean", () => {
        const result = parseArgs(["--json", "--key", "dos_abc"]);
        expect(result.flags.json).toBe("");
        expect(result.flags.key).toBe("dos_abc");
    });

    it("should handle --workspace with value", () => {
        const result = parseArgs(["ls", "--workspace", "ws_abc123"]);
        expect(result.args).toEqual(["ls"]);
        expect(result.flags.workspace).toBe("ws_abc123");
    });

    it("should handle --timeout with value", () => {
        const result = parseArgs(["--timeout", "60"]);
        expect(result.flags.timeout).toBe("60");
    });

    it("should handle --no-color as boolean", () => {
        const result = parseArgs(["--no-color"]);
        expect(result.flags["no-color"]).toBe("");
    });

    // ─── Short flags ────────────────────────────────────

    it("should expand -j to json", () => {
        const result = parseArgs(["-j"]);
        expect(result.flags.json).toBe("");
    });

    it("should expand -q to quiet", () => {
        const result = parseArgs(["-q"]);
        expect(result.flags.quiet).toBe("");
    });

    it("should expand -v to version", () => {
        const result = parseArgs(["-v"]);
        expect(result.flags.version).toBe("");
    });

    it("should expand -h to help", () => {
        const result = parseArgs(["-h"]);
        expect(result.flags.help).toBe("");
    });

    it("should expand -k with value", () => {
        const result = parseArgs(["-k", "dos_abc"]);
        expect(result.flags.key).toBe("dos_abc");
    });

    it("should expand -w with value", () => {
        const result = parseArgs(["-w", "ws_abc"]);
        expect(result.flags.workspace).toBe("ws_abc");
    });

    it("should expand -o with value", () => {
        const result = parseArgs(["-o", "./output"]);
        expect(result.flags.output).toBe("./output");
    });

    it("should expand -c with value", () => {
        const result = parseArgs(["-c", "16"]);
        expect(result.flags.connections).toBe("16");
    });

    it("should expand -r to recursive", () => {
        const result = parseArgs(["-r"]);
        expect(result.flags.recursive).toBe("");
    });

    it("should expand -f to force", () => {
        const result = parseArgs(["-f"]);
        expect(result.flags.force).toBe("");
    });

    // ─── Combined short flags ───────────────────────────

    it("should handle combined boolean short flags -jq", () => {
        const result = parseArgs(["-jq"]);
        expect(result.flags.json).toBe("");
        expect(result.flags.quiet).toBe("");
    });

    it("should handle combined flags ending with value flag -jk dos_abc", () => {
        const result = parseArgs(["-jk", "dos_abc"]);
        expect(result.flags.json).toBe("");
        expect(result.flags.key).toBe("dos_abc");
    });

    it("should handle -rjw with value", () => {
        const result = parseArgs(["-rjw", "ws_123"]);
        expect(result.flags.recursive).toBe("");
        expect(result.flags.json).toBe("");
        expect(result.flags.workspace).toBe("ws_123");
    });

    // ─── -- separator ───────────────────────────────────

    it("should treat everything after -- as positional args", () => {
        const result = parseArgs(["upload", "--", "--not-a-flag", "-x"]);
        expect(result.args).toEqual(["upload", "--not-a-flag", "-x"]);
        expect(result.flags).toEqual({});
    });

    it("should handle -- with no args after", () => {
        const result = parseArgs(["cmd", "--"]);
        expect(result.args).toEqual(["cmd"]);
    });

    // ─── Mixed args and flags ───────────────────────────

    it("should correctly mix positional args and flags", () => {
        const result = parseArgs(["upload", "file.txt", "--workspace", "ws_abc", "--json"]);
        expect(result.args).toEqual(["upload", "file.txt"]);
        expect(result.flags.workspace).toBe("ws_abc");
        expect(result.flags.json).toBe("");
    });

    it("should parse a full realistic command", () => {
        const result = parseArgs([
            "upload", "./mydir",
            "--workspace", "ws_abc123",
            "--folder", "fld_xyz",
            "--recursive",
            "--parallel", "5",
            "--json",
        ]);

        expect(result.args).toEqual(["upload", "./mydir"]);
        expect(result.flags.workspace).toBe("ws_abc123");
        expect(result.flags.folder).toBe("fld_xyz");
        expect(result.flags.recursive).toBe("");
        expect(result.flags.parallel).toBe("5");
        expect(result.flags.json).toBe("");
    });

    it("should parse download command with short flags", () => {
        const result = parseArgs(["download", "fil_abc", "-o", "./out", "-c", "8", "-j"]);
        expect(result.args).toEqual(["download", "fil_abc"]);
        expect(result.flags.output).toBe("./out");
        expect(result.flags.connections).toBe("8");
        expect(result.flags.json).toBe("");
    });

    it("should parse workspace subcommand", () => {
        const result = parseArgs(["workspace", "create", "--name", "My Project"]);
        expect(result.args).toEqual(["workspace", "create"]);
        expect(result.flags.name).toBe("My Project");
    });

    it("should parse member invite command", () => {
        const result = parseArgs([
            "member", "invite",
            "--email", "alice@example.com",
            "--role", "Admin",
            "-w", "ws_abc",
        ]);
        expect(result.args).toEqual(["member", "invite"]);
        expect(result.flags.email).toBe("alice@example.com");
        expect(result.flags.role).toBe("Admin");
        expect(result.flags.workspace).toBe("ws_abc");
    });

    it("should parse share command with all options", () => {
        const result = parseArgs([
            "share", "fil_abc",
            "--password", "secret",
            "--expires", "7d",
            "--lock", "view",
            "-j",
        ]);
        expect(result.args).toEqual(["share", "fil_abc"]);
        expect(result.flags.password).toBe("secret");
        expect(result.flags.expires).toBe("7d");
        expect(result.flags.lock).toBe("view");
        expect(result.flags.json).toBe("");
    });

    it("should parse rm with --permanent --force", () => {
        const result = parseArgs(["rm", "fil_abc", "--permanent", "--force"]);
        expect(result.args).toEqual(["rm", "fil_abc"]);
        expect(result.flags.permanent).toBe("");
        expect(result.flags.force).toBe("");
    });

    it("should parse rm with -f shorthand", () => {
        const result = parseArgs(["rm", "fil_abc", "--permanent", "-f"]);
        expect(result.args).toEqual(["rm", "fil_abc"]);
        expect(result.flags.permanent).toBe("");
        expect(result.flags.force).toBe("");
    });

    // ─── Edge cases ─────────────────────────────────────

    it("should handle value flag at end of argv with no value", () => {
        const result = parseArgs(["--key"]);
        expect(result.flags.key).toBe("");
    });

    it("should handle short value flag at end with no value", () => {
        const result = parseArgs(["-k"]);
        expect(result.flags.key).toBe("");
    });

    it("should not consume next arg starting with - as a value", () => {
        const result = parseArgs(["--key", "--json"]);
        expect(result.flags.key).toBe("");
        expect(result.flags.json).toBe("");
    });
});
