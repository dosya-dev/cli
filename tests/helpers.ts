import { DosyaClient } from "../src/client";

export function getApiKey(): string {
    return process.env.DOSYA_TEST_API_KEY ?? "";
}

/**
 * Where the integration suite points when DOSYA_TEST_API_BASE is unset.
 *
 * This used to be `https://api.dosya.dev` - PRODUCTION. These tests create
 * workspaces, upload files, mint share links and delete things, and they run
 * with whatever DOSYA_TEST_API_KEY is in scope. The only thing standing
 * between a `bun test tests/integration` and doing all of that against the
 * live API was the presence of an untracked, gitignored apps/cli/.env - so
 * anyone cloning fresh, or anyone whose .env lost its API_BASE line while
 * keeping its key, got production by default and no warning.
 *
 * A local default cannot cause that. If nothing is listening the probe below
 * fails, the suite reports "unreachable", and the worst outcome is a skipped
 * run rather than mutations against real accounts. Matches `astro dev --port
 * 4322` in apps/api's package.json.
 *
 * Pointing at production is still possible; it just has to be typed.
 */
export const DEFAULT_TEST_API_BASE = "http://localhost:4322";

export function getApiBase(): string {
    return process.env.DOSYA_TEST_API_BASE ?? DEFAULT_TEST_API_BASE;
}

/**
 * True when the suite is aimed somewhere other than localhost.
 *
 * Not a refusal - running against a deployed environment is legitimate, and
 * packages/prod-smoke exists for exactly that. It is a LOUD banner, because
 * the difference between "my tests failed" and "my tests just deleted a real
 * workspace" should never be something you discover afterwards.
 */
export function isRemoteTarget(base = getApiBase()): boolean {
    try {
        const { hostname } = new URL(base);
        return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]";
    } catch {
        return true; // unparseable is not provably local
    }
}

interface LiveApiProbe {
    ok: boolean;
    reason: string;
}

/**
 * Integration tests talk to a real API. Skipping is OPT-IN via
 * DOSYA_SKIP_INTEGRATION=1 rather than automatic, because the automatic
 * version meant 27 files reported green while executing nothing: the key
 * lives in apps/cli/.env, CI never sets it, and the skip was announced only
 * through a console.warn nobody reads.
 *
 * This function does NOT throw. It used to - but `../helpers` is also
 * imported by test files that need nothing but `runCli` and have no
 * live-API dependency at all (completion.test.ts, config.test.ts,
 * security.test.ts). A throw here failed module evaluation for every file
 * that imports this module, including those three - not a loud, targeted
 * error, but a `ReferenceError: Cannot access '...' before initialization`
 * cascade across every one of them, since bun:test never reached their
 * describe blocks. The single authoritative "no key and no skip flag" failure
 * now lives in one place: `tests/integration/_live-api-guard.test.ts`.
 */
async function probeLiveApi(): Promise<LiveApiProbe> {
    if (process.env.DOSYA_SKIP_INTEGRATION === "1") {
        return { ok: false, reason: "DOSYA_SKIP_INTEGRATION=1 - integration tests skipped on purpose." };
    }
    if (!process.env.DOSYA_TEST_API_KEY) {
        return {
            ok: false,
            reason:
                "DOSYA_TEST_API_KEY is not set. Integration tests need a real API.\n" +
                "  - to run them:  set DOSYA_TEST_API_KEY and DOSYA_TEST_API_BASE\n" +
                "  - to skip them: set DOSYA_SKIP_INTEGRATION=1",
        };
    }
    // Said before the first request, not after the damage. Only when a key is
    // present and a remote target is configured - i.e. only when this run can
    // actually mutate something that is not yours.
    if (isRemoteTarget()) {
        console.warn(
            `\n  ⚠  CLI integration tests are pointed at ${getApiBase()}, not localhost.\n` +
            `     They create workspaces, upload files and delete things with DOSYA_TEST_API_KEY.\n` +
            `     Unset DOSYA_TEST_API_BASE to use ${DEFAULT_TEST_API_BASE}.\n`,
        );
    }
    try {
        const res = await fetch(`${getApiBase()}/api/cli/version`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { ok: true, reason: "" };
    } catch (err) {
        return {
            ok: false,
            reason:
                `${getApiBase()} is unreachable (${(err as Error).message}). ` +
                "Start the API or set DOSYA_SKIP_INTEGRATION=1.",
        };
    }
}

const liveApiProbe = await probeLiveApi();

/** True only when a live API was actually reached. Used by every
 * `describe.skipIf(!LIVE_API)` block in this directory. */
export const LIVE_API = liveApiProbe.ok;

/** Why LIVE_API is false - empty string when LIVE_API is true. Consumed by
 * the guard test, `tests/integration/_live-api-guard.test.ts`. */
export const LIVE_API_REASON = liveApiProbe.reason;

/** True only when the skip was requested on purpose via
 * DOSYA_SKIP_INTEGRATION=1, as opposed to a missing key or an unreachable
 * API - the guard test uses this to tell "skip on purpose" apart from
 * "should have failed". */
export const LIVE_API_SKIPPED_ON_PURPOSE = process.env.DOSYA_SKIP_INTEGRATION === "1";

// Printed once per run, not once per file: Bun caches this module, so every
// other file's `import ... from "../helpers"` reuses this evaluation instead
// of re-running it.
if (!LIVE_API) {
    console.warn(`[tests] ${LIVE_API_REASON}`);
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
