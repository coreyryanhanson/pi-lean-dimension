/**
 * BOE param helper — transforms caller-friendly params into the shapes
 * the BOE open-data API actually expects.
 *
 * Helper contract:
 *   (params, ctx) => params
 *
 * Transforms:
 *  - `fecha`: ISO date (YYYY-MM-DD) → `aaaammdd` (YYYYMMDD) — path param
 *    that core `dateParams` can't reach (only applies to query params).
 *  - `query`: a plain search string → BOE's JSON query DSL
 *    (`{"query":{"query_string":{"query":"texto:<term>"}}}`).
 *    A value that already looks like a JSON object is passed through
 *    verbatim so callers can use the full DSL (field-specific search,
 *    `range`, `sort`). See `api-guides/boe.es/debug-notes.md` →
 *    "query param contract" for why a bare string 500s.
 *
 * `from`/`to` date conversion is handled by the core `dateParams`
 * feature (declared on listConsolidada in guide.md).
 *
 * Place this file at api-guides/boe.es/helper.ts (alongside guide.md)
 * to use it alongside the boe.es guide.
 */

// ponytail: only `fecha` remains in the helper — `from`/`to` are handled
// by core `dateParams` on the operation. `fecha` is a path param so core
// can't reach it.
const DATE_PARAMS = new Set(["fecha"]);

/**
 * Convert an ISO date string (YYYY-MM-DD) to BOE format (YYYYMMDD).
 * Returns the original value if it doesn't look like an ISO date.
 * Only used for `fecha` (path param) — `from`/`to` are core `dateParams`.
 */
function toBoeDate(value: unknown): string {
	if (typeof value !== "string") return String(value ?? "");

	// Already in aaaammdd format — pass through.
	if (/^\d{8}$/.test(value)) return value;

	// ISO format: YYYY-MM-DD or YYYYMMDD.
	const match = value.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
	if (match) {
		return `${match[1]}${match[2]}${match[3]}`;
	}

	return value;
}

/**
 * Convert a `query` value into BOE's required JSON query DSL.
 *
 * BOE's `listConsolidada` `query` param is typed `object` in their docs:
 * it must be a URL-encoded JSON string of shape
 *   {"query":{"query_string":{"query":"<dsl>"}},"sort":[...]}
 * where `<dsl>` is a non-empty `field:value` expression. A bare string
 * like `"crisis"` makes BOE try `JSON.parse("crisis")` and return
 * `500 Server error - Code: 109`.
 *
 * Rules:
 *  - Empty/missing → left as-is (omitted from params, so not sent).
 *  - A caller-supplied OBJECT (the natural shape from api-fetch params)
 *    → serialized, so power users can pass the full DSL (`range`, `sort`,
 *    field-specific search) as a real JS object. If the object already has
 *    a top-level `query` key it is the full DSL and passes through verbatim;
 *    otherwise it is treated as the inner query content and wrapped as
 *    `{query: <obj>}` — so the common mistake of passing
 *    `{query_string:{...}}` (missing the outer `query` wrapper) is repaired
 *    instead of producing BOE's `400 formato no soportado`.
 *  - A string that already looks like a JSON object (starts with `{`)
 *    → passed through verbatim (same, for callers who build the string).
 *  - Plain string → wrapped as `texto:<term>` full-text search.
 *    Multi-word terms are quoted so phrase search works
 *    (`texto:"crisis economica"`); a bare space returns no hits.
 */
function toBoeQuery(value: unknown): string {
	// Caller supplied the DSL as a real object. If it already has the
	// top-level `query` key it's the full DSL → serialize verbatim.
	// Otherwise it's the inner query content (the natural mistake:
	// `{query_string:{...}}` without the outer `query` wrapper) → wrap it.
	// Without object handling at all, String(value) would yield
	// "[object Object]" and the plugin would ship `texto:[object Object]`.
	if (typeof value === "object" && value !== null) {
		const full = "query" in value ? value : { query: value };
		return JSON.stringify(full);
	}
	const s = typeof value === "string" ? value : String(value ?? "");
	if (s === "") return s;
	if (s.trim().startsWith("{")) return s; // caller supplied the full DSL as a string
	// ponytail: a term containing a literal `"` would yield a malformed quoted
	// phrase; BOE's escape syntax is undocumented, so we don't guess. The
	// status-check fix surfaces the resulting 500 cleanly instead of as
	// "Invalid JSON". Upgrade: escape once BOE documents quote escaping.
	const term = s.includes(" ") ? `"${s}"` : s;
	return JSON.stringify({
		query: { query_string: { query: `texto:${term}` } },
	});
}

export default function boeParamHelper(
	params: Record<string, unknown>,
	_ctx: { operation: string; domain: string },
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, val] of Object.entries(params)) {
		if (DATE_PARAMS.has(key)) {
			result[key] = toBoeDate(val);
		} else if (key === "query") {
			result[key] = toBoeQuery(val);
		} else {
			result[key] = val;
		}
	}

	return result;
}
