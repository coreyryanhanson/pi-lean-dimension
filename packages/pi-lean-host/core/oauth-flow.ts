/**
 * OAuth2 authorization-code + PKCE interactive flow — host-only.
 *
 * The user consents in THEIR OWN browser at the provider, logging in with
 * their own credentials. Routing that through portal's driven browser would
 * flow the user's provider password through agent context — a hard no. So
 * this module: generates the PKCE pair, spins up a loopback HTTP listener
 * bound to 127.0.0.1 to capture the `?code=…` redirect, surfaces the
 * authorize URL for the user, exchanges the captured code, and stamps the
 * token store. No static portal import — the host-only boundary holds.
 *
 * Two completion paths:
 *  - Interactive (`ctx.hasUI`): loopback listener + user's own browser. The
 *    authorize URL is printed; the browser redirects to
 *    `http://localhost:<port>/callback` and the listener captures the code.
 *  - Headless / manual-code: print the authorize URL (redirect_uri =
 *    `auth.redirectUri`, e.g. OSM's `urn:ietf:wg:oauth:2.0:oob`) and persist
 *    the PKCE verifier as a pending flow; the user completes auth and runs
 *    `/api oauth <domain> --code <code>` to exchange it. The verifier MUST
 *    survive between the two invocations — the exchange fails if it doesn't
 *    match the challenge sent in the authorize URL.
 *
 * Import direction: oauth-flow → auth (exchange/refresh) → oauth-store; the
 * store imports nothing from here, so no cycle can form.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OAuth2Auth } from "./api-guide-types.js";
import {
	exchangeAuthCode,
	forceRefreshToken,
	resolveClientCredentials,
	OAuthTokenMissingError,
} from "./auth.js";
import {
	readPendingFlow,
	writePendingFlow,
	deletePendingFlow,
	writeToken,
} from "./oauth-store.js";
import type { OAuthToken } from "./oauth-store.js";

/** How long the loopback listener waits for the browser callback. */
export const CALLBACK_TIMEOUT_MS = 10 * 60_000;

/**
 * Thrown by `waitForCode` when the browser callback doesn't arrive in time.
 * Distinct from the `error`-param rejection so the loopback flow can turn a
 * timeout into a recoverable `--code` nudge (the verifier is still valid).
 */
class CallbackTimeoutError extends Error {
	constructor() {
		super("Timed out waiting for the OAuth2 authorization callback");
		this.name = "CallbackTimeoutError";
	}
}

/** The page served to the browser after a callback lands. */
const CALLBACK_HTML =
	"<!doctype html><html><body><p>OAuth2 authorization received — you can close this window.</p></body></html>";

function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

/** PKCE S256 pair: a random verifier + its base64url(SHA-256) challenge. */
export function generatePkcePair(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/** Random `state` value for the authorize URL + callback check. */
export function generateState(): string {
	return base64url(randomBytes(16));
}

/**
 * Build the provider's authorize URL (response_type=code + PKCE + state).
 * `redirectUri` is the exact URI the provider will redirect to — the
 * loopback path passes the dynamic `http://localhost:<port>/callback`, the
 * manual-code path passes `auth.redirectUri`.
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

/**
 * A loopback callback listener bound explicitly to `127.0.0.1` on an
 * ephemeral port — a bare `listen(port)` defaults to `0.0.0.0` on some
 * platforms and would expose the listener to the network. Every request gets
 * a "close this window" HTML response. `waitForCode` resolves the code once
 * a callback carrying a matching `state` + `code` arrives, rejects on an
 * `error` param, and rejects on timeout. The request handler is attached at
 * creation (not inside `waitForCode`) so a callback racing the wait setup is
 * never dropped.
 */
export async function startCallbackServer(): Promise<{
	port: number;
	waitForCode(state: string, timeoutMs: number): Promise<string>;
	close(): void;
}> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;

	let active: {
		state: string;
		resolve: (c: string) => void;
		reject: (e: Error) => void;
	} | null = null;
	let timer: NodeJS.Timeout | null = null;

	server.on("request", (req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(CALLBACK_HTML);
		const cur = active;
		if (!cur) return; // no active wait yet — ignore (favicon, stray GET)
		let url: URL;
		try {
			url = new URL(req.url ?? "/", "http://localhost");
		} catch {
			return; // malformed request path — already answered with the HTML
		}
		if (url.searchParams.get("state") !== cur.state) return; // state mismatch
		const error = url.searchParams.get("error");
		if (error) {
			if (timer) clearTimeout(timer);
			server.close();
			cur.reject(new Error(`OAuth2 authorization error: ${error}`));
			return;
		}
		const code = url.searchParams.get("code");
		if (code) {
			if (timer) clearTimeout(timer);
			server.close();
			cur.resolve(code);
		}
	});

	return {
		port,
		close: () => server.close(),
		waitForCode(state, timeoutMs) {
			return new Promise((resolve, reject) => {
				active = { state, resolve, reject };
				timer = setTimeout(() => {
					server.close();
					reject(new CallbackTimeoutError());
				}, timeoutMs);
			});
		},
	};
}

/** Options for `mintAuthCodeToken`. */
export interface AuthCodeMintOptions {
	/** Manual authorization code (the `--code` escape valve). */
	code?: string;
	/** Force a refresh via the stored refresh token (no re-consent). */
	refresh?: boolean;
	/** Loopback wait budget (test seam / tuning; default CALLBACK_TIMEOUT_MS). */
	timeoutMs?: number;
}

/**
 * Mint (or refresh) a token for an authorization_code guide. Order:
 * 1. `--code` → complete a pending manual-code flow.
 * 2. `--refresh` → force a refresh via the stored refresh token; falls back
 *    to the interactive flow when there is no refresh token.
 * 3. Interactive (`ctx.hasUI`) → loopback listener + user's own browser.
 *    Headless → print the authorize URL, persist the pending flow, and
 *    throw `OAuthTokenMissingError` (awaiting `--code`).
 */
export async function mintAuthCodeToken(
	auth: OAuth2Auth,
	storeDomain: string,
	ctx: ExtensionCommandContext,
	opts: AuthCodeMintOptions = {},
): Promise<OAuthToken> {
	if (opts.code !== undefined) {
		return completeManualCode(auth, storeDomain, opts.code);
	}
	if (opts.refresh) {
		try {
			return await forceRefreshToken(auth, storeDomain);
		} catch (err) {
			if (!(err instanceof OAuthTokenMissingError)) throw err;
			// no refresh token → fall through to the interactive flow
		}
	}
	if (ctx.hasUI) {
		return runLoopbackFlow(auth, storeDomain, ctx, opts.timeoutMs);
	}
	return runManualCodeFlow(auth, storeDomain, ctx);
}

/**
 * Interactive path: loopback listener captures the browser callback. The
 * pending flow is persisted up front so a loopback timeout is recoverable
 * via `--code` (the verifier must match the challenge in the printed URL) —
 * a TUI user whose browser can't reach the loopback (different machine) is
 * otherwise stuck: re-running always goes to loopback, and `--code` with no
 * pending flow fails. Deleted on success.
 */
async function runLoopbackFlow(
	auth: OAuth2Auth,
	storeDomain: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = CALLBACK_TIMEOUT_MS,
): Promise<OAuthToken> {
	const cb = await startCallbackServer();
	const redirectUri = `http://localhost:${cb.port}/callback`;
	const { verifier, challenge } = generatePkcePair();
	const state = generateState();
	const authorizeUrl = buildAuthorizeUrl(
		auth,
		redirectUri,
		challenge,
		state,
		resolveClientCredentials(auth, storeDomain).clientId,
	);
	writePendingFlow(storeDomain, { verifier, state, redirectUri });
	try {
		ctx.ui.notify(
			`🔑 Authorize '${storeDomain}' in your browser (log in with your own credentials — the agent never sees them):\n\n` +
				`${authorizeUrl}\n\nWaiting for the callback…`,
			"info",
		);
		let code: string;
		try {
			code = await cb.waitForCode(state, timeoutMs);
		} catch (err) {
			if (err instanceof CallbackTimeoutError) {
				throw new OAuthTokenMissingError(
					`Timed out waiting for the OAuth2 authorization callback for '${storeDomain}'. ` +
						`Open the URL above again and run /api oauth ${storeDomain} --code <code> to complete manually.`,
				);
			}
			throw err;
		}
		const token = await exchangeAuthCode(
			auth,
			storeDomain,
			code,
			redirectUri,
			verifier,
		);
		writeToken(storeDomain, token);
		deletePendingFlow(storeDomain);
		return token;
	} finally {
		cb.close();
	}
}

/** Headless path: print the URL, persist the pending flow, await `--code`. */
async function runManualCodeFlow(
	auth: OAuth2Auth,
	storeDomain: string,
	ctx: ExtensionCommandContext,
): Promise<never> {
	const redirectUri = auth.redirectUri!; // parser-enforced for auth-code
	const { verifier, challenge } = generatePkcePair();
	const state = generateState();
	const authorizeUrl = buildAuthorizeUrl(
		auth,
		redirectUri,
		challenge,
		state,
		resolveClientCredentials(auth, storeDomain).clientId,
	);
	writePendingFlow(storeDomain, { verifier, state, redirectUri });
	ctx.ui.notify(
		`🔑 Open this URL in your browser, authorize, then run:\n` +
			`  /api oauth ${storeDomain} --code <code>\n\n${authorizeUrl}`,
		"info",
	);
	throw new OAuthTokenMissingError(
		`Awaiting a manual OAuth2 authorization code for '${storeDomain}'. ` +
			`Open the URL above, then run /api oauth ${storeDomain} --code <code>.`,
	);
}

/** `--code` completion: exchange the pasted code with the persisted verifier. */
async function completeManualCode(
	auth: OAuth2Auth,
	storeDomain: string,
	code: string,
): Promise<OAuthToken> {
	const pending = readPendingFlow(storeDomain);
	if (!pending) {
		throw new OAuthTokenMissingError(
			`No pending OAuth2 authorization flow for '${storeDomain}'. ` +
				`Run /api oauth ${storeDomain} first to get the authorize URL.`,
		);
	}
	try {
		const token = await exchangeAuthCode(
			auth,
			storeDomain,
			code,
			pending.redirectUri,
			pending.verifier,
		);
		writeToken(storeDomain, token);
		return token;
	} finally {
		deletePendingFlow(storeDomain);
	}
}
