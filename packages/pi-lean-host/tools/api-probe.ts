/**
 * api-probe tool definition.
 *
 * Shape-discovery for the authoring loop: fetch an exploratory path against a
 * domain's apiHost, summarize the JSON shape, suggest `via` / `itemsPath`,
 * echo a representative record id, and emit a draft YAML op block to paste
 * into `guide.md`. The author confirms — it never writes the guide.
 *
 * Pre-guide: call it with a bare URL + templated path. For an endpoint that
 * already has a guide, get the `apiHost` from `api-guide({domain})` first.
 *
 * The suggestions (via/itemsPath/draft) are advisory — the operation must
 * still be traceable to a real endpoint ("cite the source, don't invent
 * endpoints"). This tool surfaces evidence, not authority.
 *
 * Reuses the same `transport.ts` pipeline as api-fetch (UA, charset, 429
 * retry, ETag cache) — the sanctioned way to reach even WAF'd hosts.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmTokenUrl } from "../core/oauth-flow.js";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { fetchUrl, redactSecretParams } from "../core/transport.js";
import {
	extractPathTokens,
	fillPathTemplate,
	joinUrl,
} from "../core/path-template.js";
import {
	assertNoBearerCollision,
	buildSyntheticOAuth2Auth,
	hostnameOf,
	isTokenExpired,
	resolveAccessToken,
	resolveProvisionedParentDomain,
	resolveSecretHeaders,
	resolveSecretQueryParams,
	scrubSecretValues,
} from "../core/auth.js";
import { readToken } from "../core/oauth-store.js";
import { provisionedDomainsSuffix } from "../core/secrets-store.js";
import { serverMessage, isPlanGated } from "../core/status-hint.js";
import { appendFooter, contentText } from "./utils.js";
import type {
	SecretRef,
	StaticKeyAuth,
	OAuth2Grant,
} from "../core/api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface ShapeSummary {
	topLevel: "object" | "array" | "number" | "string" | "boolean" | "null";
	isArray: boolean;
	/** Top-level keys when an object (capped at 20). */
	keys: string[];
	/** Length when the body (or the items array) is an array. */
	arrayLen: number;
	/** Suggested executor. `paginate` for any list; `restGet` for singles. */
	suggestedVia: "restGet" | "paginate";
	/** `itemsPath` for `paginate` — `$` for a bare top-level array. Empty for restGet. */
	suggestedItemsPath: string;
	/** Body keys that look like pagination signals. */
	paginationMarkers: string[];
	/** First record's id-ish field, for reuse as a detail-lookup path param. */
	representativeId?: { field: string; value: string | number };
}

export interface ProbeResult {
	url: string;
	/** Final URL after redirects (equals `url` when no hop occurred). */
	finalUrl: string;
	status: number;
	ok: boolean;
	shape: ShapeSummary | null;
	/** Draft YAML operation block (empty on non-2xx / non-JSON). */
	draft: string;
	/** Truncated raw body for eyeballing. */
	raw: string;
	/** Human note (auth-required, 404, version-prefix hit, non-JSON, …). */
	note?: string;
}

export interface ProbeOptions {
	/** Accept header (default application/json). */
	accept?: string;
	/** On 404, walk the apiHost version backward (vN→v1). Default true. */
	walkVersions?: boolean;
	/**
	 * Store-backed auth injection for probing auth-gated endpoints
	 * (authoring loop). Injection fields only — no kind/requires/optional.
	 * Values resolve from the secrets store and never enter the transcript.
	 */
	auth?: {
		/** Maps header name → secret name, same direction as the guide schema. */
		secretRefs?: Record<string, string>;
		secretQueryRefs?: Record<string, string>;
		/**
		 * Header name → prefix prepended to the resolved secret value (e.g.
		 * `Authorization: "Bearer "`). The store holds the raw token; the prefix
		 * is API knowledge. Keys must be present in `secretRefs`.
		 */
		headerPrefixes?: Record<string, string>;
		/**
		 * Read the OAuth2 access token from the token store (the domain the
		 * probe resolved) and inject `Authorization: Bearer <token>` — values
		 * never enter the transcript. Bearer-header only (ponytail: query
		 * paramStyle waits for a recipe that needs it). No/expired token →
		 * the note nudges `/api oauth <domain>` and the probe proceeds
		 * unauthenticated (probe misses are never fail-closed). With mint
		 * fields below, the miss mints instead of nudging. Requires `grant` +
		 * `tokenUrl` (the slot key) — omitting either is a validation error.
		 */
		useTokenStore?: boolean;
		/**
		 * The token slot to read: slots are keyed `(domain, grant, tokenUrl)`,
		 * so a store read needs the same grant + token endpoint facts the mint
		 * arm already carries. Required with useTokenStore — a call without
		 * them is a loud validation error, not a silent store miss.
		 */
		grant?: OAuth2Grant;
		/**
		 * Mint-on-demand (client-credentials authoring bootstrap): when the
		 * token store has no usable token, the probe POSTs `tokenUrl` once
		 * (client-credentials grant), stamps the token store, and injects the
		 * fresh Bearer. `clientId`/`clientSecret` are secrets-store NAMES —
		 * values resolve from the store, never the transcript. Implies
		 * useTokenStore. auth-code cannot be inlined (needs the interactive
		 * paste dance) — save a draft guide and use `/api oauth` for that.
		 * `tokenUrl` is load-bearing beyond minting: it keys the token-store
		 * slot read (with `grant`).
		 */
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
		scopes?: string[];
		tokenEndpointAuthMethod?:
			| "client_secret_basic"
			| "client_secret_post"
			| "none";
	};
	/** Domain for secrets-store lookups; defaults to apiHost's hostname (or its provisioned parent domain). */
	domain?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Pure shape logic — the non-trivial part, exported for testing
// ═══════════════════════════════════════════════════════════════════

const PAGINATION_KEYS = new Set([
	"offset",
	"limit",
	"start",
	"endOfRecords",
	"page",
	"per_page",
	"continue",
	"cursor",
	"next",
	"nextLink",
	"next_page_url",
	"total_count",
	"count",
	"total",
	"numFound",
]);
const ARRAY_VALUE_KEYS = new Set([
	"results",
	"items",
	"search",
	"docs",
	"data",
	"records",
	"features",
	"releases",
	"commits",
	"issues",
	"events",
]);
const ID_FIELDS = [
	"id",
	"key",
	"sha",
	"usageKey",
	"node_id",
	"number",
	"uuid",
	"_id",
];

export function summarize(data: unknown): ShapeSummary {
	const topLevel = topLevelOf(data);
	const keys = isObj(data) ? Object.keys(data as object).slice(0, 20) : [];
	const paginationMarkers = keys.filter((k) => PAGINATION_KEYS.has(k));

	// Find the items array: either the body itself, or the first array-valued
	// key (preferring known envelope keys, then any array key).
	let itemsPath = "";
	let items: unknown[] | null = null;
	if (Array.isArray(data)) {
		itemsPath = "$";
		items = data;
	} else if (isObj(data)) {
		const entries = Object.entries(data as Record<string, unknown>);
		const hit =
			entries.find(([k, v]) => ARRAY_VALUE_KEYS.has(k) && Array.isArray(v)) ??
			entries.find(([, v]) => Array.isArray(v));
		if (hit) {
			itemsPath = hit[0];
			items = hit[1] as unknown[];
		}
	}

	const arrayLen = items?.length ?? 0;
	const hasPaginationSignal = paginationMarkers.length > 0;
	const suggestedVia =
		items === null || !hasPaginationSignal ? "restGet" : "paginate";

	const summary: ShapeSummary = {
		topLevel,
		isArray: Array.isArray(data),
		keys,
		arrayLen,
		suggestedVia,
		suggestedItemsPath: items === null ? "" : itemsPath,
		paginationMarkers,
	};
	const representativeId = pickRepresentativeId(items);
	if (representativeId) summary.representativeId = representativeId;
	return summary;
}

function topLevelOf(data: unknown): ShapeSummary["topLevel"] {
	if (data === null) return "null";
	if (Array.isArray(data)) return "array";
	return typeof data as ShapeSummary["topLevel"];
}

function isObj(data: unknown): data is object {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}

function pickRepresentativeId(
	items: unknown[] | null,
): { field: string; value: string | number } | undefined {
	const rec = items?.[0];
	if (!isObj(rec)) return undefined;
	const obj = rec as Record<string, unknown>;
	for (const f of ID_FIELDS) {
		const v = obj[f];
		if (typeof v === "string" || typeof v === "number")
			return { field: f, value: v };
	}
	return undefined;
}

// ═══════════════════════════════════════════════════════════════════
// IO wrapper — fetches via the shared transport and formats the answer
// ═══════════════════════════════════════════════════════════════════

/** Resolved probe auth — store values + the names/values to redact/scrub. */
interface ProbeAuthCtx {
	hasAuthBlock: boolean;
	headers: Record<string, string>;
	queryParams: Record<string, string>;
	secretHeaderNames: Set<string>;
	secretQueryParamNames: Set<string>;
	secretValues: string[];
	missingNames: string[];
	/** headerPrefixes declared but no secretRefs to apply them to — the
	 *  prefixes would be silently dropped. Surfaced as a note, not an error. */
	misconfiguredPrefixes: boolean;
	/** useTokenStore declared but no usable token (absent or expired) — the
	 *  nudge text, composed into the 401/403 note. Empty when fine/unused. */
	tokenNote: string;
}

/**
 * Convert the probe's flat inline `auth` block (tool param — injection
 * fields only) into a nested `StaticKeyAuth` for the shared resolvers.
 * `headerPrefixes` fold inline onto each ref's `prefix`.
 */
function flatToStaticKeyAuth(
	auth: NonNullable<ProbeOptions["auth"]>,
): StaticKeyAuth {
	const secretRefs: Record<string, SecretRef> = {};
	for (const [header, secretName] of Object.entries(auth.secretRefs ?? {})) {
		secretRefs[header] = {
			secret: secretName,
			...(auth.headerPrefixes?.[header] === undefined
				? {}
				: { prefix: auth.headerPrefixes[header] }),
		};
	}
	const secretQueryRefs: Record<string, SecretRef> = {};
	for (const [param, secretName] of Object.entries(auth.secretQueryRefs ?? {})) {
		secretQueryRefs[param] = { secret: secretName };
	}
	return {
		kind: "static-key",
		...(Object.keys(secretRefs).length > 0 ? { secretRefs } : {}),
		...(Object.keys(secretQueryRefs).length > 0 ? { secretQueryRefs } : {}),
	};
}

/**
 * Resolve an inline `auth` block against the secrets store. Probe semantics:
 * a store miss is NOT fail-closed (human-in-the-loop authoring tool) — the
 * missing name is reported and the call proceeds with the header/param
 * omitted. `requires`/`optional` are absent from the probe's injection-only
 * block, so every miss lands in the report list.
 */
async function resolveProbeAuth(
	auth: NonNullable<ProbeOptions["auth"]> | undefined,
	domain: string,
	ctx?: ExtensionContext,
): Promise<ProbeAuthCtx> {
	// Computed before the hasRefs check so the flag survives both paths: a
	// headerPrefixes-only block (hasRefs false → early return) and a
	// secretQueryRefs block with prefixes but no secretRefs (hasRefs true →
	// normal path, where resolveSecretHeaders would silently drop the
	// prefixes). Query secrets never take prefixes, so secretQueryRefs is
	// deliberately excluded from the flag.
	const misconfiguredPrefixes =
		!!auth &&
		Object.keys(auth.headerPrefixes ?? {}).length > 0 &&
		Object.keys(auth.secretRefs ?? {}).length === 0;
	const hasRefs =
		!!auth &&
		(Object.keys(auth.secretRefs ?? {}).length > 0 ||
			Object.keys(auth.secretQueryRefs ?? {}).length > 0);
	const useTokenStore = !!auth?.useTokenStore;
	// Inline mint fields imply the token path even without useTokenStore.
	const hasMintFields = !!auth?.tokenUrl && !!auth?.clientId;
	// tokenUrl is load-bearing for both arms (mint destination AND store slot
	// key), so mint fields + any non-cc grant is an ambiguous mix — refuse
	// loudly instead of silently minting a client_credentials token that
	// overwrites the intent (and stamps a cc slot nobody asked for).
	if (hasMintFields && auth?.grant && auth.grant !== "client_credentials") {
		return {
			hasAuthBlock: true,
			headers: {},
			queryParams: {},
			secretHeaderNames: new Set(),
			secretQueryParamNames: new Set(),
			secretValues: [],
			missingNames: [],
			misconfiguredPrefixes,
			tokenNote:
				`mint fields (tokenUrl + clientId) are client_credentials-only; ` +
				`drop auth.grant ("${auth.grant}") or omit the mint fields and set ` +
				`auth.useTokenStore to read the existing ${auth.grant} slot`,
		};
	}
	if (!hasRefs && !useTokenStore && !hasMintFields) {
		return {
			hasAuthBlock: false,
			headers: {},
			queryParams: {},
			secretHeaderNames: new Set(),
			secretQueryParamNames: new Set(),
			secretValues: [],
			missingNames: [],
			misconfiguredPrefixes,
			tokenNote: "",
		};
	}
	const staticKeyAuth = flatToStaticKeyAuth(auth!);
	const headerRes = resolveSecretHeaders(staticKeyAuth, domain);
	const queryRes = resolveSecretQueryParams(staticKeyAuth, domain);
	// OAuth2 token injection: the token rides the same ctx as secret headers
	// (scrub + redirect-strip cover it). Bearer-header only (ponytail: query
	// paramStyle injection waits for a recipe that needs it). Two modes:
	// store-read-only (useTokenStore, nudge /api oauth on miss) and
	// mint-on-demand (inline tokenUrl + clientId — authoring bootstrap).
	let tokenNote = "";
	const tokenHeader: Record<string, string> = {};
	// Raw (unprefixed) token value for the body scrub — a 401 body can echo
	// the bare credential, not just the `Bearer <token>` header form.
	let rawTokenValue = "";
	if (hasMintFields) {
		// Build a synthetic oauth2 auth and hand it straight to
		// resolveAccessToken so the cache → refresh → mint → stamp machinery is
		// reused wholesale (incl. the per-domain refresh lock). Failures never
		// fail-closed — validation throws included, since
		// buildSyntheticOAuth2Auth runs inside the same try/catch — the message
		// rides the note and the probe proceeds unauthenticated.
		// Interactive sessions re-gate the secret-bearing destination on the
		// human (same trust root as oauth-mint). Headless has no gate — the
		// agent-has-bash posture covers it; documented in AGENTS.md. Decline
		// skips only the mint: tokenHeader stays empty and the shared return
		// below reports the unauthenticated probe + any secret misses.
		if (ctx?.hasUI) {
			const ok = await confirmTokenUrl(
				ctx,
				domain,
				auth!.tokenUrl!,
				auth!.clientId!,
			);
			if (!ok)
				tokenNote = `token-URL confirm declined for "${domain}"; probe proceeding unauthenticated`;
		}
		// Decline skips only the mint (tokenHeader stays empty) — the note and
		// unauthenticated probe are reported by the shared return below.
		if (tokenNote === "") {
			try {
				const oauthAuth = buildSyntheticOAuth2Auth({
					grant: "client_credentials",
					tokenUrl: auth!.tokenUrl!,
					clientId: auth!.clientId!,
					...(auth!.clientSecret ? { clientSecret: auth!.clientSecret } : {}),
					...(auth!.scopes?.length ? { scopes: auth!.scopes } : {}),
					...(auth!.tokenEndpointAuthMethod
						? { tokenEndpointAuthMethod: auth!.tokenEndpointAuthMethod }
						: {}),
				});
				const result = await resolveAccessToken(oauthAuth, domain);
				const bearer = result.authHeaders?.authorization;
				if (bearer) {
					tokenHeader["authorization"] = bearer;
					rawTokenValue = result.secretValues[0] ?? "";
				} else tokenNote = "oauth2 mint succeeded but produced no bearer header";
			} catch (e) {
				tokenNote = e instanceof Error ? e.message : "oauth2 mint failed";
			}
		}
	} else if (useTokenStore) {
		// Slot-keyed store read: the slot derives from (grant, tokenUrl) — the
		// same facts the mint arm carries. Without them the read would target a
		// slot that never exists; that misconfiguration is a LOUD validation
		// error (the caller's try/catch surfaces it), not a misleading
		// "run /api oauth" note on an unauthenticated fetch.
		if (!auth?.grant || !auth?.tokenUrl) {
			throw new Error(
				"auth.useTokenStore requires auth.grant (client_credentials | authorization_code) " +
					"and auth.tokenUrl — token slots are keyed by (domain, grant, token endpoint).",
			);
		}
		const token = readToken(domain, auth.grant, auth.tokenUrl);
		if (!token) {
			tokenNote = `no cached token for "${domain}"; run /api oauth ${domain} to mint one`;
		} else if (isTokenExpired(token)) {
			tokenNote = `token for "${domain}" is expired; run /api oauth ${domain} --refresh`;
		} else {
			tokenHeader["authorization"] = `Bearer ${token.accessToken}`;
			rawTokenValue = token.accessToken;
		}
	}
	if (Object.keys(tokenHeader).length > 0) {
		assertNoBearerCollision(
			headerRes.headers,
			"the probe auth block's secretRefs",
		);
	}
	const headers = { ...headerRes.headers, ...tokenHeader };
	return {
		hasAuthBlock: true,
		headers,
		queryParams: queryRes.queryParams,
		secretHeaderNames: new Set(Object.keys(headers).map((h) => h.toLowerCase())),
		secretQueryParamNames: new Set(Object.keys(queryRes.queryParams)),
		secretValues: [
			...Object.values(headers),
			...headerRes.rawHeaderValues,
			...Object.values(queryRes.queryParams),
			...(rawTokenValue ? [rawTokenValue] : []),
		],
		missingNames: [
			...headerRes.absentRequired,
			...headerRes.absentOptional,
			...queryRes.absentRequired,
			...queryRes.absentOptional,
		],
		misconfiguredPrefixes,
		tokenNote,
	};
}

/** Root-cause note for a headerPrefixes-only auth block (no secretRefs to
 *  apply the prefixes to). `:`/`;` internal separators keep the combined
 *  error note from stacking three ` — ` joins when it composes with the
 *  401/403 wording. */
const MISCONFIGURED_PREFIXES_NOTE =
	"headerPrefixes ignored: no secretRefs to apply them to; put the secret name in auth.secretRefs";

/** First missing secret name as a one-line note (names only, never values).
 *  Prescriptive: names the other provisioned domains and tells the author to
 *  pass `domain:` — the probe's domain is inferred from apiHost, so a miss is
 *  usually a domain-mismatch, not a missing secret. */
function missNote(authCtx: ProbeAuthCtx, domain: string): string {
	if (authCtx.missingNames.length === 0) return "";
	const suffix = provisionedDomainsSuffix(domain);
	const tail = suffix ? `${suffix}; pass domain: <one> to use its secret` : "";
	return `secret "${authCtx.missingNames[0]}" not found in store for domain "${domain}"${tail}`;
}

/** missNote + the token-store note, joined — the one miss renderer used at
 *  every note site, so a useTokenStore nudge rides along wherever a secret
 *  miss would. */
function authMissNote(authCtx: ProbeAuthCtx, domain: string): string {
	return [missNote(authCtx, domain), authCtx.tokenNote]
		.filter(Boolean)
		.join(" — ");
}

/** Trailing path of an apiHost URL (e.g. `/v3`), or `""` when empty/root.
 *  Trailing slashes stripped so `.../v3/` + `/items` → `/v3/items`, not `/v3//items`.
 *  Lets the probe draft carry the version prefix that was actually fetched. */
function versionPrefixOf(apiHost: string): string {
	try {
		return new URL(apiHost).pathname.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

export async function probe(
	apiHost: string,
	path: string,
	params: Record<string, unknown> = {},
	opts: ProbeOptions = {},
	ctx?: ExtensionContext,
): Promise<ProbeResult> {
	const accept = opts.accept ?? "application/json";
	const walkVersions = opts.walkVersions ?? true;
	const domain =
		opts.domain ?? resolveProvisionedParentDomain(hostnameOf(apiHost));
	const authCtx = await resolveProbeAuth(opts.auth, domain, ctx);

	// Base case only carries the apiHost version prefix; a walk-hit draft
	// embeds its walked version in the prefix passed to fetchOne.
	const base = await fetchOne(
		apiHost,
		path,
		params,
		accept,
		authCtx,
		domain,
		versionPrefixOf(apiHost),
	);
	if (base.status !== 404 || !walkVersions || /^\/v\d+\//.test(path)) {
		return base;
	}
	// Recover an over-claimed version by walking the apiHost version backward
	// (vN-1 → … → 1). Only fires on 404 — never a poller on a live 200.
	const stated = VERSION_PATHNAME_RE.exec(versionPrefixOf(apiHost))?.[1];
	if (stated === undefined) {
		// Gate excludes a bare / non-integer / subdomain-versioned host — no
		// walk to run, so tell the agent why rather than a silent bare 404.
		base.note = walkSkipNote(authCtx, domain);
		return base;
	}
	const hit = await walkBackward(
		{ apiHost, path, params, accept, authCtx, domain },
		Number(stated),
	);
	return hit ?? base;
}

// ponytail: MAX_VERSION_WALK caps a high-version host's request burst
// (a /v10 host fires at most 5 backward walks, not 9); raise it if a longer
// version-gap chain is ever needed.
export const MAX_VERSION_WALK = 5;

/** Matches a pure integer version pathname (`/v3`), excluding date/non-numeric
 *  /subdomain /multi-segment conventions — the only form the walk can swap. */
const VERSION_PATHNAME_RE = /^\/v(\d+)$/;

/** Backward version walk: refetch the same bare path with /vN-… swapped into
 *  apiHost; return the first non-404 (with a version-walk note) or null. */
async function walkBackward(
	ctx: {
		apiHost: string;
		path: string;
		params: Record<string, unknown>;
		accept: string;
		authCtx: ProbeAuthCtx;
		domain: string;
	},
	start: number,
): Promise<ProbeResult | null> {
	const miss = authMissNote(ctx.authCtx, ctx.domain);
	const floor = Math.max(start - MAX_VERSION_WALK, 1);
	for (let k = start - 1; k >= floor; k--) {
		const tried = await fetchOne(
			withVersion(ctx.apiHost, k),
			ctx.path,
			ctx.params,
			ctx.accept,
			ctx.authCtx,
			ctx.domain,
			`/v${k}`,
		);
		if (tried.status !== 404) {
			// A walk hit may itself have redirected (e.g. /v2 301→ /v3); the
			// draft carries /v${k} while the body came from elsewhere — flag
			// it so the agent checks finalUrl instead of trusting the prefix.
			const redirected = tried.finalUrl !== tried.url;
			tried.note = `${miss ? `${miss} — ` : ""}404 on /v${start}${ctx.path}; version walk → /v${k}${redirected ? " — verify finalUrl (redirect target)" : ""}`;
			return tried;
		}
	}
	return null;
}

/** apiHost with the version segment swapped via the URL API — never a
 *  string-replace (the version string could appear elsewhere in the host). */
function withVersion(apiHost: string, k: number): string {
	try {
		const u = new URL(apiHost);
		u.pathname = `/v${k}`;
		return `${u.origin}${u.pathname}`;
	} catch {
		return apiHost;
	}
}

/** The gate-excluded 404 note (bare / non-integer / subdomain version hosts). */
function walkSkipNote(authCtx: ProbeAuthCtx, domain: string): string {
	const miss = authMissNote(authCtx, domain);
	return `${miss ? `${miss} — ` : ""}404 — no version walk (apiHost has no /vN prefix)`;
}

async function fetchOne(
	apiHost: string,
	path: string,
	params: Record<string, unknown>,
	accept: string,
	authCtx: ProbeAuthCtx,
	domain: string,
	prefix = "",
): Promise<ProbeResult> {
	// Inject secret query params below the agent-supplied params map, then
	// redact the surfaced URL so the real key never reaches the transcript.
	const rawUrl = buildUrl(apiHost, path, { ...params, ...authCtx.queryParams });
	const url = redactSecretParams(rawUrl, authCtx.secretQueryParamNames);
	const hasQuerySecret = Object.keys(authCtx.queryParams).length > 0;
	const res = await fetchUrl(rawUrl, {
		headers: { accept, ...authCtx.headers },
		fresh: true,
		...(authCtx.hasAuthBlock
			? {
					hasQuerySecret,
					secretHeaderNames: authCtx.secretHeaderNames,
					secretQueryParamNames: authCtx.secretQueryParamNames,
				}
			: {}),
	});
	// Probe-local body scrub: the probe bypasses checkResponseStatus, so
	// scrub known secret values from the full body directly — a 401 body
	// echoing the key must not leak it into agent context. Scrub before
	// slicing so a secret straddling the cut can't leave a partial prefix.
	const raw = scrubSecretValues(res.body, authCtx.secretValues).slice(0, 800);
	const finalUrl = redactSecretParams(
		res.finalUrl ?? rawUrl,
		authCtx.secretQueryParamNames,
	);

	if (res.status >= 400) {
		// 401 or 403 — both mean the request was rejected on auth grounds
		// (gated endpoint, or bad/missing credentials), distinct from other
		// 4xx/5xx statuses. The name is deliberate: it covers 403 too.
		const isAuthError = res.status === 401 || res.status === 403;
		const miss = authMissNote(authCtx, domain);
		let note: string;
		if (!authCtx.hasAuthBlock) {
			// No auth injected — a 401/403 means the endpoint is gated and the
			// probe sent nothing. Pre-guide authoring tool: no guide in scope,
			// so no stale "(guide is auth:none)" wording.
			note = isAuthError
				? `${res.status} — endpoint requires auth; configure auth injection (auth.secretRefs)`
				: `${res.status}`;
		} else if (miss) {
			// Auth injected but a required secret was missing — the miss names it.
			note = `${res.status}${isAuthError ? " — auth rejected;" : ""} ${miss}`;
		} else {
			// Auth injected, nothing missing. A 403 means authenticated but
			// forbidden — "verify header name" is a 401 signal, not a 403 one.
			// Surface the server's own reason (from the scrubbed `raw`, never
			// `res.body`) when we can parse it; fall back to the bare status.
			// When the reason reads as plan-gating, say so — it's the key's
			// plan, not the recipe.
			if (res.status === 403) {
				const msg = serverMessage(raw);
				if (msg) {
					const suffix = isPlanGated(raw)
						? "plan/subscription limitation on the key, not the recipe"
						: "auth configured correctly; not a header/secret problem";
					note = `${res.status} — ${msg} (${suffix})`;
				} else {
					note = `${res.status}`;
				}
			} else if (res.status === 401) {
				note = `${res.status} — auth injected but rejected; verify header name and secret value`;
			} else {
				note = `${res.status}`;
			}
		}
		if (authCtx.misconfiguredPrefixes) {
			note += ` — ${MISCONFIGURED_PREFIXES_NOTE}`;
		}
		return {
			url,
			finalUrl,
			status: res.status,
			ok: false,
			shape: null,
			draft: "",
			raw,
			note,
		};
	}

	let data: unknown;
	try {
		data = JSON.parse(res.body);
	} catch {
		return {
			url,
			finalUrl,
			status: res.status,
			ok: true,
			shape: null,
			draft: "",
			raw,
			note:
				"non-JSON body (set opts.accept for XML/HTML, or use a different path)",
		};
	}

	const shape = summarize(data);
	const miss = authMissNote(authCtx, domain);
	const draft = emitDraft(path, params, shape, prefix);
	let note: string | undefined = miss;
	if (authCtx.misconfiguredPrefixes) {
		note = [note, MISCONFIGURED_PREFIXES_NOTE].filter(Boolean).join(" — ");
	}
	return {
		url,
		finalUrl,
		status: res.status,
		ok: true,
		shape,
		draft,
		raw,
		...(note ? { note } : {}),
	};
}

const RESERVED_PARAM_NAMES = new Set(["domain", "apiHost", "path", "auth"]);

function buildUrl(
	apiHost: string,
	path: string,
	params: Record<string, unknown>,
): string {
	for (const key of Object.keys(params)) {
		if (RESERVED_PARAM_NAMES.has(key)) {
			throw new Error(
				`"${key}" is a top-level param, not a query param — move it out of params`,
			);
		}
	}
	// Substitute {token} → params[token] BEFORE building the URL, so a
	// templated path fetches real values instead of literal %7Bowner%7D.
	// Missing tokens stay literal ({token}) — fine for probing an unfilled path.
	const pathTokens = new Set(extractPathTokens(path));
	const substituted = fillPathTemplate(path, params);
	const qs = new URLSearchParams(
		Object.fromEntries(
			Object.entries(params)
				.filter(([k, v]) => v !== undefined && !pathTokens.has(k))
				.map(([k, v]) => [k, String(v)]),
		),
	).toString();
	return joinUrl(apiHost, substituted, qs);
}

// ═══════════════════════════════════════════════════════════════════
// Draft YAML emission (suggests; the author confirms)
// ═══════════════════════════════════════════════════════════════════

export function emitDraft(
	path: string,
	params: Record<string, unknown>,
	shape: ShapeSummary,
	prefix = "",
): string {
	// Idempotent: only prepend when the path doesn't already carry the prefix,
	// so `apiHost: .../v3` + `path: /v3/items` doesn't become `/v3/v3/items`.
	const fullPath = prefix && !path.startsWith(prefix) ? prefix + path : path;
	const name = suggestName(fullPath);
	const pathTokens = extractPathTokens(fullPath);
	const queryParamKeys = Object.keys(params).filter(
		(k) => !pathTokens.includes(k),
	);
	const lines: string[] = [
		`  - name: ${name}`,
		`    via: ${shape.suggestedVia}`,
		`    path: ${fullPath}`,
		`    accept: json`,
	];

	if (shape.suggestedVia === "paginate") {
		lines.push(
			"    # unverified — pagination params are guessed from response keys; confirm the API accepts them",
		);
		const markers = shape.paginationMarkers;
		const isPageStyle = markers.includes("page") || markers.includes("per_page");
		const style = isPageStyle ? "page" : "offset-limit";
		// `start` marker ⇒ 1-based row offset (CMC, GBIF) — emit base: 1 so the
		// first page starts at 1, not the 0 default. `offset` ⇒ 0-based, no base.
		let pageParam: string;
		if (isPageStyle) pageParam = "page";
		else if (markers.includes("start")) pageParam = "start";
		else pageParam = "offset";
		const pageSizeParam = isPageStyle ? "per_page" : "limit";
		if (style === "offset-limit") {
			lines.push(
				"    # offset-limit advances the page param by pageSize each page (row-offset semantics); base seeds the start (1 for `start` params, 0 for `offset`)",
			);
		}
		lines.push("    pagination:");
		lines.push(`      style: ${style}`);
		lines.push(`      itemsPath: ${shape.suggestedItemsPath}`);
		lines.push(`      pageParam: ${pageParam}`);
		lines.push(`      pageSizeParam: ${pageSizeParam}`);
		lines.push("      pageSize: 30");
		if (pageParam === "start") lines.push("      base: 1");
	}
	if (shape.suggestedVia === "restGet" && shape.suggestedItemsPath !== "") {
		lines.push(
			"    # array response with no pagination markers — if the API documents paging, prefer paginate:",
			"    #   offset-limit advances the page param by pageSize each page (use base: 1 for 1-based `start` APIs like CMC); page increments the page param by 1.",
		);
	}
	if (queryParamKeys.length > 0) {
		lines.push("    params:");
		for (const k of queryParamKeys) {
			lines.push(`      ${k}:`);
			lines.push(`        description: TODO — ${k}.`);
		}
	}
	if (shape.representativeId) {
		lines.push(
			`    # representative id: ${shape.representativeId.field}=${shape.representativeId.value}`,
		);
	}
	return lines.join("\n");
}

function suggestName(path: string): string {
	const segs = path.split("/").filter((s) => s && !s.startsWith("{"));
	const last = segs[segs.length - 1] ?? "op";
	// kebab/snake → camelCase placeholder; author renames.
	return last
		.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase())
		.replace(/[^a-zA-Z0-9]/g, "");
}

// Tool definition
// ═══════════════════════════════════════════════════════════════════

export const apiProbeTool = defineTool({
	name: "api-probe",
	label: "API Probe",
	description:
		"Discover the shape of a not-yet-guided API endpoint before authoring a guide. " +
		"Fetches a templated path over the real transport, summarizes the JSON shape, " +
		"suggests via/itemsPath/pagination, echoes a representative record id, and emits " +
		"a draft YAML operation block to paste into a guide recipe. " +
		"It only suggests — it never writes the guide, and the operation must still be " +
		"traceable to your plan source. Pre-guide: pass apiHost + path. After a guide " +
		"exists, use api-guide({domain}) to get apiHost, or api-fetch to execute. " +
		"Before the first auth-gated probe, use api-store (learn mode) to check what " +
		"credentials exist for the domain — pass that domain up front so a store-miss " +
		"round-trip is avoided. " +
		"Before authoring a new guide, read the provider's docs index (llms.txt, " +
		"openapi.json at the API root, or the docs page) to learn the current API " +
		"version — then probe that version explicitly. Do not default the version from " +
		"memory: a stale version that still returns 200 is not detected as old (the " +
		"backward walk only fires on 404). The probe recovers an over-claimed version " +
		"but cannot detect a stale-but-working one. ",

	parameters: Type.Object({
		apiHost: Type.String({
			description:
				"Base URL including the API's current version prefix, e.g. " +
				"'https://api.example.com/v3'. Find the latest version before probing: " +
				"check the API's docs page, openapi.json/swagger.json at the API root, " +
				"or llms.txt. Supply the newest version you can verify — if it 404s, the " +
				"probe walks backward (v3→v2→v1) to recover. Do not default to /v1 from " +
				"memory; a stale version that still returns 200 is not detected as old.",
		}),
		path: Type.String({
			description:
				"Templated path, e.g. '/repos/{owner}/{repo}/branches'. {token} placeholders are filled from params.",
		}),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					"Values for {token} path placeholders and query parameters. Path tokens are not re-declared as query params.",
			}),
		),
		walkVersions: Type.Optional(
			Type.Boolean({
				description:
					"On 404, walk the apiHost version backward (vN→v1) to find the highest live version. Default true.",
			}),
		),
		auth: Type.Optional(
			Type.Object(
				{
					secretRefs: Type.Optional(Type.Record(Type.String(), Type.String())),
					secretQueryRefs: Type.Optional(Type.Record(Type.String(), Type.String())),
					headerPrefixes: Type.Optional(Type.Record(Type.String(), Type.String())),
					useTokenStore: Type.Optional(
						Type.Boolean({
							description:
								"Inject the OAuth2 access token from the token store as 'Authorization: Bearer <token>' (mint it first via /api oauth <domain>). Requires auth.grant + auth.tokenUrl (the token-slot key). Values never enter the transcript; absent/expired token → the note nudges /api oauth and the probe proceeds unauthenticated.",
						}),
					),
					grant: Type.Optional(
						Type.Union(
							[Type.Literal("client_credentials"), Type.Literal("authorization_code")],
							{
								description:
									"The token slot's grant — token slots are keyed (domain, grant, tokenUrl). Required with useTokenStore; the mint arm always uses client_credentials.",
							},
						),
					),
					tokenUrl: Type.Optional(
						Type.String({
							description:
								"Token endpoint URL — load-bearing beyond minting: it keys the token-store slot read (with grant). When the token store has no usable token and mint fields are present, the probe POSTs client-credentials once, stamps the store, and injects the fresh Bearer.",
						}),
					),
					clientId: Type.Optional(
						Type.String({
							description:
								"Mint-on-demand: secrets-store NAME of the client id (value resolves from the store, never the transcript). Requires tokenUrl.",
						}),
					),
					clientSecret: Type.Optional(
						Type.String({
							description: "Mint-on-demand: secrets-store NAME of the client secret.",
						}),
					),
					scopes: Type.Optional(
						Type.Array(Type.String(), {
							description: "Mint-on-demand: scopes for the token request.",
						}),
					),
					tokenEndpointAuthMethod: Type.Optional(
						Type.Union(
							[
								Type.Literal("client_secret_basic"),
								Type.Literal("client_secret_post"),
								Type.Literal("none"),
							],
							{
								description:
									"Mint-on-demand: token-endpoint auth method (default client_secret_post).",
							},
						),
					),
				},
				{
					description:
						"Store-backed auth injection for probing auth-gated endpoints (authoring loop). Accepts secretRefs, secretQueryRefs, headerPrefixes, useTokenStore (+ grant + tokenUrl, the token-slot key), and client-credentials mint-on-demand fields (tokenUrl + clientId [+ clientSecret, scopes, tokenEndpointAuthMethod]) for bootstrapping a guide-less authoring loop. Values resolve from the secrets/token stores and never enter the transcript; a store miss fetches unauthenticated and reports the miss in the note.",
					// Tight: unknown keys (e.g. a stray `domain`) are rejected before execute runs.
					// The description above names the allowed fields explicitly — keep it in
					// sync when adding/renaming a field here, or the prose lies to agents.
					additionalProperties: false,
				},
			),
		),
		domain: Type.Optional(
			Type.String({
				description:
					"Domain for secrets-store lookups; defaults to apiHost's hostname (or its provisioned parent domain).",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { apiHost, path, walkVersions, auth, domain } = params as {
			apiHost: string;
			path: string;
			params?: Record<string, unknown>;
			walkVersions?: boolean;
			auth?: ProbeOptions["auth"];
			domain?: string;
		};
		const userParams = (params as Record<string, unknown>)["params"] as
			| Record<string, unknown>
			| undefined;

		try {
			const result = await probe(
				apiHost,
				path,
				userParams ?? {},
				{
					...(walkVersions === undefined ? {} : { walkVersions }),
					...(auth ? { auth } : {}),
					...(domain ? { domain } : {}),
				},
				ctx,
			);
			return {
				content: [{ type: "text", text: formatProbeResult(result) }],
				details: {
					url: result.url,
					finalUrl: result.finalUrl,
					status: result.status,
					ok: result.ok,
					shape: result.shape,
					note: result.note,
					draft: result.draft,
					raw: result.raw,
				},
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `api-probe failed for '${apiHost}${path}': ${
							err instanceof Error ? err.message : String(err)
						}`,
					},
				],
				details: { error: "unexpected", message: String(err) },
			};
		}
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("api-probe "))];
		if (args.apiHost) parts.push(theme.fg("accent", `"${args.apiHost}"`));
		if (args.path) parts.push(theme.fg("dim", `› ${args.path}`));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Probing…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) {
			return new Text(theme.fg("error", `⚠ ${contentText(result, "?")}`), 0, 0);
		}
		const status = d?.status as number | undefined;
		const shape = d?.shape as ShapeSummary | null | undefined;

		let text = theme.fg("accent", theme.bold("🔬 api-probe"));
		text += ` — ${(d?.url as string) ?? "?"} · ${status ?? "?"}`;
		if (shape) {
			const items =
				shape.suggestedVia === "paginate"
					? ` · itemsPath: ${shape.suggestedItemsPath}`
					: "";
			text += `\n${theme.fg("dim", `${shape.suggestedVia}${items}`)}`;
		}
		return new Text(appendFooter(text, expanded, result, theme, 1000), 0, 0);
	},
});

// ═══════════════════════════════════════════════════════════════════
// Result formatting
// ═══════════════════════════════════════════════════════════════════

const DOCS_NUDGE = [
	"probe validates shape only — it cannot enumerate endpoints.",
	"For a full guide, read the API's docs index (e.g. llms.txt or per-endpoint .md).",
];

export function formatProbeResult(r: ProbeResult): string {
	const lines: string[] = [];
	lines.push(`🔬 api-probe — ${r.url}`);
	lines.push(`  status: ${r.status}`);
	if (r.finalUrl !== r.url) lines.push(`  final url: ${r.finalUrl}`);
	if (r.note) lines.push(`  note: ${r.note}`);
	if (r.shape) {
		const s = r.shape;
		lines.push(`  shape: ${s.topLevel}`);
		if (s.keys.length > 0) lines.push(`  keys: ${s.keys.join(", ")}`);
		lines.push(`  via: ${s.suggestedVia}`);
		if (s.suggestedItemsPath) lines.push(`  itemsPath: ${s.suggestedItemsPath}`);
		if (s.arrayLen > 0) lines.push(`  arrayLen: ${s.arrayLen}`);
		if (s.paginationMarkers.length > 0)
			lines.push(`  pagination markers: ${s.paginationMarkers.join(", ")}`);
		if (s.representativeId)
			lines.push(
				`  representative id: ${s.representativeId.field}=${s.representativeId.value}`,
			);
	}
	if (r.draft) {
		lines.push(`  draft:`);
		lines.push(r.draft.replace(/^/gm, "    "));
	}
	if (r.raw) {
		lines.push(`  raw (truncated):`);
		lines.push(r.raw);
	}
	lines.push("");
	lines.push(`  ${DOCS_NUDGE.join("\n  ")}`);
	return lines.join("\n");
}
