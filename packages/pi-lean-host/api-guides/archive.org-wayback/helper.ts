/**
 * Wayback synthetic helper — named post-response `transform` for the
 * `transform-builtin` axis (restGet × text body). Converts the text/plain
 * CDX-style snapshot line into a lean object.
 *
 * Non-lossy: a non-string body passes through untouched.
 */

export function transform(
	data: unknown,
	_ctx: { operation: string; domain: string },
): unknown {
	if (typeof data !== "string") return data;
	const line = data.trim().split("\n")[0] ?? "";
	// CDX line: "<url> <timestamp> …"
	const parts = line.split(/\s+/);
	if (parts.length < 2) return data;
	const [url, timestamp] = parts as [string, string];
	return { url, timestamp, raw: line };
}
