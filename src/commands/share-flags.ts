import { buildShareEmailBody, type ShareTarget } from "@dosya-dev/shared/share/payload";

/**
 * `--strip-metadata`: ask the API (migration 0183) to serve photos through the
 * link without their EXIF/XMP/IPTC - GPS position, camera, capture time. The
 * stored file is untouched; only what leaves through the link changes. Sent
 * only when the flag is present, so every existing invocation builds the body
 * it always did.
 */
export function applyStripMetadataFlag(body: Record<string, unknown>, flags: Record<string, string>): Record<string, unknown> {
    if (flags["strip-metadata"] !== undefined) body.strip_metadata = true;
    return body;
}

/**
 * The body for POST /api/{files,folders}/:id/share-email, built by the same
 * shared builder the desktop app and the extension use - `emails[]` plus an
 * explicit `restrict_to_recipients`, never the legacy singular `email`.
 * `--email` takes one address or a comma-separated list; `--restrict` makes
 * the link open only for those addresses (each proves their inbox with a code).
 */
export function buildShareEmailFlagsBody(target: ShareTarget, flags: Record<string, string>): Record<string, unknown> {
    return buildShareEmailBody({
        target,
        emails: splitEmails(flags.email),
        message: flags.message,
        password: flags.password || null,
        restrictToRecipients: flags.restrict !== undefined,
        stripMetadata: flags["strip-metadata"] !== undefined,
    });
}

/** `--email a@b.com,c@d.com` -> both addresses, blanks dropped. */
export function splitEmails(raw: string | undefined): string[] {
    return (raw ?? "").split(",").map(e => e.trim()).filter(e => e.length > 0);
}
