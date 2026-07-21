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
