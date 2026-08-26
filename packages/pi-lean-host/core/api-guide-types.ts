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
 * semantic 0. Bumped to 1 at the v1 auth-type reshape (0.5.0) — a breaking
 * TS-type + YAML-shape change to `AuthConfig`, not a parse-behavior break.
 */
export const GUIDE_SCHEMA_VERSION = 1 as const;

/** Auth strategies recognized by the schema (the seam). v1 realizes `none`, `static-key`, and `oauth2`. */
export const KNOWN_AUTH_KINDS: ReadonlySet<string> = new Set([
	"none",
	"static-key",
	"oauth2",
]);

export type AuthKind = "none" | "static-key" | "oauth2";

/**
 * A single secret reference — self-contained. Availability is a property of
 * THIS ref (default: required, fail-closed when absent), not a separate
 * roster. `prefix` folds the old top-level `headerPrefixes` inline. Shared by
 * `StaticKeyAuth` and `OAuth2Auth` (for oauth2 the map key is a FORM FIELD
 * NAME, not a header name — see `validateOAuth2`).
 */
export interface SecretRef {
	/** Store name (provisioned via /api secrets <domain>). */
	secret: string;
	/** Prefix prepended to the stored value at resolution time (e.g. "Bearer "). */
	prefix?: string;
	/** Default false — absent → fail-closed before the request. */
	optional?: boolean;
}

export interface NoneAuth {
	kind: "none";
	/** Extra headers merged into every request (e.g. `X-Api-Key: DEMO_KEY`). */
	headers?: Record<string, string>;
}

export interface StaticKeyAuth {
	kind: "static-key";
	/** Extra headers merged into every request (e.g. `X-Api-Key: DEMO_KEY`). */
	headers?: Record<string, string>;
	/**
	 * Maps request header name → secret ref. Values are injected at fetch
	 * time from the secrets store; the value never enters agent context.
	 */
	secretRefs?: Record<string, SecretRef>;
	/**
	 * Maps query param name → secret ref. Values are injected below the
	 * agent-supplied params map at fetch time (never into it) and redacted
	 * from every surfaced URL. A param name colliding with any operation's
	 * `params` map is a parse error — the agent must not be able to supply a
	 * secretly-injected param.
	 */
	secretQueryRefs?: Record<string, SecretRef>;
}

export type OAuth2Grant = "client_credentials" | "authorization_code";
export type OAuth2ParamStyle = "bearer-header" | "query";
export type OAuth2TokenEndpointAuthMethod =
	| "client_secret_basic"
	| "client_secret_post"
	| "none";

export interface OAuth2Auth {
	kind: "oauth2";
	grant: OAuth2Grant;
	/** Token endpoint (POST — the only non-GET host makes, auth plumbing). */
	tokenUrl: string;
	clientId: string;
	/**
	 * Reuses the nested `SecretRef` shape. For oauth2 the map key is a FORM
	 * FIELD NAME (e.g. "client_secret"), not a header name. `client_secret`
	 * is required for `client_credentials`, optional for `authorization_code`
	 * (PKCE apps have no secret) — parser-enforced in `validateOAuth2`.
	 */
	secretRefs?: Record<string, SecretRef>;
	/** Static scope list declared in the guide — no runtime picker. */
	scopes?: string[];
	/** Default bearer-header. `query` sends `?access_token=…` (RFC 6750 §2.3). */
	paramStyle?: OAuth2ParamStyle;
	/** How the client authenticates at the token endpoint. Default client_secret_post. */
	tokenEndpointAuthMethod?: OAuth2TokenEndpointAuthMethod;
	/** auth-code only (parser-enforced present iff grant === "authorization_code"). */
	authorizeUrl?: string;
	/** auth-code only. */
	redirectUri?: string;
	/** auth-code only (parser-enforced true). */
	pkce?: boolean;
	/** Optional revocation endpoint. */
	revokeUrl?: string;
}

export type AuthConfig = NoneAuth | StaticKeyAuth | OAuth2Auth;

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

/**
 * Warning channel for load-time diagnostics — `ctx.ui.notify` when the
 * caller has a UI context, else `console.warn`. The loader defaults to
 * `console.warn` so pure call sites (and tests) stay unchanged; the
 * `session_start` handler passes `ctx.ui.notify` so the migration banner
 * and per-guide warnings render through the Text component (wraps long
 * lines, honors newlines) instead of raw stderr (truncates + merges with
 * the status bar).
 */
export type NotifyFn = (
	message: string,
	type?: "info" | "warning" | "error",
) => void;

// `Guide` (the projection-slice base type) is imported above and extended by
// `ApiGuide`; consumers import it directly from ./guide-loader.js when needed.
