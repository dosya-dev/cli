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
import { lstatSync, realpathSync } from "fs";
import { dirname, resolve, sep } from "path";

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

/**
 * Symlink-aware containment for the filesystem sinks.
 *
 * resolveWithinRoot is purely lexical: it rejects "..", separators, and
 * absolute/UNC prefixes, but path.resolve does not follow symlinks, so a
 * *pre-existing directory symlink inside the root* (which the local scanner
 * deliberately skips, so it is never in the inventory) still yields a string
 * under the root and passes. A remote-controlled name like "alias/victim.txt",
 * where "alias" is such a symlink, would then be written through the symlink
 * and land outside the root. See the reconcile/executor download path.
 *
 * This gate runs the lexical check first, then walks from the candidate up to
 * the deepest component that exists on disk and resolves its real path. Because
 * realpath collapses every symlink in that ancestor, an escaping symlink
 * resolves outside the real root and fails closed. Segments below the deepest
 * existing ancestor cannot be symlinks (they do not exist yet) and were already
 * validated as ordinary names by isSafeRelPath, so appending them is safe.
 *
 * The sync model has no legitimate symlinks (the scanner skips them), so
 * refusing to write through any symlinked component never blocks a real sync.
 */
export function resolveRealWithinRoot(root: string, relPath: string): string | null {
    const full = resolveWithinRoot(root, relPath);
    if (full === null) return null;

    let rootReal: string;
    try {
        rootReal = realpathSync(root);
    } catch {
        return null; // root must exist and be resolvable; fail closed otherwise
    }

    // Walk up to the deepest component that exists on disk. lstat does not
    // follow the final component, so a dangling symlink still counts as
    // existing and is caught here rather than slipping through as "not yet
    // created".
    let probe = full;
    for (;;) {
        let symlink = false;
        let exists = true;
        try {
            symlink = lstatSync(probe).isSymbolicLink();
        } catch {
            exists = false; // this component does not exist yet - keep walking up
        }
        if (exists) {
            // The sync model has no legitimate symlinks, so refuse to write
            // through or onto any symlinked component, escaping or not.
            if (symlink) return null;
            let real: string;
            try {
                real = realpathSync(probe);
            } catch {
                return null;
            }
            // realpath also collapses any symlink in probe's ancestors, so an
            // escaping directory symlink above this point resolves outside the
            // real root and is caught by the containment check.
            if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
            return full;
        }
        const parent = dirname(probe);
        if (parent === probe) return null; // reached the filesystem root without an existing ancestor
        probe = parent;
    }
}
