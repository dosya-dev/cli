import { DosyaClient } from "../src/client";

export function getApiKey(): string {
    const key = process.env.DOSYA_TEST_API_KEY;
    if (!key) throw new Error("DOSYA_TEST_API_KEY env var is required. Set it in .env");
    return key;
}

export function getApiBase(): string {
    return process.env.DOSYA_TEST_API_BASE ?? "https://dosya.dev";
}

export function getClient(): DosyaClient {
    return new DosyaClient(getApiBase(), getApiKey());
}

export async function getWorkspaceId(): Promise<string> {
    const client = getClient();
    const data = await client.get<{ ok: boolean; workspaces: { id: string }[] }>("/api/workspaces");
    if (!data.workspaces.length) throw new Error("No workspaces found");
    return data.workspaces[0].id;
}

/**
 * Run the CLI as a subprocess and capture output.
 * Returns stdout, stderr, and exit code.
 */
export async function runCli(args: string[], env?: Record<string, string>): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    const proc = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
        cwd: import.meta.dir + "/..",
        env: {
            ...process.env,
            DOSYA_API_KEY: getApiKey(),
            DOSYA_API_BASE: getApiBase(),
            // Prevent config file from interfering
            XDG_CONFIG_HOME: "/tmp/dosya-test-config-" + Date.now(),
            ...env,
        },
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
