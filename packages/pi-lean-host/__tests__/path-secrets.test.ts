/**
 * secretPathRefs executor + resolve-op tests — transport mocked.
 *
 * Covers:
 *  - store-filled token in the fetched URL (restGet + paginate); the agent
 *    params map the caller passed stays untouched
 *  - an agent-supplied value for a secret-owned token is DROPPED
 *  - query isolation: a passthrough op in a multi-op path-secret guide
 *    carries no token in its query string or result.params
 *  - hasPathSecret + redactPathSecret threading into the transport
 *  - result.url / PaginateResult.urls redacted (raw, %3A, lowercase %3a
 *    echoes); the URL on HelperError redacted (incl. the SSRF-block errUrl,
 *    built separately); the tool-level details channel is asserted in
 *    tools.test.ts
 *  - scrub: a 401 body echoing the token (raw + both hex forms) → *** (the
 *    encoded forms arrive folded into secretValues from resolve-op)
 *  - fail-closed: a missing required path ref returns
 *    auth_required_not_provisioned before any fetch (restGet and paginate)
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restGet, paginate, HelperError } from "../core/helpers.js";
import { resolveOpForExecution } from "../core/resolve-op.js";
import { writeSecret, setSecretsDir } from "../core/secrets-store.js";
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

const TOKEN = "s3cr3t:PATH-key";
const TOKEN_ENC = encodeURIComponent(TOKEN); // %3A uppercase
const TOKEN_ENC_LOWER = TOKEN_ENC.replace(/%../g, (s) => s.toLowerCase()); // %3a

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

function makePathGuide(apiHost: string): ApiGuide {
	return {
		content: "",
		updated: "2026-12-01",
		category: "site",
		source: "user",
		icon: "🤖",
		shortName: "PathAuth",
		domains: ["p.test"],
		kind: "api",
		apiHost,
		verified: "2026-12-01",
		gatherAllMax: 1000,
		auth: {
			kind: "static-key",
			secretPathRefs: { token: { secret: "path_key" } },
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

/** pathSecretParams as resolve-op would thread it. */
const pathAuth = { secretPathParams: { token: TOKEN } };

function okResponse(body: unknown = { ok: true }) {
	return {
		status: 200,
		headers: {},
		body: JSON.stringify(body),
		cached: false,
	};
}

let tmpSecrets: string;
beforeAll(() => {
	tmpSecrets = mkdtempSync(join(tmpdir(), "host-path-secrets-"));
	setSecretsDir(tmpSecrets);
});
afterAll(() => {
	rmSync(tmpSecrets, { recursive: true, force: true });
});

beforeEach(() => {
	fetchUrlMock.mockClear();
	fetchUrlMock.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// Executor — store-filled path, agent values dropped
// ═══════════════════════════════════════════════════════════════════

describe("restGet — secretPathParams", () => {
	it("fills {token} from the store in the fetched URL; result.url redacted", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/get");
		fetchUrlMock.mockResolvedValue(okResponse());
		const result = await restGet("https://p.test", op, {}, guide, pathAuth);
		const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
		expect(calledUrl).toContain(`/auth${TOKEN_ENC}/get`);
		expect(result.url).toContain("/auth***/get");
		expect(result.url).not.toContain(TOKEN);
		expect(fetchUrlMock.mock.calls[0]![1]?.hasPathSecret).toBe(true);
		expect(fetchUrlMock.mock.calls[0]![1]?.redactPathSecret).toBeTypeOf(
			"function",
		);
	});

	it("an agent-supplied value for a secret-owned token is DROPPED", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/get");
		fetchUrlMock.mockResolvedValue(okResponse());
		await restGet(
			"https://p.test",
			op,
			{ token: "AGENT-SUPPLIED" },
			guide,
			pathAuth,
		);
		const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
		expect(calledUrl).toContain(TOKEN_ENC);
		expect(calledUrl).not.toContain("AGENT-SUPPLIED");
	});

	it("query isolation: a passthrough op without {token} carries no token in query or params", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/status", "restGet", { passthrough: true });
		fetchUrlMock.mockResolvedValue(okResponse());
		const result = await restGet(
			"https://p.test",
			op,
			{ token: "AGENT-SUPPLIED" }, // would ride passthrough if not deleted
			guide,
			pathAuth,
		);
		const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
		expect(calledUrl).not.toContain(TOKEN);
		expect(calledUrl).not.toContain("AGENT-SUPPLIED");
		expect(calledUrl).not.toContain("?"); // nothing leaked into the query
		expect(Object.values(result.params)).not.toContain(TOKEN);
		expect(result.params["token"]).toBeUndefined();
	});

	it("a non-secret query param still builds normally alongside path fill", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/list", "restGet", {
			params: { offset: { default: 0 } },
		});
		fetchUrlMock.mockResolvedValue(okResponse());
		const result = await restGet(
			"https://p.test",
			op,
			{ offset: 5 },
			guide,
			pathAuth,
		);
		const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
		expect(calledUrl).toContain("offset=5");
		expect(result.params["offset"]).toBe("5");
	});
});

describe("paginate — secretPathParams (token survives every page build)", () => {
	it("offset-limit: every page URL carries the filled token; surfaced urls redacted", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/list", "paginate", {
			pagination: {
				style: "offset-limit",
				itemsPath: "items",
				pageParam: "offset",
				pageSizeParam: "limit",
				pageSize: 1,
			},
		});
		fetchUrlMock.mockResolvedValue(okResponse({ items: [{ id: 1 }, { id: 2 }] }));
		const result = await paginate(
			"https://p.test",
			op,
			{ gatherAll: true },
			guide,
			{ ...pathAuth, gatherAll: true, gatherAllMax: 2 },
		);
		expect(result.urls.length).toBeGreaterThan(0);
		for (const u of result.urls) {
			expect(u).toContain("/auth***/list");
			expect(u).not.toContain(TOKEN);
		}
		// The wire URL of the FIRST call carried the real token.
		const first = fetchUrlMock.mock.calls[0]![0] as string;
		expect(first).toContain(`/auth${TOKEN_ENC}/list`);
	});

	it("nextLink: a server-supplied nextUrl echoing the token (raw / %3A / %3a) is redacted", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/list", "paginate", {
			pagination: { style: "nextLink", itemsPath: "items", nextLinkPath: "next" },
		});
		fetchUrlMock
			.mockResolvedValueOnce(
				okResponse({
					items: [{ id: 1 }],
					next: `https://p.test/auth${TOKEN}/list`,
				}),
			)
			.mockResolvedValueOnce(
				okResponse({
					items: [{ id: 2 }],
					next: `https://p.test/auth${TOKEN_ENC_LOWER}/list`,
				}),
			)
			.mockResolvedValueOnce(okResponse({ items: [{ id: 3 }], next: null }));
		const result = await paginate("https://p.test", op, {}, guide, {
			...pathAuth,
			gatherAll: true,
		});
		expect(result.pages).toBe(3);
		for (const u of result.urls) {
			expect(u).not.toContain(TOKEN);
			expect(u).not.toContain(TOKEN_ENC);
			expect(u).not.toContain(TOKEN_ENC_LOWER);
			expect(u).toContain("/auth***/list");
		}
	});

	it("an SSRF-blocked nextUrl's error URL is redacted (errUrl, built separately)", async () => {
		// The SSRF-block error's errUrl is constructed separately from the other
		// surfaced URLs — a server-supplied nextLink pointing at a blocked host
		// that echoes the token must still surface redacted. The real ssrfGuard
		// runs (not skipped) — 169.254.169.254 is the cloud-metadata blocklist.
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/list", "paginate", {
			pagination: { style: "nextLink", itemsPath: "items", nextLinkPath: "next" },
		});
		fetchUrlMock.mockResolvedValueOnce(
			okResponse({
				items: [{ id: 1 }],
				next: `http://169.254.169.254/auth${TOKEN}/latest`,
			}),
		);
		try {
			await paginate("https://p.test", op, {}, guide, {
				...pathAuth,
				gatherAll: true,
			});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HelperError);
			const err = e as HelperError;
			expect(err.message).toContain("URL blocked during pagination");
			for (const surfaced of [err.url ?? "", err.found ?? ""]) {
				expect(surfaced).toContain("/auth***/latest");
				expect(surfaced).not.toContain(TOKEN);
			}
			// The fetch itself was blocked before any request — one call, page one.
			expect(fetchUrlMock.mock.calls.length).toBe(1);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Output-channel — error paths
// ═══════════════════════════════════════════════════════════════════

describe("path-secret error-path audit", () => {
	it("HelperError.url is redacted (raw token)", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/get");
		fetchUrlMock.mockResolvedValue({
			status: 401,
			headers: {},
			body: JSON.stringify({ error: `Unauthorized` }),
			cached: false,
		});
		try {
			await restGet("https://p.test", op, {}, guide, {
				...pathAuth,
				secretValues: [TOKEN, TOKEN_ENC, TOKEN_ENC_LOWER],
			});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HelperError);
			const err = e as HelperError;
			expect(err.url).toContain("/auth***/get");
			expect(err.url).not.toContain(TOKEN);
		}
	});

	it("a 401 body echoing the token scrubs in raw, %3A, and %3a forms", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/get");
		fetchUrlMock.mockResolvedValue({
			status: 401,
			headers: {},
			// Echo all three forms in one body.
			body: JSON.stringify({
				error: `bad ${TOKEN} / ${TOKEN_ENC} / ${TOKEN_ENC_LOWER}`,
			}),
			cached: false,
		});
		try {
			await restGet("https://p.test", op, {}, guide, {
				...pathAuth,
				secretValues: [TOKEN, TOKEN_ENC, TOKEN_ENC_LOWER],
			});
			expect.fail("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).not.toContain(TOKEN);
			expect(msg).not.toContain(TOKEN_ENC);
			expect(msg).not.toContain(TOKEN_ENC_LOWER);
			expect(msg).toContain("***");
		}
	});

	it("resolve-op folds the encoded forms into secretValues (body scrub end-to-end)", async () => {
		writeSecret("p.scrub", "path_key", TOKEN);
		const guide = makePathGuide("https://p.test");
		guide.domains = ["p.scrub"];
		const op = makeOp("/auth{token}/get");
		fetchUrlMock.mockResolvedValue({
			status: 401,
			headers: {},
			body: JSON.stringify({ error: `bad ${TOKEN_ENC}` }),
			cached: false,
		});
		// The executor throws (401); the message must carry the SCRUBBED body —
		// resolve-op folded TOKEN_ENC into the scrub set, so the %3A echo never
		// reaches agent context.
		await expect(resolveOpForExecution(guide, op, "p.scrub", {})).rejects.toThrow(
			/bad \*\*\*/,
		);
	});

	it("a HelperError from a throw-before-fetch path token still carries the filled URL", async () => {
		// Missing path token → fillPathStrict throws with the path in the message.
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/get");
		await expect(
			restGet("https://p.test", op, {}, guide, {}),
		).rejects.toMatchObject({ field: "params.token" });
	});
});

// ═══════════════════════════════════════════════════════════════════
// resolve-op — fail-closed + scrub folding
// ═══════════════════════════════════════════════════════════════════

describe("resolveOpForExecution — secretPathRefs", () => {
	it("missing required path ref fails closed BEFORE any fetch (restGet)", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/get");
		const outcome = await resolveOpForExecution(guide, op, "p.test", {});
		expect(outcome).toMatchObject({
			ok: false,
			reason: "auth_required_not_provisioned",
			missing: ["path_key"],
		});
		expect(fetchUrlMock).not.toHaveBeenCalled();
	});

	it("missing required path ref fails closed BEFORE any fetch (paginate)", async () => {
		const guide = makePathGuide("https://p.test");
		const op = makeOp("/auth{token}/list", "paginate", {
			pagination: {
				style: "offset-limit",
				itemsPath: "items",
				pageParam: "offset",
			},
		});
		const outcome = await resolveOpForExecution(guide, op, "p.test", {});
		expect(outcome).toMatchObject({
			ok: false,
			reason: "auth_required_not_provisioned",
			missing: ["path_key"],
		});
		expect(fetchUrlMock).not.toHaveBeenCalled();
	});

	it("provisioned: store-filled token in the fetched URL; authOpts carries path params + scrub set", async () => {
		writeSecret("p.ok", "path_key", TOKEN);
		const guide = makePathGuide("https://p.test");
		guide.domains = ["p.ok"];
		const op = makeOp("/auth{token}/get");
		fetchUrlMock.mockResolvedValue(okResponse());
		const outcome = await resolveOpForExecution(guide, op, "p.test", {});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			const calledUrl = fetchUrlMock.mock.calls[0]![0] as string;
			expect(calledUrl).toContain(TOKEN_ENC);
			expect(outcome.authOpts.secretPathParams).toEqual({ token: TOKEN });
			// Scrub set carries raw + both hex forms.
			expect(outcome.authOpts.secretValues).toContain(TOKEN);
			expect(outcome.authOpts.secretValues).toContain(TOKEN_ENC);
			expect(outcome.authOpts.secretValues).toContain(TOKEN_ENC_LOWER);
			if (outcome.via === "restGet") {
				expect((outcome.result as { url: string }).url).toContain("/auth***/get");
			}
		}
	});
});
