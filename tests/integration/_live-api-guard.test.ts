import { describe, it } from "bun:test";
import { LIVE_API, LIVE_API_REASON, LIVE_API_SKIPPED_ON_PURPOSE } from "../helpers";

/**
 * Single authoritative check for "no key and no skip flag was given". Every
 * other file in this directory gates its live-API describe blocks with
 * `describe.skipIf(!LIVE_API)`, which silently skips - correct for those
 * files once a real decision (run or skip) has been made, but on its own
 * that leaves the "nobody configured anything" case silent too: 27 files
 * reporting green while executing nothing, which is the bug this task exists
 * to fix.
 *
 * This file is the one place that turns "no key and no skip flag" into a
 * single, loud, actionable failure - not a throw inside `../helpers` at
 * module scope, which would fail every file that imports it (including
 * completion.test.ts, config.test.ts, security.test.ts, none of which need a
 * live API at all) with an opaque `ReferenceError: Cannot access '...'
 * before initialization` instead of a message naming DOSYA_TEST_API_KEY.
 *
 * The leading underscore in the filename is deliberate: bun:test runs files
 * in path order, so this sorts before the rest of `tests/integration/` and
 * its failure (if any) appears near the top of the log instead of buried
 * after dozens of skipped describe blocks.
 */
describe("live API guard", () => {
    it("requires DOSYA_TEST_API_KEY or DOSYA_SKIP_INTEGRATION=1", () => {
        if (LIVE_API || LIVE_API_SKIPPED_ON_PURPOSE) return;
        throw new Error(LIVE_API_REASON);
    });
});
