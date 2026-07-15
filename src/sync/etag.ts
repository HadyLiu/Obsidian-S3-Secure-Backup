/**
 * Parse S3/R2 ETag into a lowercase hex MD5 when the object is single-part.
 * Multipart ETags contain a hyphen and cannot be compared as MD5.
 */
export function etagToMd5(etag: string | undefined): string | null {
	if (!etag) {
		return null;
	}

	const stripped = etag.replace(/^"|"$/g, '').toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(stripped)) {
		return null;
	}
	return stripped;
}
