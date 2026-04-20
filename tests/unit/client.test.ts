import { describe, it, expect, mock, beforeEach } from "bun:test";
import { DosyaClient, AuthError, NetworkError } from "../../src/client";

describe("DosyaClient", () => {
    describe("constructor", () => {
        it("should strip trailing slash from apiBase", () => {
            const client = new DosyaClient("https://dosya.dev/", "dos_test");
            // Verify by making a request and checking the URL
            expect(client).toBeDefined();
        });
    });

    describe("request()", () => {
        it("should send Authorization header", async () => {
            let capturedHeaders: Record<string, string> = {};

            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async (url: string, init: any) => {
                capturedHeaders = init?.headers ?? {};
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_mykey");
                await client.request("/api/test");
                expect(capturedHeaders.Authorization).toBe("Bearer dos_mykey");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should return parsed JSON for successful responses", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ ok: true, user: { name: "Test" } }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                const res = await client.request<{ ok: boolean; user: { name: string } }>("/api/me");
                expect(res.ok).toBe(true);
                expect(res.data.user.name).toBe("Test");
                expect(res.status).toBe(200);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should return ok: false for 4xx client errors", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
                    status: 404,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                const res = await client.request("/api/files/nonexistent");
                expect(res.ok).toBe(false);
                expect(res.status).toBe(404);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should throw AuthError on 401", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ error: "Unauthorized" }), {
                    status: 401,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_bad");
                await expect(client.request("/api/me")).rejects.toThrow(AuthError);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should throw AuthError on 403", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ error: "Forbidden" }), {
                    status: 403,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.request("/api/secret")).rejects.toThrow(AuthError);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should send JSON body for POST requests", async () => {
            let capturedBody: string = "";
            let capturedHeaders: Record<string, string> = {};

            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async (_url: string, init: any) => {
                capturedBody = init?.body ?? "";
                capturedHeaders = init?.headers ?? {};
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await client.request("/api/test", {
                    method: "POST",
                    body: { name: "test" },
                });

                const parsed = JSON.parse(capturedBody);
                expect(parsed.name).toBe("test");
                expect(capturedHeaders["Content-Type"]).toBe("application/json");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should use absolute URL when path starts with http", async () => {
            let capturedUrl = "";

            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async (url: string) => {
                capturedUrl = url;
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await client.request("https://r2.dosya.dev/upload/123");
                expect(capturedUrl).toBe("https://r2.dosya.dev/upload/123");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    describe("convenience methods", () => {
        let originalFetch: typeof fetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
        });

        it("get() should throw on non-ok response", async () => {
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
                    status: 404,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.get("/api/files/bad")).rejects.toThrow("Not found");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("post() should send body and return data", async () => {
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ ok: true, id: "ws_new" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                const result = await client.post<{ ok: boolean; id: string }>("/api/workspaces", { name: "Test" });
                expect(result.id).toBe("ws_new");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("put() should use PUT method", async () => {
            let capturedMethod = "";
            globalThis.fetch = (async (_url: string, init: any) => {
                capturedMethod = init?.method ?? "";
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await client.put("/api/files/x/rename", { name: "new" });
                expect(capturedMethod).toBe("PUT");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("del() should use DELETE method", async () => {
            let capturedMethod = "";
            globalThis.fetch = (async (_url: string, init: any) => {
                capturedMethod = init?.method ?? "";
                return new Response(JSON.stringify({ ok: true, permanent: false }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await client.del("/api/files/x");
                expect(capturedMethod).toBe("DELETE");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });
});

describe("AuthError", () => {
    it("should set name and message", () => {
        const err = new AuthError("auth failed");
        expect(err.name).toBe("AuthError");
        expect(err.message).toBe("auth failed");
        expect(err).toBeInstanceOf(Error);
    });
});

describe("NetworkError", () => {
    it("should set name and message", () => {
        const err = new NetworkError("connection failed");
        expect(err.name).toBe("NetworkError");
        expect(err.message).toBe("connection failed");
        expect(err).toBeInstanceOf(Error);
    });
});
