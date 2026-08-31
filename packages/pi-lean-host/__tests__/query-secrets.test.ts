/**
 * Query-param-secret output-channel audit + parser (+ probe auth),
 * structural tests with the transport layer mocked.
 *
 * Covers:
 *  - parser: secretQueryRefs rules (consistency, collision-with-op-params,
 *    passthrough allowed, kind:none rejected)
 *  - URL channel: redacted `?apikey=***` on result.url / PaginateResult.urls
 *    (incl. a server-supplied nextUrl); the fetch still uses the RAW url; a
 *    non-secret param stays intact
 *  - params channel: the returned params map never contains the secret value
 *  - passthrough guard: an agent-supplied value for a secret param name is
 *    dropped before the query string
 *  - error-path: a HelperError carries the REDACTED url on err.url
 *  - hasAuth wiring: queries force hasQuerySecret=true through to the transport
 *  - api-probe inline auth: store injection, URL redact, body scrub, store-miss
 *    (fetch-anyway + miss note, stale auth:none never fires)
 *
 * The cache-skip / SSRF parity live in auth.test.ts (real local server).
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restGet, paginate, HelperError } from "../core/helpers.js";
import { parseApiGuide } from "../core/parse-api-guide.js";
import { writeSecret, setSecretsDir } from "../core/secrets-store.js";
import { probe } from "../tools/api-probe.js";
import type { ApiGuide, Operation } from "../core/api-guide-types.js";

// Mock the transport BEFORE imports that use it.
vi.mock("../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../core/transport.js")>(
		"../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { fetchUrl } from "../core/transport.js";
const fetchUrlMock = vi.mocked(fetchUrl);

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

function makeQueryGuide(apiHost: string): ApiGuide {
	return {
		content: "",
		updated: "2026-12-01",
		category: "site",
		source: "user",
		icon: "🔑",
		shortName: "QueryAuth",
		domains: ["q.test"],
		kind: "api",
		apiHost,
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

function makeOp(
	path: string,
	via: "restGet" | "paginate" = "restGet",
	extra?: Partial<Operation>,
): Operation {
	return {
		name: "op",
		via,
		path,
		accept: "json",
		params: {},
		pathParams: [],
		...extra,
	};
}

const qAuth = {
	secretQueryParams: { apikey: "REALKEY" },
	secretQueryParamNames: new Set(["apikey"]),
};

let tmpSecrets: string;
beforeAll(() => {
	tmpSecrets = mkdtempSync(join(tmpdir(), "host-a2-secrets-"));
	setSecretsDir(tmpSecrets);
});
afterAll(() => {
	rmSync(tmpSecrets, { recursive: true, force: true });
});

// Each test observes only its own fetch calls (module-level mock accumulates).
beforeEach(() => {
	fetchUrlMock.mockClear();
	fetchUrlMock.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// Parser — secretQueryRefs
// ═══════════════════════════════════════════════════════════════════

function parseAuthQuery(
	authYaml: string,
	opsYaml = `  - name: get\n    via: restGet\n    path: /things\n    accept: json\n    params: {}\n`,
) {
	const raw = `---
domains: [q.com]
apiHost: https://api.q.com
auth:
${authYaml}
operations:
${opsYaml}
---
body
`;
	return parseApiGuide(raw, { filename: "q.com" });
}

describe("auth schema / parser — secretQueryRefs", () => {
	it("secretQueryRefs with a nested ref parses", () => {
		const r = parseAuthQuery(
			`  kind: static-key
  secretQueryRefs:
    apikey:
      secret: api_key`,
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			if (r.guide.auth.kind === "static-key") {
				expect(r.guide.auth.secretQueryRefs).toEqual({
					apikey: { secret: "api_key" },
				});
			}
		}
	});

	it("secretQueryRefs coexists with header secretRefs", () => {
		const r = parseAuthQuery(
			`  kind: static-key
  secretRefs:
    x-api-key:
      secret: api_key
  secretQueryRefs:
    apikey:
      secret: api_key`,
		);
		expect(r.ok).toBe(true);
	});

	it("a query ref missing its secret name → ParseError", () => {
		const r = parseAuthQuery(
			`  kind: static-key
  secretQueryRefs:
    apikey:
      prefix: "x-"`,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretQueryRefs.apikey.secret");
		}
	});

	it("secretQueryRefs with kind: none → ParseError (per-variant allowlist)", () => {
		const r = parseAuthQuery(
			`  kind: none
  secretQueryRefs:
    apikey:
      secret: api_key`,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.secretQueryRefs");
	});

	it("a secret param name colliding with an op's params map → ParseError", () => {
		const ops = `  - name: get\n    via: restGet\n    path: /things\n    accept: json\n    params:\n      apikey:\n        required: true\n`;
		const r = parseAuthQuery(
			`  kind: static-key
  secretQueryRefs:
    apikey:
      secret: api_key`,
			ops,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretQueryRefs.apikey");
			expect(r.error.fix).toContain('operation "get"');
		}
	});

	it("passthrough + secretQueryRefs parses (defense is runtime, not parse)", () => {
		const ops = `  - name: get\n    via: restGet\n    path: /things\n    accept: json\n    passthrough: true\n    params: {}\n`;
		const r = parseAuthQuery(
			`  kind: static-key
  secretQueryRefs:
    apikey:
      secret: api_key`,
			ops,
		);
		expect(r.ok).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Output-channel — URL channel
// ═══════════════════════════════════════════════════════════════════

describe("output-channel audit — URL channel (query-param)", () => {
	it("restGet: result.url redacted, fetch uses raw, params map agent-only, hasQuerySecret passed", async () => {
		const guide = makeQueryGuide("https://q.test");
		const op = makeOp("/api/ok");
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true }),
			cached: false,
		});
		const result = await restGet("https://q.test", op, {}, guide, qAuth);
		expect(result.url).toContain("apikey=***");
		expect(result.url).not.toContain("REALKEY");
		expect(result.params["apikey"]).toBeUndefined();
		const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
		expect(calledUrl).toContain("apikey=REALKEY");
		expect(fetchUrlMock.mock.calls[0]![1]?.hasQuerySecret).toBe(true);
	});

	it("a non-secret param stays intact on the redacted URL", async () => {
		const guide = makeQueryGuide("https://q.test");
		const op = makeOp("/api/ok", "restGet", { params: { chainid: {} } });
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true }),
			cached: false,
		});
		const result = await restGet(
			"https://q.test",
			op,
			{ chainid: 1 },
			guide,
			qAuth,
		);
		expect(result.url).toContain("chainid=1");
		expect(result.url).toContain("apikey=***");
		expect(result.params["chainid"]).toBe("1"); // agent param surfaced
	});

	it("paginate: every surfaced URL redacted incl. a server-supplied nextUrl", async () => {
		const guide = makeQueryGuide("https://q.test");
		const op = makeOp("/api/list", "paginate", {
			pagination: {
				style: "nextLink",
				itemsPath: "items",
				nextLinkPath: "next",
			},
		});
		const nextLink = "https://q.test/api/list?page=2&apikey=REALKEY";
		fetchUrlMock
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: JSON.stringify({ items: [{ id: 1 }], next: nextLink }),
				cached: false,
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: JSON.stringify({ items: [{ id: 2 }] }),
				cached: false,
			});
		const result = await paginate("https://q.test", op, {}, guide, {
			gatherAll: true,
			...qAuth,
		});
		expect(result.urls.length).toBe(2);
		for (const u of result.urls) {
			expect(u).toContain("apikey=***");
			expect(u).not.toContain("REALKEY");
		}
		expect(result.params["apikey"]).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════
// Output-channel — params channel + passthrough guard
// ═══════════════════════════════════════════════════════════════════

describe("output-channel audit — params channel / passthrough guard", () => {
	it("the returned params map never contains the secret value (agent-supplied only)", async () => {
		const guide = makeQueryGuide("https://q.test");
		const op = makeOp("/api/ok", "restGet", { params: { foo: {} } });
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true }),
			cached: false,
		});
		const result = await restGet(
			"https://q.test",
			op,
			{ foo: "bar" },
			guide,
			qAuth,
		);
		expect(result.params).toEqual({ foo: "bar" });
	});

	it("passthrough: an agent-supplied value for a secret param is dropped before the query string", async () => {
		const guide = makeQueryGuide("https://q.test");
		const op = makeOp("/api/pass", "restGet", { passthrough: true });
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true }),
			cached: false,
		});
		// The agent (accidentally or maliciously) supplies apikey=AGENT; the
		// injected REALKEY must win and the agent value must be dropped entirely.
		const result = await restGet(
			"https://q.test",
			op,
			{ apikey: "AGENT" },
			guide,
			qAuth,
		);
		const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
		expect(calledUrl).toContain("apikey=REALKEY");
		expect(calledUrl).not.toContain("apikey=AGENT");
		expect(calledUrl.split("apikey=").length - 1).toBe(1); // single occurrence
		expect(result.params["apikey"]).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════
// Error-path URL redaction
// ═══════════════════════════════════════════════════════════════════

describe("output-channel audit — error-path URL redaction", () => {
	it("a HelperError from restGet carries the REDACTED url on err.url", async () => {
		const guide = makeQueryGuide("https://q.test");
		const op = makeOp("/api/boom");
		fetchUrlMock.mockResolvedValue({
			status: 401,
			headers: {},
			body: JSON.stringify({ error: "bad key REALKEY" }),
			cached: false,
		});
		try {
			await restGet("https://q.test", op, {}, guide, {
				...qAuth,
				secretValues: ["REALKEY"],
			});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HelperError);
			const err = e as HelperError;
			expect(err.url).toContain("apikey=***");
			expect(err.url).not.toContain("REALKEY");
			expect(err.message).not.toContain("REALKEY"); // 401-body scrub
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// api-probe store-backed auth (inline auth block)
// ═══════════════════════════════════════════════════════════════════

describe("api-probe store-backed auth (authoring loop)", () => {
	it("inline auth injects from the store, redacts the URL, scrubs the body", async () => {
		writeSecret("q.test", "api_key", "REALKEY");
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ results: [{ id: 1 }] }),
			cached: false,
		});
		const result = await probe(
			"https://api.q.test",
			"/v1/things",
			{},
			{
				auth: { secretQueryRefs: { apikey: "api_key" } },
				domain: "q.test",
			},
		);
		const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
		expect(calledUrl).toContain("apikey=REALKEY"); // fetched with the key
		expect(result.url).toContain("apikey=***");
		expect(result.url).not.toContain("REALKEY");
		expect(result.raw).not.toContain("REALKEY");
		expect(result.ok).toBe(true);
	});

	it("store-miss reports in the note and fetches anyway (not fail-closed)", async () => {
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ results: [{ id: 1 }] }),
			cached: false,
		});
		const result = await probe(
			"https://api.qmiss.test",
			"/things",
			{},
			{
				auth: { secretQueryRefs: { apikey: "api_key" } },
				domain: "q.miss",
			},
		);
		const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
		expect(calledUrl).not.toContain("apikey="); // fetched unauthenticated
		expect(result.note).toContain(
			'secret "api_key" not found in store for domain "q.miss"',
		);
	});

	it("auth-block miss never emits the stale auth:none text on a 401", async () => {
		fetchUrlMock.mockResolvedValue({
			status: 401,
			headers: {},
			body: JSON.stringify({ error: "nope" }),
			cached: false,
		});
		const result = await probe(
			"https://api.q.test",
			"/protected",
			{},
			{
				auth: { secretQueryRefs: { apikey: "api_key" } },
				domain: "q.miss",
			},
		);
		expect(result.status).toBe(401);
		expect(result.note).toContain(
			'secret "api_key" not found in store for domain "q.miss"',
		);
		expect(result.note).not.toContain("auth:none");
	});

	it("a 401 body echoing the key is scrubbed from raw (probe-local scrub)", async () => {
		writeSecret("q.test", "api_key", "REALKEY");
		fetchUrlMock.mockResolvedValue({
			status: 401,
			headers: {},
			body: JSON.stringify({ error: "invalid key REALKEY" }),
			cached: false,
		});
		const result = await probe(
			"https://api.q.test",
			"/protected",
			{},
			{
				auth: { secretQueryRefs: { apikey: "api_key" } },
				domain: "q.test",
			},
		);
		expect(result.raw).not.toContain("REALKEY");
		expect(result.note).not.toContain("REALKEY");
	});
});
