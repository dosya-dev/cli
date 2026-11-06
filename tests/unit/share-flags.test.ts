import { describe, it, expect } from "bun:test";
import { applyStripMetadataFlag, buildShareEmailFlagsBody, splitEmails } from "../../src/commands/share-flags";

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

/**
 * `dosya share email` builds its body with the shared builder: `emails[]` and
 * an explicit `restrict_to_recipients`, the same contract the desktop app and
 * the extension send - never the legacy singular `email`.
 */
describe("buildShareEmailFlagsBody", () => {
    const file = { kind: "file", fileIds: ["fil_1"] } as const;

    it("sends emails[] and restrict_to_recipients: false by default", () => {
        const body = buildShareEmailFlagsBody(file, { email: "A@b.com" });
        expect(body).toEqual({ emails: ["a@b.com"], message: "", restrict_to_recipients: false });
        expect(body).not.toHaveProperty("email");
    });

    it("restricts the link to the recipients with --restrict", () => {
        const body = buildShareEmailFlagsBody({ kind: "folder", folderId: "fld_1" }, { email: "a@b.com,c@d.com", restrict: "" });
        expect(body.emails).toEqual(["a@b.com", "c@d.com"]);
        expect(body.restrict_to_recipients).toBe(true);
    });

    it("carries message, password and --strip-metadata", () => {
        const body = buildShareEmailFlagsBody(file, { email: "a@b.com", message: " hi ", password: "secret12", "strip-metadata": "" });
        expect(body).toMatchObject({ message: "hi", password: "secret12", strip_metadata: true });
    });
});

describe("splitEmails", () => {
    it("splits on commas and drops blanks", () => {
        expect(splitEmails(" a@b.com , ,c@d.com")).toEqual(["a@b.com", "c@d.com"]);
        expect(splitEmails(undefined)).toEqual([]);
    });
});
