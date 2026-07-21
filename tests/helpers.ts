import { DosyaClient } from "../src/client";

export function getApiKey(): string {
    return process.env.DOSYA_TEST_API_KEY ?? "";
}

export function getApiBase(): string {
    return process.env.DOSYA_TEST_API_BASE ?? "https://api.dosya.dev";
}

/**
 * Integration tests talk to a real API. They are skipped rather than failed
 * when no key is configured or the server isn't up, so `bun test` is
 * meaningful on a clean checkout and in CI.
 *
 * Reachability is probed rather than assumed: `.env` is auto-loaded by Bun, so
 * a key is usually present even when the local dev server is not running.
 */
async function probeLiveApi(): Promise<boolean> {
    if (!process.env.DOSYA_TEST_API_KEY) {
        console.warn("[tests] DOSYA_TEST_API_KEY not set — skipping integration tests.");
        return false;
    }
    try {
        // Public endpoint: confirms the server is up without spending auth
        const res = await fetch(`${getApiBase()}/api/cli/version`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return true;
    } catch (err) {
        console.warn(`[tests] ${getApiBase()} unreachable (${(err as Error).message}) — skipping integration tests.`);
        return false;
    }
}

export const LIVE_API = await probeLiveApi();

export function getClient(): DosyaClient {
    return new DosyaClient(getApiBase(), getApiKey());
}

export async function getWorkspaceId(): Promise<string> {
    const client = getClient();
    const data = await client.get<{ ok: boolean; workspaces: { id: string }[] }>("/api/workspaces");
    if (!data.workspaces.length) throw new Error("No workspaces found");
    return data.workspaces[0].id;
}

let configCounter = 0;

/**
 * Run the CLI as a subprocess and capture output.
 * Returns stdout, stderr, and exit code.
 */
export async function runCli(args: string[], env?: Record<string, string>): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    const baseEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        DOSYA_API_BASE: getApiBase(),
        // Isolate every run from the developer's real config file
        XDG_CONFIG_HOME: `/tmp/dosya-test-config-${process.pid}-${configCounter++}`,
    };

    const apiKey = getApiKey();
    if (apiKey) baseEnv.DOSYA_API_KEY = apiKey;
    else delete baseEnv.DOSYA_API_KEY;

    const proc = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
        cwd: import.meta.dir + "/..",
        env: { ...baseEnv, ...env },
        stdout: "pipe",
        stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
}

/**
 * Upload a small test file via the API client (not CLI).
 * Returns the file ID for use in subsequent tests.
 */
export async function uploadTestFile(workspaceId: string): Promise<string> {
    const client = getClient();
    const content = `Test file ${Date.now()}`;

    const init = await client.post<{ ok: boolean; session_id: string; upload_url: string }>(
        "/api/upload/init",
        {
            workspace_id: workspaceId,
            file_name: `cli-test-${Date.now()}.txt`,
            file_size: content.length,
            mime_type: "text/plain",
        },
    );

    const res = await client.request<{ ok: boolean; file: { id: string } }>(init.upload_url, {
        method: "PUT",
        rawBody: new TextEncoder().encode(content),
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(content.length),
        },
    });

    return res.data.file.id;
}

/**
 * Delete a file via the API client.
 */
export async function deleteFile(fileId: string): Promise<void> {
    const client = getClient();
    try {
        await client.del(`/api/files/${fileId}`);
    } catch {
        // ignore if already deleted
    }
}
