import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runCli } from "../helpers";

/**
 * `download --recursive` renamed every downloaded file onto its destination
 * without checking whether one was already there, and never read --force.
 * Anyone who could add a file to the workspace (a `.env`, say) silently
 * replaced the victim's local copy on the next recursive download into an
 * existing project directory. Single-file download asks and --zip refuses;
 * recursive must refuse too, unless --force.
 */

let server: ReturnType<typeof Bun.serve>;
let outDir: string;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/api/sync/snapshot") {
                return Response.json({
                    ok: true,
                    files: [
                        { id: "file_env", name: ".env", size_bytes: 15, mime_type: null, folder_id: null, updated_at: 1, current_version: 1 },
                        { id: "file_new", name: "new.txt", size_bytes: 3, mime_type: null, folder_id: null, updated_at: 1, current_version: 1 },
                    ],
                    folders: [],
                    nextCursor: null,
                    hasMore: false,
                });
            }
            if (url.pathname === "/api/sync/download-manifest") {
                const base = `http://localhost:${server.port}`;
                return Response.json({
                    ok: true,
                    downloads: [
                        { fileId: "file_env", url: `${base}/content/env`, name: ".env", size: 15 },
                        { fileId: "file_new", url: `${base}/content/new`, name: "new.txt", size: 3 },
                    ],
                });
            }
            if (url.pathname === "/content/env") return new Response("REMOTE_SENTINEL");
            if (url.pathname === "/content/new") return new Response("new");
            return new Response("not found", { status: 404 });
        },
    });
});

afterAll(() => {
    server.stop(true);
});

beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "dosya-dl-rec-"));
    writeFileSync(join(outDir, ".env"), "LOCAL_SENTINEL");
});

afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
});

function run(extra: string[]) {
    return runCli(
        ["download", "--recursive", "ws_test", "-o", outDir, "--json", ...extra],
        { DOSYA_API_BASE: `http://localhost:${server.port}`, DOSYA_API_KEY: "dos_test" },
    );
}

describe("download --recursive does not clobber existing files", () => {
    it("keeps an existing file and reports it as a failure without --force", async () => {
        const { stdout, exitCode } = await run([]);
        const out = JSON.parse(stdout);

        expect(readFileSync(join(outDir, ".env"), "utf8")).toBe("LOCAL_SENTINEL");
        expect(existsSync(join(outDir, ".env.dosya-partial"))).toBe(false);
        // The other files still come down.
        expect(readFileSync(join(outDir, "new.txt"), "utf8")).toBe("new");
        expect(out.ok).toBe(false);
        expect(out.downloaded).toBe(1);
        expect(out.failures).toHaveLength(1);
        expect(out.failures[0].file).toBe(".env");
        expect(out.failures[0].error).toContain("--force");
        expect(exitCode).not.toBe(0);
    });

    it("overwrites with --force", async () => {
        const { stdout, exitCode } = await run(["--force"]);
        const out = JSON.parse(stdout);

        expect(readFileSync(join(outDir, ".env"), "utf8")).toBe("REMOTE_SENTINEL");
        expect(out).toMatchObject({ ok: true, downloaded: 2, failures: [] });
        expect(exitCode).toBe(0);
    });
});
