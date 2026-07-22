import { describe, it, expect } from "bun:test";
import { httpErrorMessage } from "../../src/errors";

describe("httpErrorMessage", () => {
    it("gives friendly, actionable text for common codes", () => {
        expect(httpErrorMessage(402)).toContain("paid plan");
        expect(httpErrorMessage(403)).toContain("Permission denied");
        expect(httpErrorMessage(404)).toContain("Not found");
        expect(httpErrorMessage(409)).toContain("Conflict");
        expect(httpErrorMessage(413)).toContain("Too large");
        expect(httpErrorMessage(422)).toContain("invalid");
        expect(httpErrorMessage(423)).toContain("Locked");
        expect(httpErrorMessage(429)).toContain("Rate limited");
    });

    it("always includes the status number so it's never ambiguous", () => {
        expect(httpErrorMessage(404)).toContain("404");
        expect(httpErrorMessage(500)).toContain("500");
    });

    it("has sane fallbacks for uncommon codes", () => {
        expect(httpErrorMessage(418)).toContain("HTTP 418");
        expect(httpErrorMessage(599)).toContain("Server error");
    });
});
