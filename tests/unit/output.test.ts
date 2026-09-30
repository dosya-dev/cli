import { describe, it, expect } from "bun:test";
import { timeAgo, EXIT, exitCodeFor } from "../../src/output";
import { AuthError, NetworkError } from "../../src/errors";

describe("timeAgo", () => {
    it("should return 'just now' for recent timestamps", () => {
        const now = Math.floor(Date.now() / 1000);
        expect(timeAgo(now)).toBe("just now");
        expect(timeAgo(now - 30)).toBe("just now");
    });

    it("should return minutes ago", () => {
        const now = Math.floor(Date.now() / 1000);
        expect(timeAgo(now - 60)).toBe("1m ago");
        expect(timeAgo(now - 120)).toBe("2m ago");
        expect(timeAgo(now - 3599)).toBe("59m ago");
    });

    it("should return hours ago", () => {
        const now = Math.floor(Date.now() / 1000);
        expect(timeAgo(now - 3600)).toBe("1h ago");
        expect(timeAgo(now - 7200)).toBe("2h ago");
        expect(timeAgo(now - 86399)).toBe("23h ago");
    });

    it("should return days ago", () => {
        const now = Math.floor(Date.now() / 1000);
        expect(timeAgo(now - 86400)).toBe("1d ago");
        expect(timeAgo(now - 172800)).toBe("2d ago");
        expect(timeAgo(now - 604799)).toBe("6d ago");
    });

    it("should return formatted date for older timestamps", () => {
        const now = Math.floor(Date.now() / 1000);
        const result = timeAgo(now - 604800); // exactly 7 days
        // Should be a date string, not "Xd ago"
        expect(result).not.toContain("ago");
        expect(result).toMatch(/\d/); // contains at least a digit
    });
});

describe("EXIT codes", () => {
    it("should have correct exit code values", () => {
        expect(EXIT.OK).toBe(0);
        expect(EXIT.ERROR).toBe(1);
        expect(EXIT.USAGE).toBe(2);
        expect(EXIT.AUTH).toBe(3);
        expect(EXIT.NETWORK).toBe(4);
    });
});

describe("exitCodeFor", () => {
    it("separates a permission refusal from a dead credential", () => {
        // A script that reacts to 3 by re-authenticating must not do that for a
        // 403: the key is fine, the role is not allowed. Distinct code.
        expect(EXIT.FORBIDDEN).toBe(5);
        expect(exitCodeFor(new AuthError("no", 403))).toBe(EXIT.FORBIDDEN);
        expect(exitCodeFor(new AuthError("dead", 401))).toBe(EXIT.AUTH);
        expect(exitCodeFor(new AuthError("no status"))).toBe(EXIT.AUTH);
        expect(exitCodeFor(new NetworkError("offline"))).toBe(EXIT.NETWORK);
        expect(exitCodeFor(new Error("boom"))).toBe(EXIT.ERROR);
    });
});
