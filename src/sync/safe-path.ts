/**
 * Path containment for the sync engine.
 *
 * Remote file/folder names arrive in the snapshot as untrusted, workspace-
 * controlled strings and are concatenated into a root-relative path (see
 * buildRemotePaths). A name containing "..", a path separator, an absolute or
 * drive/UNC prefix, or a control character can make join(root, relPath) escape
 * the configured sync root, letting a hostile snapshot write, overwrite, move,
 * or delete files anywhere on disk. Every local filesystem sink in the executor
 * must resolve its path through resolveWithinRoot and fail closed on null.
 *
 * The checks are platform-independent on purpose: the same snapshot bytes are
 * dangerous on Windows ("..\\") and on POSIX ("../"), and a client fails closed
 * regardless of which host it runs on. Both "/" and "\\" are treated as
 * separators so a "..\\" segment is caught even on a POSIX host, where
 * path.resolve would otherwise treat the backslash as an ordinary filename
 * character and miss it.
 */
import { resolve, sep } from "path";

/**
 * A root-relative path is safe only if every segment is an ordinary name:
 * no "." / ".." / empty segments, no absolute / drive-qualified / UNC prefix,
 * and no NUL or control characters.
 */
export function isSafeRelPath(relPath: string): boolean {
    if (typeof relPath !== "string" || relPath.length === 0) return false;
    if (/[\x00-\x1f]/.test(relPath)) return false;        // NUL / control chars
    if (/^[a-zA-Z]:/.test(relPath)) return false;         // C:\ drive-qualified
    if (/^[\\/]/.test(relPath)) return false;             // absolute / UNC / leading separator
    for (const seg of relPath.split(/[\\/]/)) {
        if (seg === "" || seg === "." || seg === "..") return false;
    }
    return true;
}

/**
 * Resolve `relPath` against `root`, returning the absolute path only if it
 * stays inside `root`; otherwise null. The prefix comparison appends the
 * separator so a sibling dir sharing the root's name (".../syncroot-evil") is
 * not mistaken for a child of ".../syncroot".
 */
export function resolveWithinRoot(root: string, relPath: string): string | null {
    if (!isSafeRelPath(relPath)) return null;
    const rootResolved = resolve(root);
    const full = resolve(rootResolved, relPath);
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
    return full;
}
