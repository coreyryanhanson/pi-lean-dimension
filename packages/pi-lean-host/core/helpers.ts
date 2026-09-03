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
import { scrubSecretValues } from "./auth.js";
import { serverMessage, isPlanGated } from "./status-hint.js";
import {
	fetchUrl,
	redactSecretParams,
	type FetchOptions,
} from "./transport.js";
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
 * `secretParamNames`: the query-param names that are code-injected from
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
				typeof val === "object" && val !== null ? JSON.stringify(val) : String(val);
		}
	}

	// At-least-one-of constraint: at least one group member must be supplied.
	// Members can't be `required` or carry a `default` (parser-enforced), so
	// this is the only guard the group needs — same fail-closed seam as the
	// per-param `required` check above. Both api-fetch and /api verify route
	// through here (resolveOpForExecution → restGet/paginate), so one guard
	// covers both call sites.
	if (operation.requiresAnyOf && operation.requiresAnyOf.length > 0) {
		const satisfied = operation.requiresAnyOf.some(
			(name) => params[name] !== undefined,
		);
		if (!satisfied) {
			throw new HelperError(
				"params.requiresAnyOf",
				`Missing one of: ${operation.requiresAnyOf.join(", ")}`,
				`at least one of: ${operation.requiresAnyOf.join(", ")}`,
				"none supplied",
			);
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
			// A secretQueryRefs param name is code-injected below the map —
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
 * Tokenize a JSON path into key/index segments in a single pass.
 *
 * - Dot segments split on `.` as before (unquoted legacy paths parse
 *   identically to the old regex-rewrite tokenizer).
 * - Numeric brackets `[3]` become index segments.
 * - Quoted brackets `['@odata.nextLink']` / `["@odata.nextLink"]` become
 *   ATOMIC key segments — the dot inside is part of the key name, not a
 *   separator. The old rewrite turned the quoted segment into `.nextLink`
 *   and silently missed the literal key.
 *
 * Syntax limits (documented, not handled): a quoted segment's content may
 * not contain `]` or a quote character — either ends the capture. So
 * `['a]b']` does NOT resolve (it accidentally resolved under the legacy
 * regex; a miss is the acceptable outcome for a pathological key).
 *
 * Returns null for a malformed path (unterminated bracket, non-numeric
 * unquoted bracket, `[-0]`) — the caller resolves that to `undefined`, never
 * a silent wrong match.
 */
function tokenizeJsonPath(path: string): string[] | null {
	const s = path.replace(/^\$\.?/, "");
	const parts: string[] = [];
	let buf = "";
	let i = 0;
	const flush = () => {
		if (buf.length > 0) parts.push(buf);
		buf = "";
	};
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === ".") {
			flush();
			i++;
		} else if (ch === "[") {
			flush();
			i++;
			const q = s[i];
			if (q === "'" || q === '"') {
				// Quoted segment: atomic key, dots included. Content ends at the
				// closing quote (which must be followed by `]`); `]` or a quote
				// inside the content is a syntax limit → malformed.
				i++;
				let content = "";
				while (i < s.length && s[i] !== q && s[i] !== "]") {
					content += s[i];
					i++;
				}
				if (i >= s.length || s[i] !== q || s[i + 1] !== "]") return null;
				parts.push(content);
				i += 2;
			} else {
				// Unquoted bracket: numeric index, optionally negative (`[3]`, `[-1]`).
				let neg = false;
				if (s[i] === "-") {
					neg = true;
					i++;
				}
				let digits = "";
				while (i < s.length && s[i]! >= "0" && s[i]! <= "9") {
					digits += s[i];
					i++;
				}
				if (digits.length === 0 || s[i] !== "]") return null;
				// Reject `[-0]`/`[-00]`: parseInt yields -0 and `-0 < 0` is false in
				// JS, so the resolver's negative guard would never fire and `[-0]`
				// would silently match element 0.
				if (neg && /^0+$/.test(digits)) return null;
				parts.push((neg ? "-" : "") + digits);
				i++;
			}
		} else {
			buf += ch;
			i++;
		}
	}
	flush();
	return parts;
}

/**
 * Resolve a simple dot-delimited JSON path against an object.
 * Supports `data.items`, `resultados[0].campo`, negative array indexes
 * addressing from the end (`results[-1].id`), `$.items` prefix, and
 * quoted-bracket atomic keys for dot-containing names (`['@odata.nextLink']`).
 *
 * Returns `unknown` by design — the value at an arbitrary JSON path has no
 * named domain type until the caller knows the path they asked for.
 */
// pi-lens-ignore: ast-grep:no-unknown-returns
export function resolveJsonPath(obj: unknown, path: string): unknown {
	const parts = tokenizeJsonPath(path);
	if (parts === null) return undefined; // malformed path → miss, never a wrong match
	if (parts.length === 0) return obj;

	let current: unknown = obj;
	for (const part of parts) {
		if (current === null || typeof current !== "object") return undefined;
		if (Array.isArray(current)) {
			const idx = parseInt(part, 10);
			if (isNaN(idx)) return undefined;
			// Negative index addresses from the end; out of bounds → miss.
			const j = idx < 0 ? idx + current.length : idx;
			if (j < 0 || j >= current.length) return undefined;
			current = current[j];
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
	// Strip element-name prefixes (message:GenericData → GenericData) so
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
 * Returns `unknown` by design — an arbitrary API response body has no named
 * domain type; callers resolve JSON paths or run transforms against it.
 *
 * @param body    The response body string (correctly decoded).
 * @param shape   The response shape (format dictates XML vs JSON parsing).
 * @returns       Parsed JSON value or XML-converted object.
 */
// pi-lens-ignore: ast-grep:no-unknown-returns
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
 * `paginate` call site and the guide schema.
 */
function checkAuth(auth: ApiGuide["auth"]): void {
	switch (auth.kind) {
		case "none":
		case "static-key":
		case "oauth2":
			return;
		default: {
			// Exhaustiveness: a future fourth kind is a compile error here.
			const _exhaustive: never = auth;
			throw new HelperError(
				"auth.kind",
				`Auth kind "${_exhaustive}" is not supported in this version`,
				"one of: none | static-key | oauth2",
				String(_exhaustive),
			);
		}
	}
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
	secretQueryParamNames?: Set<string>,
): ReturnType<typeof fetchUrl> {
	const opts: FetchOptions = { headers: { accept, ...extraHeaders } };
	if (fresh !== undefined) opts.fresh = fresh;
	if (guardRedirects) opts.guardRedirects = true;
	if (fallbackCharset) opts.fallbackCharset = fallbackCharset;
	if (secretHeaderNames) opts.secretHeaderNames = secretHeaderNames;
	if (hasQuerySecret) opts.hasQuerySecret = true;
	if (secretQueryParamNames) opts.secretQueryParamNames = secretQueryParamNames;
	return fetchUrl(url, opts);
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

	// Output-channel audit: scrub known store-injected secret values from the
	// error excerpt so a 401 body echoing an auth header can't leak the key
	// into agent context.
	const scrubbed = scrubSecretValues(result.body, secretValues);
	// Cap the raw body to avoid flooding the error output.
	let message = scrubbed.slice(0, 500);
	// Try to extract <text> from BOE-style XML error bodies.
	const textMatch = scrubbed.match(/<text>([\s\S]*?)<\/text>/i);
	if (textMatch) {
		message = textMatch[1]!.trim();
	}

	// 403 + structured JSON: surface the server's own reason and flag
	// plan-gating so a "plan doesn't support this endpoint" reads as a
	// key/subscription limitation, not a recipe bug. Same classifier as
	// api-probe — one implementation, two call sites. Parses the scrubbed
	// body (full, for the best chance the JSON is intact), never the raw one.
	// Unlike probe, fetch has no auth context, so it only adds the
	// plan-gating hint — no "auth configured correctly" claim.
	if (result.status === 403) {
		const reason = serverMessage(scrubbed);
		if (reason) {
			message = isPlanGated(scrubbed)
				? `${reason} (plan/subscription limitation on the key, not the recipe)`
				: reason;
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
	/** Store-injected secret query params — appended below the agent params map. */
	secretQueryParams?: Record<string, string>;
	/** The injected query-param names — redacted from every surfaced URL. */
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
	// injected names are tracked for cross-domain redirect stripping. oauth2
	// carries no literal headers (the resolved Bearer token arrives via
	// opts.authHeaders).
	const literalHeaders =
		guide.auth.kind === "oauth2" ? undefined : guide.auth.headers;
	const extraHeaders = { ...literalHeaders, ...opts?.authHeaders };

	// 4. Build URL. Secret query params are injected BELOW the
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
		opts?.secretQueryParamNames,
	);

	// 7. Check HTTP status before attempting to parse the body.
	// This turns "Invalid JSON response: <?xml..." into a clean
	// "Unexpected HTTP 400: El parámetro fecha..." message. Secret values are
	// scrubbed from the error excerpt so an auth-echo body can't leak a key.
	// The URL stored on the error object is the REDACTED one (computed
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
		...(transformWarning === undefined ? {} : { transformWarning }),
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
	/** Store-injected secret query params — appended below the agent params map. */
	secretQueryParams?: Record<string, string>;
	/** The injected query-param names — redacted from every surfaced URL. */
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
	// redirect stripping. oauth2 carries no literal headers (the resolved
	// Bearer token arrives via opts.authHeaders).
	const literalHeaders =
		guide.auth.kind === "oauth2" ? undefined : guide.auth.headers;
	const extraHeaders = { ...literalHeaders, ...opts?.authHeaders };

	// State for the styles.
	let cursor: string | undefined;
	let nextUrl: string | undefined;
	let page: number | undefined;
	let token: string | undefined;
	let tokenBag: Record<string, string> | undefined;

	const style = pagCfg.style;

	// Seed offset/page params.
	if (style === "offset-limit" || style === "page") {
		// Caller value, else `pagination.base` (where this API's index
		// starts), else the recipe's declared default for this page param,
		// else the style's framework default: 0 for offset-limit (row
		// offsets start at 0) and 1 for page (nearly all page-indexed APIs are
		// 1-based; a rare 0-based page API overrides with
		// `base: 0` or `params: { page: { default: 0 } }`).
		const fallback = style === "page" ? 1 : 0;
		const rawPage =
			params[pagCfg.pageParam!] ??
			pagCfg.base ??
			operation.params[pagCfg.pageParam!]?.default ??
			fallback;
		page = typeof rawPage === "number" ? rawPage : parseInt(String(rawPage), 10);
		if (isNaN(page)) page = fallback;
	}

	// Compute effective params once — used for both per-page building and result transparency.
	// Agent-supplied only (secret param names excluded, incl. passthrough).
	const secretParamNames = opts?.secretQueryParamNames ?? new Set<string>();
	const effectiveParams = buildQueryParams(operation, params, secretParamNames);

	// Resolve the effective page size once for the seeding styles — the
	// caller's value, else the op's declared default (both already folded into
	// effectiveParams), else pagCfg.pageSize, else 50. Used for the per-page
	// pageSizeParam set AND the offset-limit advance, so a caller-supplied
	// size is honored end-to-end (the row-offset increment must match the size
	// the server honored, or pages overlap/skip).
	let effectivePageSize: number | undefined;
	if (style === "offset-limit" || style === "page") {
		const rawSize =
			pagCfg.pageSizeParam === undefined
				? undefined
				: (params[pagCfg.pageSizeParam] ?? effectiveParams[pagCfg.pageSizeParam]);
		effectivePageSize =
			rawSize === undefined ? (pagCfg.pageSize ?? 50) : Number(rawSize);
		if (isNaN(effectivePageSize)) effectivePageSize = 50;
	} else if (style === "cursor") {
		// Terminal fallback for cursor is OMIT (server default applies) — no
		// fabricated 50 like offset-limit (which needs a real number to advance
		// row offsets; cursor's position comes from the response cursor). Seed
		// effectiveParams (not pageParams — rebuilt per iteration) so
		// result.params stays honest about what was sent.
		if (
			pagCfg.pageSizeParam !== undefined &&
			pagCfg.pageSize !== undefined &&
			params[pagCfg.pageSizeParam] === undefined &&
			effectiveParams[pagCfg.pageSizeParam] === undefined
		) {
			effectiveParams[pagCfg.pageSizeParam] = String(pagCfg.pageSize);
		}
	}
	// Secret query params injected below the agent map on every page's fetch URL.
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
			pageParams[pagCfg.pageParam!] = String(page);
			// effectivePageSize is always resolved (a number) in this branch.
			if (pagCfg.pageSizeParam) {
				pageParams[pagCfg.pageSizeParam] = String(effectivePageSize);
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
			// Append secret query params below the agent-supplied page params.
			url = buildUrl(apiHost, resolvedPath, {
				...pageParams,
				...secretParams,
			});
		}

		// Every surfaced URL (incl. a server-supplied nextUrl that may
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
			opts?.secretQueryParamNames,
		);

		// Check HTTP status before attempting to parse. Secret values scrubbed
		// from the error excerpt (output-channel audit). The URL stored on
		// the error object is redacted, computed upstream of checkResponseStatus.
		checkResponseStatus(
			{ ...result, url: redactSecretParams(url, secretParamNames) },
			opts?.secretValues,
		);

		// Parse.
		const data = parseResponse(result.body, shape);

		// Extract the server's reported total from the first page that resolves
		// one — before the empty-page break below, so a zero-result page that
		// still carries the count (e.g. `total_count: 0`) surfaces it rather
		// than losing it to the early `break`. Accepts a number directly or a
		// numeric string (coerced via Number()); a page that misses the path
		// leaves it undefined and later pages can still supply it.
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
		// Normalize a single XML record (or scalar) into an array so the
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

		// hasMorePath done-flag (style-agnostic).
		// Sits after the ceiling checks so ceilingHit still wins when both fire
		// on the same page. The undefined carve-out is fail-open: a missing or
		// typo'd path never stops the walk (pre-existing exhaustion semantics
		// apply); a RESOLVED falsy value stops cleanly. Plain truthiness, no
		// coercion — the string "false" advances by design.
		if (pagCfg.hasMorePath !== undefined) {
			const v = resolveJsonPath(data, pagCfg.hasMorePath);
			if (v !== undefined && !v) break;
		}

		// Determine next page.
		const advanced = advancePagination(
			style,
			pagCfg,
			data,
			page,
			effectivePageSize,
		);

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
		...(serverTotal === undefined ? {} : { serverTotal }),
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
	effectivePageSize?: number,
): PaginationState | null {
	if (style === "offset-limit") {
		// Row-offset semantics: the API skips `offset` items, so the next page
		// must advance by the effective page size (caller value → op default →
		// cfg.pageSize → 50) — the size actually sent — not by 1 (a +1 advance
		// re-reads the same rows and overlaps pages) and not by a stale
		// pageSize (overlaps/skips when the caller overrides the size). APIs
		// whose param is a true page index use style: page, which keeps the +1
		// advance.
		return {
			page: (prevPage ?? 0) + (effectivePageSize ?? cfg.pageSize ?? 50),
		};
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
		// Numeric cursors coerce to strings (tokenBag-style) BEFORE the
		// type/falsy check — a numeric 0 must advance like string "0", not die
		// at !next. nextLink stays string-strict (a numeric "next URL" is
		// garbage); booleans/objects don't coerce.
		const raw = resolveJsonPath(data, cfg.cursorPath!);
		const next = typeof raw === "number" ? String(raw) : raw;
		if (!next || typeof next !== "string") return null;
		return { cursor: next };
	}

	if (style === "resumptionToken") {
		// No !next guard here by design — "" and missing are exhaustion.
		const raw = resolveJsonPath(data, cfg.tokenPath!);
		const t = typeof raw === "number" ? String(raw) : raw; // coercion, before the check
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
			// Wire param = last dot segment, with any quoted-bracket dress
			// stripped UNCONDITIONALLY (before the dot check): a quoted
			// non-dotted key like "['next']" (no dot → pop is a no-op) would
			// otherwise wire the bracketed junk as the param name.
			const param = key
				.split(".")
				.pop()!
				.replace(/^\[['"]?/, "")
				.replace(/['"]?\]$/, "");
			collected[param] = String(v);
		}
		return Object.keys(collected).length > 0 ? { tokenBag: collected } : null;
	}

	return null;
}
