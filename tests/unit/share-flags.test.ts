import { describe, it, expect } from "bun:test";
import { applyStripMetadataFlag } from "../../src/commands/share-flags";

/**
 * `dosya share ... --strip-metadata` asks the API (migration 0183) to serve
 * photos through the link without EXIF/XMP/IPTC. The field is sent only when
 * the flag is present, so every existing invocation builds the body it always
 * did.
 */
describe("applyStripMetadataFlag", () => {
    it("sets strip_metadata when the flag is given", () => {
        expect(applyStripMetadataFlag({ password: "x" }, { "strip-metadata": "" })).toEqual({ password: "x", strip_metadata: true });
    });

    it("leaves the body alone otherwise", () => {
        expect(applyStripMetadataFlag({}, {})).toEqual({});
        expect(applyStripMetadataFlag({}, { json: "" })).toEqual({});
    });
});
