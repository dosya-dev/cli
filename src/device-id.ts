import { randomUUID } from "crypto";
import { join } from "path";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { getConfigDir } from "./config";

/**
 * A stable identity for THIS INSTALLATION of the CLI.
 *
 * The server cannot tell that a machine has stopped syncing without one: "sync
 * stopped" is the absence of an event, so it can only be found by comparing a
 * per-device last-seen timestamp against now. The id goes out on the
 * `X-Dosya-Device` header, `POST /api/sync/commit` records it against
 * `device_sync_state`, and a daily sweep notices when a device stops writing
 * (`/api/internal/notifications/sync-watchdog`).
 *
 * Three properties, all deliberate and all shared with the desktop app's
 * `apps/desktop/src/main/sync/device-id.ts`:
 *
 *   - **Random, never derived from hardware.** A MAC address or a machine
 *     serial would be a fingerprint that survives an uninstall and identifies
 *     the person rather than the installation. This is a `randomUUID()` and
 *     means nothing outside our own table. The server treats it as opaque.
 *   - **One per installation, not one per account.** Migration 0113 keys
 *     `device_sync_state` on `(user_id, device_id)`, so a laptop logged into a
 *     personal and a work account gets one row per account from a single id.
 *   - **Beside the config file, not inside it.** `dosya auth logout` deletes
 *     `config.json` wholesale (`deleteConfig`), and the machine is still the
 *     same machine after a logout, so the id lives in its own file.
 *
 * A reinstall, or a `rm -rf ~/.dosya`, produces a new id. That is fine and
 * documented: the old device row goes quiet and ages out of the 30-day window
 * the watchdog looks at.
 *
 * Everything here is SYNCHRONOUS on purpose. `DosyaClient.request` builds its
 * headers synchronously, the CLI process is short-lived, and one small read on
 * the first request is cheaper than threading a promise through every call
 * site - where an `await` that somebody forgot would silently drop the header.
 */

/** Header name, spelled once. The server reads it case-insensitively. */
export const DEVICE_ID_HEADER = "X-Dosya-Device";

/** JSON rather than a bare string so a later field can join it without a format change. */
export const DEVICE_ID_FILE = "device-id.json";

/**
 * The same shape and bounds the server validates on
 * (apps/api/src/lib/sync/device-state.ts `parseDeviceId`). Kept in step
 * deliberately: an id this CLI happily persists but the server silently ignores
 * is a device that looks like it is reporting and never is.
 */
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const SHAPE = /^[A-Za-z0-9._:-]+$/;

export function isValidDeviceId(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const id = value.trim();
    return id.length >= MIN_LENGTH && id.length <= MAX_LENGTH && SHAPE.test(id);
}

export function deviceIdPath(): string {
    return join(getConfigDir(), DEVICE_ID_FILE);
}

/**
 * Write to a per-process temp file, then rename - the same contract
 * `saveConfig` uses, and for the same reason: a crash midway through a plain
 * write leaves a 0-byte file, which here would read as "no device yet" and mint
 * a second identity for the same machine on the next run.
 *
 * 0600 because it sits in a directory that also holds the API key, not because
 * the id is a secret - it is not, and nothing downstream may treat it as one.
 */
function persist(path: string, deviceId: string): void {
    const tmpFile = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(tmpFile, `${JSON.stringify({ deviceId }, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmpFile, path);
    } catch (err) {
        try { unlinkSync(tmpFile); } catch { /* nothing to clean up */ }
        throw err;
    }
}

/**
 * Read the installation's id, minting and persisting one on first run.
 *
 * **Never throws and never returns an empty string.** The id decorates sync
 * requests, and a device identity failing must never be able to stop a sync: a
 * read-only home directory, a full disk or a corrupt file all degrade to an
 * in-memory id that lasts for this process and starts over next run - the same
 * degradation as a reinstall, which the watchdog already handles.
 */
export function loadOrCreateDeviceId(): string {
    const path = deviceIdPath();
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { deviceId?: unknown };
        if (isValidDeviceId(parsed?.deviceId)) return parsed.deviceId.trim();
        // A corrupt or truncated store is replaced rather than repaired: there
        // is nothing in it to repair from, and the cost is one device row going
        // quiet and ageing out.
    } catch {
        // ENOENT is the ordinary first run. Any other read failure lands here
        // too and is treated the same way - mint, try to persist, carry on.
    }

    const deviceId = randomUUID();
    try {
        mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
        persist(path, deviceId);
    } catch {
        // Sync carries on with an id that lasts as long as this process does.
    }
    return deviceId;
}

/**
 * Process-wide memo. One read on first use, one value for the life of the
 * command, so a sync that issues hundreds of requests does not stat the config
 * directory hundreds of times.
 */
let cached: string | null = null;

export function getDeviceId(): string {
    if (cached === null) cached = loadOrCreateDeviceId();
    return cached;
}

/** Test hook: forget the memo so a spec can simulate a fresh process. */
export function __resetDeviceId(): void {
    cached = null;
}
