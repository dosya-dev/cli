import { basename } from "path";

/**
 * Process-wide runtime settings and interrupt handling.
 *
 * Set once from global flags in `index.ts`, read by commands and the client.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

let requestTimeoutMs = DEFAULT_TIMEOUT_MS;
let timeoutWasSet = false;

/** Apply `--timeout <sec>`. Ignores junk values and keeps the default. */
export function setRequestTimeout(rawSeconds: string | undefined): void {
    if (!rawSeconds) return;
    const seconds = Number(rawSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    requestTimeoutMs = Math.round(seconds * 1000);
    timeoutWasSet = true;
}

export function getRequestTimeout(): number {
    return requestTimeoutMs;
}

/**
 * Scale a long-running operation's timeout budget.
 *
 * Uploads and downloads need far longer than a metadata call, but must still
 * honour an explicit `--timeout`. This tracks whether the flag was passed
 * rather than comparing against the default value — `--timeout 30` is a
 * deliberate choice and must not be mistaken for "unset".
 */
export function getLongTimeout(defaultMs: number): number {
    return timeoutWasSet ? requestTimeoutMs : defaultMs;
}

/**
 * True when running as a `bun build --compile` binary.
 *
 * Under `bun run src/index.ts`, `process.execPath` is the user's bun
 * interpreter — self-replacing or deleting it would destroy their Bun install.
 */
export function isCompiledBinary(): boolean {
    // Bun's single-file executables expose a virtual filesystem root
    const dir = import.meta.dir ?? "";
    if (dir.startsWith("/$bunfs") || dir.includes("~BUN")) return true;

    // Fallback: a bare interpreter is never a dosya binary
    const exec = basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
    return exec !== "bun" && exec !== "node";
}

type CleanupHandler = () => void;

const cleanupHandlers = new Set<CleanupHandler>();

/**
 * Register work that must happen before the process exits on Ctrl+C —
 * flushing download resume state, closing file descriptors, and so on.
 */
export function onInterrupt(handler: CleanupHandler): () => void {
    cleanupHandlers.add(handler);
    return () => cleanupHandlers.delete(handler);
}

export function runCleanup(): void {
    for (const handler of cleanupHandlers) {
        try {
            handler();
        } catch {
            // Best effort — never let cleanup block exit
        }
    }
    cleanupHandlers.clear();
}
