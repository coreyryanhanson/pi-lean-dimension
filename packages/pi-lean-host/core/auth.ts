/**
 * Auth — store-backed secret resolution + OAuth2 token resolution + the
 * metadata-only auth footer.
 *
 * Shared by `api-fetch` (injection + fail-closed), `api-guide`/`api-fetch`
 * footers, and `/api oauth`. Reads the secrets store and the OAuth2 token
 * store; exposes names only — secret values never leave the resolved header
 * map (which only the fetch pipeline consumes, never agent context).
 *
 * Import direction: this module imports `oauth-store.ts` (the footer and
 * token resolution must read the token store); `oauth-store.ts` imports
 * nothing from here, so the edge stays one-way and no cycle can form.
 */

import type {
	ApiGuide,
	AuthConfig,
	OAuth2Auth,
	OAuth2Grant,
	OAuth2TokenEndpointAuthMethod,
	StaticKeyAuth,
} from "./api-guide-types.js";
import {
	listDomains,
	readSecret,
	provisionedDomainsSuffix,
} from "./secrets-store.js";
import { readToken, writeToken, deleteToken, slotKey } from "./oauth-store.js";
import type { OAuthToken } from "./oauth-store.js";

/**
 * The canonical secret-store key for a guide: its primary browsable domain.
 * `domains:` is parser-required (an `ApiGuide` always has a non-empty
 * `domains` array), so `domains[0]` is always present. No override field,
 * no organization chain, no dirName fallback.
 */
export function canonicalStoreDomain(guide: ApiGuide): string {
	// `domains` is optional on the Guide base for web-guides, but parser-required
	// (non-empty) on any ApiGuide — see requireStringArray in parse-api-guide.ts.
	return guide.domains![0]!;
}

/** Result of resolving a guide's `auth.secretRefs` against the store. */
export interface SecretResolution {
	/** headerName → resolved value (with prefix applied), ready to merge into the request. */
	headers: Record<string, string>;
	/**
	 * The unprefixed (raw) resolved secret values, for the output-channel
	 * audit — a server may echo the bare token, not just the prefixed form.
	 */
	rawHeaderValues: string[];
	/** secret names referenced by required refs that are absent from the store. */
	absentRequired: string[];
	/** secret names referenced by optional refs that are absent from the store. */
	absentOptional: string[];
}

/** Resolve store-secret headers for a `static-key` guide. */
export function resolveSecretHeaders(
	auth: StaticKeyAuth,
	domain: string,
): SecretResolution {
	const headers: Record<string, string> = {};
	const rawHeaderValues: string[] = [];
	const absentRequired: string[] = [];
	const absentOptional: string[] = [];
	for (const [headerName, ref] of Object.entries(auth.secretRefs ?? {})) {
		const value = readSecret(domain, ref.secret);
		if (value === null) {
			if (ref.optional) absentOptional.push(ref.secret);
			else absentRequired.push(ref.secret);
		} else {
			headers[headerName] = (ref.prefix ?? "") + value;
			rawHeaderValues.push(value);
		}
	}
	return { headers, rawHeaderValues, absentRequired, absentOptional };
}

/** Result of resolving a guide's `auth.secretQueryRefs` against the store. */
export interface QuerySecretResolution {
	/** paramName → resolved value, injected below the agent params map. */
	queryParams: Record<string, string>;
	/** secret names referenced by required refs that are absent from the store. */
	absentRequired: string[];
	/** secret names referenced by optional refs that are absent from the store. */
	absentOptional: string[];
}

/**
 * Resolve store-secret query params for a `static-key` guide. Mirrors
 * `resolveSecretHeaders`: reads the store, splits absents by ref.optional.
 * The values are injected below the agent-supplied params map by the fetch
 * pipeline and never enter agent context.
 */
export function resolveSecretQueryParams(
	auth: StaticKeyAuth,
	domain: string,
): QuerySecretResolution {
	const queryParams: Record<string, string> = {};
	const absentRequired: string[] = [];
	const absentOptional: string[] = [];
	for (const [paramName, ref] of Object.entries(auth.secretQueryRefs ?? {})) {
		const value = readSecret(domain, ref.secret);
		if (value === null) {
			if (ref.optional) absentOptional.push(ref.secret);
			else absentRequired.push(ref.secret);
		} else {
			queryParams[paramName] = value;
		}
	}
	return { queryParams, absentRequired, absentOptional };
}

/**
 * Metadata-only auth status footer line, shared by `api-guide` and `api-fetch`.
 * Five static-key states (no-auth → undefined / ok / nudge-provision /
 * ok-optional / optional-not-provisioned) plus the oauth2 states (ok /
 * expired-but-refreshable / missing → nudge /api oauth). Never renders a
 * secret value ��� names only.
 */
export function authStatusLine(
	auth: AuthConfig,
	domain: string,
): string | undefined {
	switch (auth.kind) {
		case "none":
			return undefined;
		case "static-key": {
			// Nothing to report when neither ref map has an entry (empty maps
			// are valid = no injection).
			if (
				Object.keys(auth.secretRefs ?? {}).length === 0 &&
				Object.keys(auth.secretQueryRefs ?? {}).length === 0
			)
				return undefined;
			const headerRes = resolveSecretHeaders(auth, domain);
			const queryRes = resolveSecretQueryParams(auth, domain);
			// Dedupe across the two ref maps: a secret injected into both a
			// header and a query param must be named once, not twice.
			const absentRequired = [
				...new Set([...headerRes.absentRequired, ...queryRes.absentRequired]),
			];
			if (absentRequired.length > 0) {
				return (
					`🔑 auth: requires ${absentRequired.join(", ")} — not provisioned. ` +
					`Run /api secrets ${domain}.` +
					provisionedDomainsSuffix(domain)
				);
			}
			// The optional dimension only exists for refs actually marked
			// optional (a ref with optional: true).
			const referencedOptional = [
				...Object.entries(auth.secretRefs ?? {}),
				...Object.entries(auth.secretQueryRefs ?? {}),
			]
				.filter(([, r]) => r.optional)
				.map(([, r]) => r.secret);
			if (referencedOptional.length > 0) {
				const absentOptional = [
					...new Set([...headerRes.absentOptional, ...queryRes.absentOptional]),
				];
				if (absentOptional.length > 0) {
					return (
						`🔑 auth: ok (optional ${absentOptional.join(", ")} not ` +
						`provisioned — unauthenticated; provision with /api secrets ${domain} for higher limits)`
					);
				}
				return "🔑 auth: ok (optional provisioned)";
			}
			return "🔑 auth: ok";
		}
		case "oauth2": {
			const token = readToken(domain, auth.grant, auth.tokenUrl);
			if (!token) {
				return `🔑 auth: oauth2 — no token. Run /api oauth ${domain}.`;
			}
			if (isTokenExpired(token)) {
				return (
					`🔑 auth: oauth2 — token expired` +
					(token.refreshToken
						? `, refreshable. Run /api oauth ${domain} --refresh.`
						: `. Run /api oauth ${domain} to re-mint.`)
				);
			}
			return "🔑 auth: ok (oauth2)";
		}
		default: {
			const _exhaustive: never = auth;
			throw new Error(`Unhandled auth kind: ${_exhaustive}`);
		}
	}
}

/**
 * Output-channel audit — true when `value` contains any known store-injected
 * secret value. Shared by the body/error scrub and the response-header
 * echo drop.
 */
export function containsSecret(
	value: string,
	secretValues?: string[],
): boolean {
	if (!secretValues) return false;
	return secretValues.some((s) => s && s.length > 0 && value.includes(s));
}

/**
 * Output-channel audit — replace every occurrence of a known store-injected
 * secret value in `text` with `***`, so a request/response body or error
 * echoing the key can't leak it into agent context. No-op when no secrets.
 */
export function scrubSecretValues(
	text: string,
	secretValues?: string[],
): string {
	if (!secretValues) return text;
	for (const v of secretValues) {
		if (v && v.length > 0) text = text.split(v).join("***");
	}
	return text;
}

// ═════════════════════════════════════════════════��═════════════════
// OAuth2 token resolution (client_credentials + lazy refresh)
// ═══════════════════════════════════════════════════════════════════

/**
 * Thrown when an OAuth2 token can't be produced without human action (no
 * cached token, no client_secret to mint, or an auth-code guide with no
 * interactive flow). Callers fail closed and nudge `/api oauth <domain>`.
 */
export class OAuthTokenMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthTokenMissingError";
	}
}

/** Resolved OAuth2 token injection, shaped to drop straight into AuthOpts. */
export interface AccessTokenResult {
	authHeaders?: Record<string, string>;
	secretHeaderNames?: Set<string>;
	secretQueryParams?: Record<string, string>;
	secretQueryParamNames?: Set<string>;
	secretValues: string[];
}

/** Refresh the access token one round trip before real expiry. */
const EXPIRY_SKEW_MS = 60_000;

/** True when a cached token should be refreshed/re-minted (skewed early). */
export function isTokenExpired(
	token: OAuthToken,
	now: number = Date.now(),
): boolean {
	if (token.expiresAt === undefined) {
		// ponytail: no expires_in → treat as fresh; a provider that omits it
		// will 401 and the next call re-mints. Add a TTL heuristic if a real
		// recipe's short TTL makes this hurt.
		return false;
	}
	return now >= token.expiresAt - EXPIRY_SKEW_MS;
}

/**
 * Per-slot in-process lock keyed by `(storeDomain, slot)` — the same slot
 * derivation the token store uses (two derivations that can diverge would be
 * a second clobber), so concurrent `api-fetch` calls for the same slot
 * serialize on one read-check-refresh-write sequence. Without it, two
 * parallel calls that both see an expired token could race a refresh and
 * double-spend a rotated refresh token. Cross-slot calls don't serialize —
 * they touch different records; the store's synchronous read-modify-write
 * keeps them atomic wrt the event loop.
 */
const tokenLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding the per-slot lock — serializes any read-check-refresh-write
 * sequence for `(storeDomain, slot)`, so `--refresh`/mint paths can't race an
 * agent's `resolveAccessToken` into double-spending a rotated refresh token.
 */
async function withSlotLock<T>(
	auth: OAuth2Auth,
	domain: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockKey = `${domain}:${slotKey(auth.grant, auth.tokenUrl)}`;
	const inFlight = tokenLocks.get(lockKey);
	if (inFlight) await inFlight.catch(() => {});
	const p = fn();
	tokenLocks.set(lockKey, p);
	try {
		return await p;
	} finally {
		tokenLocks.delete(lockKey);
	}
}

/**
 * Resolve an access token for an oauth2 auth (guide-backed or synthetic):
 * cached → lazy refresh → client-credentials mint. Reads the token store
 * fresh on every call (no closure cache) so a refresh on op N is visible to
 * op N+1 during a long `/api verify` run. Fail-closed: throws `OAuthTokenMissingError` when no
 * token exists and none can be minted.
 */
export async function resolveAccessToken(
	auth: OAuth2Auth,
	domain: string,
): Promise<AccessTokenResult> {
	return withSlotLock(auth, domain, () => resolveTokenUnlocked(auth, domain));
}

async function resolveTokenUnlocked(
	auth: OAuth2Auth,
	domain: string,
): Promise<AccessTokenResult> {
	let token = readToken(domain, auth.grant, auth.tokenUrl);
	if (token && !isTokenExpired(token))
		return toAccessTokenResult(auth, token, domain);
	if (token?.refreshToken) {
		try {
			token = await refreshAccessToken(auth, domain, token.refreshToken);
			writeToken(domain, auth.grant, auth.tokenUrl, token);
			return toAccessTokenResult(auth, token, domain);
		} catch {
			// Refresh failed (rotated/revoked refresh token, endpoint down) —
			// fall through to re-mint; the mint surfaces the real failure.
		}
	}
	if (auth.grant === "client_credentials") {
		token = await mintClientCredentialsToken(auth, domain);
		writeToken(domain, auth.grant, auth.tokenUrl, token);
		return toAccessTokenResult(auth, token, domain);
	}
	// authorization_code: no interactive mint here — fail closed with
	// a nudge to /api oauth.
	throw new OAuthTokenMissingError(
		`No usable OAuth2 token for '${domain}' (grant: authorization_code). ` +
			`Run /api oauth ${domain} to start the interactive flow.`,
	);
}

/** Map a token set onto the AuthOpts shape (bearer-header or query style). */
function toAccessTokenResult(
	auth: OAuth2Auth,
	token: OAuthToken,
	domain: string,
): AccessTokenResult {
	// secretRefs (e.g. Twitch's Client-Id) merge onto the same header map —
	// SAME semantics as static-key: resolved from the secrets store,
	// fail-closed when a required one is missing.
	const resolvedHeaders: Record<string, string> = {};
	const resolvedValues: string[] = [];
	for (const [headerName, ref] of Object.entries(auth.secretRefs ?? {})) {
		const value = readSecret(domain, ref.secret);
		if (value === null) {
			if (ref.optional) continue;
			throw new OAuthTokenMissingError(
				`OAuth2 request header '${headerName}' needs the secret '${ref.secret}' provisioned ` +
					`for '${domain}'. Run /api secrets ${domain} then /api oauth ${domain}.`,
			);
		}
		resolvedHeaders[headerName] = (ref.prefix ?? "") + value;
		resolvedValues.push(value);
	}
	const style = auth.paramStyle ?? "bearer-header";
	if (style === "query") {
		// RFC 6750 §2.3 — the query-injected param name is `access_token`.
		return {
			...(Object.keys(resolvedHeaders).length > 0
				? {
						authHeaders: resolvedHeaders,
						// Strip them on cross-domain redirect hops, same as bearer style.
						secretHeaderNames: new Set(
							Object.keys(resolvedHeaders).map((h) => h.toLowerCase()),
						),
					}
				: {}),
			secretQueryParams: { access_token: token.accessToken },
			secretQueryParamNames: new Set(["access_token"]),
			secretValues: [token.accessToken, ...resolvedValues],
		};
	}
	return {
		authHeaders: {
			authorization: `Bearer ${token.accessToken}`,
			...resolvedHeaders,
		},
		secretHeaderNames: new Set([
			"authorization",
			...Object.keys(resolvedHeaders).map((h) => h.toLowerCase()),
		]),
		secretValues: [token.accessToken, ...resolvedValues],
	};
}

/**
 * The client credentials for an oauth2 guide: resolved from the secrets
 * store via the guide's named `clientId` / `clientSecret` SecretRefs
 * (store-resolved values appear ONLY as `SecretRef.secret` — a shippable
 * guide bakes in no per-user registration). Null secret when the guide
 * declares no `clientSecret` (PKCE auth-code apps) or the store lacks it.
 * Throws `OAuthTokenMissingError` when the client id's store name is absent —
 * the token endpoint cannot be called without it.
 */
export function resolveClientCredentials(
	auth: OAuth2Auth,
	domain: string,
): {
	clientId: string;
	clientSecret: { secret: string; refName: string } | null;
} {
	const clientId = readSecret(domain, auth.clientId.secret);
	if (clientId === null) {
		throw new OAuthTokenMissingError(
			`OAuth2 needs the client id '${auth.clientId.secret}' provisioned ` +
				`for '${domain}'. Run /api secrets ${domain} then /api oauth ${domain}.`,
		);
	}
	const ref = auth.clientSecret;
	const clientSecret = ref ? readSecret(domain, ref.secret) : null;
	return {
		clientId,
		...(clientSecret !== null && ref
			? { clientSecret: { secret: clientSecret, refName: ref.secret } }
			: { clientSecret: null }),
	};
}

/**
 * True when a token can be produced without human interaction: a cached
 * fresh token, a refreshable one, or (client_credentials) a provisioned
 * client secret to mint from. Used by the `/api verify` precheck to
 * fail-fast instead of surfacing N identical token-missing failures.
 */
export function hasUsableTokenPath(auth: OAuth2Auth, domain: string): boolean {
	const token = readToken(domain, auth.grant, auth.tokenUrl);
	if (token && !isTokenExpired(token)) return true;
	if (token?.refreshToken) return true;
	if (auth.grant === "client_credentials") {
		return (
			readSecret(domain, auth.clientId.secret) !== null &&
			auth.clientSecret !== undefined &&
			readSecret(domain, auth.clientSecret.secret) !== null
		);
	}
	return false;
}

/**
 * Attach client authentication to a token-endpoint request (RFC 6749 §2.3):
 * `client_secret_basic` → Basic Authorization header, `client_secret_post`
 * (the default) → `client_secret` form field, `none` → nothing. Mutates
 * `form` / `headers`. No-op without a client secret (PKCE public clients).
 */
function applyClientAuth(
	auth: OAuth2Auth,
	clientId: string,
	clientSecret: { secret: string } | null,
	form: Record<string, string>,
	headers: Record<string, string>,
): void {
	if (!clientSecret) return;
	const method = auth.tokenEndpointAuthMethod ?? "client_secret_post";
	if (method === "client_secret_basic") {
		headers["authorization"] =
			"Basic " +
			Buffer.from(`${clientId}:${clientSecret.secret}`).toString("base64");
	} else if (method === "client_secret_post") {
		form["client_secret"] = clientSecret.secret;
	}
}

/**
 * Exchange an authorization code for a token set (PKCE verifier in the
 * body). `redirectUri` must be the SAME URI sent in the authorize step.
 * The client secret (when the guide declares one) rides per
 * `tokenEndpointAuthMethod`; PKCE public clients send none.
 */
export async function exchangeAuthCode(
	auth: OAuth2Auth,
	domain: string,
	code: string,
	redirectUri: string,
	verifier: string,
): Promise<OAuthToken> {
	const { clientId, clientSecret } = resolveClientCredentials(auth, domain);
	const form: Record<string, string> = {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: clientId,
		code_verifier: verifier,
	};
	const headers: Record<string, string> = {};
	applyClientAuth(auth, clientId, clientSecret, form, headers);
	const data = await oauthPost(auth.tokenUrl, form, headers, [
		code,
		...(clientSecret ? [clientSecret.secret] : []),
	]);
	return tokenFromResponse(data);
}

/**
 * Force a fresh token for an auth-code guide by refreshing via the stored
 * refresh token (no re-consent). Throws `OAuthTokenMissingError` when there
 * is no refresh token — the caller falls back to the interactive flow.
 */
export async function forceRefreshToken(
	auth: OAuth2Auth,
	domain: string,
): Promise<OAuthToken> {
	return withSlotLock(auth, domain, () =>
		forceRefreshTokenUnlocked(auth, domain),
	);
}

async function forceRefreshTokenUnlocked(
	auth: OAuth2Auth,
	domain: string,
): Promise<OAuthToken> {
	const token = readToken(domain, auth.grant, auth.tokenUrl);
	if (!token?.refreshToken) {
		throw new OAuthTokenMissingError(
			`No refresh token for '${domain}' — run /api oauth ${domain} to start the interactive flow.`,
		);
	}
	const fresh = await refreshAccessToken(auth, domain, token.refreshToken);
	writeToken(domain, auth.grant, auth.tokenUrl, fresh);
	return fresh;
}

/**
 * One POST to an OAuth2 endpoint (token/refresh/revoke) — the first non-GET
 * requests host makes, kept OUT of `transport.ts` (GET-only by contract) in
 * a small separate helper. `secretValues` are scrubbed from any error body
 * so a server echoing a credential can't leak it into agent context.
 *
 * Returns the parsed JSON body, or `{}` for an empty/non-JSON body (valid
 * for RFC 7009 revocation, which returns 200 OK with no body). Callers that
 * need a token validate `access_token` themselves via `tokenFromResponse`.
 */
async function oauthPost(
	url: string,
	form: Record<string, string>,
	headers: Record<string, string>,
	secretValues: string[],
): Promise<Record<string, unknown>> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
		body: new URLSearchParams(form).toString(),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`OAuth2 endpoint ${res.status}: ${scrubSecretValues(text.slice(0, 300), secretValues)}`,
		);
	}
	try {
		const data = JSON.parse(text);
		if (data && typeof data === "object" && !Array.isArray(data)) {
			return data as Record<string, unknown>;
		}
	} catch {
		// empty / non-JSON body — valid for revocation (RFC 7009)
	}
	return {};
}

function tokenFromResponse(data: Record<string, unknown>): OAuthToken {
	const at = data["access_token"];
	if (typeof at !== "string") {
		throw new Error("OAuth2 token endpoint returned no access_token");
	}
	const token: OAuthToken = {
		accessToken: at,
	};
	if (typeof data["refresh_token"] === "string") {
		token.refreshToken = data["refresh_token"];
	}
	const expiresIn = data["expires_in"];
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
		token.expiresAt = Date.now() + expiresIn * 1000;
	}
	if (typeof data["scope"] === "string") token.scope = data["scope"];
	return token;
}

/** Client-credentials mint: POST grant_type=client_credentials → token. */
async function mintClientCredentialsToken(
	auth: OAuth2Auth,
	domain: string,
): Promise<OAuthToken> {
	const { clientId, clientSecret } = resolveClientCredentials(auth, domain);
	if (!clientSecret) {
		const refName = auth.clientSecret?.secret ?? "client_secret";
		throw new OAuthTokenMissingError(
			`OAuth2 client_credentials needs the client secret '${refName}' provisioned ` +
				`for '${domain}'. Run /api secrets ${domain} then /api oauth ${domain}.`,
		);
	}
	const form: Record<string, string> = {
		grant_type: "client_credentials",
		client_id: clientId,
	};
	const headers: Record<string, string> = {};
	applyClientAuth(auth, clientId, clientSecret, form, headers);
	if (auth.scopes && auth.scopes.length > 0) {
		form["scope"] = auth.scopes.join(" ");
	}
	const data = await oauthPost(auth.tokenUrl, form, headers, [
		clientSecret.secret,
	]);
	return tokenFromResponse(data);
}

/** Lazy refresh: POST grant_type=refresh_token → fresh token set. */
async function refreshAccessToken(
	auth: OAuth2Auth,
	domain: string,
	refreshToken: string,
): Promise<OAuthToken> {
	const { clientId, clientSecret } = resolveClientCredentials(auth, domain);
	const form: Record<string, string> = {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
	};
	const headers: Record<string, string> = {};
	applyClientAuth(auth, clientId, clientSecret, form, headers);
	const data = await oauthPost(auth.tokenUrl, form, headers, [
		refreshToken,
		...(clientSecret ? [clientSecret.secret] : []),
	]);
	return tokenFromResponse(data);
}

/**
 * Best-effort revocation: POST the access token to the guide's declared
 * `revokeUrl` (if any), then clear the local token store regardless.
 */
export async function revokeAccessToken(
	auth: OAuth2Auth,
	domain: string,
): Promise<void> {
	const token = readToken(domain, auth.grant, auth.tokenUrl);
	if (token && auth.revokeUrl) {
		try {
			const { clientId, clientSecret } = resolveClientCredentials(auth, domain);
			const form: Record<string, string> = { token: token.accessToken };
			const headers: Record<string, string> = {};
			applyClientAuth(auth, clientId, clientSecret, form, headers);
			await oauthPost(auth.revokeUrl, form, headers, [token.accessToken]);
		} catch {
			// best-effort — the local store is cleared regardless
		}
	}
	deleteToken(domain, auth.grant, auth.tokenUrl);
}

// ═══════════════════════════════════════════════════════════════
// Guide-less bootstrap — shared synthetic-auth construction
// ═══════════════════════════════════════════════════════════════

/**
 * Secrets-store domain for a not-yet-guided hostname: the hostname when it is
 * itself provisioned, else the longest provisioned parent domain
 * (api.openstreetmap.org → openstreetmap.org), else the hostname as-is (fail
 * at exchange, not silently). Matched against the SECRETS store — the wizard
 * and the probe both resolve credentials from it. ponytail: parent-suffix
 * match against the store, not a public-suffix list — no dep, and the store
 * is the source of truth for where secrets live.
 */
export function resolveProvisionedParentDomain(hostname: string): string {
	const domains = listDomains();
	if (domains.includes(hostname)) return hostname;
	const parent = domains
		.filter((d) => hostname.endsWith(`.${d}`))
		.sort((a, b) => b.length - a.length)[0];
	return parent ?? hostname;
}

/** Hostname of an apiHost URL (falls back to the raw string). */
export function hostnameOf(apiHost: string): string {
	try {
		return new URL(apiHost).hostname;
	} catch {
		return apiHost;
	}
}

/** Fields the bootstrap surfaces collect into a synthetic `OAuth2Auth`. */
export interface SyntheticOAuth2Fields {
	grant: OAuth2Grant;
	tokenUrl: string;
	/** secrets-store NAME — the value resolves at flow time, never a literal. */
	clientId: string;
	clientSecret?: string;
	authorizeUrl?: string;
	scopes?: string[];
	tokenEndpointAuthMethod?: OAuth2TokenEndpointAuthMethod;
}

/**
 * Build a synthetic oauth2 auth for the guide-less bootstrap paths (`/api
 * oauth init <domain>` and api-probe's mint arm). Shared construction pattern:
 * the synthetic auth feeds the existing resolveAccessToken / mintAuthCodeToken
 * machinery, so cache/refresh/lock/stamp is shared code. Fail-closed (command
 * semantics — the probe wraps its own try/catch around the flow): invalid
 * combinations throw instead of parsing loosely.
 */
export function buildSyntheticOAuth2Auth(f: SyntheticOAuth2Fields): OAuth2Auth {
	if (f.grant !== "client_credentials" && f.grant !== "authorization_code") {
		throw new Error(
			`--grant must be client_credentials | authorization_code (got: ${String(f.grant)})`,
		);
	}
	if (!isHttpUrl(f.tokenUrl)) {
		throw new Error(`--token-url must be an http(s) URL (got: ${f.tokenUrl})`);
	}
	if (!f.clientId) {
		throw new Error("--client-id (a provisioned store NAME) is required.");
	}
	if (
		f.tokenEndpointAuthMethod !== undefined &&
		f.tokenEndpointAuthMethod !== "client_secret_basic" &&
		f.tokenEndpointAuthMethod !== "client_secret_post" &&
		f.tokenEndpointAuthMethod !== "none"
	) {
		throw new Error(
			`--token-endpoint-auth-method must be client_secret_basic | client_secret_post | none (got: ${f.tokenEndpointAuthMethod})`,
		);
	}
	if (f.grant === "client_credentials") {
		if (!f.clientSecret) {
			throw new Error(
				"grant client_credentials requires --client-secret (a provisioned store NAME).",
			);
		}
		if (f.authorizeUrl !== undefined) {
			throw new Error(
				"--authorize-url is only valid with --grant authorization_code (client_credentials is server-to-server).",
			);
		}
	} else if (!f.authorizeUrl) {
		throw new Error(
			"grant authorization_code requires --authorize-url (the provider's authorization endpoint).",
		);
	}
	if (f.authorizeUrl !== undefined && !isHttpUrl(f.authorizeUrl)) {
		throw new Error(
			`--authorize-url must be an http(s) URL (got: ${f.authorizeUrl})`,
		);
	}
	if (f.tokenEndpointAuthMethod === "none" && f.clientSecret !== undefined) {
		throw new Error(
			"--token-endpoint-auth-method none sends no client credentials — drop --client-secret.",
		);
	}
	return {
		kind: "oauth2",
		grant: f.grant,
		tokenUrl: f.tokenUrl,
		clientId: { secret: f.clientId },
		...(f.clientSecret === undefined
			? {}
			: { clientSecret: { secret: f.clientSecret } }),
		...(f.scopes !== undefined && f.scopes.length > 0
			? { scopes: f.scopes }
			: {}),
		...(f.tokenEndpointAuthMethod === undefined
			? {}
			: { tokenEndpointAuthMethod: f.tokenEndpointAuthMethod }),
		...(f.authorizeUrl === undefined ? {} : { authorizeUrl: f.authorizeUrl }),
	};
}

function isHttpUrl(s: string): boolean {
	try {
		const u = new URL(s);
		return u.protocol === "https:" || u.protocol === "http:";
	} catch {
		return false;
	}
}
