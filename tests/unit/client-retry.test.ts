import { describe, it, expect, afterEach } from "bun:test";
import { DosyaClient, ApiError } from "../../src/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** Record every call and reply with a scripted sequence of responses. */
function mockFetch(responses: (() => Response)[]) {
    const calls: { url: string; method: string }[] = [];
    let i = 0;
    globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        const make = responses[Math.min(i, responses.length - 1)];
        i++;
        return make();
    }) as unknown as typeof fetch;
    return calls;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });

describe("DosyaClient - retry safety", () => {
    it("retries GET on 5xx", async () => {
        const calls = mockFetch([
            () => json({ error: "boom" }, 500),
            () => json({ ok: true }, 200),
        ]);

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");
        const res = await client.request("/api/files");

        expect(res.ok).toBe(true);
        expect(calls.length).toBe(2);
    });

    it("does NOT retry POST on 5xx - a replayed invite sends duplicates", async () => {
        const calls = mockFetch([() => json({ error: "boom" }, 500)]);

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");
        const res = await client.request("/api/team/invite", { method: "POST", body: { email: "a@b.c" } });

        expect(res.status).toBe(500);
        expect(calls.length).toBe(1);
    });

    it("does NOT retry DELETE on 5xx - a second delete is a permanent delete", async () => {
        const calls = mockFetch([() => json({ error: "boom" }, 500)]);

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");
        const res = await client.request("/api/files/fil_1", { method: "DELETE" });

        expect(res.status).toBe(500);
        expect(calls.length).toBe(1);
    });

    it("retries PUT on 5xx (rename/move are idempotent)", async () => {
        const calls = mockFetch([
            () => json({ error: "boom" }, 500),
            () => json({ ok: true }, 200),
        ]);

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");
        await client.request("/api/files/fil_1/rename", { method: "PUT", body: { name: "x" } });

        expect(calls.length).toBe(2);
    });
});

describe("DosyaClient - 429 handling", () => {
    it("honours Retry-After and then succeeds", async () => {
        const calls = mockFetch([
            () => json({ error: "slow down" }, 429, { "retry-after": "0" }),
            () => json({ ok: true }, 200),
        ]);

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");
        const res = await client.request("/api/files");

        expect(res.ok).toBe(true);
        expect(calls.length).toBe(2);
    });

    it("retries a 429 even for POST, since the request was never processed", async () => {
        const calls = mockFetch([
            () => json({ error: "slow down" }, 429, { "retry-after": "0" }),
            () => json({ ok: true }, 200),
        ]);

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");
        const res = await client.request("/api/folders", { method: "POST", body: { name: "x" } });

        expect(res.ok).toBe(true);
        expect(calls.length).toBe(2);
    });
});

describe("DosyaClient - credential scope", () => {
    it("sends the API key to the configured host", async () => {
        let headers: Record<string, string> = {};
        globalThis.fetch = (async (_url: string, init: any) => {
            headers = init?.headers ?? {};
            return json({ ok: true }, 200);
        }) as unknown as typeof fetch;

        const client = new DosyaClient("https://api.dosya.dev", "dos_secret");
        await client.request("/api/me");

        expect(headers.Authorization).toBe("Bearer dos_secret");
    });

    it("never sends the API key to another origin", async () => {
        let headers: Record<string, string> = {};
        globalThis.fetch = (async (_url: string, init: any) => {
            headers = init?.headers ?? {};
            return json({ ok: true }, 200);
        }) as unknown as typeof fetch;

        const client = new DosyaClient("https://api.dosya.dev", "dos_secret");
        await client.request("https://evil.example.com/steal");

        expect(headers.Authorization).toBeUndefined();
    });
});

describe("DosyaClient - error typing", () => {
    it("throws ApiError carrying the status code", async () => {
        mockFetch([() => json({ error: "Not found" }, 404)]);

        const client = new DosyaClient("https://api.dosya.dev", "dos_test");

        try {
            await client.get("/api/files/nope");
            throw new Error("expected get() to throw");
        } catch (err) {
            expect(err).toBeInstanceOf(ApiError);
            expect((err as ApiError).status).toBe(404);
            expect((err as ApiError).message).toBe("Not found");
        }
    });
});
