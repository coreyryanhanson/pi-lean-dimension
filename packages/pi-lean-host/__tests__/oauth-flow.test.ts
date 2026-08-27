/**
 * OAuth2 authorization-code + PKCE flow tests — mocked transport, headless
 * paste-based flow (no listener, no inbound network).
 *
 * Covers the Phase-2.6 headless-only flow:
 *  - PKCE pair generation + authorize-URL construction (redirect_uri is the
 *    http://127.0.0.1/callback convention).
 *  - parsePastedRedirect: bare code, full address-bar URL (state surfaced),
 *    host-less / bare-query inputs, provider `?error=` surfacing, no-code
 *    and empty-input failures.
 *  - exchangeAuthCode: the token POST body (code + verifier + redirect_uri).
 *  - mintAuthCodeToken orchestration: pending-flow + --code completion (bare
 *    code and full URL with state), state-mismatch rejection (pending flow
 *    survives), --code with no pending flow fail-closed, --refresh via the
 *    stored refresh token.
 *
 * The token POST goes through global `fetch` (stubbed).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generatePkcePair,
	generateState,
	buildAuthorizeUrl,
	parsePastedRedirect,
	mintAuthCodeToken,
	REDIRECT_URI,
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

function makeAuthCodeAuth(overrides: Partial<OAuth2Auth> = {}): OAuth2Auth {
	return {
		kind: "oauth2",
		grant: "authorization_code",
		tokenUrl: TOKEN_URL,
		// Store-ref semantics — resolved per-user from the secrets store.
		clientId: { secret: "client_id" },
		clientSecret: { secret: "client_secret" },
		authorizeUrl: AUTHORIZE_URL,
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

// ═══════════════════════════════════════════════════════════════════
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
// parsePastedRedirect — the paste is the only completion input
// ═══════════════════════════════════════════════════════════════════

describe("parsePastedRedirect", () => {
	it("accepts the full redirect URL (documented default) with state", () => {
		const r = parsePastedRedirect(
			`http://127.0.0.1/callback?code=CB&state=${generateState()}`,
		);
		expect(r.code).toBe("CB");
		expect(r.state).toBeDefined();
	});

	it("accepts a host-less redirect URL", () => {
		const r = parsePastedRedirect("localhost/callback?code=CB&state=ST");
		expect(r.code).toBe("CB");
		expect(r.state).toBe("ST");
	});

	it("accepts a bare query string", () => {
		expect(parsePastedRedirect("code=CB&state=ST")).toEqual({
			code: "CB",
			state: "ST",
		});
	});

	it("accepts a bare code (state check skipped — pi never sees it)", () => {
		expect(parsePastedRedirect("CB-RAW-VALUE")).toEqual({ code: "CB-RAW-VALUE" });
	});

	it("tolerates surrounding whitespace and other params", () => {
		const r = parsePastedRedirect(
			"  http://127.0.0.1/callback?foo=1&code=CB&bar=2&state=ST  ",
		);
		expect(r.code).toBe("CB");
		expect(r.state).toBe("ST");
	});

	it("surfaces the provider's error + description", () => {
		expect(() =>
			parsePastedRedirect(
				"http://127.0.0.1/callback?error=access_denied&error_description=User+cancelled",
			),
		).toThrow("access_denied — User cancelled");
	});

	it("rejects a query with no code", () => {
		expect(() => parsePastedRedirect("state=ST")).toThrow("no `code`");
	});

	it("rejects an empty paste", () => {
		expect(() => parsePastedRedirect("   ")).toThrow("empty");
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

	it("headless: prints the URL with the redirect convention, persists the pending flow, and --code completes it", async () => {
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

		// The headless nudge teaches the --code completion path.
		await expect(
			mintAuthCodeToken(auth, "oauth.manual", ctx, {}),
		).rejects.toThrow(/--code/);
		// Pending flow persisted with the verifier that produced the challenge.
		const pending = readPendingFlow("oauth.manual");
		expect(pending).not.toBeNull();
		expect(pending?.redirectUri).toBe(REDIRECT_URI);
		const text = ctx.ui.notify.mock.calls.map((c: unknown[]) => c[0]).join("\n");
		expect(text).toContain("127.0.0.1/callback"); // registration convention
		const url = text.match(/https?:\/\/\S*code_challenge=\S+/)?.[0];
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

	it("--code accepts the full redirect URL and validates the state", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.state", "client_id", "MY_CLIENT");
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "STATEFUL", expires_in: 3600 }),
		);
		await expect(
			mintAuthCodeToken(auth, "oauth.state", headlessCtx(), {}),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
		const pending = readPendingFlow("oauth.state");
		expect(pending).not.toBeNull();

		// Mismatched state → rejected, pending flow survives for a retry.
		const pasted = `http://127.0.0.1/callback?code=X&state=WRONG-${pending?.state}`;
		await expect(
			mintAuthCodeToken(auth, "oauth.state", headlessCtx(), { code: pasted }),
		).rejects.toThrow("state mismatch");
		expect(readPendingFlow("oauth.state")).not.toBeNull();

		// Matching state → completes.
		const good = `http://127.0.0.1/callback?code=GOOD&state=${pending?.state}`;
		const token = await mintAuthCodeToken(auth, "oauth.state", headlessCtx(), {
			code: good,
		});
		expect(token.accessToken).toBe("STATEFUL");
		expect(readToken("oauth.state")?.accessToken).toBe("STATEFUL");
		expect(readPendingFlow("oauth.state")).toBeNull();
	});

	it("--code surfaces a provider ?error= paste", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.denied", "client_id", "MY_CLIENT");
		await expect(
			mintAuthCodeToken(auth, "oauth.denied", headlessCtx(), {}),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
		await expect(
			mintAuthCodeToken(auth, "oauth.denied", headlessCtx(), {
				code:
					"http://127.0.0.1/callback?error=access_denied&error_description=Nope",
			}),
		).rejects.toThrow("access_denied — Nope");
		// The pending flow survives a failed paste — the user can retry.
		expect(readPendingFlow("oauth.denied")).not.toBeNull();
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

	it("--refresh with no refresh token falls through to a fresh authorize URL", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.norefresh", "client_id", "MY_CLIENT");
		const ctx = headlessCtx();
		await expect(
			mintAuthCodeToken(auth, "oauth.norefresh", ctx, { refresh: true }),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
		// Fell through to the authorize path → pending flow written.
		expect(readPendingFlow("oauth.norefresh")).not.toBeNull();
	});

	it("interactive (hasUI): prompts for the paste and completes inline", async () => {
		const auth = makeAuthCodeAuth();
		writeSecret("oauth.prompt", "client_id", "MY_CLIENT");
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "PROMPTED", expires_in: 3600 }),
		);
		let pending: ReturnType<typeof readPendingFlow>;
		const ctx = {
			hasUI: true,
			ui: {
				notify: vi.fn(),
				input: async () => {
					// The pending flow is written BEFORE the prompt so the paste
					// can be validated against the generated state.
					pending = readPendingFlow("oauth.prompt");
					return `http://127.0.0.1/callback?code=CB&state=${pending?.state}`;
				},
			},
		} as any;

		const token = await mintAuthCodeToken(auth, "oauth.prompt", ctx, {});
		expect(token.accessToken).toBe("PROMPTED");
		expect(readToken("oauth.prompt")?.accessToken).toBe("PROMPTED");
		expect(readPendingFlow("oauth.prompt")).toBeNull();
	});
});
