/**
 * OAuth2 authorization-code + PKCE flow — headless paste-based, host-only.
 *
 * The user consents in THEIR OWN browser at the provider, logging in with
 * their own credentials. Routing that through portal's driven browser would
 * flow the user's provider password through agent context — a hard no. So
 * this module: generates the PKCE pair, builds the authorize URL
 * (`redirect_uri = http://127.0.0.1/callback`, the RFC 8252 §7.3 loopback
 * convention — nothing listens there, by design), persists the pending flow,
 * and surfaces the URL. The user pastes back the address-bar redirect URL
 * (or bare code); pi validates `state`, exchanges the code, and stamps the
 * token store. No listener, no inbound network surface — the flow works
 * unchanged whether pi runs on the user's machine, in a container, or inside
 * a VM. No static portal import — the host-only boundary holds.
 *
 * Import direction: oauth-flow → auth (exchange/refresh) → oauth-store; the
 * store imports nothing from here, so no cycle can form.
 */

import { createHash, randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import type { OAuth2Auth } from "./api-guide-types.js";
import {
	exchangeAuthCode,
	forceRefreshToken,
	resolveClientCredentials,
	slotOverwriteWarning,
	OAuthTokenMissingError,
} from "./auth.js";
import {
	readPendingFlow,
	writePendingFlow,
	deletePendingFlow,
	writeToken,
} from "./oauth-store.js";
import type { OAuthToken } from "./oauth-store.js";

/**
 * The redirect-URI convention for every auth-code guide (RFC 8252 §7.3 —
 * loopback, variable port). The IP literal 127.0.0.1 is used rather than
 * `localhost`: RFC 8252 §7.3 recommends it, and some providers (OSM) accept
 * only `http://127.0.0.1*` as a non-https redirect. The redirect URI is a
 * fact of the USER's app
 * registration, not the provider's API, so the schema carries no field;
 * the runtime owns the redirect end-to-end through this one convention.
 * Nothing listens on the port — the user copies the address-bar URL.
 */
export const REDIRECT_URI = "http://127.0.0.1/callback";

function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

/** PKCE S256 pair: a random verifier + its base64url(SHA-256) challenge. */
export function generatePkcePair(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/** Random `state` value for the authorize URL + paste check. */
export function generateState(): string {
	return base64url(randomBytes(16));
}

/**
 * Build the provider's authorize URL (response_type=code + PKCE + state).
 * `redirectUri` is the URI sent as `redirect_uri` — the paste flow always
 * passes the `REDIRECT_URI` convention; it is a parameter so tests can pin
 * the wiring.
 */
export function buildAuthorizeUrl(
	auth: OAuth2Auth,
	redirectUri: string,
	challenge: string,
	state: string,
	/** The client id VALUE — resolved from the secrets store by the caller
	 *  (`clientId` is a store name, not a literal). */
	clientIdValue: string,
): string {
	const base = auth.authorizeUrl;
	if (!base) {
		throw new Error("oauth2 authorization_code guide is missing authorizeUrl");
	}
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw new Error(`oauth2 authorizeUrl is not a valid URL: ${base}`);
	}
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", clientIdValue);
	url.searchParams.set("redirect_uri", redirectUri);
	if (auth.scopes && auth.scopes.length > 0) {
		url.searchParams.set("scope", auth.scopes.join(" "));
	}
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

/** A successfully parsed paste: the code plus the state (if the URL had one). */
export interface PastedAuthResult {
	code: string;
	state?: string;
}

/**
 * Parse the user's pasted authorization result. Tolerant by design — accepts
 * the full redirect URL from the browser's address bar (documented default),
 * a host-less `127.0.0.1/callback?code=…&state=…`, a bare `code=…&state=…`
 * query, or just the bare code (which skips the state check — pi never sees
 * it). A provider rejection (`?error=…`) surfaces the provider's actual
 * reason instead of a generic "exchange failed".
 */
export function parsePastedRedirect(input: string): PastedAuthResult {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Pasted OAuth2 authorization result is empty.");
	}
	// Only treat as query-ish when it actually carries an OAuth param —
	// a bare base64-padded code contains `=` but is not a query.
	if (/(^|[?&])(code|error|state)=/.test(trimmed)) {
		// Query-ish: after a "?" if present, else the whole string.
		const qs = trimmed.includes("?")
			? trimmed.slice(trimmed.indexOf("?") + 1)
			: trimmed;
		const params = new URLSearchParams(qs);
		const error = params.get("error");
		if (error) {
			const desc = params.get("error_description");
			throw new Error(
				`OAuth2 authorization error: ${error}${desc ? ` — ${desc}` : ""}`,
			);
		}
		const code = params.get("code");
		if (!code) {
			throw new Error(
				"Pasted value carries no `code` parameter — paste the full redirect URL from the browser's address bar (or just the code).",
			);
		}
		const state = params.get("state");
		return state ? { code, state } : { code };
	}
	return { code: trimmed };
}

/** Validate a paste against the pending flow's state and return the code. */
function validatePasted(pasted: string, state: string): string {
	const parsed = parsePastedRedirect(pasted);
	if (parsed.state !== undefined && parsed.state !== state) {
		throw new Error(
			"OAuth2 state mismatch — the pasted URL doesn't match the authorize URL pi generated. " +
				"Re-run /api oauth <domain> and paste the fresh result.",
		);
	}
	return parsed.code;
}

/** Exchange the code and stamp the token store (slot-keyed by the auth). */
async function exchangeAndStamp(
	auth: OAuth2Auth,
	storeDomain: string,
	code: string,
	verifier: string,
	redirectUri: string,
): Promise<OAuthToken> {
	const token = await exchangeAuthCode(
		auth,
		storeDomain,
		code,
		redirectUri,
		verifier,
	);
	writeToken(storeDomain, auth.grant, auth.tokenUrl, token);
	return token;
}

/** Options for `mintAuthCodeToken`. */
export interface AuthCodeMintOptions {
	/** Pasted redirect URL (or bare code) — the `--code` escape valve. */
	code?: string;
	/** Force a refresh via the stored refresh token (no re-consent). */
	refresh?: boolean;
	/** Override of the default redirect URI — sent as `redirect_uri` in the
	 *  authorize request AND stored on the pending flow so the `--code`
	 *  completion exchanges with the same value (RFC 6749 §4.1.3). */
	redirectUri?: string;
}

/**
 * The human trust-gate for the secret-bearing token endpoint — the one
 * message every mint-on-demand path must confirm before exchanging
 * credentials there (the human is the trust root for agent-researched
 * token URLs). Shared by oauth-mint and api-probe's inline mint.
 */
export async function confirmTokenUrl(
	ctx: ExtensionContext,
	domain: string,
	tokenUrl: string,
	clientId: string,
): Promise<boolean> {
	return ctx.ui.confirm(
		`Confirm the token endpoint for '${domain}'`,
		`Exchange credentials at ${tokenUrl} (client: '${clientId}')? The client secret is sent to this URL.`,
	);
}

/**
 * Mint (or refresh) a token for an authorization_code guide. Order:
 * 1. `--code` → parse the pasted redirect URL / code and complete the
 *    pending flow (headless scripting; interactive users get an inline
 *    prompt instead).
 * 2. `--refresh` → force a refresh via the stored refresh token; falls back
 *    to a fresh authorize flow when there is no refresh token.
 * 3. Otherwise → print the authorize URL, persist the pending flow, and
 *    either prompt for the paste (`ctx.hasUI`) or throw
 *    `OAuthTokenMissingError` (headless — awaiting `--code`).
 */
export async function mintAuthCodeToken(
	auth: OAuth2Auth,
	storeDomain: string,
	// ExtensionContext (not the command subtype): tools drive the flow too
	// (oauth-mint). Only ui.notify/ui.input/hasUI are used.
	ctx: ExtensionContext,
	opts: AuthCodeMintOptions = {},
): Promise<OAuthToken> {
	// The `--code` and start branches both end in a fresh stamp that clobbers
	// the slot; `--refresh` is exempt (same-slot refresh, never a scope
	// change — and its fresh-flow fallback warns below).
	const warnOverwrite = (): void => {
		const warning = slotOverwriteWarning(auth, storeDomain);
		if (warning) ctx.ui.notify(warning, "warning");
	};
	if (opts.code !== undefined) {
		warnOverwrite();
		return completePastedCode(auth, storeDomain, opts.code);
	}
	if (opts.refresh) {
		try {
			return await forceRefreshToken(auth, storeDomain);
		} catch (err) {
			if (!(err instanceof OAuthTokenMissingError)) throw err;
			// no refresh token → fall through to a fresh authorize flow
		}
	}
	warnOverwrite();
	return startAuthCodeFlow(auth, storeDomain, ctx, opts.redirectUri);
}

/**
 * The authorize URL as the user should see it. With OSC 8 support the visible
 * text is just origin + path (always fits one line — no wrapping, so no
 * space-inserted copies and no link split across lines); the hyperlink
 * target carries the FULL URL, so click / copy-link always gets the intact
 * authorize URL including the query string. Without OSC 8 the visible text
 * is all the user gets, so print the full URL — plus a wrap warning, since
 * the long query string will wrap and terminal copy inserts spaces at the
 * breaks.
 */
function printableAuthorizeUrl(url: string): string {
	if (getCapabilities().hyperlinks) {
		try {
			const u = new URL(url);
			return hyperlink(`\x1b[1m${u.origin}${u.pathname}\x1b[22m`, url);
		} catch {
			// unreachable — buildAuthorizeUrl already validated the URL
		}
	}
	return (
		`\x1b[1m${url}\x1b[22m` +
		`\n(if the URL wraps across lines, remove the extra spaces at each line break after copying)`
	);
}

/**
 * The primary — and only — authorize path. Generates the PKCE pair + state,
 * builds the authorize URL with the redirect URI (default: the
 * `http://127.0.0.1/callback` convention, overridable per invocation),
 * persists the pending flow (the verifier MUST survive so the later exchange
 * matches the challenge sent in the authorize URL), prints the URL, and
 * either prompts for the paste (TUI) or throws awaiting `--code` (headless).
 */
async function startAuthCodeFlow(
	auth: OAuth2Auth,
	storeDomain: string,
	ctx: ExtensionContext,
	redirectUri: string = REDIRECT_URI,
): Promise<OAuthToken> {
	const { verifier, challenge } = generatePkcePair();
	const state = generateState();
	const authorizeUrl = buildAuthorizeUrl(
		auth,
		redirectUri,
		challenge,
		state,
		resolveClientCredentials(auth, storeDomain).clientId,
	);
	writePendingFlow(storeDomain, auth.grant, auth.tokenUrl, {
		verifier,
		state,
		redirectUri,
	});
	ctx.ui.notify(
		`🔑 Open this URL in YOUR browser and authorize (log in with your own credentials — the agent never sees them). ` +
			`Your OAuth app needs '${redirectUri}' registered as its redirect URI (default: RFC 8252 §7.3 — loopback, any port). ` +
			`After consenting, copy the redirect URL from the browser's address bar.\n\n` +
			printableAuthorizeUrl(authorizeUrl),
		"info",
	);
	if (ctx.hasUI) {
		// The paste dialog is what's on screen while the user acts — repeat the
		// URL + instructions in its title (accent-colored, multi-line, ANSI-aware
		// wrap) so they never have to hunt for it in the scrollback above.
		// Retry loop: a bad paste (typo, state mismatch, exchange hiccup) just
		// re-prompts — the pending flow (verifier + state) is unchanged, so a
		// retry is always safe. Escape/cancel exits to the --code nudge below.
		for (;;) {
			const pasted = await ctx.ui.input(
				`Open this URL in YOUR browser and authorize, then paste the redirect URL (or just the code) for '${storeDomain}':\n` +
					printableAuthorizeUrl(authorizeUrl),
				"paste the address-bar URL after consenting",
			);
			// Cancelled → fall through to the --code nudge (pending flow survives).
			if (pasted === undefined) break;
			try {
				return await completePastedCode(auth, storeDomain, pasted);
			} catch (err) {
				ctx.ui.notify(
					`🔑 ${err instanceof Error ? err.message : String(err)} — paste again, or escape to cancel.`,
					"warning",
				);
			}
		}
	}
	throw new OAuthTokenMissingError(
		`Awaiting the OAuth2 authorization result for '${storeDomain}'. ` +
			`Open the URL above, authorize, then paste the redirect URL: /api oauth ${storeDomain} --code <redirect-url-or-code>.`,
	);
}

/** `--code` (or interactive-prompt) completion: parse, validate state, exchange.
 *  The pending flow is read/written under the slot derived from the synthetic
 *  (or guide-backed) auth, so two auth-code issuers on one domain can't
 *  consume each other's verifier. */
async function completePastedCode(
	auth: OAuth2Auth,
	storeDomain: string,
	pasted: string,
): Promise<OAuthToken> {
	const pending = readPendingFlow(storeDomain, auth.grant, auth.tokenUrl);
	if (!pending) {
		throw new OAuthTokenMissingError(
			`No pending OAuth2 authorization flow for '${storeDomain}'. ` +
				`Run /api oauth ${storeDomain} (or /api oauth init ${storeDomain} guide-less) ` +
				`first to get the authorize URL.`,
		);
	}
	const code = validatePasted(pasted, pending.state);
	// The exchange's redirect_uri must match the authorize request's exactly
	// (RFC 6749 §4.1.3) — read it back from the pending flow, which remembers
	// what was sent. Records missing the field are rejected at read time, so
	// a pre-field pending entry just reads as "no pending flow" (re-run the
	// authorize step — tokens/pending are re-mintable, no migration).
	const token = await exchangeAndStamp(
		auth,
		storeDomain,
		code,
		pending.verifier,
		pending.redirectUri,
	);
	deletePendingFlow(storeDomain, auth.grant, auth.tokenUrl);
	return token;
}
