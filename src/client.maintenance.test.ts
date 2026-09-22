import { describe, it, expect, afterEach } from "bun:test";
import { DosyaClient } from "./client";
import { MaintenanceError } from "./errors";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });

describe("DosyaClient - maintenance (surface_disabled)", () => {
    it("throws MaintenanceError on a 503 surface_disabled response, without retrying", async () => {
        const calls: { url: string; method: string }[] = [];
        globalThis.fetch = (async (url: string, init: any) => {
            calls.push({ url: String(url), method: init?.method ?? "GET" });
            return json(
                {
                    ok: false,
                    error: "The dosya CLI is paused for maintenance.",
                    code: "surface_disabled",
                    surface: "cli",
                    message: "Upgrading storage backend, back in ~1h.",
                    retry_after: 60,
                },
                503,
            );
        }) as unknown as typeof fetch;

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");

        try {
            await client.request("/api/files");
            throw new Error("expected request() to throw");
        } catch (err) {
            expect(err).toBeInstanceOf(MaintenanceError);
            const maint = err as MaintenanceError;
            expect(maint.surface).toBe("cli");
            expect(maint.message).toBe("Upgrading storage backend, back in ~1h.");
            expect(maint.body).toEqual({
                ok: false,
                error: "The dosya CLI is paused for maintenance.",
                code: "surface_disabled",
                surface: "cli",
                message: "Upgrading storage backend, back in ~1h.",
                retry_after: 60,
            });
        }

        expect(calls.length).toBe(1);
    });

    it("falls back to the default message when the server sends message: null", async () => {
        globalThis.fetch = (async () =>
            json(
                {
                    ok: false,
                    error: "The dosya CLI is paused for maintenance.",
                    code: "surface_disabled",
                    surface: "cli",
                    message: null,
                    retry_after: 60,
                },
                503,
            )) as unknown as typeof fetch;

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");

        try {
            await client.request("/api/files");
            throw new Error("expected request() to throw");
        } catch (err) {
            expect(err).toBeInstanceOf(MaintenanceError);
            expect((err as MaintenanceError).message).toBe("Paused for maintenance");
        }
    });

    it("still retries a plain 503 that lacks the surface_disabled code, reusing the parsed body without double-reading it", async () => {
        const calls: { url: string; method: string }[] = [];
        let i = 0;
        const responses = [
            () => json({ error: "Service unavailable" }, 503),
            () => json({ ok: true }, 200),
        ];
        globalThis.fetch = (async (url: string, init: any) => {
            calls.push({ url: String(url), method: init?.method ?? "GET" });
            return responses[Math.min(i++, responses.length - 1)]();
        }) as unknown as typeof fetch;

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");
        const res = await client.request("/api/files");

        // GET is retryable on 5xx, so a plain 503 (not surface_disabled) should
        // still go through the existing retry loop, not throw MaintenanceError.
        expect(res.ok).toBe(true);
        expect(calls.length).toBe(2);
    });
});
