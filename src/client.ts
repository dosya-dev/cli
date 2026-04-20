import { debug } from "./output";

export interface ApiResponse<T = unknown> {
    ok: boolean;
    status: number;
    data: T;
    headers: Headers;
}

interface RequestOptions {
    method?: string;
    body?: unknown;
    rawBody?: ReadableStream | ArrayBuffer | Uint8Array;
    headers?: Record<string, string>;
    timeout?: number;
    redirect?: RequestRedirect;
}

export class AuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AuthError";
    }
}

export class NetworkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NetworkError";
    }
}

const RETRY_DELAYS = [1000, 3000, 8000];

export class DosyaClient {
    private apiBase: string;
    private apiKey: string;

    constructor(apiBase: string, apiKey: string) {
        this.apiBase = apiBase.replace(/\/$/, "");
        this.apiKey = apiKey;
    }

    async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
        const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
        const method = opts.method ?? "GET";

        const headers: Record<string, string> = {
            "Authorization": `Bearer ${this.apiKey}`,
            ...opts.headers,
        };

        let fetchBody: BodyInit | undefined;
        const isStreamBody = opts.rawBody instanceof ReadableStream;

        if (opts.rawBody) {
            fetchBody = opts.rawBody as BodyInit;
            headers["Content-Type"] ??= "application/octet-stream";
        } else if (opts.body !== undefined) {
            fetchBody = JSON.stringify(opts.body);
            headers["Content-Type"] = "application/json";
        }

        const timeoutMs = opts.timeout ?? 30_000;
        let lastError: Error | null = null;
        // Stream bodies (ReadableStream) can only be consumed once — do not retry them
        const maxRetries = isStreamBody ? 0 : RETRY_DELAYS.length;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                debug(`${method} ${url} (attempt ${attempt + 1})`);

                const response = await fetch(url, {
                    method,
                    headers,
                    body: fetchBody,
                    redirect: opts.redirect ?? "follow",
                    signal: AbortSignal.timeout(timeoutMs),
                });

                debug(`${method} ${url} → ${response.status}`);

                // Auth errors — never retry
                if (response.status === 401) {
                    const data = await response.json().catch(() => ({ error: "Unauthorized" })) as T;
                    throw new AuthError("Authentication failed. Run 'dosya auth login' to re-authenticate.");
                }
                if (response.status === 403) {
                    const data = await response.json().catch(() => ({ error: "Forbidden" })) as T;
                    throw new AuthError("Permission denied. You don't have access to this resource.");
                }

                // Don't retry other client errors
                if (response.status >= 400 && response.status < 500) {
                    const data = await response.json().catch(() => ({ ok: false, error: "Unknown error" })) as T;
                    return { ok: false, status: response.status, data, headers: response.headers };
                }

                // Retry 5xx (but not for stream bodies)
                if (response.status >= 500 && attempt < maxRetries) {
                    lastError = new Error(`Server error: ${response.status}`);
                    debug(`Retrying in ${RETRY_DELAYS[attempt]}ms...`);
                    await Bun.sleep(RETRY_DELAYS[attempt]);
                    continue;
                }

                const contentType = response.headers.get("content-type") ?? "";
                let data: T;
                if (contentType.includes("application/json")) {
                    data = await response.json() as T;
                } else {
                    // For binary responses (downloads), return the response itself
                    data = response as unknown as T;
                }

                return { ok: response.ok, status: response.status, data, headers: response.headers };
            } catch (err) {
                // Re-throw typed errors immediately
                if (err instanceof AuthError) throw err;

                // Classify the error
                if (err instanceof DOMException && err.name === "TimeoutError") {
                    lastError = new NetworkError(
                        `Request timed out after ${timeoutMs / 1000}s. Check your connection or try again.`
                    );
                } else if (err instanceof TypeError && (err.message.includes("fetch") || err.message.includes("connect"))) {
                    lastError = new NetworkError(
                        `Cannot reach ${this.apiBase}. Check your internet connection.`
                    );
                } else {
                    lastError = err as Error;
                }

                if (attempt < maxRetries) {
                    debug(`Request error: ${lastError.message}. Retrying in ${RETRY_DELAYS[attempt]}ms...`);
                    await Bun.sleep(RETRY_DELAYS[attempt]);
                    continue;
                }
            }
        }

        throw lastError ?? new NetworkError("Request failed after retries.");
    }

    async get<T = unknown>(path: string): Promise<T> {
        const res = await this.request<T>(path);
        if (!res.ok) {
            const err = res.data as { error?: string };
            throw new Error(err?.error ?? `Request failed: ${res.status}`);
        }
        return res.data;
    }

    async post<T = unknown>(path: string, body?: unknown): Promise<T> {
        const res = await this.request<T>(path, { method: "POST", body });
        if (!res.ok) {
            const err = res.data as { error?: string };
            throw new Error(err?.error ?? `Request failed: ${res.status}`);
        }
        return res.data;
    }

    async put<T = unknown>(path: string, body?: unknown): Promise<T> {
        const res = await this.request<T>(path, { method: "PUT", body });
        if (!res.ok) {
            const err = res.data as { error?: string };
            throw new Error(err?.error ?? `Request failed: ${res.status}`);
        }
        return res.data;
    }

    async del<T = unknown>(path: string): Promise<T> {
        const res = await this.request<T>(path, { method: "DELETE" });
        if (!res.ok) {
            const err = res.data as { error?: string };
            throw new Error(err?.error ?? `Request failed: ${res.status}`);
        }
        return res.data;
    }
}
