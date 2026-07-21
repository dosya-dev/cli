import { debug } from "./output";
import { ApiError, AuthError, NetworkError } from "./errors";
import { getRequestTimeout } from "./runtime";

export { ApiError, AuthError, NetworkError };

/** Build a client that honours the global `--timeout` flag. */
export function createClient(apiBase: string, apiKey: string): DosyaClient {
    return new DosyaClient(apiBase, apiKey, getRequestTimeout());
}

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

const RETRY_DELAYS = [1000, 3000, 8000];
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Methods that are safe to replay after a 5xx or a transport error.
 *
 * POST is excluded because it creates resources (an invite retried three times
 * sends three invites). DELETE is excluded because this API treats a second
 * DELETE on a file as "permanently delete" — replaying a soft delete that
 * actually succeeded would destroy the file.
 */
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "PUT"]);

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }

    const date = Date.parse(value);
    if (!Number.isNaN(date)) {
        return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
    }

    return null;
}

export class DosyaClient {
    private apiBase: string;
    private apiKey: string;
    private defaultTimeout: number;

    constructor(apiBase: string, apiKey: string, defaultTimeout = 30_000) {
        this.apiBase = apiBase.replace(/\/$/, "");
        this.apiKey = apiKey;
        this.defaultTimeout = defaultTimeout;
    }

    /**
     * Only attach credentials to the configured API host, so a redirect or a
     * server-supplied absolute URL can never exfiltrate the API key.
     */
    private isSameOrigin(url: string): boolean {
        try {
            return new URL(url).origin === new URL(this.apiBase).origin;
        } catch {
            return false;
        }
    }

    async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
        const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
        const method = (opts.method ?? "GET").toUpperCase();

        const headers: Record<string, string> = { ...opts.headers };
        if (this.isSameOrigin(url)) {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        } else {
            debug(`Omitting credentials for cross-origin request to ${url}`);
        }

        let fetchBody: BodyInit | undefined;
        const isStreamBody = opts.rawBody instanceof ReadableStream;

        if (opts.rawBody) {
            fetchBody = opts.rawBody as BodyInit;
            headers["Content-Type"] ??= "application/octet-stream";
        } else if (opts.body !== undefined) {
            fetchBody = JSON.stringify(opts.body);
            headers["Content-Type"] = "application/json";
        }

        const timeoutMs = opts.timeout ?? this.defaultTimeout;
        let lastError: Error | null = null;

        // A ReadableStream body can only be consumed once, so it can never be
        // resent. A non-idempotent method may only be replayed when the server
        // tells us it did not process the request (429) — never after a 5xx or
        // a transport error, where the write may well have landed.
        const canResend = !isStreamBody;
        const canReplay = canResend && RETRYABLE_METHODS.has(method);
        const maxRetries = RETRY_DELAYS.length;

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

                // Auth errors — never retry. Drain the body first so the
                // socket can be reused instead of being held open.
                if (response.status === 401 || response.status === 403) {
                    await response.body?.cancel().catch(() => {});
                    throw new AuthError(
                        response.status === 401
                            ? "Authentication failed. Run 'dosya auth login' to re-authenticate."
                            : "Permission denied. You don't have access to this resource.",
                    );
                }

                // Rate limited. The request was rejected, not processed, so
                // this is safe to replay for any method.
                if (response.status === 429 && canResend && attempt < maxRetries) {
                    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
                    const waitMs = retryAfter ?? RETRY_DELAYS[attempt];
                    lastError = new NetworkError("Rate limited by the server.");
                    debug(`Rate limited (429). Waiting ${waitMs}ms before retry...`);
                    await response.body?.cancel().catch(() => {});
                    await Bun.sleep(waitMs);
                    continue;
                }

                // Don't retry other client errors
                if (response.status >= 400 && response.status < 500) {
                    const data = await response.json().catch(() => ({ ok: false, error: "Unknown error" })) as T;
                    return { ok: false, status: response.status, data, headers: response.headers };
                }

                // Retry 5xx where the method allows it
                if (response.status >= 500 && canReplay && attempt < maxRetries) {
                    lastError = new Error(`Server error: ${response.status}`);
                    debug(`Retrying in ${RETRY_DELAYS[attempt]}ms...`);
                    await response.body?.cancel().catch(() => {});
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
                        `Request timed out after ${Math.round(timeoutMs / 1000)}s. Check your connection or try again.`,
                    );
                } else if (err instanceof TypeError && (err.message.includes("fetch") || err.message.includes("connect"))) {
                    lastError = new NetworkError(
                        `Cannot reach ${this.apiBase}. Check your internet connection.`,
                    );
                } else {
                    lastError = err as Error;
                }

                // A transport error gives no proof the server didn't act, so
                // only idempotent methods may be replayed.
                if (canReplay && attempt < maxRetries) {
                    debug(`Request error: ${lastError.message}. Retrying in ${RETRY_DELAYS[attempt]}ms...`);
                    await Bun.sleep(RETRY_DELAYS[attempt]);
                    continue;
                }
                break;
            }
        }

        throw lastError ?? new NetworkError("Request failed after retries.");
    }

    /** Unwrap a response, turning a non-2xx into a typed ApiError. */
    private unwrap<T>(res: ApiResponse<T>): T {
        if (!res.ok) {
            const err = res.data as { error?: string };
            throw new ApiError(err?.error ?? `Request failed: ${res.status}`, res.status);
        }
        return res.data;
    }

    async get<T = unknown>(path: string): Promise<T> {
        return this.unwrap(await this.request<T>(path));
    }

    async post<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.unwrap(await this.request<T>(path, { method: "POST", body }));
    }

    async put<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.unwrap(await this.request<T>(path, { method: "PUT", body }));
    }

    async del<T = unknown>(path: string): Promise<T> {
        return this.unwrap(await this.request<T>(path, { method: "DELETE" }));
    }
}
