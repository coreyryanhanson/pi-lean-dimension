/** Expand shorthand Accept names: json → application/json, xml → application/xml; else pass through. */
function expandAccept(accept: string): string {
	return accept === "json"
		? "application/json"
		: accept === "xml"
			? "application/xml"
			: accept;
}

/**
 * Built-in executor helpers — the three-helper v1 set.
 *
 * `restGet`  — single-request fetch with path templating, query assembly,
 *              Accept negotiation, and auth dispatch.
 * `paginate` — paginated fetch supporting offset-limit, nextLink, cursor,
 *              and page styles; optional `gatherAll` with ceiling.
 * `parseResponse` — XML→JSON conversion with charset correction.
 *
 * Every helper returns a structured `HelperResult` or throws `HelperError`.
 */

import { XMLParser } from "fast-xml-parser";
import { ssrfGuard } from "./ssrf-guard.js";
import { fetchUrl, type FetchOptions } from "./transport.js";
import { fillPathTemplate, joinUrl } from "./path-template.js";
import type { TransformFn } from "./local-helpers.js"; // type-only — no runtime import (flat dependency direction)
import type {
	ApiGuide,
	DateParamFormat,
	Operation,
	ResponseShape,
} from "./api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Error type
// ═══════════════════════════════════════════════════════════════════

export class HelperError extends Error {
	override name = "HelperError";

	constructor(
		/** Dotted field path, e.g. "params.date" or "auth.kind". */
		public readonly field: string,
		message: string,
		/** Human-readable description of what was expected. */
		public readonly expected?: string,
		/** What was actually found. */
		public readonly found?: string,
		/** Suggested fix, if the helper can offer one. */
		public readonly fix?: string,
		/** The full resolved URL that caused the error, if known. */
		public readonly url?: string,
	) {
		super(message);
	}
}

// ═══════════════════════════════════════════════════════════════════
// Result types
// ═══════════════════════════════════════════════════════════════════

export interface RestGetResult {
	/** Full parsed response body (JSON object/array or XML-converted). */
	data: unknown;
	/** Response headers. */
	headers: Record<string, string>;
	/** The full resolved URL that was fetched. */
	url: string;
	/** Effective query params actually sent (post-defaults, post-validation). */
	params: Record<string, string>;
	/** Set when a post-response transform throws (raw `data` preserved). */
	transformWarning?: string;
}

export interface PaginateResult {
	/** Accumulated items across all fetched pages. */
	items: unknown[];
	/** Total count of items fetched (may be less than server total due to ceiling). */
	totalFetched: number;
	/**
	 * Raw (untransformed) items whose post-response transform threw. Absent
	 * when no item fails — no item is ever dropped. Total raw items processed
	 * = `items.length + failedItems.length`.
	 */
	failedItems?: unknown[];
	/** Server-reported total count from the first page (when the guide
	 * declares `totalCountPath` and it resolves to a number/numeric string). */
	serverTotal?: number;
	/** True when `gatherAllMax` ceiling halted pagination. */
	ceilingHit: boolean;
	/** Every page URL fetched (bounded by page count). */
	urls: string[];
	/** Number of pages fetched (= urls.length). */
	pages: number;
	/** Effective query params actually sent (post-defaults, post-validation). */
	params: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Strict path templating for execution — a missing `{token}` throws.
 * (The shared `fillPathTemplate` keeps missing tokens literal for probing.)
 */
function fillPathStrict(path: string, params: Record<string, unknown>): string {
	return fillPathTemplate(path, params, (token) => {
		throw new HelperError(
			`params.${token}`,
			`Missing path parameter: ${token}`,
			`a value for "{${token}}" in path "${path}"`,
			"missing",
		);
	});
}

/**
 * Build query-string params: apply defaults for query params,
 * validate required params, and exclude path params.
 *
 * `secretParamNames` (A2): the query-param names that are code-injected from
 * the secrets store. They are excluded from the returned agent-supplied map
 * AND skipped in the `passthrough` branch so an agent-supplied value can't
 * override or race the injection.
 */
function buildQueryParams(
	operation: Operation,
	params: Record<string, unknown>,
	secretParamNames?: Set<string>,
): Record<string, string> {
	const query: Record<string, string> = {};
	const pathParamSet = new Set(operation.pathParams);

	for (const [key, spec] of Object.entries(operation.params)) {
		if (pathParamSet.has(key)) continue; // already in path

		let val = params[key];

		// Apply default if not provided.
		if (val === undefined && spec.default !== undefined) {
			val = spec.default;
		}

		// Validate required.
		if (val === undefined && spec.required) {
			throw new HelperError(
				`params.${key}`,
				`Missing required query parameter: ${key}`,
				`a value for required param "${key}"`,
				"missing",
			);
		}

		if (val !== undefined) {
			// Date param normalization — convert to target format before serialization.
			if (operation.dateParams && key in operation.dateParams) {
				val = normalizeDateParam(val, operation.dateParams[key]!);
			}
			// Nested objects/arrays serialize as JSON so structured query
			// params (e.g. BOE's ES query_string DSL) reach the wire as
			// JSON, not `[object Object]`. Scalars stay as String(val).
			query[key] =
				typeof val === "object" && val !== null
					? JSON.stringify(val)
					: String(val);
		}
	}

	// `passthrough`: forward caller-supplied params not declared in the
	// recipe's `params` map onto the query string as-is. For APIs with an
	// open param surface (Infogami /query.json flat form, CKAN, OAI-PMH)
	// where the caller supplies type-specific keys at query time. Default
	// is a closed contract: extras are dropped so the agent gets a
	// predictable request, not a silent miss on an undeclared key.
	if (operation.passthrough) {
		for (const [key, val] of Object.entries(params)) {
			if (pathParamSet.has(key)) continue; // path params stay in path
			if (key in operation.params) continue; // already handled above
			// A2: a secretQueryRefs param name is code-injected below the map —
			// drop any agent-supplied value so it can't override or race it.
			if (secretParamNames && secretParamNames.has(key)) continue;
			if (val === undefined) continue;
			let v: unknown = val;
			if (operation.dateParams && key in operation.dateParams) {
				v = normalizeDateParam(v, operation.dateParams[key]!);
			}
			query[key] =
				typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
		}
	}

	return query;
}

/**
 * Normalize a date string to a target format.
 * Accepts ISO 8601 (YYYY-MM-DD or with time tail), already-target format,
 * or non-date strings (passed through as-is).
 */
export function normalizeDateParam(
	val: unknown,
	format: DateParamFormat,
): string {
	const s = typeof val === "string" ? val : String(val ?? "");
	const m = s.match(/^(\d{4})-?(\d{1,2})-?(\d{1,2})(.*)$/);
	if (!m) return s;
	const [, y, mo, d] = m;
	const mm = mo!.padStart(2, "0");
	const dd = d!.padStart(2, "0");
	if (format === "yyyymmdd") return `${y}${mm}${dd}`;
	if (format === "yyyy-mm-dd") return `${y}-${mm}-${dd}`;
	return format === "iso8601" ? `${y}-${mm}-${dd}${m[4] ?? ""}` : s;
}

/**
 * Resolve a simple dot-delimited JSON path against an object.
 * Supports `data.items`, `resultados[0].campo`, `$.items` prefix.
 */
export function resolveJsonPath(obj: unknown, path: string): unknown {
	// Normalise: strip leading $ or $., convert bracket notation.
	const normalised = path
		.replace(/^\$\.?/, "")
		.replace(/\[['"](.*?)['"]\]/g, ".$1")
		.replace(/\[(\d+)\]/g, ".$1");
	const parts = normalised.split(".").filter((p) => p.length > 0);
	if (parts.length === 0) return obj;

	let current: unknown = obj;
	for (const part of parts) {
		if (current === null || typeof current !== "object") return undefined;
		if (Array.isArray(current)) {
			const idx = parseInt(part, 10);
			if (isNaN(idx)) return undefined;
			current = current[idx];
		} else {
			current = (current as Record<string, unknown>)[part];
		}
	}
	return current;
}

// ═══════════════════════════════════════════════════════════════════
// parseResponse
// ═══════════════════════════════════════════════════════════════════

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	textNodeName: "#text",
	parseAttributeValue: true,
	trimValues: true,
	// A2: strip element-name prefixes (message:GenericData → GenericData) so
	// itemsPath/totalCountPath use stable local names across XML providers.
	removeNSPrefix: true,
});

/**
 * Parse a response body according to the guide's response shape.
 *
 * The body is already decoded to a JavaScript string by the transport
 * layer, which uses the response's Content-Type charset with the recipe's
 * `shape.charset` as a fallback when the header omits one (an explicit
 * header charset wins). `parseResponse` itself does no decoding — the
 * `charset` field is consumed by the transport, not here.
 *
 * @param body    The response body string (correctly decoded).
 * @param shape   The response shape (format dictates XML vs JSON parsing).
 * @returns       Parsed JSON value or XML-converted object.
 */
export function parseResponse(body: string, shape: ResponseShape): unknown {
	if (shape.format === "text") {
		// Raw passthrough — returned as-is, no trim (matches xml/json branches).
		return body;
	}

	if (shape.format === "xml") {
		return xmlParser.parse(body);
	}

	// JSON
	try {
		return JSON.parse(body);
	} catch (e) {
		throw new HelperError(
			"response",
			`Invalid JSON response: ${e instanceof Error ? e.message : String(e)}`,
			"valid JSON",
			body.slice(0, 200),
		);
	}
}

// ═══════════════════════════════════════════════════════════════════
// URL construction & auth dispatch
// ═══════════════════════════════════════════════════════════════════

/**
 * Construct the full URL from apiHost + operation path + query params.
 *
 * Agent-supplied URLs are not SSRF-guarded here — the guard lives in
 * `paginate`'s nextLink branch (the one place the URL comes from the
 * remote server).
 */
function buildUrl(
	apiHost: string,
	resolvedPath: string,
	query: Record<string, string>,
): string {
	return joinUrl(apiHost, resolvedPath, new URLSearchParams(query).toString());
}

/**
 * Check auth.kind and branch accordingly.
 * v1 realizes `none` and `static-key` (header injection is resolved by
 * api-fetch and passed via opts.authHeaders — the store is not read here).
 *
 * This dispatch is a deliberate seam, not dead code: keeping the field +
 * dispatch now makes the future keyed-auth build additive (a new `kind`
 * behind this same `if`/`throw`) rather than a retrofit of every `restGet`/
 * `paginate` call site and the guide schema. See
 * `docs/design/api-secrets-roadmap.md` for the build-out plan.
 */
function checkAuth(auth: ApiGuide["auth"]): void {
	const kind = auth.kind;
	if (kind === "none" || kind === "static-key") return;

	// oauth2 — unrealized seam. A parsed guide can't reach here (oauth2 is
	// rejected at parse), but guard for hand-constructed guides/tests.
	throw new HelperError(
		"auth.kind",
		`Auth kind "${kind}" is not supported in this version`,
		"one of: none | static-key",
		kind,
		"OAuth2 is not yet implemented. Use kind: none or kind: static-key.",
	);
}

/**
 * Helper to conditionally include `fresh` in FetchOptions (exactOptionalPropertyTypes).
 */
function fetchWithOpts(
	url: string,
	accept: string,
	fresh: boolean | undefined,
	extraHeaders?: Record<string, string>,
	guardRedirects?: boolean,
	fallbackCharset?: string,
	secretHeaderNames?: Set<string>,
	hasQuerySecret?: boolean,
): ReturnType<typeof fetchUrl> {
	const opts: FetchOptions = { headers: { accept, ...extraHeaders } };
	if (fresh !== undefined) opts.fresh = fresh;
	if (guardRedirects) opts.guardRedirects = true;
	if (fallbackCharset) opts.fallbackCharset = fallbackCharset;
	if (secretHeaderNames) opts.secretHeaderNames = secretHeaderNames;
	if (hasQuerySecret) opts.hasQuerySecret = true;
	return fetchUrl(url, opts);
}

/**
 * A2 output-channel audit — URL channel: redact every secret query param's
 * value to `***` in a URL for surfacing. Returns the URL unchanged when no
 * secret param names are in play (so non-secret guides never get URL-
 * normalized by this). Used at every capture point (result.url, urls[], the
 * URL stored on HelperError.url) so the real key never passes the fetch
 * layer back to the agent.
 */
export function redactSecretParams(
	url: string,
	secretParamNames?: Set<string>,
): string {
	if (!secretParamNames || secretParamNames.size === 0) return url;
	try {
		const u = new URL(url);
		for (const name of secretParamNames) {
			if (u.searchParams.has(name)) u.searchParams.set(name, "***");
		}
		return u.toString();
	} catch {
		return url;
	}
}

/**
 * Check fetch result status and throw a structured error on 4xx/5xx.
 *
 * Without this check, a non-2xx response is passed to `parseResponse`
 * which tries to JSON.parse an XML error body, producing a misleading
 * "Invalid JSON response" message.
 *
 * For XML error bodies (common in REST APIs), the `<text>` element is
 * extracted for a cleaner human message.
 */
function checkResponseStatus(
	result: {
		status: number;
		body: string;
		url?: string;
	},
	secretValues?: string[],
): void {
	if (result.status < 400) return;

	// Cap the raw body to avoid flooding the error output.
	let message = result.body.slice(0, 500);
	// Try to extract <text> from BOE-style XML error bodies.
	const textMatch = result.body.match(/<text>([\s\S]*?)<\/text>/i);
	if (textMatch) {
		message = textMatch[1]!.trim();
	}

	// Output-channel audit: scrub known store-injected secret values from the
	// error excerpt so a 401 body echoing an auth header can't leak the key
	// into agent context.
	if (secretValues && secretValues.length > 0) {
		for (const v of secretValues) {
			if (v && v.length > 0) message = message.split(v).join("***");
		}
	}

	throw new HelperError(
		"response",
		`Unexpected HTTP ${result.status}: ${message}`,
		"HTTP 2xx",
		String(result.status),
		undefined,
		result.url,
	);
}

// ═══════════════════════════════════════════════════════════════════
// restGet
// ═══════════════════════════════════════════════════════════════════

export interface RestGetOptions {
	/** Skip cache — force fresh fetch. */
	fresh?: boolean;
	/** Store-injected secret headers (kind: static-key). Merged with guide.auth.headers. */
	authHeaders?: Record<string, string>;
	/** Lowercased injected header names — stripped on cross-domain redirects. */
	secretHeaderNames?: Set<string>;
	/** Store-injected secret values — scrubbed from error bodies (output-channel audit). */
	secretValues?: string[];
	/** A2: store-injected secret query params — appended below the agent params map. */
	secretQueryParams?: Record<string, string>;
	/** A2: the injected query-param names — redacted from every surfaced URL. */
	secretQueryParamNames?: Set<string>;
}

/**
 * Execute a single `restGet` operation.
 *
 * 1. Replaces `{token}` path params from `params`.
 * 2. Assembles query params with defaults and required validation.
 * 3. Checks auth dispatch (`none` / `static-key` realized; `oauth2` rejected at parse).
 * 4. Constructs the full URL.
 * 5. Builds the Accept header.
 * 6. Fetches via the transport layer.
 * 7. Checks HTTP status — raises HelperError on 4xx/5xx.
 * 8. Parses the response based on the operation's `parse` override or
 *    the guide's `responseShape`.
 *
 * @returns The parsed response data and response headers.
 */
export async function restGet(
	apiHost: string,
	operation: Operation,
	params: Record<string, unknown>,
	guide: ApiGuide,
	opts?: RestGetOptions,
	transformFn?: TransformFn,
	dirName?: string,
): Promise<RestGetResult> {
	// Steps 1/2 unchanged: fill path, build query (agent-supplied only —
	// secret param names are excluded, incl. from the passthrough branch).
	const resolvedPath = fillPathStrict(operation.path, params);
	const secretParamNames = opts?.secretQueryParamNames ?? new Set<string>();
	const query = buildQueryParams(operation, params, secretParamNames);

	// 3. Auth dispatch.
	checkAuth(guide.auth);

	// Merge store-injected secret headers with literal auth.headers. The
	// injected names are tracked for cross-domain redirect stripping.
	const extraHeaders = { ...guide.auth.headers, ...opts?.authHeaders };

	// 4. Build URL. A2: secret query params are injected BELOW the
	// agent-supplied map — never into it — so the returned `params` stays
	// agent-supplied-only. The fetch uses the raw URL; every surfaced copy
	// (result.url, the URL stored on HelperError.url) is redacted.
	const secretParams = opts?.secretQueryParams ?? {};
	const hasQuerySecret = Object.keys(secretParams).length > 0;
	const fetchUrlRaw = buildUrl(apiHost, resolvedPath, {
		...query,
		...secretParams,
	});
	const url = redactSecretParams(fetchUrlRaw, secretParamNames);

	// 5. Build Accept header — json/xml shorthands expand; everything
	// else passes through as-is (e.g. application/atom+xml, */*).
	const accept = expandAccept(operation.accept);

	// 6. Fetch. Pass the effective shape's charset as a transport fallback
	//    for servers that omit a Content-Type charset (e.g. legacy Latin-1
	//    APIs); an explicit header charset always wins.
	const shape = operation.parse ?? guide.responseShape;
	const result = await fetchWithOpts(
		fetchUrlRaw,
		accept,
		opts?.fresh,
		extraHeaders,
		undefined,
		shape.charset,
		opts?.secretHeaderNames,
		hasQuerySecret,
	);

	// 7. Check HTTP status before attempting to parse the body.
	// This turns "Invalid JSON response: <?xml..." into a clean
	// "Unexpected HTTP 400: El parámetro fecha..." message. Secret values are
	// scrubbed from the error excerpt so an auth-echo body can't leak a key.
	// A2: the URL stored on the error object is the REDACTED one (computed
	// upstream of checkResponseStatus) so the secret never reaches the error.
	checkResponseStatus({ ...result, url }, opts?.secretValues);

	// 8. Parse response using the effective shape resolved above.
	let data = parseResponse(result.body, shape);

	// 9. Post-response transform (optional). When api-fetch supplied a
	// `transformFn` (op.transform === true), apply it. A throwing transform is
	// caught: keep the raw `data` and carry a `transformWarning` so the caller
	// can surface "⚠ Transform failed:" — the op is NOT disabled, so a
	// subsequent call re-attempts the transform.
	let transformWarning: string | undefined;
	if (transformFn) {
		try {
			data = transformFn(data, {
				operation: operation.name,
				domain: dirName ?? "",
			});
		} catch (err) {
			transformWarning = err instanceof Error ? err.message : String(err);
		}
	}

	return {
		data,
		headers: result.headers,
		url,
		params: query,
		...(transformWarning !== undefined ? { transformWarning } : {}),
	};
}

// ═══════════════════════════════════════════════════════════════════
// paginate
// ═══════════════════════════════════════════════════════════════════

export interface PaginateOptions {
	/** When true, gather items up to `gatherAllMax`. Default false. */
	gatherAll?: boolean;
	/** Max items to gather when `gatherAll` is true. Overrides guide/operation default. */
	gatherAllMax?: number;
	/** Skip cache — force fresh fetch for each page. */
	fresh?: boolean;
	/** Bypass the nextLink SSRF guard (for testing against local servers). */
	skipSsrfGuard?: boolean;
	/** Store-injected secret headers (kind: static-key). Merged with guide.auth.headers. */
	authHeaders?: Record<string, string>;
	/** Lowercased injected header names — stripped on cross-domain redirects. */
	secretHeaderNames?: Set<string>;
	/** Store-injected secret values — scrubbed from error bodies (output-channel audit). */
	secretValues?: string[];
	/** A2: store-injected secret query params — appended below the agent params map. */
	secretQueryParams?: Record<string, string>;
	/** A2: the injected query-param names — redacted from every surfaced URL. */
	secretQueryParamNames?: Set<string>;
}

/**
 * Execute a paginated operation.
 *
 * Supports six pagination styles:
 *  - `offset-limit`: advance the `offset` param by the page size (row offset).
 *  - `nextLink`: follow the `next` URL from each page response.
 *  - `cursor`: pass the cursor from each page to the next.
 *  - `page`: incrementing page number + fixed page size.
 *  - `resumptionToken`: echo an opaque token from each page into a query param.
 *  - `tokenBag`: merge a set of continuation keys from each page into the next request.
 *
 * @returns Accumulated items across all pages.
 */
export async function paginate(
	apiHost: string,
	operation: Operation,
	params: Record<string, unknown>,
	guide: ApiGuide,
	opts?: PaginateOptions,
	transformFn?: TransformFn,
	dirName?: string,
): Promise<PaginateResult> {
	const pagCfg = operation.pagination ?? guide.pagination;
	if (!pagCfg) {
		throw new HelperError(
			"pagination",
			"Cannot paginate — no pagination config in operation or guide",
			"a pagination block",
			"missing",
			"Add a pagination: block to the operation or the guide's top-level config",
		);
	}

	const gatherAll = opts?.gatherAll ?? false;
	const ceiling =
		opts?.gatherAllMax ?? operation.gatherAllMax ?? guide.gatherAllMax;
	const items: unknown[] = [];
	const failed: unknown[] = [];
	let ceilingHit = false;
	let serverTotal: number | undefined;

	// Resolve effective response shape (op-level parse or guide-level).
	const shape = operation.parse ?? guide.responseShape;
	const accept = expandAccept(operation.accept);

	// Auth dispatch — checked once up front (auth is constant per guide).
	checkAuth(guide.auth);

	// Merge store-injected secret headers with literal auth.headers once,
	// reused for every page. Injected names are tracked for cross-domain
	// redirect stripping.
	const extraHeaders = { ...guide.auth.headers, ...opts?.authHeaders };

	// State for the styles.
	let cursor: string | undefined;
	let nextUrl: string | undefined;
	let page: number | undefined;
	let token: string | undefined;
	let tokenBag: Record<string, string> | undefined;

	const style = pagCfg.style;

	// Seed offset/page params.
	if (style === "offset-limit" || style === "page") {
		// Caller value, else the recipe's declared default for this page
		// param, else the style's framework default: 0 for offset-limit (row
		// offsets start at 0) and 1 for page (nearly all page-indexed APIs are
		// 1-based; a rare 0-based page API overrides with
		// `params: { page: { default: 0 } }`).
		const fallback = style === "page" ? 1 : 0;
		const rawPage =
			params[pagCfg.pageParam!] ??
			operation.params[pagCfg.pageParam!]?.default ??
			fallback;
		page =
			typeof rawPage === "number" ? rawPage : parseInt(String(rawPage), 10);
		if (isNaN(page)) page = fallback;
	}

	// Compute effective params once — used for both per-page building and result transparency.
	// A2: agent-supplied only (secret param names excluded, incl. passthrough).
	const secretParamNames = opts?.secretQueryParamNames ?? new Set<string>();
	const effectiveParams = buildQueryParams(operation, params, secretParamNames);
	// A2: secret query params injected below the agent map on every page's fetch URL.
	const secretParams = opts?.secretQueryParams ?? {};
	const hasQuerySecret = Object.keys(secretParams).length > 0;
	const urls: string[] = [];

	while (true) {
		// Build per-page params.
		const pageParams: Record<string, string> = {};
		for (const [key, val] of Object.entries(effectiveParams)) {
			pageParams[key] = val;
		}

		if (style === "offset-limit" || style === "page") {
			pageParams[pagCfg.pageParam!] = String(page ?? 0);
			if (pagCfg.pageSizeParam) {
				pageParams[pagCfg.pageSizeParam] = String(pagCfg.pageSize ?? 50);
			}
		} else if (style === "cursor" && cursor !== undefined) {
			pageParams[pagCfg.cursorParam!] = cursor;
		} else if (style === "resumptionToken" && token !== undefined) {
			pageParams[pagCfg.tokenParam!] = token;
		} else if (style === "tokenBag" && tokenBag) {
			Object.assign(pageParams, tokenBag);
		}

		// Build URL.
		const resolvedPath = fillPathStrict(operation.path, params);

		let url: string;
		if (style === "nextLink" && nextUrl) {
			// If nextUrl is relative, resolve against apiHost.
			url = nextUrl.startsWith("http")
				? nextUrl
				: new URL(nextUrl, apiHost).toString();
		} else {
			// A2: append secret query params below the agent-supplied page params.
			url = buildUrl(apiHost, resolvedPath, {
				...pageParams,
				...secretParams,
			});
		}

		// A2: every surfaced URL (incl. a server-supplied nextUrl that may
		// already carry the secret) is redacted at the capture point.
		urls.push(redactSecretParams(url, secretParamNames));

		// NextLink guard — the URL comes from the remote server, so this is
		// the one place SSRF protection is load-bearing. `guardThisFetch`
		// both blocks the nextLink URL itself and turns on redirect-target
		// guarding in the transport layer (a malicious API can 302 a
		// nextLink to an internal host; when auth headers ship, the
		// Authorization header would attach to the redirect).
		const guardThisFetch =
			style === "nextLink" && !!nextUrl && !opts?.skipSsrfGuard;
		if (guardThisFetch) {
			const guard = ssrfGuard(url);
			if (!guard.ok) {
				const errUrl = redactSecretParams(url, secretParamNames);
				throw new HelperError(
					"url",
					`URL blocked during pagination: ${guard.reason}`,
					"a safe, public URL",
					errUrl,
					undefined,
					errUrl,
				);
			}
		}

		// Fetch.
		const result = await fetchWithOpts(
			url,
			accept,
			opts?.fresh,
			extraHeaders,
			guardThisFetch,
			shape.charset,
			opts?.secretHeaderNames,
			hasQuerySecret,
		);

		// Check HTTP status before attempting to parse. Secret values scrubbed
		// from the error excerpt (output-channel audit). A2: the URL stored on
		// the error object is redacted, computed upstream of checkResponseStatus.
		checkResponseStatus(
			{ ...result, url: redactSecretParams(url, secretParamNames) },
			opts?.secretValues,
		);

		// Parse.
		const data = parseResponse(result.body, shape);

		// Extract the server's reported total from the first page — before the
		// empty-page break below, so a zero-result page that still carries the
		// count (e.g. `total_count: 0`) surfaces it rather than losing it to the
		// early `break`. Accepts a number directly or a numeric string (coerced
		// via Number()); any other value (or an unresolved path) leaves it
		// undefined for that page and it stays unset for the whole run.
		if (serverTotal === undefined && pagCfg.totalCountPath) {
			const raw = resolveJsonPath(data, pagCfg.totalCountPath);
			if (typeof raw === "number" && Number.isFinite(raw)) {
				serverTotal = raw;
			} else if (typeof raw === "string" && raw.trim() !== "") {
				const n = Number(raw);
				if (Number.isFinite(n)) serverTotal = n;
			}
		}

		// Extract items from this page.
		let pageItems = resolveJsonPath(data, pagCfg.itemsPath);
		// A1: normalize a single XML record (or scalar) into an array so the
		// declared list path always yields an array even with one element
		// (e.g. arXiv max_results=1, PubMed retmax=1 box a single record).
		if (pageItems != null && !Array.isArray(pageItems)) {
			pageItems = [pageItems];
		}
		if (Array.isArray(pageItems)) {
			if (pageItems.length === 0) break; // empty page → exhaustion
			// Apply the post-response transform per item. A throwing transform
			// keeps the raw item in `failed` — no item is dropped. The ceiling is
			// evaluated against total raw items processed (items + failed), so
			// partial failures cannot exceed the ceiling.
			const totalProcessed = items.length + failed.length;
			const remaining = ceiling - totalProcessed;
			const toProcess =
				gatherAll && pageItems.length > remaining
					? pageItems.slice(0, remaining)
					: pageItems;
			for (const item of toProcess) {
				if (transformFn) {
					try {
						items.push(
							transformFn(item, {
								operation: operation.name,
								domain: dirName ?? "",
							}),
						);
					} catch {
						failed.push(item);
					}
				} else {
					items.push(item);
				}
			}
			if (gatherAll && pageItems.length > remaining) {
				ceilingHit = true;
				break;
			}
			if (!gatherAll) break; // default = single page; gatherAll:true walks on
		} else {
			break; // items path didn't resolve to an array → stop
		}

		// Ceiling check.
		if (gatherAll && items.length + failed.length >= ceiling) {
			ceilingHit = true;
			break;
		}

		// Determine next page.
		const advanced = advancePagination(style, pagCfg, data, page);

		if (!advanced) break;

		page = advanced.page;
		cursor = advanced.cursor;
		nextUrl = advanced.nextUrl;
		token = advanced.token;
		tokenBag = advanced.tokenBag;
	}

	return {
		items,
		totalFetched: items.length + failed.length,
		...(failed.length > 0 ? { failedItems: failed } : {}),
		...(serverTotal !== undefined ? { serverTotal } : {}),
		ceilingHit,
		urls,
		pages: urls.length,
		params: effectiveParams,
	};
}

// ═══════════════════════════════════════════════════════════════════
// Pagination advance logic
// ═══════════════════════════════════════════════════════════════════

interface PaginationState {
	page?: number;
	cursor?: string;
	nextUrl?: string;
	token?: string;
	tokenBag?: Record<string, string>;
}

function advancePagination(
	style: string,
	cfg: NonNullable<Operation["pagination"]>,
	data: unknown,
	prevPage?: number,
): PaginationState | null {
	if (style === "offset-limit") {
		// Row-offset semantics: the API skips `offset` items, so the next page
		// must advance by the page size, not by 1 (a +1 advance re-reads the
		// same rows and overlaps pages). APIs whose param is a true page index
		// use style: page, which keeps the +1 advance.
		return { page: (prevPage ?? 0) + (cfg.pageSize ?? 50) };
	}

	if (style === "page") {
		return { page: (prevPage ?? 0) + 1 };
	}

	if (style === "nextLink") {
		const next = resolveJsonPath(data, cfg.nextLinkPath!);
		if (!next || typeof next !== "string") return null;
		return { nextUrl: next };
	}

	if (style === "cursor") {
		const next = resolveJsonPath(data, cfg.cursorPath!);
		if (!next || typeof next !== "string") return null;
		return { cursor: next };
	}

	if (style === "resumptionToken") {
		const t = resolveJsonPath(data, cfg.tokenPath!);
		if (typeof t !== "string" || t === "") return null;
		return { token: t };
	}

	if (style === "tokenBag") {
		// ponytail: one resolveJsonPath call per continuation key — O(keys) per
		// page, keys ≈ 1–2 in practice. Fine. Revisit if an API emits a 50-key bag.
		// The path may be nested (e.g. "continue.rccontinue") but the param name
		// resent to the API is the last segment ("rccontinue") — matching the
		// key names inside the continuation object.
		const collected: Record<string, string> = {};
		for (const key of cfg.continuationParams ?? []) {
			const v = resolveJsonPath(data, key);
			if (v === undefined || v === null) continue;
			const param = key.includes(".") ? key.split(".").pop()! : key;
			collected[param] = String(v);
		}
		return Object.keys(collected).length > 0 ? { tokenBag: collected } : null;
	}

	return null;
}
