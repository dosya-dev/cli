import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import {
    DEVICE_ID_FILE, DEVICE_ID_HEADER, deviceIdPath, getDeviceId,
    isValidDeviceId, loadOrCreateDeviceId, __resetDeviceId,
} from "../../src/device-id";
import { DosyaClient } from "../../src/client";

const originalXdg = process.env.XDG_CONFIG_HOME;

function freshHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "dosya-device-"));
    process.env.XDG_CONFIG_HOME = dir;
    __resetDeviceId();
    return join(dir, "dosya");
}

afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    __resetDeviceId();
});

describe("isValidDeviceId", () => {
    it("accepts a UUID and matches the server's bounds", () => {
        expect(isValidDeviceId("3f1a9c5e-3b6e-4a0e-9a2b-9d1f8a2c7e41")).toBe(true);
        expect(isValidDeviceId("a".repeat(8))).toBe(true);
        expect(isValidDeviceId("a".repeat(128))).toBe(true);
    });

    it("rejects what the server would ignore", () => {
        expect(isValidDeviceId("a".repeat(7))).toBe(false);
        expect(isValidDeviceId("a".repeat(129))).toBe(false);
        expect(isValidDeviceId("has space")).toBe(false);
        expect(isValidDeviceId("new\nline")).toBe(false);
        expect(isValidDeviceId("")).toBe(false);
        expect(isValidDeviceId(undefined)).toBe(false);
        expect(isValidDeviceId(42)).toBe(false);
    });
});

describe("device id", () => {
    it("mints one on first run and persists it beside the config file", () => {
        const configDir = freshHome();
        const id = loadOrCreateDeviceId();

        expect(isValidDeviceId(id)).toBe(true);
        expect(deviceIdPath()).toBe(join(configDir, DEVICE_ID_FILE));
        const stored = JSON.parse(readFileSync(deviceIdPath(), "utf8")) as { deviceId: string };
        expect(stored.deviceId).toBe(id);
    });

    it("reuses the persisted id on the next run", () => {
        freshHome();
        const first = loadOrCreateDeviceId();
        // A brand new process reads the same file: no memo involved.
        __resetDeviceId();
        expect(loadOrCreateDeviceId()).toBe(first);
        expect(getDeviceId()).toBe(first);
    });

    it("memoises within one process", () => {
        freshHome();
        expect(getDeviceId()).toBe(getDeviceId());
    });

    it("gives two installations two different ids", () => {
        freshHome();
        const a = getDeviceId();
        freshHome();
        const b = getDeviceId();
        expect(a).not.toBe(b);
    });

    it("replaces a corrupt store rather than trying to repair it", () => {
        const configDir = freshHome();
        mkdirSync(configDir, { recursive: true });
        writeFileSync(deviceIdPath(), "{ this is not json");

        const id = loadOrCreateDeviceId();
        expect(isValidDeviceId(id)).toBe(true);
        expect(JSON.parse(readFileSync(deviceIdPath(), "utf8")).deviceId).toBe(id);
    });

    it("ignores a stored id the server would reject", () => {
        const configDir = freshHome();
        mkdirSync(configDir, { recursive: true });
        writeFileSync(deviceIdPath(), JSON.stringify({ deviceId: "no good" }));

        const id = loadOrCreateDeviceId();
        expect(id).not.toBe("no good");
        expect(isValidDeviceId(id)).toBe(true);
    });

    /**
     * The load-bearing one. A device identity is a nice-to-have; syncing is
     * not. An unwritable config directory must produce a usable id and no
     * throw, because `DosyaClient.request` calls this on every request.
     */
    it("still yields an id when the store cannot be written", () => {
        const configDir = freshHome();
        mkdirSync(configDir, { recursive: true });
        chmodSync(configDir, 0o500); // r-x: mkdir succeeds (it exists), the write cannot
        try {
            const id = loadOrCreateDeviceId();
            expect(isValidDeviceId(id)).toBe(true);
            // ...and it is stable for the rest of the process, so every request
            // in this run reports the same device.
            expect(getDeviceId()).toBe(getDeviceId());
        } finally {
            chmodSync(configDir, 0o700);
        }
    });
});

describe("the header on the wire", () => {
    it("is the name the server reads", () => {
        expect(DEVICE_ID_HEADER.toLowerCase()).toBe("x-dosya-device");
    });

    it("travels on a same-origin request and never cross-origin", async () => {
        freshHome();
        const expected = getDeviceId();
        const seen: Array<{ url: string; device: string | null; auth: string | null }> = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : String(input);
            const h = new Headers(init?.headers as HeadersInit);
            seen.push({ url, device: h.get(DEVICE_ID_HEADER), auth: h.get("Authorization") });
            return new Response(JSON.stringify({ ok: true }), {
                status: 200, headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const client = new DosyaClient("https://api.example.invalid", "key_1", 5000);
            await client.request("/api/sync/commit", { method: "POST", body: { files: [] } });
            await client.request("https://r2.example.invalid/put", { method: "PUT" });
        } finally {
            globalThis.fetch = realFetch;
        }

        expect(seen[0].device).toBe(expected);
        expect(seen[1].device).toBeNull();
        // Pinned together deliberately: the device id rides the same
        // same-origin branch as the credential and must never outlive it.
        expect(seen[1].auth).toBeNull();
    });
});
