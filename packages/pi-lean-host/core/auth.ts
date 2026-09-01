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
	isOAuth2Grant,
	isOAuth2TokenEndpointAuthMethod,
	oauth2GrantIssue,
	OAUTH2_GRANTS,
	OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS,
	type OAuth2GrantIssue,
} from "./api-guide-types.js";
import {
	listDomains,
	listNames,
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
 * Secret store-names a guide's auth block declares, from `auth.secretRefs`
 * and `auth.secretQueryRefs` (ref.secret values). For oauth2 the clientId/
 * clientSecret refs are declared too — their store names are resolved
 * per-user, so assisted provisioning should prompt for them. Empty for
 * guides without keyed/oauth auth. Single source of truth for both the
 * `/api secrets` assisted-entry and the `api-store` declared/gap report.
 */
export function declaredSecretRefNames(guide: ApiGuide): string[] {
	const names = new Set<string>();
	switch (guide.auth.kind) {
		case "static-key":
			for (const ref of Object.values(guide.auth.secretRefs ?? {}))
				names.add(ref.secret);
			for (const ref of Object.values(guide.auth.secretQueryRefs ?? {}))
				names.add(ref.secret);
			break;
		case "oauth2":
			// clientId/clientSecret are SecretRefs resolved per-user — declare
			// their store names so assisted provisioning prompts for them.
			for (const ref of [guide.auth.clientId, guide.auth.clientSecret])
				if (ref) names.add(ref.secret);
			for (const ref of Object.values(guide.auth.secretRefs ?? {}))
				names.add(ref.secret);
			break;
		case "none":
			break;
		default: {
			const _exhaustive: never = guide.auth;
			throw new Error(`Unhandled auth kind: ${_exhaustive}`);
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Metadata-only auth status footer line, shared by `api-guide` and `api-fetch`.
 * Five static-key states (no-auth → undefined / ok / nudge-provision /
 * ok-optional / optional-not-provisioned) plus the oauth2 states (ok /
 * expired-but-refreshable / missing → nudge /api oauth). Never renders a
 * secret value — names only.
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

// ═══════════════════════════════════════════════════════════════════
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

/** Granted scopes for a minted token: what the provider echoed at mint;
 *  absent → the requested scopes with `assumed: true` (RFC 6749 §5.1 —
 *  granted = requested). Empty when neither is on record. */
export function grantedScopes(
	scope: string | undefined,
	requested: string[],
): { scopes: string[]; assumed: boolean } {
	const echo = scope?.split(/\s+/).filter(Boolean) ?? [];
	if (echo.length > 0) return { scopes: echo, assumed: false };
	return { scopes: requested, assumed: requested.length > 0 };
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
	// Chain onto the current holder instead of wait-then-run: everyone who
	// awaited the same in-flight promise would otherwise resume as a herd and
	// run fn() concurrently (double-spending a rotated refresh token).
	const prev = tokenLocks.get(lockKey) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(fn);
	tokenLocks.set(lockKey, next);
	try {
		return await next;
	} finally {
		if (tokenLocks.get(lockKey) === next) tokenLocks.delete(lockKey);
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

/**
 * Loud misconfiguration guard: a static `Authorization` header (from
 * secretRefs) collides with the oauth2 bearer injection — fetch merges
 * same-named headers case-insensitively, so both would ride one garbled
 * `Authorization: Bearer x, Bearer y` header. Fail loudly instead.
 */
export function assertNoBearerCollision(
	headers: Record<string, string>,
	source: string,
): void {
	const clash = Object.keys(headers).find(
		(k) => k.toLowerCase() === "authorization",
	);
	if (clash !== undefined) {
		throw new Error(
			`oauth2 bearer injection collides with the static '${clash}' header declared via ${source} — ` +
				`declare the secret under a different header (e.g. Client-Id) or set paramStyle: query.`,
		);
	}
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
	assertNoBearerCollision(resolvedHeaders, "secretRefs");
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
 * the token endpoint cannot be called without it — or when a declared,
 * non-optional `clientSecret` is unprovisioned (fail closed with a naming
 * nudge rather than silently degrading to an unauthenticated public client
 * and a bare provider `invalid_client` at exchange time).
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
	if (ref && clientSecret === null && !ref.optional) {
		throw new OAuthTokenMissingError(
			`OAuth2 client secret '${ref.secret}' is declared but not provisioned ` +
				`for '${domain}'. Run /api secrets ${domain} ${ref.secret}, or mark ` +
				`the ref optional to proceed as a PKCE public client.`,
		);
	}
	return {
		clientId,
		...(clientSecret !== null && ref
			? { clientSecret: { secret: clientSecret, refName: ref.secret } }
			: { clientSecret: null }),
	};
}

/**
 * Which of the given secrets-store NAMES are not provisioned for `domain`.
 * Shared by oauth-mint and /api oauth init — both mint paths key credentials
 * on store NAMEs (values never enter the transcript), so both precheck the
 * same store before touching any prompt or endpoint.
 */
export function missingCredentialNames(
	domain: string,
	names: string[],
): string[] {
	const provisioned = listNames(domain);
	return names.filter((n) => !provisioned.includes(n));
}

/**
 * Shared store-name precheck for both mint paths (oauth-mint tool +
 * `/api oauth init`): returns the user-facing gap message, or null when all
 * credential NAMES are provisioned. Keeps the security prose
 * ("values never enter the transcript") in exactly one place.
 * Caller decides delivery: notify (command) vs throw (tool).
 */
export function credentialNameGap(
	storeDomain: string,
	clientId: string,
	clientSecret?: string,
): string | null {
	const missing = missingCredentialNames(storeDomain, [
		clientId,
		...(clientSecret === undefined ? [] : [clientSecret]),
	]);
	if (missing.length === 0) return null;
	return (
		`OAuth2 client credentials must be provisioned store NAMEs, but ${missing.map((n) => `'${n}'`).join(", ")} ` +
		`are not in the secrets store for '${storeDomain}'. ` +
		`Provision them first: /api secrets ${storeDomain} <name> (values never enter the transcript).`
	);
}

/**
 * Mint-time overwrite warning: slots are keyed (domain, grant, tokenUrl), so
 * a same-grant re-mint with different scopes/issuer silently replaces the
 * previous token — the documented mitigation for the reserved slot-key seam
 * (scopes/clientId are deliberately excluded from the key). Returns the
 * warning text when a token already occupies the slot, else null; callers
 * render via ctx.ui.notify (this module stays ui-free).
 */
export function slotOverwriteWarning(
	auth: OAuth2Auth,
	domain: string,
): string | null {
	const existing = readToken(domain, auth.grant, auth.tokenUrl);
	if (!existing) return null;
	return `⚠ Overwriting an existing token for this slot (${auth.grant}) — previous scope: ${existing.scope ?? "(none)"}.`;
}

/**
 * Fresh client_credentials mint: drop the slot's cached token, then mint.
 * Shared by `/api oauth init` and oauth-mint — bootstrap paths that always
 * want a fresh mint, never a cached token. Both must slot-scope the delete
 * (a bare domain delete would leave a stale prior-grant/prior-issuer slot
 * surviving the re-mint). NOTE: the plain command's `--refresh` arm stays
 * inline — its delete is conditional on the flag; resolving the cached
 * token is the default there.
 */
export async function mintFreshClientCredentials(
	auth: OAuth2Auth,
	domain: string,
): Promise<void> {
	deleteToken(domain, auth.grant, auth.tokenUrl);
	await resolveAccessToken(auth, domain);
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
 * (the default) → `client_secret` form field. Mutates `form` / `headers`.
 * No-op without a client secret (PKCE public clients). Returns extra values
 * callers must add to their `secretValues` scrub set — the Basic credential
 * (`base64(clientId:secret)`, and its full header form) is a secret a
 * token-endpoint error body can echo, just like the raw secret.
 */
function applyClientAuth(
	auth: OAuth2Auth,
	clientId: string,
	clientSecret: { secret: string } | null,
	form: Record<string, string>,
	headers: Record<string, string>,
): string[] {
	if (!clientSecret) return [];
	const method = auth.tokenEndpointAuthMethod ?? "client_secret_post";
	if (method === "client_secret_basic") {
		const cred = Buffer.from(`${clientId}:${clientSecret.secret}`).toString(
			"base64",
		);
		headers["authorization"] = "Basic " + cred;
		return [cred, `Basic ${cred}`];
	} else if (method === "client_secret_post") {
		form["client_secret"] = clientSecret.secret;
	}
	return [];
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
	const clientAuthValues = applyClientAuth(
		auth,
		clientId,
		clientSecret,
		form,
		headers,
	);
	const data = await oauthPost(auth.tokenUrl, form, headers, [
		code,
		...(clientSecret ? [clientSecret.secret] : []),
		...clientAuthValues,
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
	// ponytail: fixed 30s matching transport's DEFAULT_TIMEOUT — configurable
	// only if a provider ever needs more. Without this, a hung token endpoint
	// holds the per-slot lock (and the user's command) until undici's 300s
	// headersTimeout finally gives up.
	const ac = new AbortController();
	const timer = setTimeout(
		() => ac.abort(new Error("OAuth2 endpoint timeout (30s)")),
		30_000,
	);
	try {
		// The timer spans headers AND the body read — a server that sends
		// headers then stalls mid-body is hung just as hard as one that never
		// answers (mirrors singleGet's abort scope in transport.ts).
		const res = await fetch(url, {
			method: "POST",
			redirect: "error", // token endpoints never redirect; a 3xx must not forward secret-bearing bodies
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...headers,
			},
			body: new URLSearchParams(form).toString(),
			signal: ac.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			// Scrub before slicing — a secret straddling the cut would otherwise
			// leave its prefix unredacted.
			throw new Error(
				`OAuth2 endpoint ${res.status}: ${scrubSecretValues(text, secretValues).slice(0, 300)}`,
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
	} finally {
		clearTimeout(timer);
	}
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
	// Some providers return a string despite RFC 6749 §5.1 — coerce or the
	// token is cached as eternal (isTokenExpired treats missing expiresAt as fresh).
	const raw = data["expires_in"];
	const expiresIn = typeof raw === "string" ? Number(raw) : raw;
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
	const clientAuthValues = applyClientAuth(
		auth,
		clientId,
		clientSecret,
		form,
		headers,
	);
	if (auth.scopes && auth.scopes.length > 0) {
		form["scope"] = auth.scopes.join(" ");
	}
	const data = await oauthPost(auth.tokenUrl, form, headers, [
		clientSecret.secret,
		...clientAuthValues,
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
	const clientAuthValues = applyClientAuth(
		auth,
		clientId,
		clientSecret,
		form,
		headers,
	);
	const data = await oauthPost(auth.tokenUrl, form, headers, [
		refreshToken,
		...(clientSecret ? [clientSecret.secret] : []),
		...clientAuthValues,
	]);
	const fresh = tokenFromResponse(data);
	// RFC 6749 §6: the refresh response MAY omit refresh_token (e.g. GitHub,
	// OSM) — the old one stays valid. Carry it forward so refresh capability
	// isn't silently destroyed on the next expiry.
	if (!fresh.refreshToken) fresh.refreshToken = refreshToken;
	return fresh;
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
			const clientAuthValues = applyClientAuth(
				auth,
				clientId,
				clientSecret,
				form,
				headers,
			);
			await oauthPost(auth.revokeUrl, form, headers, [
				token.accessToken,
				...(clientSecret ? [clientSecret.secret] : []),
				...clientAuthValues,
			]);
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
	if (!isOAuth2Grant(f.grant)) {
		throw new Error(
			`--grant must be ${OAUTH2_GRANTS.join(" | ")} (got: ${String(f.grant)})`,
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
		!isOAuth2TokenEndpointAuthMethod(f.tokenEndpointAuthMethod)
	) {
		throw new Error(
			`--token-endpoint-auth-method must be ${OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS.join(" | ")} (got: ${String(f.tokenEndpointAuthMethod)})`,
		);
	}
	if (f.authorizeUrl !== undefined && !isHttpUrl(f.authorizeUrl)) {
		throw new Error(
			`--authorize-url must be an http(s) URL (got: ${f.authorizeUrl})`,
		);
	}
	// An empty-string secret is a mistyped flag, not a credential — treat it
	// as absent so client_credentials fails loudly here (store resolution
	// would only misreport it later).
	const clientSecret = f.clientSecret || undefined;
	// Grant invariants — shared with the guide parser (parse-api-guide.ts);
	// one statement of the cross-field rules for both surfaces.
	const issue = oauth2GrantIssue({
		grant: f.grant,
		hasClientSecret: clientSecret !== undefined,
		authorizeUrl: f.authorizeUrl,
		tokenEndpointAuthMethod: f.tokenEndpointAuthMethod,
	});
	if (issue) {
		throw new Error(syntheticGrantIssueMessage(issue.code));
	}
	const auth: OAuth2Auth = {
		kind: "oauth2",
		grant: f.grant,
		tokenUrl: f.tokenUrl,
		clientId: { secret: f.clientId },
	};
	if (clientSecret !== undefined) {
		auth.clientSecret = { secret: clientSecret };
	}
	if (f.scopes !== undefined && f.scopes.length > 0) {
		auth.scopes = f.scopes;
	}
	if (f.tokenEndpointAuthMethod !== undefined) {
		auth.tokenEndpointAuthMethod = f.tokenEndpointAuthMethod;
	}
	if (f.authorizeUrl !== undefined) {
		auth.authorizeUrl = f.authorizeUrl;
	}
	return auth;
}

/** CLI-flag phrasing of the shared grant-invariant codes for the
 * bootstrap surfaces (`/api oauth init`, api-probe mint arm, oauth-mint). */
function syntheticGrantIssueMessage(code: OAuth2GrantIssue["code"]): string {
	switch (code) {
		case "noneWithSecret":
			return "--token-endpoint-auth-method none sends no client credentials — drop --client-secret.";
		case "ccRequiresSecret":
			return "grant client_credentials requires --client-secret (a provisioned store NAME).";
		case "ccRejectsAuthorizeUrl":
			return "--authorize-url is only valid with --grant authorization_code (client_credentials is server-to-server).";
		case "acRequiresAuthorizeUrl":
			return "grant authorization_code requires --authorize-url (the provider's authorization endpoint).";
	}
}

function isHttpUrl(s: string): boolean {
	try {
		const u = new URL(s);
		return u.protocol === "https:" || u.protocol === "http:";
	} catch {
		return false;
	}
}
