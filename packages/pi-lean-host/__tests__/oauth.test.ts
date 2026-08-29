/**
 * OAuth2 (client_credentials) structural tests — mocked transport + mocked
 * token endpoint.
 *
 * Covers the Phase-1 client-credentials runtime:
 *  - resolveAccessToken: mint → store, cache hit (no re-fetch), expiry →
 *    refresh, expiry → re-mint, fail-closed (no client_secret / auth-code
 *    with no interactive flow), skew buffer.
 *  - resolveOpForExecution oauth2 arm: Bearer injection reaches the
 *    transport; the access token is scrubbed from a 401 body.
 *  - query style: the token rides ?access_token= and is redacted from the
 *    surfaced URL.
 *  - /api oauth --status / --revoke handler paths (metadata-only + store
 *    clear).
 *
 * The token POST goes through global `fetch` (stubbed); the API GETs go
 * through the real transport against a local test server.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";
import {
	resolveAccessToken,
	revokeAccessToken,
	isTokenExpired,
	OAuthTokenMissingError,
} from "../core/auth.js";
import {
	readToken,
	writeToken,
	setOAuthDir,
	writePendingFlow,
	readPendingFlow,
} from "../core/oauth-store.js";
import { writeSecret, setSecretsDir } from "../core/secrets-store.js";
import { resolveOpForExecution } from "../core/resolve-op.js";
import { handleOauthSubcommand } from "../core/oauth-command.js";
import type {
	ApiGuide,
	OAuth2Auth,
	Operation,
} from "../core/api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

// makeOAuthGuide's grant + tokenUrl — the token-slot key in every fixture.
const CC = "client_credentials";
const TT = "https://token.example.com/oauth/token";

function makeOAuthGuide(
	apiHost: string,
	overrides: Partial<ApiGuide["auth"] & { domains?: string[] }> = {},
): ApiGuide & { auth: OAuth2Auth } {
	const auth = {
		kind: "oauth2" as const,
		grant: "client_credentials" as const,
		tokenUrl: "https://token.example.com/oauth/token",
		// Store-NAME semantics — resolved per-user from the secrets store.
		clientId: { secret: "client_id" },
		clientSecret: { secret: "client_secret" },
		...overrides,
	};
	return {
		content: "",
		updated: "2026-12-01",
		category: "site",
		source: "user",
		icon: "🔑",
		shortName: "OAuth",
		domains: overrides.domains ?? ["oauth.test"],
		kind: "api",
		apiHost,
		verified: "2026-12-01",
		gatherAllMax: 1000,
		auth,
		responseShape: { format: "json", charset: "utf-8" },
		operations: [],
	} as ApiGuide & { auth: OAuth2Auth };
}

function makeOp(path: string): Operation {
	return {
		name: "op",
		via: "restGet",
		path,
		accept: "json",
		params: {},
		pathParams: [],
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

/** Provision both oauth2 credentials for a domain (clientId/clientSecret
 *  are store refs — minting reads them like any other secret). */
function provisionCreds(domain: string): void {
	writeSecret(domain, "client_id", "MY_CLIENT");
	writeSecret(domain, "client_secret", "S3CRET");
}

beforeAll(() => {
	tmpSecrets = mkdtempSync(join(tmpdir(), "host-oauth-secrets-"));
	tmpOAuth = mkdtempSync(join(tmpdir(), "host-oauth-tokens-"));
	setSecretsDir(tmpSecrets);
	setOAuthDir(tmpOAuth);
});

afterAll(() => {
	vi.unstubAllGlobals();
	rmSync(tmpSecrets, { recursive: true, force: true });
	rmSync(tmpOAuth, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// resolveAccessToken — mint / cache / refresh / fail-closed
// ═══════════════════════════════════════════════════════════════════

describe("resolveAccessToken (client_credentials)", () => {
	it("mints a token via the token endpoint and returns the Bearer header", async () => {
		provisionCreds("oauth.test");
		const guide = makeOAuthGuide("https://api.example.com");
		stubTokenEndpoint((url, init) => {
			expect(url).toBe("https://token.example.com/oauth/token");
			expect(String(init.body)).toContain("grant_type=client_credentials");
			expect(String(init.body)).toContain("client_id=MY_CLIENT");
			expect(String(init.body)).toContain("client_secret=S3CRET");
			return tokenResponse({
				access_token: "AT-1",
				expires_in: 3600,
				scope: "read",
			});
		});

		const res = await resolveAccessToken(guide.auth, "oauth.test");
		expect(res.authHeaders).toEqual({ authorization: "Bearer AT-1" });
		expect(res.secretValues).toEqual(["AT-1"]);
		expect(res.secretHeaderNames).toEqual(new Set(["authorization"]));
		// Stamped into the token store.
		const token = readToken("oauth.test", CC, TT);
		expect(token?.accessToken).toBe("AT-1");
		expect(token?.scope).toBe("read");
		expect(token?.expiresAt).toBeGreaterThan(Date.now());
	});

	it("cache hit: a fresh cached token is reused without a token-endpoint call", async () => {
		const guide = makeOAuthGuide("https://api.example.com");
		writeToken("oauth.cached", CC, TT, {
			accessToken: "CACHED",
			expiresAt: Date.now() + 300_000, // well beyond the 60s skew
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const res = await resolveAccessToken(guide.auth, "oauth.cached");
		expect(res.authHeaders).toEqual({ authorization: "Bearer CACHED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("expired token with a refresh token → refresh (grant_type=refresh_token)", async () => {
		provisionCreds("oauth.refresh");
		const guide = makeOAuthGuide("https://api.example.com");
		writeToken("oauth.refresh", CC, TT, {
			accessToken: "OLD",
			refreshToken: "RT-1",
			expiresAt: Date.now() - 1000, // expired
		});
		stubTokenEndpoint((_url, init) => {
			expect(String(init.body)).toContain("grant_type=refresh_token");
			expect(String(init.body)).toContain("refresh_token=RT-1");
			return tokenResponse({
				access_token: "NEW",
				refresh_token: "RT-2", // rotation
				expires_in: 3600,
			});
		});

		const res = await resolveAccessToken(guide.auth, "oauth.refresh");
		expect(res.authHeaders).toEqual({ authorization: "Bearer NEW" });
		const token = readToken("oauth.refresh", CC, TT);
		expect(token?.accessToken).toBe("NEW");
		expect(token?.refreshToken).toBe("RT-2");
	});

	it("expired token without a refresh token → re-mint (client_credentials)", async () => {
		provisionCreds("oauth.remint");
		const guide = makeOAuthGuide("https://api.example.com");
		writeToken("oauth.remint", CC, TT, {
			accessToken: "OLD",
			expiresAt: Date.now() - 1000, // expired, no refresh token
		});
		stubTokenEndpoint((_url, init) => {
			expect(String(init.body)).toContain("grant_type=client_credentials");
			return tokenResponse({ access_token: "MINTED", expires_in: 3600 });
		});

		const res = await resolveAccessToken(guide.auth, "oauth.remint");
		expect(res.authHeaders).toEqual({ authorization: "Bearer MINTED" });
	});

	it("skew buffer: a token within 60s of expiry is treated as expired", () => {
		// expiresAt = now + 30s < the 60s skew → expired.
		expect(
			isTokenExpired({ accessToken: "x", expiresAt: Date.now() + 30_000 }),
		).toBe(true);
		// expiresAt = now + 120s > the 60s skew → fresh.
		expect(
			isTokenExpired({ accessToken: "x", expiresAt: Date.now() + 120_000 }),
		).toBe(false);
		// No expiresAt → treated as fresh (ponytail: no TTL heuristic yet).
		expect(isTokenExpired({ accessToken: "x" })).toBe(false);
	});

	it("fail-closed: no client_id provisioned → OAuthTokenMissingError", async () => {
		const guide = makeOAuthGuide("https://api.example.com");
		// oauth.noclientid has neither credential in the secrets store.
		await expect(
			resolveAccessToken(guide.auth, "oauth.noclientid"),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
	});

	it("fail-closed: client_id provisioned but no client_secret → OAuthTokenMissingError", async () => {
		writeSecret("oauth.missing", "client_id", "MY_CLIENT");
		// oauth.missing has no client_secret in the secrets store.
		const guide = makeOAuthGuide("https://api.example.com");
		await expect(
			resolveAccessToken(guide.auth, "oauth.missing"),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
	});

	it("fail-closed: authorization_code guide with no token → OAuthTokenMissingError", async () => {
		const guide = makeOAuthGuide("https://api.example.com", {
			grant: "authorization_code",
			authorizeUrl: "https://api.example.com/oauth/authorize",
		});
		await expect(
			resolveAccessToken(guide.auth, "oauth.authcode"),
		).rejects.toBeInstanceOf(OAuthTokenMissingError);
	});

	it("client_secret_basic sends the credentials in the Authorization header", async () => {
		provisionCreds("oauth.basic");
		const guide = makeOAuthGuide("https://api.example.com", {
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		stubTokenEndpoint((_url, init) => {
			const headers = init.headers as Record<string, string>;
			const auth = headers["authorization"] ?? headers["Authorization"];
			expect(auth).toBe(
				"Basic " + Buffer.from("MY_CLIENT:S3CRET").toString("base64"),
			);
			expect(String(init.body)).not.toContain("client_secret");
			return tokenResponse({ access_token: "BASIC", expires_in: 3600 });
		});
		const res = await resolveAccessToken(guide.auth, "oauth.basic");
		expect(res.authHeaders).toEqual({ authorization: "Bearer BASIC" });
	});

	it("query style returns the token as a redactable query param", async () => {
		provisionCreds("oauth.query");
		const guide = makeOAuthGuide("https://api.example.com", {
			paramStyle: "query",
		});
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "QT", expires_in: 3600 }),
		);
		const res = await resolveAccessToken(guide.auth, "oauth.query");
		expect(res.secretQueryParams).toEqual({ access_token: "QT" });
		expect(res.secretQueryParamNames).toEqual(new Set(["access_token"]));
		expect(res.secretValues).toEqual(["QT"]);
	});

	it("secretRefs merge alongside the Bearer token and scrub with it", async () => {
		provisionCreds("oauth.headers");
		const guide = makeOAuthGuide("https://api.example.com", {
			secretRefs: { "Client-Id": { secret: "client_id" } },
		});
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "HDR-TOKEN", expires_in: 3600 }),
		);
		const res = await resolveAccessToken(guide.auth, "oauth.headers");
		expect(res.authHeaders).toEqual({
			authorization: "Bearer HDR-TOKEN",
			"Client-Id": "MY_CLIENT",
		});
		expect(res.secretHeaderNames).toEqual(
			new Set(["authorization", "client-id"]),
		);
		expect(res.secretValues).toEqual(["HDR-TOKEN", "MY_CLIENT"]);
	});

	it("revokeAccessToken clears the store (best-effort revoke POST)", async () => {
		provisionCreds("oauth.revoke");
		const guide = makeOAuthGuide("https://api.example.com", {
			revokeUrl: "https://token.example.com/oauth/revoke",
		});
		writeToken("oauth.revoke", CC, TT, {
			accessToken: "RVK",
			expiresAt: Date.now() + 1000,
		});
		stubTokenEndpoint((url, init) => {
			expect(url).toBe("https://token.example.com/oauth/revoke");
			expect(String(init.body)).toContain("token=RVK");
			return tokenResponse({}, 200);
		});
		await revokeAccessToken(guide.auth, "oauth.revoke");
		expect(readToken("oauth.revoke", CC, TT)).toBeNull();
	});

	it("both grants (and two issuers) on one domain land in separate slots — no clobber", async () => {
		provisionCreds("oauth.slots");
		const guide = makeOAuthGuide("https://api.example.com");
		// A user token (authorization_code) already in the store.
		writeToken("oauth.slots", "authorization_code", TT, {
			accessToken: "USER-TOKEN",
			refreshToken: "RT-USER",
		});
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "APP-TOKEN", expires_in: 3600 }),
		);
		// Minting the app token must not wipe the user-token slot.
		await resolveAccessToken(guide.auth, "oauth.slots");
		expect(readToken("oauth.slots", CC, TT)?.accessToken).toBe("APP-TOKEN");
		expect(readToken("oauth.slots", "authorization_code", TT)?.accessToken).toBe(
			"USER-TOKEN",
		);
		// Two issuers behind one API domain → distinct slots, same file.
		const TT2 = "https://other-issuer.example.com/oauth/token";
		writeToken("oauth.slots", CC, TT2, { accessToken: "OTHER-ISSUER" });
		expect(readToken("oauth.slots", CC, TT2)?.accessToken).toBe("OTHER-ISSUER");
		expect(readToken("oauth.slots", CC, TT)?.accessToken).toBe("APP-TOKEN");
		expect(readToken("oauth.slots", "authorization_code", TT)?.accessToken).toBe(
			"USER-TOKEN",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// resolveOpForExecution — Bearer injection + 401-body scrub
// ═══════════════════════════════════════════════════════════════════

describe("resolveOpForExecution oauth2 arm", () => {
	let server: { url: string; stop: () => Promise<void> };
	let sawAuth: string | undefined;

	beforeAll(async () => {
		const handler = (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			sawAuth = (req.headers["authorization"] ?? "") as string;
			switch (url.pathname) {
				case "/api/ok":
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					return;
				case "/api/401":
					// 401 body echoes the Authorization header — the audit must scrub it.
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `bad token: ${sawAuth}` }));
					return;
				default:
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "not found" }));
			}
		};
		server = await startTestServer(handler);
	});

	afterAll(async () => {
		await server.stop();
	});

	it("injects the Bearer token into the API request", async () => {
		provisionCreds("oauth.e2e");
		const guide = makeOAuthGuide(server.url, { domains: ["oauth.e2e"] });
		guide.operations = [makeOp("/api/ok")];
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "E2E-TOKEN", expires_in: 3600 }),
		);

		const outcome = await resolveOpForExecution(
			guide,
			guide.operations[0]!,
			"oauth-e2e",
		);
		expect(outcome.ok).toBe(true);
		expect(sawAuth).toBe("Bearer E2E-TOKEN");
	});

	it("scrubs the access token from a 401 body", async () => {
		provisionCreds("oauth.e2e401");
		const guide = makeOAuthGuide(server.url, { domains: ["oauth.e2e401"] });
		guide.operations = [makeOp("/api/401")];
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "SCRUB-ME", expires_in: 3600 }),
		);

		// The server 401s echoing the Authorization header — the access token
		// must be redacted from the surfaced error.
		try {
			await resolveOpForExecution(guide, guide.operations[0]!, "oauth-e2e401");
			expect.fail("should have thrown a 401 HelperError");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).toContain("Unexpected HTTP 401");
			expect(msg).not.toContain("SCRUB-ME");
		}
	});
});

// ═════════════════════════════════════════════════════════════
// /api oauth guide-less paths (orphaned tokens outlive their guide)
// ═════════════════════════════════════════════════════════════

describe("handleOauthSubcommand guide-less paths", () => {
	const ORPHAN = "guideless.invalid"; // no guide claims this domain
	function mockNotify() {
		const notify = vi.fn();
		const ctx = {
			ui: { notify },
		} as unknown as Parameters<typeof handleOauthSubcommand>[1];
		const out = () => notify.mock.calls.map((c) => String(c[0])).join("\n");
		return { ctx, out };
	}

	it("bare listing shows token-store domains", async () => {
		writeToken(ORPHAN, CC, TT, {
			accessToken: "T",
			expiresAt: Date.now() + 3_600_000,
		});
		const { ctx, out } = mockNotify();
		await handleOauthSubcommand("", ctx);
		expect(out()).toContain("token store");
		expect(out()).toContain(ORPHAN);
	});

	it("--status works without a guide", async () => {
		writeToken(ORPHAN, CC, TT, {
			accessToken: "T",
			expiresAt: Date.now() + 3_600_000,
		});
		const { ctx, out } = mockNotify();
		await handleOauthSubcommand(`${ORPHAN} --status`, ctx);
		expect(out()).toContain("no guide");
		expect(out()).toContain("State: valid");
	});

	it("--revoke clears the token + pending flow locally, no guide needed", async () => {
		writeToken(ORPHAN, CC, TT, {
			accessToken: "T",
			expiresAt: Date.now() + 3_600_000,
		});
		writePendingFlow(ORPHAN, CC, TT, {
			verifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1/callback",
		});
		const { ctx, out } = mockNotify();
		await handleOauthSubcommand(`${ORPHAN} --revoke`, ctx);
		expect(out()).toContain("cleared locally");
		expect(readToken(ORPHAN, CC, TT)).toBeNull();
		expect(readPendingFlow(ORPHAN, CC, TT)).toBeNull();
	});

	it("--revoke with no token says so (no guide error)", async () => {
		const { ctx, out } = mockNotify();
		await handleOauthSubcommand("never-provisioned.invalid --revoke", ctx);
		expect(out()).toContain("no token");
		expect(out()).not.toContain("No API guide");
	});
});
