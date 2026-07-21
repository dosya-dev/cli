import { describe, it, expect, beforeAll } from "bun:test";
import { join } from "path";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { LIVE_API, runCli, getWorkspaceId, getClient } from "../helpers";

describe("dosya sync --help", () => {
    it("prints usage without an API", async () => {
        const { stdout, exitCode } = await runCli(["sync", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage:");
        expect(stdout).toContain("bidirectional");
    });

    it("lists no pairs on a fresh config", async () => {
        const xdg = mkdtempSync(join(tmpdir(), "dosya-sync-none-"));
        const { stdout, exitCode } = await runCli(["sync", "list"], { XDG_CONFIG_HOME: xdg });
        expect(exitCode).toBe(0);
        expect(stdout).toContain("No sync pairs");
    });
});

describe.skipIf(!LIVE_API)("dosya sync (end-to-end)", () => {
    const apiKey = process.env.DOSYA_TEST_API_KEY!;
    let workspaceId: string;
    let folderId: string;
    let localDir: string;
    let xdg: string;
    let pairId: string;

    beforeAll(async () => {
        workspaceId = await getWorkspaceId();
        const folder = await getClient().post<{ ok: boolean; folder: { id: string } }>("/api/folders", {
            workspace_id: workspaceId,
            name: `cli-sync-${Date.now()}`,
        });
        folderId = folder.folder.id;
        localDir = mkdtempSync(join(tmpdir(), "dosya-sync-local-"));
        xdg = mkdtempSync(join(tmpdir(), "dosya-sync-xdg-"));
    });

    // A shared XDG dir so `add` and `run` see the same pair config.
    const env = () => ({ XDG_CONFIG_HOME: xdg });

    it("adds a pair addressed by remote folder id", async () => {
        const { stdout, exitCode } = await runCli(
            ["sync", "add", localDir, folderId, "-w", workspaceId, "--json", "-k", apiKey],
            env(),
        );
        expect(exitCode).toBe(0);
        pairId = JSON.parse(stdout).id;
        expect(pairId).toBeTruthy();
    });

    it("uploads a new local file to the remote folder", async () => {
        writeFileSync(join(localDir, "hello.txt"), "hello sync");
        const run = await runCli(["sync", "run", pairId, "-k", apiKey], env());
        expect(run.exitCode).toBe(0);

        const files = await getClient().get<{ files: { name: string }[] }>(
            `/api/files?workspace_id=${workspaceId}&folder_id=${folderId}&per_page=100`,
        );
        expect(files.files.some(f => f.name === "hello.txt")).toBe(true);
    });

    it("pulls a new remote file down to the local folder", async () => {
        // Create a file directly in the remote folder via the upload flow.
        const content = `remote body ${Date.now()}`;
        const init = await getClient().post<{ ok: boolean; session_id: string; upload_url: string }>("/api/upload/init", {
            workspace_id: workspaceId,
            file_name: "from-cloud.txt",
            file_size: content.length,
            mime_type: "text/plain",
            folder_id: folderId,
        });
        await getClient().request(init.upload_url, {
            method: "PUT",
            rawBody: new TextEncoder().encode(content),
            headers: { "Content-Type": "application/octet-stream", "Content-Length": String(content.length) },
        });

        const run = await runCli(["sync", "run", pairId, "-k", apiKey], env());
        expect(run.exitCode).toBe(0);
        expect(existsSync(join(localDir, "from-cloud.txt"))).toBe(true);
    });

    it("cleans up the remote folder", async () => {
        await getClient().del(`/api/folders/${folderId}`);
    });
});
