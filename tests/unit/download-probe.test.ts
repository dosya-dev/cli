import { describe, it, expect, afterEach } from "bun:test";
import { probeRangeSupport, UrlExpiredError } from "../../src/commands/download";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockStatuses(statuses: number[]) {
    const seen: string[] = [];
    let i = 0;
    globalThis.fetch = (async (url: string) => {
        seen.push(String(url));
        const status = statuses[Math.min(i, statuses.length - 1)];
        i++;
        return new Response(null, { status });
    }) as unknown as typeof fetch;
    return seen;
}

/**
 * Regression: a 403 means the presigned URL expired, NOT that the origin lacks
 * Range support. Treating them the same sent large downloads into the
 * single-connection fallback, where they died instantly with
 * "Download failed: HTTP 403".
 */
describe("probeRangeSupport", () => {
    it("reports Range support on 206", async () => {
        mockStatuses([206]);
        const res = await probeRangeSupport("http://origin/obj?sig=1", async () => "unused");
        expect(res.supported).toBe(true);
        expect(res.url).toBe("http://origin/obj?sig=1");
    });

    it("reports no Range support on 200", async () => {
        mockStatuses([200]);
        const res = await probeRangeSupport("http://origin/obj?sig=1", async () => "unused");
        expect(res.supported).toBe(false);
    });

    it("treats 403 as an expired URL and retries with a fresh one", async () => {
        const seen = mockStatuses([403, 206]);
        let refreshes = 0;

        const res = await probeRangeSupport("http://origin/obj?sig=1", async () => {
            refreshes++;
            return "http://origin/obj?sig=2";
        });

        expect(refreshes).toBe(1);
        expect(res.supported).toBe(true);
        expect(res.url).toBe("http://origin/obj?sig=2");
        // The retry must actually use the refreshed URL
        expect(seen[1]).toBe("http://origin/obj?sig=2");
    });

    it("gives up with UrlExpiredError when refreshes keep expiring", async () => {
        mockStatuses([403]);
        let refreshes = 0;

        await expect(
            probeRangeSupport("http://origin/obj?sig=1", async () => `http://origin/obj?sig=${++refreshes + 1}`, 2),
        ).rejects.toBeInstanceOf(UrlExpiredError);

        expect(refreshes).toBe(2);
    });
});
