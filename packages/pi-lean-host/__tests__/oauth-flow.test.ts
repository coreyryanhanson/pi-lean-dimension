/**
 * OAuth2 authorization-code + PKCE flow tests — mocked transport + a real
 * loopback callback listener.
 *
 * Covers the Phase-2 interactive half:
 *  - PKCE pair generation + authorize-URL construction.
 *  - startCallbackServer: code capture (matching state), state-mismatch
 *    ignore, error param, timeout.
 *  - exchangeAuthCode: the token POST body (code + verifier + redirect_uri).
 *  - mintAuthCodeToken orchestration: headless pending-flow + --code
 *    completion, --code with no pending flow fail-closed, --refresh via the
 *    stored refresh token, and the interactive loopback end-to-end (real
 *    listener + browser-style callback hit).
 *
 * The token POST goes through global `fetch` (stubbed); the loopback
 * callback is hit with a real node:http request so the fetch stub never
 * intercepts it.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generatePkcePair,
	buildAuthorizeUrl,
	startCallbackServer,
	mintAuthCodeToken,
} from "../core/oauth-flow.js";
import { exchangeAuthCode, OAuthTokenMissingError } from "../core/auth.js";
import {
	readToken,
	writeToken,
	readPendingFlow,
	setOAuthDir,
} from "../core/oauth-store.js";
import { writeSecret, setSecretsDir } from "../core/secrets-store.js";
import type { OAuth2Auth } from "../core/api-guide-types.js";

const TOKEN_URL = "https://token.example.com/oauth/token";
const AUTHORIZE_URL = "https://api.example.com/oauth/authorize";
const REDIRECT_URI = "http://localhost:9999/callback";

function makeAuthCodeAuth(overrides: Partial<OAuth2Auth> = {}): OAuth2Auth {
	return {
		kind: "oauth2",
		grant: "authorization_code",
		tokenUrl: TOKEN_URL,
		// Store NAME semantics — resolved per-user from the secrets store.
		clientId: "client_id",
		secretRefs: { client_secret: { secret: "client_secret" } },
		authorizeUrl: AUTHORIZE_URL,
		redirectUri: REDIRECT_URI,
		pkce: true,
		...overrides,
	};
}

/** Stub global fetch to answer token-endpoint POSTs. */
function stubTokenEndpoint(
	handler: (url: string, init: RequestInit) => Response,
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn((url: unknown, init?: RequestInit) =>
			Promise.resolve(handler(String(url), init ?? {})),
		),
	);
}

function tokenResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Hit the loopback callback with a real HTTP request (never the fetch stub). */
function hitCallback(port: number, query: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, path: `/callback?${query}` },
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** Poll the notify mock until an authorize URL appears in its messages. */
async function waitForAuthorizeUrl(
	notify: ReturnType<typeof vi.fn>,
): Promise<string> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const text = notify.mock.calls.map((c) => c[0]).join("\n");
		const m = text.match(/https?:\/\/[^\s]+/);
		if (m) return m[0];
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("no authorize URL surfaced by the flow");
}

let tmpSecrets: string;
let tmpOAuth: string;

beforeAll(() => {
	tmpSecrets = mkdtempSync(join(tmpdir(), "host-oauthflow-secrets-"));
	tmpOAuth = mkdtempSync(join(tmpdir(), "host-oauthflow-tokens-"));
	setSecretsDir(tmpSecrets);
	setOAuthDir(tmpOAuth);
});

afterAll(() => {
	vi.unstubAllGlobals();
	rmSync(tmpSecrets, { recursive: true, force: true });
	rmSync(tmpOAuth, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════��═══════════════
// PKCE + authorize URL
// ═══════════════════════════════════════════════════════════════════

describe("PKCE pair + authorize URL", () => {
	it("generates a verifier and its S256 challenge", () => {
		const { verifier, challenge } = generatePkcePair();
		expect(verifier.length).toBeGreaterThan(40);
		// challenge = base64url(SHA-256(verifier)) — recompute to prove it.
		expect(challenge).toBe(
			createHash("sha256").update(verifier).digest("base64url"),
		);
	});

	it("builds the authorize URL with code + PKCE + state", () => {
		const auth = makeAuthCodeAuth({ scopes: ["read", "read:statuses"] });
		// clientId is a store NAME — the caller passes the resolved value.
		const url = new URL(
			buildAuthorizeUrl(auth, REDIRECT_URI, "CHALLENGE", "STATE", "MY_CLIENT"),
		);
		expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe("MY_CLIENT");
		expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(url.searchParams.get("scope")).toBe("read read:statuses");
		expect(url.searchParams.get("state")).toBe("STATE");
		expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});
});

// ═══════════════════════════════════════════════════════════════════
// startCallbackServer — loopback listener
// ═══════════════════════════════════════════════════════════════════

describe("startCallbackServer", () => {
	it("captures the code when the callback carries a matching state", async () => {
		const cb = await startCallbackServer();
		try {
			const codePromise = cb.waitForCode("EXPECTED", 2000);
			const status = await hitCallback(cb.port, "code=CB&state=EXPECTED");
			expect(status).toBe(200);
			await expect(codePromise).resolves.toBe("CB");
		} finally {
			cb.close();
		}
	});

	it("ignores a state mismatch, then resolves on the matching callback", async () => {
		const cb = await startCallbackServer();
		try {
			const codePromise = cb.waitForCode("EXPECTED", 2000);
			await hitCallback(cb.port, "code=WRONG&state=OTHER");
			// Still pending after the mismatched callback.
			let settled = false;
			codePromise.then(
				() => (settled = true),
				() => (settled = true),
			);
			await new Promise((r) => setTimeout(r, 50));
			expect(settled).toBe(false);
			await hitCallback(cb.port, "code=GOOD&state=EXPECTED");
			await expect(codePromise).resolves.toBe("GOOD");
		} finally {
			cb.close();
		}
	});

	it("rejects on an error param", async () => {
		const cb = await startCallbackServer();
		try {
			const codePromise = cb.waitForCode("EXPECTED", 2000);
			// Attach the rejection handler before the callback fires so the
			// rejection is never observed as unhandled.
			const assertion = expect(codePromise).rejects.toThrow("access_denied");
			await hitCallback(cb.port, "error=access_denied&state=EXPECTED");
			await assertion;
		} finally {
			cb.close();
		}
	});

	it("times out when no callback arrives", async () => {
		const cb = await startCallbackServer();
		try {
			await expect(cb.waitForCode("EXPECTED", 50)).rejects.toThrow(
				"Timed out waiting",
			);
		} finally {
			cb.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// exchangeAuthCode — the token POST
// ═══════════════════════════════════════════════════════════════════

describe("exchangeAuthCode", () => {
	it("POSTs grant_type=authorization_code with code + verifier + redirect_uri", async () => {
		writeSecret("oauth.exchange", "client_id", "MY_CLIENT");
		writeSecret("oauth.exchange", "client_secret", "S3CRET");
		const auth = makeAuthCodeAuth();
		stubTokenEndpoint((url, init) => {
			expect(url).toBe(TOKEN_URL);
			const body = String(init.body);
			expect(body).toContain("grant_type=authorization_code");
			expect(body).toContain("code=THE-CODE");
			expect(body).toContain("code_verifier=VERIFIER");
			expect(body).toContain("redirect_uri=" + encodeURIComponent(REDIRECT_URI));
			expect(body).toContain("client_secret=S3CRET");
			return tokenResponse({
				access_token: "EXCHANGED",
				refresh_token: "RT",
				expires_in: 3600,
			});
		});

		const token = await exchangeAuthCode(
			auth,
			"oauth.exchange",
			"THE-CODE",
			REDIRECT_URI,
			"VERIFIER",
		);
		expect(token.accessToken).toBe("EXCHANGED");
		expect(token.refreshToken).toBe("RT");
	});
});

// ═══════════════════════════════════════════════════════════════════
// mintAuthCodeToken — orchestration
// ═══════════════════════════════════════════════════════════════════

describe("mintAuthCodeToken", () => {
	function headlessCtx() {
		return { hasUI: false, ui: { notify: vi.fn() } } as any;
	}

	it("headless: prints the URL, persists the pending flow, and --code completes it", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.manual", "client_id", "MY_CLIENT");
		const ctx = headlessCtx();
		stubTokenEndpoint(() =>
			tokenResponse({
				access_token: "MANUAL",
				refresh_token: "RT",
				expires_in: 3600,
			}),
		);

		await expect(
			mintAuthCodeToken(auth, "oauth.manual", ctx, {}),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
		// Pending flow persisted with the verifier that produced the challenge.
		const pending = readPendingFlow("oauth.manual");
		expect(pending).not.toBeNull();
		const text = ctx.ui.notify.mock.calls.map((c: unknown[]) => c[0]).join("\n");
		expect(text).toContain("--code <code>");
		const url = text.match(/https?:\/\/[^\s]+/)?.[0];
		expect(url).toContain("code_challenge=");
		expect(url).toContain("redirect_uri=" + encodeURIComponent(REDIRECT_URI));

		// --code completes with the persisted verifier and stamps the store.
		const token = await mintAuthCodeToken(auth, "oauth.manual", ctx, {
			code: "PASTED",
		});
		expect(token.accessToken).toBe("MANUAL");
		expect(readToken("oauth.manual")?.accessToken).toBe("MANUAL");
		expect(readPendingFlow("oauth.manual")).toBeNull();
	});

	it("--code with no pending flow fails closed", async () => {
		const auth = makeAuthCodeAuth();
		await expect(
			mintAuthCodeToken(auth, "oauth.nopending", headlessCtx(), {
				code: "X",
			}),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
	});

	it("--refresh forces a refresh via the stored refresh token (no re-consent)", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.force", "client_id", "MY_CLIENT");
		writeSecret("oauth.force", "client_secret", "S3CRET");
		writeToken("oauth.force", {
			accessToken: "OLD",
			refreshToken: "RT-1",
			expiresAt: Date.now() + 300_000, // still fresh — refresh is forced
		});
		stubTokenEndpoint((_url, init) => {
			expect(String(init.body)).toContain("grant_type=refresh_token");
			expect(String(init.body)).toContain("refresh_token=RT-1");
			return tokenResponse({
				access_token: "FRESH",
				refresh_token: "RT-2",
				expires_in: 3600,
			});
		});

		const token = await mintAuthCodeToken(auth, "oauth.force", headlessCtx(), {
			refresh: true,
		});
		expect(token.accessToken).toBe("FRESH");
		expect(readToken("oauth.force")?.refreshToken).toBe("RT-2");
	});

	it("--refresh with no refresh token falls through to the interactive flow", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.norefresh", "client_id", "MY_CLIENT");
		const ctx = headlessCtx();
		await expect(
			mintAuthCodeToken(auth, "oauth.norefresh", ctx, { refresh: true }),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
		// Fell through to the headless manual-code path → pending flow written.
		expect(readPendingFlow("oauth.norefresh")).not.toBeNull();
	});

	it("interactive: loopback listener captures the callback and exchanges the code", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.loop", "client_id", "MY_CLIENT");
		writeSecret("oauth.loop", "client_secret", "S3CRET");
		const ctx = { hasUI: true, ui: { notify: vi.fn() } } as any;
		stubTokenEndpoint((_url, init) => {
			const body = String(init.body);
			expect(body).toContain("grant_type=authorization_code");
			expect(body).toContain("code_verifier=");
			return tokenResponse({
				access_token: "LOOP",
				refresh_token: "RT",
				expires_in: 3600,
			});
		});

		const promise = mintAuthCodeToken(auth, "oauth.loop", ctx, {});
		const url = await waitForAuthorizeUrl(ctx.ui.notify);
		const u = new URL(url);
		// The loopback port lives in the redirect_uri query param (the
		// authorize URL itself carries no port).
		const redirectUri = u.searchParams.get("redirect_uri")!;
		expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
		const port = Number(new URL(redirectUri).port);
		const state = u.searchParams.get("state");

		const status = await hitCallback(port, `code=CB-CODE&state=${state}`);
		expect(status).toBe(200);
		const token = await promise;
		expect(token.accessToken).toBe("LOOP");
		expect(readToken("oauth.loop")?.accessToken).toBe("LOOP");
		// A successful loopback clears the pending flow it wrote up front.
		expect(readPendingFlow("oauth.loop")).toBeNull();
	});

	it("interactive: a loopback timeout is recoverable via --code (pending flow persisted)", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.timeout", "client_id", "MY_CLIENT");
		const ctx = { hasUI: true, ui: { notify: vi.fn() } } as any;
		// No callback hit — the short budget times out, the pending flow stays
		// (so a TUI user whose browser can't reach the loopback isn't stuck),
		// and the failure is a recoverable nudge, not a raw error.
		await expect(
			mintAuthCodeToken(auth, "oauth.timeout", ctx, { timeoutMs: 50 }),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
		expect(readPendingFlow("oauth.timeout")).not.toBeNull();

		// --code completes the recovered flow with the persisted verifier.
		stubTokenEndpoint(() =>
			tokenResponse({
				access_token: "RECOVERED",
				refresh_token: "RT",
				expires_in: 3600,
			}),
		);
		const token = await mintAuthCodeToken(auth, "oauth.timeout", ctx, {
			code: "PASTED",
		});
		expect(token.accessToken).toBe("RECOVERED");
		expect(readToken("oauth.timeout")?.accessToken).toBe("RECOVERED");
		expect(readPendingFlow("oauth.timeout")).toBeNull();
	});
});
