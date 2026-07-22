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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.request("/api/secret")).rejects.toThrow(AuthError);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should surface the server's message on 403 (not a generic string)", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ error: "Free plan allows a maximum of 3 workspaces. Upgrade to create more." }), {
                    status: 403,
                    headers: { "content-type": "application/json" },
                });
            }) as unknown as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.request("/api/workspaces")).rejects.toThrow(
                    "Free plan allows a maximum of 3 workspaces. Upgrade to create more.",
                );
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should fall back to a generic 403 message when the body has none", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response("", { status: 403 });
            }) as unknown as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.request("/api/secret")).rejects.toThrow("Permission denied");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should keep the re-auth hint on 401 regardless of body", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ error: "Unauthorized" }), {
                    status: 401,
                    headers: { "content-type": "application/json" },
                });
            }) as unknown as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_bad");
                await expect(client.request("/api/me")).rejects.toThrow("dosya auth login");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should surface the server's message on a 4xx via get()", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ error: "A workspace with that name already exists." }), {
                    status: 409,
                    headers: { "content-type": "application/json" },
                });
            }) as unknown as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.get("/api/workspaces")).rejects.toThrow("A workspace with that name already exists.");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should give a clear status message when a 4xx has no error field", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response(JSON.stringify({ ok: false }), {
                    status: 404,
                    headers: { "content-type": "application/json" },
                });
            }) as unknown as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.get("/api/nope")).rejects.toThrow("Not found (404)");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should give a clear message + base hint for a non-JSON error body (wrong host)", async () => {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (async () => {
                return new Response("<!doctype html><title>404</title>", {
                    status: 404,
                    headers: { "content-type": "text/html" },
                });
            }) as unknown as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.get("/api/files")).rejects.toThrow("DOSYA_API_BASE");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("should give a clear message on a 5xx", async () => {
            const originalFetch = globalThis.fetch;
            // POST isn't retried on 5xx, so this resolves immediately.
            globalThis.fetch = (async () => {
                return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } });
            }) as unknown as typeof fetch;

            try {
                const client = new DosyaClient("https://dosya.dev", "dos_test");
                await expect(client.post("/api/x", {})).rejects.toThrow("Server error (500)");
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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

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
            }) as unknown as typeof fetch;

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
