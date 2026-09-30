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
