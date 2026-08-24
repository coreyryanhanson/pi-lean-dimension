/**
 * Shared path-templating utilities.
 *
 * Owned as a single module (not duplicated across helpers.ts, api-probe.ts,
 * and parse-api-guide.ts) so the executor (`restGet`/`paginate`), the
 * authoring tool (`api-probe`), and the parser share one implementation.
 *
 * - `extractPathTokens` — pull `{token}` names out of a templated path.
 * - `fillPathTemplate` — substitute `{token}` placeholders from params.
 * - `joinUrl` — join a base host + path + query string into a full URL.
 * - `assertSafeDomain` — reject a domain that could escape the guides dir.
 */

/** Extract `{token}` names from a templated path, in order, deduplicated. */
export function extractPathTokens(path: string): string[] {
	const out: string[] = [];
	for (const m of path.matchAll(/\{(\w+)\}/g)) {
		const token = m[1];
		if (token && !out.includes(token)) out.push(token);
	}
	return out;
}

/**
 * Replace `{token}` placeholders in `path` with `encodeURIComponent`'d
 * values from `params`. Tokens absent from `params` fall through to
 * `onMissing` (default: keep the `{token}` literal — useful for probing a
 * not-yet-filled path). Execution callers pass an `onMissing` that throws.
 */
export function fillPathTemplate(
	path: string,
	params: Record<string, unknown>,
	onMissing: (token: string) => string = (token) => `{${token}}`,
): string {
	return path.replace(/\{(\w+)\}/g, (_, token) => {
		const val = params[token];
		if (val === undefined) return onMissing(token);
		return encodeURIComponent(String(val));
	});
}

/**
 * Join a base host, a (possibly leading-`/`) path, and an already-built
 * query string into a full absolute URL.
 */
export function joinUrl(baseHost: string, path: string, query: string): string {
	const base = baseHost.endsWith("/") ? baseHost : `${baseHost}/`;
	const rel = path.startsWith("/") ? path.slice(1) : path;
	const url = new URL(rel, base).toString();
	if (!query) return url;
	const sep = url.includes("?") ? "&" : "?";
	return `${url}${sep}${query}`;
}

/**
 * Reject a `domain` that could escape the guides dir via path traversal.
 *
 * Domains are used in `join(guidesDir, domain, ...)` for helper lookups
 * and guide writes. A user-typed `/api helpers ../../foo` or an agent
 * `api-learn({domain: "../x"})` must not read or write outside the
 * guides dir. Returns the domain if safe, throws otherwise.
 */
export function assertSafeDomain(domain: string): string {
	// A safe domain is a single path segment: no separators, no NUL,
	// and not "."/".." (self/parent). Anything else is a literal dir name.
	if (
		domain.length === 0 ||
		domain.includes("/") ||
		domain.includes("\\") ||
		domain.includes("\0") ||
		domain === "." ||
		domain === ".."
	) {
		throw new Error(
			`Invalid domain '${domain}': must be a single path segment with no '/', '\\', or '..'.`,
		);
	}
	return domain;
}

/**
 * Slugify a guide `shortName` into the safe single path segment that names
 * its identity folder (`<guidesDir>/<slug(shortName)>/guide.md`). Lowercase;
 * replace every run of non-`[a-z0-9-]` chars with `-`; collapse repeated `-`;
 * strip leading/trailing `-`. The result is passed through `assertSafeDomain`
 * as the single safety guard (it already rejects `/`, `\`, `\0`, `.`, `..`,
 * and empty), so domains and slugs share one safety surface. After the
 * transform the only reachable failure is empty (an empty or all-symbol
 * `shortName`), so the throw is wrapped with a prescriptive message that
 * names `shortName` rather than `domain`.
 */
export function slug(shortName: string): string {
	const s = shortName
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	try {
		return assertSafeDomain(s);
	} catch {
		throw new Error(
			`Invalid shortName '${shortName}': must slug to a non-empty directory name (lowercase letters, digits, and '-').`,
		);
	}
}
