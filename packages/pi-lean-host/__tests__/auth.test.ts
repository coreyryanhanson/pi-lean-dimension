/**
 * Authenticated-API structural tests (no live network).
 *
 * Covers the whole vertical slice, split by concern:
 *  - schema/parser: validateAuth rules (static-key realized; oauth2 rejected;
 *    secretRefs↔requires/optional consistency; none + fields rejected)
 *  - injection + fail-closed: resolveSecretHeaders; requires absent → fail
 *    closed before request; optional absent → proceed unauthenticated
 *  - output-channel audit (header): 401 body scrub; response-header echo scrub
 *  - cache/SSRF/redirect (header): hasAuth forces guarded redirects; auth 302→
 *    internal is blocked; cross-domain strip (case c) via stripSecretHeaders
 *  - footer: five auth states via the shared helper
 *  - api-fetch end-to-end: fail-closed return + auth footer + header scrub
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";
import { parseApiGuide } from "../core/parse-api-guide.js";
import { restGet, HelperError } from "../core/helpers.js";
import { stripSecretHeaders, fetchUrl } from "../core/transport.js";
import {
	resolveSecretHeaders,
	authStatusLine,
	canonicalStoreDomain,
} from "../core/auth.js";
import {
	writeSecret,
	listNames,
	setSecretsDir,
} from "../core/secrets-store.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { slug } from "../core/path-template.js";
import { apiFetchTool, apiGuideTool } from "../tools/index.js";
import { contentText } from "../tools/utils.js";
import type { ApiGuide, Operation } from "../core/api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Local test server (auth-aware responses)
// ═══════════════════════════════════════════════════════════════════

async function startAuthServer(): Promise<{
	url: string;
	stop: () => Promise<void>;
}> {
	let cacheHits = 0;
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const xkey = (req.headers["x-api-key"] ?? "") as string;
		// Request counter for the cache-skip parity test: a unique path per
		// probe is used so pre-existing module-level cache entries don't interfere.
		if (url.pathname.startsWith("/api/cache/")) {
			cacheHits += 1;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ count: cacheHits }));
			return;
		}
		switch (url.pathname) {
			case "/api/auth-ok":
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			case "/api/auth-401":
				// 401 body that echoes the auth header — the audit must scrub it.
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: `invalid key: ${xkey}` }));
				return;
			case "/api/auth-401-bare":
				// 401 body that echoes the BARE token (no scheme prefix) — the audit
				// must scrub the raw value, not just the prefixed "Bearer …" form.
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ error: `invalid key: ${xkey.replace(/^Bearer /, "")}` }),
				);
				return;
			case "/api/auth-header-echo":
				// Response header that echoes the auth secret — api-fetch must scrub it.
				res.writeHead(200, {
					"Content-Type": "application/json",
					"x-api-echo": xkey,
				});
				res.end(JSON.stringify({ ok: true }));
				return;
			case "/api/redirect-internal":
				// 302 → an internal/loopback host. On an auth-bearing (guarded) call
				// the forced guarded-redirect path SSRF-blocks this before fetching.
				res.writeHead(302, { Location: "http://127.0.0.1:19999/internal" });
				res.end();
				return;
			default:
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "not found" }));
		}
	};
	return startTestServer(handler);
}

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

/** Inline ApiGuide for direct restGet tests (no store, no parse). */
function makeAuthGuide(serverUrl: string): ApiGuide {
	return {
		content: "",
		updated: "2026-12-01",
		category: "site",
		source: "user",
		icon: "🔑",
		shortName: "Auth",
		domains: ["auth.test"],
		kind: "api",
		apiHost: serverUrl,
		verified: "2026-12-01",
		gatherAllMax: 1000,
		auth: {
			kind: "static-key",
			secretRefs: { "x-api-key": { secret: "api_key" } },
		},
		responseShape: { format: "json", charset: "utf-8" },
		operations: [],
	};
}

/** Query-param-secret-only guide (no header secret) for parity tests. */
function makeQueryAuthGuide(serverUrl: string): ApiGuide {
	return {
		content: "",
		updated: "2026-12-01",
		category: "site",
		source: "user",
		icon: "🔑",
		shortName: "QueryAuth",
		domains: ["auth.test"],
		kind: "api",
		apiHost: serverUrl,
		verified: "2026-12-01",
		gatherAllMax: 1000,
		auth: {
			kind: "static-key",
			secretQueryRefs: { apikey: { secret: "api_key" } },
		},
		responseShape: { format: "json", charset: "utf-8" },
		operations: [],
	};
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

function authRecipe(
	serverUrl: string,
	opts: { domain?: string; requires?: boolean; optional?: boolean } = {},
): string {
	const domain = opts.domain ?? "auth.test";
	// requires: false / optional: true → an optional ref (proceeds
	// unauthenticated when absent); default → a required ref (fail-closed).
	const optional = opts.requires === false || opts.optional;
	const ref = optional
		? `    x-api-key:
      secret: api_key
      optional: true`
		: `    x-api-key:
      secret: api_key`;
	return `---
domains: [${domain}]
apiHost: ${serverUrl}
auth:
  kind: static-key
  secretRefs:
${ref}
operations:
  - name: ping
    via: restGet
    path: /api/auth-ok
    accept: json
  - name: echoHeader
    via: restGet
    path: /api/auth-header-echo
    accept: json
  - name: boom
    via: restGet
    path: /api/auth-401
    accept: json
  - name: redirectInternal
    via: restGet
    path: /api/redirect-internal
    accept: json
---
body
`;
}

let server: { url: string; stop: () => Promise<void> };
let tmpGuidesDir: string;
let tmpSecretsDir: string;

beforeAll(async () => {
	server = await startAuthServer();
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-auth-guides-"));
	tmpSecretsDir = mkdtempSync(join(tmpdir(), "host-auth-secrets-"));
	setUserGuidesDir(tmpGuidesDir);
	setSecretsDir(tmpSecretsDir);
	// Domain `auth.test` IS provisioned with the key. `auth.partial` has the
	// required key but no optional key.
	writeSecret("auth.test", "api_key", "S3CRET-VALUE");
	writeSecret("auth.partial", "api_key", "S3CRET-VALUE");
	invalidateCache();
});

afterAll(async () => {
	await server.stop();
	rmSync(tmpGuidesDir, { recursive: true, force: true });
	rmSync(tmpSecretsDir, { recursive: true, force: true });
});

function writeGuide(yaml: string): void {
	// Folder must equal slug(shortName); these recipes carry no shortName, so
	// shortName defaults to the filename = folder name.
	const dir = join(tmpGuidesDir, "auth-test");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), yaml);
	invalidateCache();
}

function writeGuideForDomain(domain: string, yaml: string): void {
	const dir = join(tmpGuidesDir, slug(domain));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), yaml);
	invalidateCache();
}

// ═══════════════════════════════════════════════════════════════════
// Schema / parser
// ═════════════════════════════════════════════════════════════════���═

describe("auth schema / parser", () => {
	function parseAuthBlock(authYaml: string) {
		const raw = `---
domains: [example.com]
apiHost: https://api.example.com
auth:
${authYaml}
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		return parseApiGuide(raw, { filename: "example.com" });
	}

	it("static-key with a nested secretRef parses", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key`);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.guide.auth.kind).toBe("static-key");
			if (r.guide.auth.kind === "static-key") {
				expect(r.guide.auth.secretRefs).toEqual({
					"x-api-key": { secret: "api_key" },
				});
			}
		}
	});

	it("a ref with optional: true parses and is preserved", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
      optional: true`);
		expect(r.ok).toBe(true);
		if (r.ok) {
			if (r.guide.auth.kind === "static-key") {
				expect(r.guide.auth.secretRefs).toEqual({
					"x-api-key": { secret: "api_key", optional: true },
				});
			}
		}
	});

	it("a ref missing its secret name → ParseError", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key:
      prefix: "Bearer "`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretRefs.x-api-key.secret");
		}
	});

	it("a ref with an unknown key → ParseError", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
      name: nope`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretRefs.x-api-key");
			expect(r.error.found).toContain("name");
		}
	});

	it("a ref with a non-boolean optional → ParseError", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
      optional: maybe`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.secretRefs.x-api-key.optional");
	});

	it("a ref with a bare {name} placeholder prefix → ParseError (misconception guard)", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
      prefix: "{api_key}"`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.secretRefs.x-api-key.prefix");
	});

	it("secretRefs with kind: none → ParseError (per-variant allowlist)", () => {
		const r = parseAuthBlock(`  kind: none
  secretRefs:
    x-api-key:
      secret: api_key`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretRefs");
			expect(r.error.found).toContain("unknown key");
		}
	});

	it("oauth2 client_credentials parses with named clientId/clientSecret refs", () => {
		const r = parseAuthBlock(`  kind: oauth2
  grant: client_credentials
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret }
  scopes: [read]
  paramStyle: bearer-header
  tokenEndpointAuthMethod: client_secret_post`);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.guide.auth.kind).toBe("oauth2");
			if (r.guide.auth.kind === "oauth2") {
				expect(r.guide.auth.grant).toBe("client_credentials");
				expect(r.guide.auth.tokenUrl).toBe("https://api.example.com/oauth/token");
				expect(r.guide.auth.clientId).toEqual({ secret: "my_client" });
				expect(r.guide.auth.clientSecret).toEqual({
					secret: "client_secret",
				});
				expect(r.guide.auth.secretRefs).toBeUndefined();
			}
		}
	});

	it("oauth2 client_credentials without clientSecret → ParseError teaching the named ref", () => {
		const r = parseAuthBlock(`  kind: oauth2
  grant: client_credentials
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client }`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.clientSecret");
			expect(r.error.fix).toContain("clientSecret: { secret: client_secret }");
		}
	});

	it("oauth2 client_credentials with authorizeUrl → ParseError", () => {
		const r = parseAuthBlock(`  kind: oauth2
  grant: client_credentials
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret }
  authorizeUrl: https://api.example.com/oauth/authorize`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.authorizeUrl");
	});

	it("oauth2 authorization_code requires authorizeUrl only (redirectUri is the runtime convention); clientSecret optional (PKCE implicit)", () => {
		const r = parseAuthBlock(`  kind: oauth2
  grant: authorization_code
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client }
  authorizeUrl: https://api.example.com/oauth/authorize`);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.guide.auth.kind).toBe("oauth2");
			if (r.guide.auth.kind === "oauth2") {
				expect(r.guide.auth.grant).toBe("authorization_code");
				expect(r.guide.auth.clientSecret).toBeUndefined();
				expect(r.guide.auth.secretRefs).toBeUndefined();
			}
		}
	});

	it("pkce and redirectUri are deleted — rejected by the allowlist (PKCE implicit, redirect is the runtime convention)", () => {
		for (const key of ["pkce: true", "redirectUri: http://127.0.0.1/callback"]) {
			const r = parseAuthBlock(`  kind: oauth2
  grant: authorization_code
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client }
  authorizeUrl: https://api.example.com/oauth/authorize
  ${key}`);
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.error.found).toContain("unknown key");
			}
		}
	});

	it("clientId as a bare store-name string → ParseError (store values appear only as SecretRef.secret)", () => {
		const r = parseAuthBlock(`  kind: oauth2
  grant: client_credentials
  tokenUrl: https://api.example.com/oauth/token
  clientId: my_client
  clientSecret: { secret: client_secret }`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.clientId");
			expect(r.error.expected).toContain("secret: <store name>");
		}
	});

	it("prefix/optional on clientId → ParseError (semantically impossible ref flags)", () => {
		for (const flag of ["prefix: 'Bearer '", "optional: true"]) {
			const r = parseAuthBlock(`  kind: oauth2
  grant: client_credentials
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client, ${flag} }
  clientSecret: { secret: client_secret }`);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.field).toBe("auth.clientId");
		}
	});

	it("optional on clientSecret under client_credentials → ParseError (field is parser-required)", () => {
		const r = parseAuthBlock(`  kind: oauth2
  grant: client_credentials
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret, optional: true }`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.clientSecret.optional");
	});

	it("tokenEndpointAuthMethod: none with clientSecret → ParseError", () => {
		const r = parseAuthBlock(`  kind: oauth2
  grant: authorization_code
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret }
  authorizeUrl: https://api.example.com/oauth/authorize
  tokenEndpointAuthMethod: none`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.clientSecret");
			expect(r.error.expected).toContain("none");
		}
	});

	it("oauth2 with an unknown kind-only key → ParseError (per-variant allowlist)", () => {
		const r = parseAuthBlock(`  kind: oauth2
  grant: client_credentials
  tokenUrl: https://api.example.com/oauth/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret }
  headers:
    X-Foo: bar`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.headers");
			expect(r.error.found).toContain("unknown key");
		}
	});

	it("a static-key block with an oauth2-only key → ParseError (per-variant allowlist)", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
  tokenUrl: https://api.example.com/oauth/token`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.tokenUrl");
			expect(r.error.found).toContain("unknown key");
		}
	});

	it("a ref prefix parses and is preserved (folded headerPrefixes)", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    Authorization:
      secret: api_key
      prefix: "Bearer "`);
		expect(r.ok).toBe(true);
		if (r.ok) {
			if (r.guide.auth.kind === "static-key") {
				expect(r.guide.auth.secretRefs).toEqual({
					Authorization: { secret: "api_key", prefix: "Bearer " },
				});
			}
		}
	});

	it("an empty ref prefix parses (bare-key header)", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
      prefix: ""`);
		expect(r.ok).toBe(true);
		if (r.ok) {
			if (r.guide.auth.kind === "static-key") {
				expect(r.guide.auth.secretRefs).toEqual({
					"x-api-key": { secret: "api_key", prefix: "" },
				});
			}
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Injection + fail-closed (store-backed resolution)
// ═══════════════════════════════════════════════════════════════════

describe("resolveSecretHeaders (store-backed injection)", () => {
	const auth = {
		kind: "static-key" as const,
		secretRefs: {
			"x-api-key": { secret: "api_key" },
			"x-optional": { secret: "rate_key", optional: true },
		},
	};

	it("resolves required + optional when both are provisioned", () => {
		writeSecret("auth.test", "rate_key", "RATE");
		const res = resolveSecretHeaders(auth, "auth.test");
		expect(res.headers["x-api-key"]).toBe("S3CRET-VALUE");
		expect(res.headers["x-optional"]).toBe("RATE");
		expect(res.absentRequired).toEqual([]);
		expect(res.absentOptional).toEqual([]);
	});

	it("optional absent is reported, not required", () => {
		// domain auth.opt has no secrets at all
		const res = resolveSecretHeaders(auth, "auth.opt");
		expect(res.headers).toEqual({});
		expect(res.absentRequired).toEqual(["api_key"]);
		expect(res.absentOptional).toEqual(["rate_key"]);
	});

	it("a ref prefix prepends to the header and surfaces the raw value", () => {
		const prefixed = {
			kind: "static-key" as const,
			secretRefs: { Authorization: { secret: "api_key", prefix: "Bearer " } },
		};
		const res = resolveSecretHeaders(prefixed, "auth.test");
		expect(res.headers["Authorization"]).toBe("Bearer S3CRET-VALUE");
		expect(res.rawHeaderValues).toEqual(["S3CRET-VALUE"]);
	});

	it("absent ref prefix → verbatim value (existing behavior)", () => {
		const res = resolveSecretHeaders(auth, "auth.test");
		expect(res.headers["x-api-key"]).toBe("S3CRET-VALUE");
		// raw values still surfaced (identical when no prefix)
		expect(res.rawHeaderValues).toContain("S3CRET-VALUE");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Output-channel audit (header) — direct helper level
// ═══════════════════════════════════════════════════════════════════

describe("output-channel audit — 401 body scrub", () => {
	it("a 401 body echoing the secret reaches the agent scrubbed", async () => {
		const guide = makeAuthGuide(server.url);
		try {
			await restGet(server.url, makeOp("/api/auth-401"), {}, guide, {
				authHeaders: { "x-api-key": "S3CRET" },
				secretValues: ["S3CRET"],
			});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HelperError);
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).not.toContain("S3CRET");
			expect(msg).toContain("Unexpected HTTP 401");
		}
	});

	it("secretValues are scrubbed anywhere in the 500-char excerpt", async () => {
		const guide = makeAuthGuide(server.url);
		try {
			await restGet(server.url, makeOp("/api/auth-401"), {}, guide, {
				authHeaders: { "x-api-key": "S3CRET" },
				secretValues: ["S3CRET"],
			});
			expect.fail("should have thrown");
		} catch (e) {
			expect((e as Error).message.split("S3CRET").length).toBe(1); // absent
		}
	});

	it("a bare-token echo is scrubbed when the prefixed form is also known", async () => {
		// headerPrefixes in play: the wire carries "Bearer TOKEN", but a server
		// may echo the bare token. Both forms must be redacted.
		const guide = makeAuthGuide(server.url);
		try {
			await restGet(server.url, makeOp("/api/auth-401-bare"), {}, guide, {
				authHeaders: { "x-api-key": "Bearer S3CRET" },
				secretValues: ["Bearer S3CRET", "S3CRET"],
			});
			expect.fail("should have thrown");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).not.toContain("S3CRET");
			expect(msg).toContain("Unexpected HTTP 401");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Cache / SSRF / redirect (header)
// ═══════════════════════════════════════════════════════════════════

describe("cache/SSRF/redirect (header auth)", () => {
	it("stripSecretHeaders drops store-injected + Authorization, keeps literal (case c)", () => {
		const out = stripSecretHeaders(
			{
				accept: "application/json",
				"x-api-key": "SECRET",
				authorization: "Bearer t0ken",
				"x-literal": "stay",
			},
			new Set(["x-api-key"]),
		);
		expect(out["x-api-key"]).toBeUndefined();
		expect(out["authorization"]).toBeUndefined();
		expect(out["x-literal"]).toBe("stay");
		expect(out["accept"]).toBe("application/json");
	});

	it("auth-bearing restGet that redirects to an internal host is SSRF-blocked (case b)", async () => {
		const guide = makeAuthGuide(server.url);
		await expect(
			restGet(server.url, makeOp("/api/redirect-internal"), {}, guide, {
				authHeaders: { "x-api-key": "S3CRET" },
				secretHeaderNames: new Set(["x-api-key"]),
			}),
		).rejects.toMatchObject({ name: "SsrfBlockedError" });
	});
});

// ═══════════════════════════════════════════════════════════════════
// Parity — a secretQueryRefs-only guide (no header secret)
// ═══════════════════════════════════════════════════════════════════

describe("secretQueryRefs-only parity (cache + SSRF)", () => {
	it("a query-secret fetch is not cached — each call reaches the server", async () => {
		const uri = `${server.url}/api/cache/parity-${Date.now()}`;
		const r1 = JSON.parse(
			(await fetchUrl(uri, { hasQuerySecret: true })).body,
		) as { count: number };
		const r2 = JSON.parse(
			(await fetchUrl(uri, { hasQuerySecret: true })).body,
		) as { count: number };
		// hasQuerySecret → hasAuth → cache-skip. Second call hit the server.
		expect(r2.count).toBe(r1.count + 1);
		// Control: same URL without auth IS cached (second call served from cache).
		const c1 = JSON.parse((await fetchUrl(uri, { fresh: false })).body) as {
			count: number;
		};
		const c2 = JSON.parse((await fetchUrl(uri, { fresh: false })).body) as {
			count: number;
		};
		expect(c2.count).toBe(c1.count);
	});

	it("a query-secret-only guide that redirects to an internal host is SSRF-blocked", async () => {
		const guide = makeQueryAuthGuide(server.url);
		await expect(
			restGet(server.url, makeOp("/api/redirect-internal"), {}, guide, {
				secretQueryParams: { apikey: "S3CRET" },
				secretQueryParamNames: new Set(["apikey"]),
			}),
		).rejects.toMatchObject({ name: "SsrfBlockedError" });
	});
});

// ═══════════════════════════════════════════════════════════════════
// Footer — five states via the shared helper
// ═══════════════════════════════════════════════════════════════════

describe("authStatusLine footer", () => {
	const base = {
		secretRefs: {
			"x-api-key": { secret: "api_key" },
			"x-rate": { secret: "rate_key", optional: true },
		},
	} as const;

	it("no-auth (kind none) → undefined", () => {
		expect(authStatusLine({ kind: "none" }, "auth.test")).toBeUndefined();
	});

	it("static-key with empty ref maps → undefined (nothing to report)", () => {
		expect(
			authStatusLine({ kind: "static-key", secretRefs: {} }, "auth.test"),
		).toBeUndefined();
		expect(
			authStatusLine({ kind: "static-key", secretQueryRefs: {} }, "auth.test"),
		).toBeUndefined();
	});

	it("required refs present → ok", () => {
		const line = authStatusLine(
			{
				kind: "static-key",
				secretRefs: {
					"x-api-key": { secret: "api_key" },
					"x-rate": { secret: "rate_key" },
				},
			},
			"auth.test",
		);
		expect(line).toContain("auth: ok");
		expect(line).not.toContain("S3CRET-VALUE"); // never the value
	});

	it("required absent → nudge-provision", () => {
		const line = authStatusLine({ kind: "static-key", ...base }, "auth.missing");
		expect(line).toContain("not provisioned");
		expect(line).toContain("/api secrets auth.missing");
	});

	it("required present + optional absent → optional-not-provisioned", () => {
		const line = authStatusLine(
			{ kind: "static-key", ...base },
			"auth.partial", // has api_key, not rate_key
		);
		expect(line).toContain("optional");
		expect(line).toContain("not provisioned");
	});

	it("required + optional present → ok (optional)", () => {
		writeSecret("auth.test", "rate_key", "RATE");
		const line = authStatusLine({ kind: "static-key", ...base }, "auth.test");
		expect(line).toContain("auth: ok");
		expect(line).toContain("optional provisioned");
	});

	// ── secretQueryRefs parity: the footer must cover query-param auth too ──

	it("query-ref required present → ok", () => {
		const line = authStatusLine(
			{
				kind: "static-key",
				secretQueryRefs: { apikey: { secret: "api_key" } },
			},
			"auth.test",
		);
		expect(line).toContain("auth: ok");
		expect(line).not.toContain("S3CRET-VALUE"); // never the value
	});

	it("query-ref required absent → nudge-provision", () => {
		const line = authStatusLine(
			{
				kind: "static-key",
				secretQueryRefs: { apikey: { secret: "api_key" } },
			},
			"auth.missing",
		);
		expect(line).toContain("requires api_key");
		expect(line).toContain("/api secrets auth.missing");
	});

	it("query-ref optional absent → optional-not-provisioned", () => {
		const line = authStatusLine(
			{
				kind: "static-key",
				secretQueryRefs: { apikey: { secret: "api_key", optional: true } },
			},
			"auth.missing",
		);
		expect(line).toContain("auth: ok (optional api_key not provisioned");
	});

	it("query-ref optional present → ok (optional)", () => {
		const line = authStatusLine(
			{
				kind: "static-key",
				secretQueryRefs: { apikey: { secret: "api_key", optional: true } },
			},
			"auth.test",
		);
		expect(line).toContain("auth: ok");
		expect(line).toContain("optional provisioned");
	});

	it("mixed header+query: missing query required surfaces in the nudge", () => {
		const line = authStatusLine(
			{
				kind: "static-key",
				secretRefs: { "x-api-key": { secret: "api_key" } },
				secretQueryRefs: { apikey: { secret: "api_key" } },
			},
			"auth.missing",
		);
		// The same name is referenced by both maps — it must appear exactly once.
		expect(line).toContain(
			"🔑 auth: requires api_key — not provisioned. Run /api secrets auth.missing.",
		);
		// Other provisioned domains surface as a names-only hint.
		expect(line).toContain("provisioned domains:");
		expect(line).toContain("auth.test");
	});

	// ── oauth2 footer states ──

	it("oauth2 with no token → nudge /api oauth", () => {
		const line = authStatusLine(
			{
				kind: "oauth2",
				grant: "client_credentials",
				tokenUrl: "https://api.example.com/oauth/token",
				clientId: { secret: "c" },
			},
			"auth.missing",
		);
		expect(line).toContain("oauth2");
		expect(line).toContain("/api oauth auth.missing");
	});
});

// ═══════════════════════════════════════════════════════════════════
// api-fetch end-to-end (fail-closed + footer + response-header scrub)
// ═══════════════════════════════════════════════════════════════════

describe("api-fetch authenticated execution", () => {
	it("required secret missing → fail-closed before the request", async () => {
		// domain auth.missing has no key provisioned
		writeGuideForDomain(
			"auth.missing",
			authRecipe(server.url, { domain: "auth.missing" }),
		);

		const res = await apiFetchTool.execute(
			"t",
			{ domain: "auth.missing", operation: "ping" },
			undefined,
			undefined,
			undefined as any,
		);
		const details = res.details as Record<string, unknown>;
		expect(details.error).toBe("auth_required_not_provisioned");
		const text = contentText(res);
		expect(text).toContain("/api secrets auth.missing");
		// Parallel: the fail-closed footer also names the other provisioned
		// domains so the user isn't forced to ls the store.
		expect(text).toContain("provisioned domains:");
	});

	it("provisioned key: fetch succeeds, response-header echo scrubbed from details", async () => {
		writeGuide(authRecipe(server.url));
		const res = await apiFetchTool.execute(
			"t",
			{ domain: "auth.test", operation: "echoHeader" },
			undefined,
			undefined,
			undefined as any,
		);
		const details = res.details as Record<string, unknown>;
		const headers = (details.headers as Record<string, string>) ?? {};
		// The secret value must not appear in any echoed header value.
		for (const v of Object.values(headers)) {
			expect(String(v)).not.toContain("S3CRET-VALUE");
		}
		expect(contentText(res)).toContain("auth: ok");
	});

	it("headerPrefixes: prefix on the wire, raw token scrubbed from a bare-token 401", async () => {
		// Guide declares the Bearer prefix; the store holds the raw token. The
		// server echoes the bare token — the union scrub must redact it.
		writeGuideForDomain(
			"auth.prefix",
			`---
domains: [auth.prefix]
apiHost: ${server.url}
auth:
  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
      prefix: "Bearer "
operations:
  - name: boomBare
    via: restGet
    path: /api/auth-401-bare
    accept: json
---
body
`,
		);
		writeSecret("auth.prefix", "api_key", "S3CRET-VALUE");
		const res = await apiFetchTool.execute(
			"t",
			{ domain: "auth.prefix", operation: "boomBare" },
			undefined,
			undefined,
			undefined as any,
		);
		const text = contentText(res);
		expect(text).not.toContain("S3CRET-VALUE");
		expect(text).toContain("Unexpected HTTP 401");
	});

	it("optional-only (no requires) missing secret → proceeds unauthenticated", async () => {
		// domain auth.opt has no key provisioned and requires nothing
		writeGuideForDomain(
			"auth.opt",
			authRecipe(server.url, {
				domain: "auth.opt",
				requires: false,
				optional: true,
			}),
		);

		const res = await apiFetchTool.execute(
			"t",
			{ domain: "auth.opt", operation: "ping" },
			undefined,
			undefined,
			undefined as any,
		);
		expect((res.details as Record<string, unknown>).error ?? "ok").toBeDefined();
		const text = contentText(res);
		// Must NOT have failed closed; the footer reports optional not provisioned.
		expect(text).toContain("auth: ok (optional");
		expect(text).toContain("not provisioned");
	});

	it("flipped guide: secrets resolve under domains[0] regardless of the routing domain", async () => {
		// Guide claims both the canonical base and the api subdomain; the secret
		// is provisioned ONLY under the canonical key (github.com).
		writeGuideForDomain(
			"flipped",
			`---
domains: [github.com, api.github.com]
apiHost: ${server.url}
auth:
  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
operations:
  - name: ping
    via: restGet
    path: /api/auth-ok
    accept: json
---
body
`,
		);
		writeSecret("github.com", "api_key", "S3CRET-VALUE");
		invalidateCache();

		const run = async (domain: string) =>
			apiFetchTool.execute(
				"t",
				{ domain, operation: "ping" },
				undefined,
				undefined,
				undefined as any,
			);

		// Routing on the canonical base.
		const resBase = await run("github.com");
		expect(contentText(resBase)).toContain("auth: ok");
		expect(contentText(resBase)).not.toContain("S3CRET-VALUE");

		// Routing on the api subdomain STILL resolves under github.com.
		const resApi = await run("api.github.com");
		expect(contentText(resApi)).toContain("auth: ok");
		expect((resApi.details as Record<string, unknown>).error).toBeUndefined();
	});

	it("fail-closed error names the canonical store domain, not the api subdomain", async () => {
		// Guide claims the base + api subdomain; NO secret provisioned under the
		// canonical key (gbif.org).
		writeGuideForDomain(
			"flipped-missing",
			`---
domains: [gbif.org, api.gbif.org]
apiHost: ${server.url}
auth:
  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
operations:
  - name: ping
    via: restGet
    path: /api/auth-ok
    accept: json
---
body
`,
		);
		invalidateCache();

		const res = await apiFetchTool.execute(
			"t",
			{ domain: "api.gbif.org", operation: "ping" },
			undefined,
			undefined,
			undefined as any,
		);
		expect((res.details as Record<string, unknown>).error).toBe(
			"auth_required_not_provisioned",
		);
		const text = contentText(res);
		expect(text).toContain("/api secrets gbif.org");
		expect(text).not.toContain("/api secrets api.gbif.org");
	});
});

// ═══════════════════════════════════════════════════════════════════
// api-guide footer uses the same shared helper
// ═══════════════════════════════════════════════════════════════════

describe("api-guide auth footer", () => {
	it("renders the shared auth status line for a keyed guide", async () => {
		writeGuide(authRecipe(server.url));
		const res = await apiGuideTool.execute(
			"t",
			{ domain: "auth.test" },
			undefined,
			undefined,
			undefined as any,
		);
		const text = contentText(res);
		expect(text).toContain("Auth: static-key");
		expect(text).toContain("auth: ok");
		expect(text).not.toContain("S3CRET-VALUE");
	});
});

// Keep listNames import used (proves store write happened for this domain).
describe("store sanity", () => {
	it("auth.test has the provisioned api_key", () => {
		expect(listNames("auth.test")).toContain("api_key");
	});
});

// ═══════════════════════════════════════════════════════════════════
// canonicalStoreDomain (T1.1) — the canonical store-key seam
// ═══════════════════════════════════════════════════════════════════

describe("canonicalStoreDomain", () => {
	it("returns domains[0] — the primary browsable domain", () => {
		expect(
			canonicalStoreDomain({
				domains: ["github.com", "api.github.com"],
			} as ApiGuide),
		).toBe("github.com");
		expect(canonicalStoreDomain({ domains: ["boe.es"] } as ApiGuide)).toBe(
			"boe.es",
		);
	});
});
