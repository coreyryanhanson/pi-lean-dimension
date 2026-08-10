/**
 * en.wikipedia.org-action post-response transform — zips the MediaWiki
 * `action=opensearch` bare positional array into row objects:
 * `[searchTerm, [titles], [descriptions], [urls]]` →
 * `[{ title, description, url }, …]`.
 *
 * Transform contract:
 *   (data, ctx) => unknown
 *
 * Declared on `openSearch` via `transform: true` in guide.md. Loaded by
 * `loadTransform` (no pre-call params needed), invoked by the restGet
 * hookpoint; a throw falls back to the raw array with a warning (graceful,
 * no disable). Pure function — no default export.
 */
export function transform(
	data: unknown,
	_ctx: { operation: string; domain: string },
): unknown {
	if (!Array.isArray(data) || data.length < 2) return data;
	const [, titles, descriptions, urls] = data as unknown[];
	if (!Array.isArray(titles)) return data;
	const titleList = titles as unknown[];
	const descriptionList = Array.isArray(descriptions)
		? (descriptions as unknown[])
		: [];
	const urlList = Array.isArray(urls) ? (urls as unknown[]) : [];
	return titleList.map(
		(title, i): Record<string, unknown> => ({
			title,
			description: descriptionList[i] ?? null,
			url: urlList[i] ?? null,
		}),
	);
}
