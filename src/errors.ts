/**
 * Typed errors shared by the HTTP client and the output layer.
 *
 * These live in their own module so `output.ts` can map an error to an exit
 * code without importing `client.ts` (which imports `output.ts` for `debug`).
 */

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

/** A non-2xx response that carried a structured error payload. */
export class ApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

/**
 * Human-readable fallback for an HTTP status, used only when the server did not
 * send its own `error` message. The server's message always wins; this exists so
 * that a bare or non-JSON error response never surfaces as "Unknown error" or a
 * cryptic number - the user always gets something they can act on.
 */
export function httpErrorMessage(status: number): string {
    switch (status) {
        case 400: return "Bad request - the server rejected the input (400).";
        case 401: return "Authentication failed. Run 'dosya auth login' to re-authenticate.";
        case 402: return "This action requires a paid plan (402).";
        case 403: return "Permission denied. You don't have access to this resource (403).";
        case 404: return "Not found (404).";
        case 405: return "That action isn't allowed here (405).";
        case 408: return "The server timed out waiting for the request (408). Try again.";
        case 409: return "Conflict - the resource's current state prevents this (409).";
        case 410: return "This resource is no longer available (410).";
        case 413: return "Too large (413).";
        case 415: return "Unsupported file or content type (415).";
        case 422: return "The request was rejected as invalid (422).";
        case 423: return "Locked - unlock it first (423).";
        case 429: return "Rate limited - too many requests. Try again shortly (429).";
        case 500: return "Server error (500). Please try again.";
        case 502: return "The server is unreachable right now (502). Please try again.";
        case 503: return "The service is temporarily unavailable (503). Please try again.";
        case 504: return "The server timed out (504). Please try again.";
        default:
            if (status >= 500) return `Server error (${status}). Please try again.`;
            if (status >= 400) return `Request failed (HTTP ${status}).`;
            return `Unexpected response (HTTP ${status}).`;
    }
}
