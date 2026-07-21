/**
 * Shared interactive confirmation.
 *
 * Extracted from `rm` and `workspace`, which each hand-rolled the same
 * `[y/N]` prompt. Reused by any destructive command (folder delete, trash
 * empty, sync remove).
 */

/** Only an explicit `y`/`yes` (any case) is affirmative; everything else is no. */
export function decideConfirm(answer: string): boolean {
    const a = answer.trim().toLowerCase();
    return a === "y" || a === "yes";
}

/**
 * Ask the user to confirm a destructive action.
 *
 * Returns `true` when `force` is set, the parsed answer on a TTY, or `null`
 * when we cannot prompt (non-interactive and not forced). Callers turn `null`
 * into a usage error so scripts get a clear "use --force" message rather than
 * hanging on a read that never arrives.
 */
export async function confirm(question: string, opts: { force?: boolean } = {}): Promise<boolean | null> {
    if (opts.force) return true;
    if (!process.stdin.isTTY) return null;

    process.stdout.write(`${question} [y/N] `);
    const reader = Bun.stdin.stream().getReader();
    try {
        const { value } = await reader.read();
        const answer = new TextDecoder().decode(value ?? new Uint8Array());
        return decideConfirm(answer);
    } finally {
        reader.releaseLock();
    }
}
