/**
 * API guide recipe schema types — the richer `ApiGuide extends Guide` shape.
 *
 * The projection slice (Guide) lives in guide-loader.ts; this file owns the
 * recipe slice (apiHost, operations, auth, pagination, responseShape) that
 * host consumes internally and never crosses to portal.
 */

import type { Guide } from "./guide-loader.js";

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

/**
 * Global fallback ceiling for `gatherAll` when a guide declares no
 * `gatherAllMax`. Prevents self-DoS against a 100k-item paginator.
 * ponytail: tune per-domain when a real guide hits the ceiling.
 */
export const GATHER_ALL_MAX_FALLBACK = 1000;

/**
 * The schema version of the guide recipe format. Metadata-only attribution:
 * it is surfaced on the parsed guide but NEVER gates/warns/alters parse
 * (see __tests__/schema-version.test.ts). Absent frontmatter defaults to the
 * semantic 0. Bumped to 1 at lockstep (a label change, not a break).
 */
export const GUIDE_SCHEMA_VERSION = 0 as const;

/** Auth strategies recognized by the schema (the seam). v1 realizes `none` and `static-key`; `oauth2` is rejected at parse. */
export const KNOWN_AUTH_KINDS: ReadonlySet<string> = new Set([
	"none",
	"static-key",
	"oauth2",
]);

// ═══════════════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════════════

export type AuthKind = "none" | "static-key" | "oauth2";

export interface AuthConfig {
	kind: AuthKind;
	/** Extra headers merged into every request (e.g. `X-Api-Key: DEMO_KEY`). */
	headers?: Record<string, string>;
	/**
	 * static-key only: maps request header name → secret store name. Values
	 * are injected at fetch time from the secrets store; the value never
	 * enters agent context. Every referenced name must also appear in
	 * `requires` or `optional` (parser-enforced).
	 */
	secretRefs?: Record<string, string>;
	/**
	 * static-key only: maps request header name → prefix string prepended to
	 * the stored secret value before it is sent. The store holds the raw
	 * credential; the guide declares how it is presented (e.g.
	 * `Authorization: "Bearer "`). Absent = verbatim value. Every key must
	 * also appear in `secretRefs` (parser-enforced).
	 */
	headerPrefixes?: Record<string, string>;
	/**
	 * static-key only: maps query param name → secret store name.
	 * Values are injected below the agent-supplied params map at fetch time
	 * (never into it) and redacted from every surfaced URL. A param name
	 * colliding with any operation's `params` map is a parse error — the
	 * agent must not be able to supply a secretly-injected param. Every
	 * referenced name must also appear in `requires` or `optional`
	 * (parser-enforced, same rule as `secretRefs`).
	 */
	secretQueryRefs?: Record<string, string>;
	/** static-key: secret names whose absence fails the request closed before it is sent. */
	requires?: string[];
	/** static-key: secret names that add value when present but are not required. */
	optional?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// Pagination
// ═══════════════════════════════════════════════════════════════════

export type PaginationStyle =
	| "offset-limit"
	| "nextLink"
	| "cursor"
	| "page"
	| "resumptionToken"
	| "tokenBag";

export interface PaginationConfig {
	style: PaginationStyle;
	/** JSON path to the items array in each page body. Required for all styles. */
	itemsPath: string;
	/** offset-limit: the row-offset param name; page: the page-number param name. */
	pageParam?: string;
	/** offset-limit / page: the page-size param name. */
	pageSizeParam?: string;
	/** offset-limit / page: requested page size. */
	pageSize?: number;
	/**
	 * offset-limit / page: the seed value for the page param — where this
	 * API's index starts (e.g. `base: 1` for 1-based offset APIs). Used only
	 * as the pagination seed; the seed precedence is caller value → `base` →
	 * the param `default` → the style fallback (0 for offset-limit, 1 for
	 * page). Accepted but never read by the non-seeding styles.
	 */
	base?: number;
	/** nextLink: JSON path to the next-page URL. */
	nextLinkPath?: string;
	/** cursor: the cursor query param name. */
	cursorParam?: string;
	/** cursor: JSON path to the next cursor in the body. */
	cursorPath?: string;
	/** resumptionToken: the query param name to echo the opaque token into. */
	tokenParam?: string;
	/** resumptionToken: JSON path to the next token string in the body. */
	tokenPath?: string;
	/**
	 * Style-agnostic JSON path to the server's reported total count, surfaced
	 * as `serverTotal` in PaginateResult / the api-fetch footer. Guides whose
	 * APIs expose a total opt in; guides that don't simply omit it. The count
	 * is read from the first page only. Supersedes the old resumptionToken-only
	 * `completeListSizePath` (removed pre-release, not aliased).
	 */
	totalCountPath?: string;
	/** tokenBag: response keys read from each page and merged into the next request's query params. */
	continuationParams?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// Response shape
// ═══════════════════════════════════════════════════════════════════

export type ResponseFormat = "json" | "xml" | "text";
/** Response charset: "utf-8" (default) or any IANA charset name (e.g. "iso-8859-1"). Used by the transport as a fallback when the response's Content-Type header omits a charset; an explicit header charset always wins. */
export type ResponseCharset = string;

export interface ResponseShape {
	format: ResponseFormat;
	charset: ResponseCharset;
}

// ═══════════════════════════════════════════════════════════════════
// Operations
// ═══════════════════════════════════════════════════════════════════

export type ExecutorVia = "restGet" | "paginate";
export type AcceptType = string;

export interface QueryParamSpec {
	required?: boolean;
	default?: unknown;
	/** Human-readable hint surfaced to the model via api-guide (format, semantics). */
	description?: string;
}

export type DateParamFormat = "iso8601" | "yyyymmdd" | "yyyy-mm-dd";

export interface Operation {
	name: string;
	via: ExecutorVia;
	/** Relative path; `{token}` = inferred path param. */
	path: string;
	/** Request-side Accept header (json|xml|any media-type string). */
	accept: AcceptType;
	/** Query params; path params are inferred from `{token}` in `path`. */
	params: Record<string, QueryParamSpec>;
	/** Path-param names inferred from `{token}` tokens in `path`. */
	pathParams: string[];
	/**
	 * Docs-only descriptions for path-param tokens, declared as
	 * `params.<token>.description` in the recipe. Never sent as query params —
	 * the token is filled from `{token}` in `path` at call time. Surfaced to
	 * the model via api-guide only.
	 */
	pathParamDocs?: Record<string, string>;
	/**
	 * At-least-one-of constraint: at least one of these param names must be
	 * supplied. Members may not be `required: true` nor carry a `default`
	 * (both parser-enforced) — they are mutually exclusive peers, so a
	 * default would fire alongside a caller-supplied sibling and a
	 * `required` flag would defeat the group. One group per op (v1); a
	 * multi-group `requiresAnyOfGroups` upgrade is purely additive.
	 */
	requiresAnyOf?: string[];
	/**
	 * Whether this operation uses the domain's local helper (coarse, pre-call).
	 * A `true` value means call `<guidesDir>/<domain>/helper.ts` for this op.
	 */
	helper?: boolean;
	/**
	 * Whether this operation post-processes the parsed response with the
	 * domain's local helper `transform` export (post-response). A `true`
	 * value means call `<guidesDir>/<domain>/helper.ts`'s named `transform`.
	 */
	transform?: boolean;
	/** Op-level responseShape override. */
	parse?: ResponseShape;
	/** Op-level pagination override (for `via: paginate`). */
	pagination?: PaginationConfig;
	/** Param names → target date format. Applied in buildQueryParams before serialization. */
	dateParams?: Record<string, DateParamFormat>;
	/** Op-level gatherAll ceiling override. */
	gatherAllMax?: number;
	/**
	 * Forward caller-supplied params not declared in `params` onto the query
	 * string as-is. For APIs with an open param surface (Infogami
	 * `/query.json`, CKAN, OAI-PMH) where the caller supplies type-specific
	 * keys at query time. Default false: closed contract — extras are
	 * dropped so the agent gets a predictable request, not a silent miss.
	 */
	passthrough?: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// ApiGuide
// ═══════════════════════════════════════════════════════════════════

/**
 * Full API guide — recipe slice + projection slice. Host owns this type;
 * portal never imports it. The projection (`projectToGuide`) strips the
 * recipe fields and hands portal a plain `Guide`.
 */
export interface ApiGuide extends Guide {
	kind: "api";
	/**
	 * Recipe schema version (attribution, not enforcement — see
	 * GUIDE_SCHEMA_VERSION). Parsed from frontmatter `schemaVersion:`; absent
	 * stays `undefined` (semantic default 0). Never gates/warns/alters parse.
	 */
	schemaVersion?: number;
	/** Execution root: scheme + host + base path; version prefix lives here. */
	apiHost: string;
	/** Drift signal; defaulted not enforced. */
	verified: string;
	/** Optional canonical API documentation URL; surfaced to the model in api-guide. */
	docs?: string;
	/**
	 * Optional org identity across guides (catalog grouping + disambiguation).
	 * Routing-independent — never enters api-guide/api-fetch resolution (both
	 * route on `domains:`). Convention: the org's primary registrable domain.
	 * Not projected to portal (Guide has no such field).
	 */
	organization?: string;
	/**
	 * Optional one-line summary of what the API is for. Primary signal in the
	 * multi-guide disambiguation menu. Parser rejects newlines (structural);
	 * the ≤200-char cap is enforced on the api-learn write path only.
	 * Not projected to portal (Guide has no such field).
	 */
	description?: string;
	/** Per-guide gatherAll ceiling; falls back to GATHER_ALL_MAX_FALLBACK. */
	gatherAllMax: number;
	auth: AuthConfig;
	/** Top-level pagination default; operations may override. */
	pagination?: PaginationConfig;
	/** Top-level responseShape default; operations may override. */
	responseShape: ResponseShape;
	operations: Operation[];
}

// ═══════════════════════════════════════════════════════════════════
// Parse error + result
// ═══════════════════════════════════════════════════════════════════

export interface ParseError {
	/** On-disk path (load-time) or omitted (write-time). */
	file?: string;
	/** Dotted path to the failing field, e.g. "operations[1].path". */
	field: string;
	/** One-line shape description. */
	expected: string;
	/** What was actually there. */
	found: string;
	/** The failing block verbatim, for context. */
	snippet?: string;
	/** The minimal correction, when the validator can suggest one. */
	fix?: string;
}

export type ParseApiGuideResult =
	| { ok: true; guide: ApiGuide }
	| { ok: false; error: ParseError };

export interface ParseApiGuideOptions {
	/** On-disk path (load-time) — included in ParseError.file. */
	file?: string;
	/** Filename without extension — used for the shortName default. */
	filename?: string;
}

export interface MalformedGuide {
	file: string;
	filename: string;
	error: ParseError;
}

export interface LoadedApiGuides {
	guides: Record<string, ApiGuide>;
	malformed: MalformedGuide[];
}

// `Guide` (the projection-slice base type) is imported above and extended by
// `ApiGuide`; consumers import it directly from ./guide-loader.js when needed.
