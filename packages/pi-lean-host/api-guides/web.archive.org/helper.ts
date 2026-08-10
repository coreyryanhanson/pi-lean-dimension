/**
 * Wayback CDX post-response transform — zips the CDX `output=json`
 * array-of-arrays (element 0 = field-name header) into row objects:
 * `[{ urlkey, timestamp, original, mimetype, statuscode, digest, length }, …]`.
 *
 * Transform contract:
 *   (data, ctx) => unknown
 *
 * Declared on `queryCdx` via `transform: true` in guide.md. Loaded by
 * `loadTransform` (no pre-call params needed), invoked by the restGet
 * hookpoint; a throw falls back to the raw array with a warning (graceful,
 * no disable). Pure function — no default export.
 */
export function transform(
	data: unknown,
	_ctx: { operation: string; domain: string },
): unknown {
	if (!Array.isArray(data) || data.length === 0) return data;
	const [header, ...rows] = data as unknown[][];
	if (!Array.isArray(header)) return data;
	const keys = header as string[];
	return rows.map((row): Record<string, unknown> => {
		const values = row as unknown[];
		return Object.fromEntries(
			keys.map((key, i): [string, unknown] => [key, values[i] ?? null]),
		);
	});
}
