/**
 * Sprint 1 — authenticated-API structural tests (no live network).
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
			secretRefs: { "x-api-key": "api_key" },
			requires: ["api_key"],
		},
		responseShape: { format: "json", charset: "utf-8" },
		operations: [],
	};
}

/** A2-only guide (query-param secret, no header secret) for parity tests. */
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
			secretQueryRefs: { apikey: "api_key" },
			requires: ["api_key"],
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
	const req = opts.requires === false ? "" : `  requires:\n    - api_key\n`;
	const opt = opts.optional ? `  optional:\n    - api_key\n` : "";
	return `---
domains: [${domain}]
apiHost: ${serverUrl}
auth:
  kind: static-key
  secretRefs:
    x-api-key: api_key
${req}${opt}
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
	const dir = join(tmpGuidesDir, "auth.test");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), yaml);
	invalidateCache();
}

function writeGuideForDomain(domain: string, yaml: string): void {
	const dir = join(tmpGuidesDir, domain);
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
domains: [x.com]
apiHost: https://api.x.com
auth:
${authYaml}
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		return parseApiGuide(raw, { filename: "x.com" });
	}

	it("static-key with consistent secretRefs/requires parses", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key: api_key
  requires:
    - api_key`);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.guide.auth.kind).toBe("static-key");
			expect(r.guide.auth.secretRefs).toEqual({ "x-api-key": "api_key" });
			expect(r.guide.auth.requires).toEqual(["api_key"]);
		}
	});

	it("secretRefs name not in requires/optional → ParseError with fix", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key: unknownName
  requires:
    - api_key`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretRefs.x-api-key");
			expect(r.error.fix).toBeDefined();
		}
	});

	it("a secret name in BOTH requires and optional → ParseError", () => {
		const r = parseAuthBlock(`  kind: static-key
  secretRefs:
    x-api-key: api_key
  requires:
    - api_key
  optional:
    - api_key`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.requires");
	});

	it("secretRefs with kind: none → ParseError (kind↔field consistency)", () => {
		const r = parseAuthBlock(`  kind: none
  secretRefs:
    x-api-key: api_key`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.secretRefs");
	});

	it("oauth2 is rejected at parse (not yet implemented)", () => {
		const r = parseAuthBlock(`  kind: oauth2`);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.kind");
			expect(r.error.fix).toContain("not yet implemented");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Injection + fail-closed (store-backed resolution)
// ═══════════════════════════════════════════════════════════════════

describe("resolveSecretHeaders (store-backed injection)", () => {
	const auth = {
		kind: "static-key" as const,
		secretRefs: { "x-api-key": "api_key", "x-optional": "rate_key" },
		requires: ["api_key"],
		optional: ["rate_key"],
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
// A2 parity — a secretQueryRefs-only guide (no header secret)
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
		// A2: hasQuerySecret → hasAuth → cache-skip. Second call hit the server.
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
		secretRefs: { "x-api-key": "api_key", "x-rate": "rate_key" },
	} as const;

	it("no-auth (kind none) → undefined", () => {
		expect(authStatusLine({ kind: "none" }, "auth.test")).toBeUndefined();
	});

	it("requires present → ok", () => {
		const line = authStatusLine(
			{ kind: "static-key", ...base, requires: ["api_key"] },
			"auth.test",
		);
		expect(line).toContain("auth: ok");
		expect(line).not.toContain("S3CRET-VALUE"); // never the value
	});

	it("required absent → nudge-provision", () => {
		const line = authStatusLine(
			{ kind: "static-key", ...base, requires: ["api_key"] },
			"auth.missing",
		);
		expect(line).toContain("not provisioned");
		expect(line).toContain("/api secrets auth.missing");
	});

	it("requires present + optional absent → optional-not-provisioned", () => {
		const line = authStatusLine(
			{
				kind: "static-key",
				...base,
				requires: ["api_key"],
				optional: ["rate_key"],
			},
			"auth.partial", // has api_key, not rate_key
		);
		expect(line).toContain("optional");
		expect(line).toContain("not provisioned");
	});

	it("requires + optional present → ok (optional)", () => {
		writeSecret("auth.test", "rate_key", "RATE");
		const line = authStatusLine(
			{
				kind: "static-key",
				...base,
				requires: ["api_key"],
				optional: ["rate_key"],
			},
			"auth.test",
		);
		expect(line).toContain("auth: ok");
		expect(line).toContain("optional provisioned");
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
    x-api-key: api_key
  requires:
    - api_key
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
    x-api-key: api_key
  requires:
    - api_key
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
