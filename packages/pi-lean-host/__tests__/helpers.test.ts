/**
 * Helper execution tests.
 *
 * Covers:
 *  - restGet with path templating, query params, missing required params
 *  - paginate with all four styles (offset-limit, nextLink, cursor, page)
 *  - gatherAll ceiling
 *  - parseResponse XML→JSON + charset correction
 *  - 429 retry with backoff
 *  - URL safety at execute time (private IP, off-host path escape)
 *  - auth.kind: none vs unrecognised auth.kind
 *  - Caching: second identical call within TTL doesn't hit the server
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { startTestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";
import {
	restGet,
	paginate,
	parseResponse,
	HelperError,
	resolveJsonPath,
	normalizeDateParam,
} from "../core/helpers.js";
import { ssrfGuard } from "../core/ssrf-guard.js";
import { fetchUrl } from "../core/transport.js";
import type { ApiGuide, Operation } from "../core/api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Test server helpers
// ═══════════════════════════════════════════════════════════════════

interface TestContext {
	serverUrl: string;
	stop: () => Promise<void>;
	requestCounts: Map<string, number>;
}

/**
 * Create a test server that serves JSON items for pagination/restGet tests.
 *
 * Endpoints:
 *  GET /api/items          — returns all items (no pagination)
 *  GET /api/items/:id      — returns one item by path param
 *  GET /api/paginate/offset-limit?page=N&limit=M — paginated items
 *  GET /api/paginate/next-link?page=N — paginated with nextLink
 *  GET /api/paginate/cursor?cursor=X  — paginated with cursor
 *  GET /api/paginate/page?page=N&size=M — paginated with page
 *  GET /api/paginate/resumption-token?resumptionToken=X — paginated with resumptionToken
 *  GET /api/paginate/token-bag?continue&rccontinue — paginated with tokenBag
 *  GET /api/retry          — returns 429 once, then 200
 *  GET /api/xml            — returns XML with iso-8859-1 encoded content
 *  GET /api/cache-test     — returns response with ETag/Cache-Control
 *  GET /api/echo-headers   — echoes request headers as JSON
 */
async function createTestServer(): Promise<TestContext> {
	const requestCounts = new Map<string, number>();

	function count(path: string) {
		requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
	}

	const handler = (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const pathname = url.pathname;
		count(pathname);

		if (pathname === "/api/items") {
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=3600",
				ETag: '"items-v1"',
			});
			res.end(JSON.stringify({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
			return;
		}

		if (pathname.startsWith("/api/items/")) {
			const id = pathname.split("/").pop();
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=3600",
			});
			res.end(JSON.stringify({ data: { id: Number(id), name: `Item ${id}` } }));
			return;
		}

		if (pathname === "/api/items-query") {
			const page = parseInt(url.searchParams.get("page") ?? "0", 10);
			const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
			const items = Array.from({ length: limit }, (_, i) => ({
				id: page * limit + i + 1,
				name: `Item ${page * limit + i + 1}`,
			}));
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=60",
			});
			res.end(
				JSON.stringify({
					data: items,
					total: 100,
					page,
				}),
			);
			return;
		}

		if (pathname === "/api/paginate/offset-limit") {
			// Row-offset model: the `page` param is the raw row offset (the paginator
			// advances it by pageSize), matching real offset-limit APIs (BOE, USGS).
			const page = parseInt(url.searchParams.get("page") ?? "0", 10);
			const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
			const start = page;
			const totalItems = 35;
			const count = Math.min(limit, totalItems - start);
			if (count <= 0) {
				res.writeHead(200, {
					"Content-Type": "application/json",
				});
				res.end(JSON.stringify({ data: [], total: totalItems }));
				return;
			}
			const items = Array.from({ length: count }, (_, i) => ({
				id: start + i + 1,
				name: `Item ${start + i + 1}`,
			}));
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=5",
			});
			res.end(
				JSON.stringify({
					data: items,
					total: totalItems,
					page,
				}),
			);
			return;
		}

		if (pathname === "/api/paginate/next-link") {
			const page = parseInt(url.searchParams.get("page") ?? "1", 10);
			if (page > 3) {
				res.writeHead(200, {
					"Content-Type": "application/json",
				});
				res.end(JSON.stringify({ data: [], next: null }));
				return;
			}
			const items = Array.from({ length: 3 }, (_, i) => ({
				id: (page - 1) * 3 + i + 1,
			}));
			const next = page < 3 ? `/api/paginate/next-link?page=${page + 1}` : null;
			res.writeHead(200, {
				"Content-Type": "application/json",
			});
			res.end(JSON.stringify({ data: items, next }));
			return;
		}

		// nextLink SSRF test: first page's next points at metadata endpoint
		if (pathname === "/api/paginate/next-link-ssrf") {
			const page = parseInt(url.searchParams.get("page") ?? "1", 10);
			if (page >= 3) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [], next: null }));
				return;
			}
			const items = Array.from({ length: 2 }, (_, i) => ({
				id: (page - 1) * 2 + i + 1,
			}));
			const next = page === 1 ? "http://169.254.169.254/latest/meta-data/" : null;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: items, next }));
			return;
		}

		// nextLink SSRF bypass test: next points to the test server itself
		if (pathname === "/api/paginate/next-link-ssrf-bypass") {
			const page = parseInt(url.searchParams.get("page") ?? "1", 10);
			if (page >= 3) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [], next: null }));
				return;
			}
			const items = Array.from({ length: 2 }, (_, i) => ({
				id: (page - 1) * 2 + i + 1,
			}));
			const host = req.headers.host ?? "127.0.0.1";
			const next = `http://${host}/api/paginate/next-link-ssrf-bypass?page=${page + 1}`;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: items, next }));
			return;
		}

		// 302 redirect to the cloud metadata endpoint — used by the
		// fetchUrl guardRedirects test (M3). The initial URL is on the
		// test server (127.0.0.1); fetchUrl does NOT ssrf-check the
		// initial URL, only redirect targets, so this isolates the
		// redirect-guard behaviour from paginate's pre-fetch guard.
		if (pathname === "/redirect-to-metadata") {
			res.writeHead(302, {
				Location: "http://169.254.169.254/latest/meta-data/",
			});
			res.end();
			return;
		}

		if (pathname === "/api/paginate/cursor") {
			const cursor = url.searchParams.get("cursor") ?? "";
			if (cursor === "done") {
				res.writeHead(200, {
					"Content-Type": "application/json",
				});
				res.end(JSON.stringify({ data: [], nextCursor: null }));
				return;
			}
			const items = Array.from({ length: 3 }, (_, i) => ({
				id: i + 1,
				name: `Item ${i + 1} (cursor=${cursor})`,
			}));
			const nextCursor = cursor === "page2" ? "done" : "page2";
			res.writeHead(200, {
				"Content-Type": "application/json",
			});
			res.end(JSON.stringify({ data: items, nextCursor }));
			return;
		}

		if (pathname === "/api/paginate/page") {
			const page = parseInt(url.searchParams.get("page") ?? "1", 10);
			const size = parseInt(url.searchParams.get("size") ?? "5", 10);
			const totalItems = 12;
			// 1-based page index (matches the framework's page-style default and
			// real page-indexed APIs).
			const start = (page - 1) * size;
			const count = Math.min(size, totalItems - start);
			if (count <= 0) {
				res.writeHead(200, {
					"Content-Type": "application/json",
				});
				res.end(JSON.stringify({ results: [], total: totalItems }));
				return;
			}
			const items = Array.from({ length: count }, (_, i) => ({
				id: start + i + 1,
			}));
			res.writeHead(200, {
				"Content-Type": "application/json",
			});
			res.end(JSON.stringify({ results: items, total: totalItems }));
			return;
		}

		if (pathname === "/api/paginate/resumption-token") {
			const token = url.searchParams.get("resumptionToken") ?? "";
			if (token === "def") {
				// Page 3 — return items but NO resumptionToken → advance returns null → stop
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						ListRecords: {
							record: [
								{ id: 5, title: "Record 5" },
								{ id: 6, title: "Record 6" },
							],
						},
					}),
				);
				return;
			}
			const isFirst = token === "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					ListRecords: {
						record: isFirst
							? [
									{ id: 1, title: "Record 1" },
									{ id: 2, title: "Record 2" },
								]
							: [
									{ id: 3, title: "Record 3" },
									{ id: 4, title: "Record 4" },
								],
						resumptionToken: isFirst ? "abc" : "def",
					},
				}),
			);
			return;
		}

		if (pathname === "/api/paginate/token-bag") {
			const rcContinue = url.searchParams.get("rccontinue") ?? "";
			// Empty continue → no more pages
			const isDone = rcContinue === "done";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					continue: isDone ? {} : { rccontinue: "done", continue: "||" },
					query: {
						recentchanges: isDone
							? [{ title: "Page C", type: "edit" }]
							: [
									{ title: "Page A", type: "edit" },
									{ title: "Page B", type: "new" },
								],
					},
				}),
			);
			return;
		}

		// Server total extraction (B2): a single-page response carrying a
		// `total_count` count field (zero items — asserts the count is read
		// *before* the empty-page break so it still surfaces).
		if (pathname === "/api/search-zero") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ results: [], total_count: 0 }));
			return;
		}

		// OAI-PMH-style resumptionToken (B6): hyphenated `OAI-PMH` key plus the
		// `@_completeListSize` attribute the XML→JSON parser emits. The token text
		// lives under `#text`; the total under `@_completeListSize` (a string here,
		// exercising Number() coercion).
		if (pathname === "/api/oai-pmh") {
			const token = url.searchParams.get("resumptionToken") ?? "";
			const isFirst = token === "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					"OAI-PMH": {
						ListRecords: {
							record: isFirst ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }, { id: 4 }],
							resumptionToken: {
								"#text": isFirst ? "tok-abc" : "",
								"@_completeListSize": "54321",
							},
						},
					},
				}),
			);
			return;
		}

		if (pathname === "/api/retry") {
			const count = requestCounts.get(pathname) ?? 0;
			if (count === 1) {
				// First hit → 429
				res.writeHead(429, {
					"Content-Type": "application/json",
					"Retry-After": "1",
				});
				res.end(JSON.stringify({ error: "too many requests" }));
			} else {
				res.writeHead(200, {
					"Content-Type": "application/json",
				});
				res.end(JSON.stringify({ data: [{ id: "success" }] }));
			}
			return;
		}

		if (pathname === "/api/xml") {
			// Return an XML response that appears to be UTF-8 decoded but was
			// originally iso-8859-1. We send the correct Content-Type so the
			// transport decodes correctly. The test will override parseResponse
			// with a specific shape to test charset correction.
			const xml = `<?xml version="1.0" encoding="iso-8859-1"?>
<root>
  <item id="1">
    <title>BOE de 17 de julio de 2026</title>
  </item>
</root>`;
			res.writeHead(200, {
				"Content-Type": "application/xml; charset=iso-8859-1",
			});
			res.end(xml);
			return;
		}

		if (pathname === "/api/latin1-no-charset") {
			// ISO-8859-1 bytes for áéíóú, served with NO charset parameter —
			// the transport must fall back to the caller's fallbackCharset.
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(Buffer.from([0xe1, 0xe9, 0xed, 0xf3, 0xfa]));
			return;
		}

		if (pathname === "/api/utf8-with-charset") {
			// Real UTF-8 bytes for áéíóú, served WITH charset=utf-8 — the
			// header charset must win even if a fallbackCharset is supplied.
			res.writeHead(200, {
				"Content-Type": "application/json; charset=utf-8",
			});
			res.end(Buffer.from("áéíóú", "utf-8"));
			return;
		}

		if (pathname === "/api/cache-test") {
			const count = requestCounts.get(pathname) ?? 0;
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=300",
				ETag: '"cache-test-v1"',
				"X-Request-Count": String(count),
			});
			res.end(JSON.stringify({ data: [{ id: count }], count }));
			return;
		}

		if (pathname === "/api/echo-headers") {
			const headers: Record<string, string> = {};
			for (const [key, val] of Object.entries(req.headers)) {
				if (typeof val === "string") headers[key] = val;
			}
			res.writeHead(200, {
				"Content-Type": "application/json",
			});
			res.end(JSON.stringify({ headers }));
			return;
		}

		// ── Non-2xx error endpoints for status-check tests ─────

		if (pathname === "/api/error-400-xml") {
			const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<response>\n  <status>\n    <code>400</code>\n    <text>El parámetro fecha no cumple el formato.</text>\n  </status>\n</response>`;
			res.writeHead(400, { "Content-Type": "application/xml" });
			res.end(xml);
			return;
		}

		if (pathname === "/api/error-500") {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "internal server error" }));
			return;
		}

		if (pathname === "/api/error-403-plan") {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					status: {
						error_code: 1006,
						error_message: "plan doesn't support this endpoint",
					},
				}),
			);
			return;
		}

		if (pathname === "/api/error-403-generic") {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "forbidden" }));
			return;
		}

		// 404
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	};

	const { url, stop } = await startTestServer(handler);
	return { serverUrl: url, stop, requestCounts };
}

// ═══════════════════════════════════════════════════════════════════
// Minimal ApiGuide / Operation factory
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_GUIDE: ApiGuide = {
	content: "",
	updated: "2026-07-17",
	category: "site",
	source: "user",
	icon: "🔌",
	shortName: "Test",
	domains: ["test.example"],
	kind: "api",
	apiHost: "", // set per-test
	verified: "2026-07-17",
	gatherAllMax: 1000,
	auth: { kind: "none" },
	responseShape: { format: "json", charset: "utf-8" },
	operations: [],
};

function makeGuide(overrides?: Partial<ApiGuide>): ApiGuide {
	return { ...DEFAULT_GUIDE, ...overrides };
}

function makeOp(overrides?: Partial<Operation>): Operation {
	return {
		name: "test",
		via: "restGet",
		path: "/api/items",
		accept: "json",
		params: {},
		pathParams: [],
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════
// resolveJsonPath
// ═══════════════════════════════════════════════════════════════════

describe("resolveJsonPath", () => {
	it("resolves a simple dot path", () => {
		const obj = { data: { items: [1, 2] } };
		expect(resolveJsonPath(obj, "data.items")).toEqual([1, 2]);
	});

	it("resolves a path with array index", () => {
		const obj = { data: [{ id: 1 }, { id: 2 }] };
		expect(resolveJsonPath(obj, "data[1].id")).toBe(2);
	});

	it("handles $. prefix", () => {
		const obj = { foo: "bar" };
		expect(resolveJsonPath(obj, "$.foo")).toBe("bar");
	});

	it("returns undefined for missing path", () => {
		const obj = { data: {} };
		expect(resolveJsonPath(obj, "data.missing")).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════
// normalizeDateParam
// ═══════════════════════════════════════════════════════════════════

describe("normalizeDateParam", () => {
	it("converts ISO date (YYYY-MM-DD) to yyyymmdd", () => {
		expect(normalizeDateParam("2026-01-15", "yyyymmdd")).toBe("20260115");
	});

	it("converts ISO date (YYYY-MM-DD) to yyyy-mm-dd (passthrough)", () => {
		expect(normalizeDateParam("2026-01-15", "yyyy-mm-dd")).toBe("2026-01-15");
	});

	it("converts ISO date (YYYY-MM-DD) to iso8601 (keeps tail)", () => {
		expect(normalizeDateParam("2026-01-15", "iso8601")).toBe("2026-01-15");
	});

	it("converts ISO date with time tail to iso8601, preserves tail", () => {
		expect(normalizeDateParam("2026-01-15T10:30:00Z", "iso8601")).toBe(
			"2026-01-15T10:30:00Z",
		);
	});

	it("passes through already-yyyymmdd format", () => {
		expect(normalizeDateParam("20260115", "yyyymmdd")).toBe("20260115");
	});

	it("zero-pads single-digit month/day", () => {
		expect(normalizeDateParam("2026-1-5", "yyyymmdd")).toBe("20260105");
		expect(normalizeDateParam("2026-1-5", "yyyy-mm-dd")).toBe("2026-01-05");
	});

	it("passes through non-date strings as-is", () => {
		expect(normalizeDateParam("not-a-date", "yyyymmdd")).toBe("not-a-date");
	});

	it("converts compact YYYYMMDD to yyyy-mm-dd", () => {
		expect(normalizeDateParam("20260115", "yyyy-mm-dd")).toBe("2026-01-15");
	});

	it("coerces a number value to string", () => {
		expect(normalizeDateParam(20260115, "yyyymmdd")).toBe("20260115");
	});

	it("handles undefined/null as empty string", () => {
		expect(normalizeDateParam(undefined, "yyyymmdd")).toBe("");
		expect(normalizeDateParam(null, "yyyymmdd")).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════
// parseResponse
// ═══════════════════════════════════════════════════════════════════

describe("parseResponse", () => {
	it("parses JSON body", () => {
		const result = parseResponse('{"data":[1,2,3]}', {
			format: "json",
			charset: "utf-8",
		});
		expect(result).toEqual({ data: [1, 2, 3] });
	});

	it("parses XML body to JSON", () => {
		const xml = `<?xml version="1.0"?><root><item id="1"><title>Hello</title></item></root>`;
		const result = parseResponse(xml, { format: "xml", charset: "utf-8" });
		expect(result).toBeTypeOf("object");
		const r = result as Record<string, unknown>;
		expect(r).toHaveProperty("root");
	});

	it("throws HelperError on invalid JSON", () => {
		expect(() =>
			parseResponse("not json", { format: "json", charset: "utf-8" }),
		).toThrow(HelperError);
	});

	it("passes text body through raw (no trim)", () => {
		const result = parseResponse(" 1.0.13\n", {
			format: "text",
			charset: "utf-8",
		});
		expect(result).toBe(" 1.0.13\n");
	});

	it("handles XML with non-ASCII characters", () => {
		// Create iso-8859-1 bytes for áéíóú and decode as latin-1
		// (which maps each byte to the same Unicode code point —
		// this is what a correct iso-8859-1 decoding produces).
		const latin1Bytes = Buffer.from([0xe1, 0xe9, 0xed, 0xf3, 0xfa]);
		const body = latin1Bytes.toString("latin1");

		// fast-xml-parser handles the correctly-decoded string.
		const xml = `<?xml version="1.0"?><root><title>${body}</title></root>`;
		const result = parseResponse(xml, {
			format: "xml",
			charset: "utf-8",
		}) as Record<string, unknown>;

		const root = result["root"] as Record<string, unknown>;
		const title = root?.["title"] as string;
		expect(title).toBe(body); // round-trips through XML parser
	});
});

// ═══════════════════════════════════════════════════════════════════
// restGet
// ═══════════════════════════════════════════════════════════════════

describe("restGet", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.stop();
	});

	it("fetches items and returns parsed data", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/items" });

		const result = await restGet(ctx.serverUrl, op, {}, guide);
		expect(result.data).toEqual({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
	});

	it("fills path template from params", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items/{id}",
			pathParams: ["id"],
			params: {},
		});

		const result = await restGet(ctx.serverUrl, op, { id: 42 }, guide);
		expect(result.data).toEqual({ data: { id: 42, name: "Item 42" } });
	});

	it("fills query params with defaults and validates required", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: {
				page: { default: 0 },
				limit: { default: 5 },
			},
		});

		const result = await restGet(ctx.serverUrl, op, {}, guide);
		expect(result.data).toBeTypeOf("object");
		const d = result.data as Record<string, unknown>;
		expect(d["data"]).toBeTypeOf("object");
	});

	it("throws HelperError for missing required query param", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items",
			params: {
				api_key: { required: true },
			},
		});

		await expect(restGet(ctx.serverUrl, op, {}, guide)).rejects.toThrow(
			HelperError,
		);
	});

	// ── requiresAnyOf — at-least-one-of group guard ───────────────
	describe("restGet — requiresAnyOf group guard", () => {
		it("throws HelperError when no group member is supplied", async () => {
			const guide = makeGuide({ apiHost: ctx.serverUrl });
			const op = makeOp({
				path: "/api/items",
				params: {
					id: { description: "Resource id." },
					slug: { description: "Resource slug." },
					code: { description: "Resource code." },
				},
				requiresAnyOf: ["id", "slug", "code"],
			});

			await expect(restGet(ctx.serverUrl, op, {}, guide)).rejects.toThrow(
				HelperError,
			);
		});

		it("passes when at least one group member is supplied", async () => {
			const guide = makeGuide({ apiHost: ctx.serverUrl });
			const op = makeOp({
				path: "/api/items",
				params: {
					id: { description: "Resource id." },
					slug: { description: "Resource slug." },
				},
				requiresAnyOf: ["id", "slug"],
			});

			const result = await restGet(ctx.serverUrl, op, { id: 42 }, guide);
			expect(result.data).toBeTypeOf("object");
			expect(result.url).toContain("id=42");
		});
	});

	// Nested object/array query params must serialize as JSON on the wire,
	// not `[object Object]` (BOE's ES query_string DSL, filter objects, etc.).
	it("serializes a nested object query param as JSON, not [object Object]", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { query: {} },
		});
		const nested = { query_string: { query: "texto:regularización" } };

		const result = await restGet(ctx.serverUrl, op, { query: nested }, guide);
		expect(result.url).toContain(
			"query=%7B%22query_string%22%3A%7B%22query%22%3A%22",
		);
		expect(result.url).not.toContain("%5Bobject+Object%5D");
		expect(result.url).not.toContain("[object Object]");
		expect(result.params["query"]).toBe(JSON.stringify(nested));
	});

	it("serializes an array query param as JSON", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { tags: {} },
		});

		const result = await restGet(ctx.serverUrl, op, { tags: ["a", "b"] }, guide);
		expect(result.params["tags"]).toBe('["a","b"]');
		expect(result.url).not.toContain("[object Object]");
	});

	// `passthrough` — open param surface (Infogami /query.json flat form,
	// CKAN, OAI-PMH): caller supplies type-specific keys not declared in
	// the recipe. Default is a closed contract (extras dropped).
	it("drops undeclared caller params when passthrough is absent (closed contract)", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { type: { required: true } },
		});

		// `isbn_10` is not declared — must be dropped, not forwarded.
		const result = await restGet(
			ctx.serverUrl,
			op,
			{ type: "/type/edition", isbn_10: "0789312239" },
			guide,
		);
		expect(result.params["type"]).toBe("/type/edition");
		expect(result.params).not.toHaveProperty("isbn_10");
		expect(result.url).not.toContain("isbn_10");
	});

	it("forwards undeclared caller params when passthrough is true", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { type: { required: true }, limit: {} },
			passthrough: true,
		});

		// `isbn_10` is undeclared but should reach the wire as-is.
		const result = await restGet(
			ctx.serverUrl,
			op,
			{ type: "/type/edition", isbn_10: "0789312239", limit: 5 },
			guide,
		);
		expect(result.params["type"]).toBe("/type/edition");
		expect(result.params["limit"]).toBe("5");
		expect(result.params["isbn_10"]).toBe("0789312239");
		expect(result.url).toContain("isbn_10=0789312239");
	});

	it("passthrough still applies defaults and validates declared required params", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { type: { required: true }, limit: { default: 10 } },
			passthrough: true,
		});

		// Missing required `type` still throws even with passthrough on.
		await expect(
			restGet(ctx.serverUrl, op, { isbn_10: "0789312239" }, guide),
		).rejects.toThrow(HelperError);

		// Declared `limit` default still fires; undeclared `isbn_10` forwards.
		const result = await restGet(
			ctx.serverUrl,
			op,
			{ type: "/type/edition", isbn_10: "0789312239" },
			guide,
		);
		expect(result.params["limit"]).toBe("10");
		expect(result.params["isbn_10"]).toBe("0789312239");
	});

	it("passthrough never forwards path params, only query extras", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items/{id}",
			pathParams: ["id"],
			params: { type: { required: true } },
			passthrough: true,
		});

		// `id` is a path param — must fill the template, NOT appear in query.
		const result = await restGet(
			ctx.serverUrl,
			op,
			{ id: 42, type: "/type/edition", extra: "x" },
			guide,
		);
		expect(result.url).toContain("/api/items/42");
		expect(result.params).not.toHaveProperty("id");
		expect(result.params["extra"]).toBe("x");
	});

	it("passthrough forwards undeclared object params as JSON", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { type: { required: true } },
			passthrough: true,
		});
		const query = { type: "/type/edition", isbn_10: "0789312239" };

		const result = await restGet(
			ctx.serverUrl,
			op,
			{ type: "/type/edition", query },
			guide,
		);
		expect(result.params["query"]).toBe(JSON.stringify(query));
		expect(result.url).not.toContain("[object Object]");
	});

	it("throws HelperError for missing path param", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items/{id}",
			pathParams: ["id"],
		});

		await expect(restGet(ctx.serverUrl, op, {}, guide)).rejects.toThrow(
			HelperError,
		);
	});

	// `buildUrl` strips one leading / before resolving, so a path starting
	// with // becomes a regular relative path, not a protocol-relative URL.
	// This prevents host escape via path. (Agent-supplied URLs are not
	// SSRF-guarded — the guard lives in paginate's nextLink only. Fetching
	// 127.0.0.1 here without skipSsrfGuard already proves that.)
	//
	// Now that restGet checks response status before parsing, the 404
	// surfaces as a structured HelperError instead of silently returning
	// the 404 body. The 404 confirms the request reached the test server
	// (safe path resolution), not a different host.
	it("handles a //-prefixed path safely (not protocol-relative)", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "//api/safe-path",
			pathParams: [],
		});

		await expect(restGet(ctx.serverUrl, op, {}, guide)).rejects.toThrow(
			HelperError,
		);
	});

	it("serializes dateParams with iso8601 format", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { since: {} },
			dateParams: { since: "iso8601" },
		});

		const result = await restGet(
			ctx.serverUrl,
			op,
			{ since: "2026-01-15" },
			guide,
		);
		expect(result.params["since"]).toBe("2026-01-15");
	});

	it("serializes dateParams with yyyymmdd format", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { fecha: {} },
			dateParams: { fecha: "yyyymmdd" },
		});

		const result = await restGet(
			ctx.serverUrl,
			op,
			{ fecha: "2026-01-15" },
			guide,
		);
		expect(result.params["fecha"]).toBe("20260115");
	});

	it("dateParams applied in passthrough loop too", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/items-query",
			params: { type: { required: true } },
			dateParams: { until: "iso8601" },
			passthrough: true,
		});

		const result = await restGet(
			ctx.serverUrl,
			op,
			{ type: "/type/edition", until: "2026-06-01" },
			guide,
		);
		expect(result.params["until"]).toBe("2026-06-01");
		expect(result.params["type"]).toBe("/type/edition");
	});
});

// ═══════════════════════════════════════════════════════════════════
// paginate — all four styles
// ═══════════════════════════════════════════════════════════════════

describe("paginate", () => {
	let ctx: TestContext;
	const SKIP = { skipSsrfGuard: true } as const;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.stop();
	});

	it("walks offset-limit style to exhaustion with gatherAll:true", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "data",
			},
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/offset-limit",
			params: {},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(35);
		expect(result.ceilingHit).toBe(false);
		expect(result.items).toHaveLength(35);
		// Row-offset advance: offsets walk 0 → 10 → 20 → 30 (pageSize steps, not
		// +1 — a +1 advance would re-read rows 0-9,1-10,… and fetch ~350 dupes),
		// then one final empty fetch at offset 40 terminates the walk.
		expect(result.urls).toHaveLength(5);
		expect(result.urls[1]).toContain("page=10");
	});

	it("seeds the offset-limit page param from a declared recipe default", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "data",
			},
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/offset-limit",
			// 1-based APIs (USGS FDSN rejects offset=0) declare their start row.
			params: { page: { default: 1 } },
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, SKIP);
		// Single page fetched with the offset seeded from the declared default (1,
		// rows 1-10), NOT the hardcoded 0 (rows 0-9) — so the first item is id 2.
		expect(result.items).toHaveLength(10);
		expect(result.items[0]).toMatchObject({ id: 2 });
	});

	it("honors a caller-supplied page size even when the op does not declare it in params", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/offset-limit",
			// `limit` deliberately NOT declared in the op's params map — the
			// size resolve must still read the raw caller value, not drop it.
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				itemsPath: "data",
			},
		});

		const result = await paginate(ctx.serverUrl, op, { limit: 2 }, guide, SKIP);
		// The caller's limit=2 reaches the first URL — not the 50 fallback.
		expect(result.urls[0]).toContain("limit=2");
		expect(result.items).toHaveLength(2);
	});

	it("walks nextLink style to exhaustion with gatherAll:true", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/next-link",
			params: {},
			pagination: {
				style: "nextLink",
				nextLinkPath: "next",
				itemsPath: "data",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(9);
		expect(result.ceilingHit).toBe(false);
	});

	it("walks cursor style to exhaustion with gatherAll:true", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/cursor",
			params: {},
			pagination: {
				style: "cursor",
				cursorParam: "cursor",
				cursorPath: "nextCursor",
				itemsPath: "data",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(6);
		expect(result.ceilingHit).toBe(false);
	});

	it("walks page style to exhaustion with gatherAll:true", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/page",
			params: {},
			pagination: {
				style: "page",
				pageParam: "page",
				pageSizeParam: "size",
				pageSize: 5,
				itemsPath: "results",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(12);
		expect(result.ceilingHit).toBe(false);
	});

	it("gatherAll ceiling stops pagination early", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
			gatherAllMax: 15,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/offset-limit",
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "data",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(15);
		expect(result.ceilingHit).toBe(true);
		// Without gatherAll: true, returns a single page
		const result2 = await paginate(ctx.serverUrl, op, {}, guide, SKIP);
		expect(result2.totalFetched).toBe(10);
		expect(result2.ceilingHit).toBe(false);
	});

	it("paginate with explicit gatherAll:false returns a single page", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/offset-limit",
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "data",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: false,
			...SKIP,
		});
		expect(result.totalFetched).toBe(10);
		expect(result.ceilingHit).toBe(false);
	});

	it("gatherAll:true with ceiling above dataset walks to exhaustion", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
			gatherAllMax: 999,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/offset-limit",
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "data",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(35);
		expect(result.ceilingHit).toBe(false);
	});

	it("nextLink guard blocks metadata endpoint URL from server", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/next-link-ssrf",
			params: {},
			pagination: {
				style: "nextLink",
				nextLinkPath: "next",
				itemsPath: "data",
			},
		});

		// First page fetches OK; second page's nextUrl (metadata endpoint)
		// is blocked by ssrfGuard.
		const reqCountBefore =
			ctx.requestCounts.get("/api/paginate/next-link-ssrf") ?? 0;

		let caught: unknown;
		try {
			await paginate(ctx.serverUrl, op, {}, guide, {
				gatherAll: true,
			});
			expect.fail("should have thrown");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(HelperError);
		if (caught instanceof HelperError) {
			expect(caught.field).toBe("url");
			expect(caught.message).toMatch(/blocked during pagination/i);
		}

		// Only the first page was fetched — the guard prevented the second.
		const reqCountAfter =
			ctx.requestCounts.get("/api/paginate/next-link-ssrf") ?? 0;
		expect(reqCountAfter - reqCountBefore).toBe(1);
	});

	it("nextLink guard bypassed with skipSsrfGuard", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/next-link-ssrf-bypass",
			params: {},
			pagination: {
				style: "nextLink",
				nextLinkPath: "next",
				itemsPath: "data",
			},
		});

		// With skipSsrfGuard, the nextUrl (pointing at the test server) is
		// fetched and pagination completes normally.
		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			skipSsrfGuard: true,
		});
		expect(result.totalFetched).toBe(4); // 2 pages × 2 items
		expect(result.ceilingHit).toBe(false);
	});

	it("walks resumptionToken style to exhaustion with gatherAll:true", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/resumption-token",
			params: {},
			pagination: {
				style: "resumptionToken",
				tokenParam: "resumptionToken",
				tokenPath: "ListRecords.resumptionToken",
				itemsPath: "ListRecords.record",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(6); // 3 pages × 2 items
		expect(result.ceilingHit).toBe(false);
		expect(result.pages).toBe(3);
		// Page 2 should have resumptionToken in the URL
		expect(result.urls[1]).toContain("resumptionToken=abc");
	});

	it("walks tokenBag style to exhaustion with gatherAll:true", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
		});
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/token-bag",
			params: {},
			pagination: {
				style: "tokenBag",
				continuationParams: ["continue.continue", "continue.rccontinue"],
				itemsPath: "query.recentchanges",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(3); // 2 pages: 2 items + 1 item
		expect(result.ceilingHit).toBe(false);
		expect(result.pages).toBe(2);
		// Page 2 should have continuation params in the URL
		expect(result.urls[1]).toContain("continue=%7C%7C"); // || encoded
		expect(result.urls[1]).toContain("rccontinue=done");
	});

	// B2 — serverTotal extracted from the first page when totalCountPath
	// is declared and resolves to a number.
	it("populates serverTotal from the first page when totalCountPath resolves", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/offset-limit",
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "data",
				totalCountPath: "total",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.totalFetched).toBe(35);
		expect(result.serverTotal).toBe(35);
	});

	// B2 — no totalCountPath → serverTotal stays undefined.
	it("leaves serverTotal undefined when no totalCountPath is declared", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			via: "paginate",
			path: "/api/paginate/offset-limit",
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "data",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.serverTotal).toBeUndefined();
	});

	// B2 — a zero-result page that still carries the count surfaces it. The
	// count is extracted BEFORE the empty-page break, so `total_count: 0`
	// (or any count alongside an empty items array) is not lost.
	it("surfaces serverTotal on a zero-result page that still reports a count", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			via: "paginate",
			path: "/api/search-zero",
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "results",
				totalCountPath: "total_count",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.items).toHaveLength(0);
		expect(result.serverTotal).toBe(0);
	});

	// B2 — a non-resolving or non-numeric totalCountPath leaves serverTotal
	// undefined (not the path's object, not NaN).
	it("leaves serverTotal undefined when the totalCountPath value is not numeric", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			via: "paginate",
			path: "/api/search-zero",
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				pageSizeParam: "limit",
				pageSize: 10,
				itemsPath: "results",
				totalCountPath: "nope.missing", // never resolves
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		expect(result.serverTotal).toBeUndefined();
	});

	// B6 — the DNB OAI-PMH shape: hyphenated `OAI-PMH` key, `@_` attribute prefix
	// from the XML→JSON parser, numeric-string `@_completeListSize` coerced via
	// Number(). Verified against a fixture that mirrors the real DNB payload.
	it("resolves the DNB OAI-PMH totalCountPath through resolveJsonPath (numeric string)", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			via: "paginate",
			path: "/api/oai-pmh",
			params: {},
			pagination: {
				style: "resumptionToken",
				tokenParam: "resumptionToken",
				tokenPath: "OAI-PMH.ListRecords.resumptionToken.#text",
				itemsPath: "OAI-PMH.ListRecords.record",
				totalCountPath: "OAI-PMH.ListRecords.resumptionToken.@_completeListSize",
			},
		});

		const result = await paginate(ctx.serverUrl, op, {}, guide, {
			gatherAll: true,
			...SKIP,
		});
		// Walks 2 pages (token tok-abc → empty #text stops), 4 items.
		expect(result.totalFetched).toBe(4);
		expect(result.serverTotal).toBe(54321);
	});
});

// ═══════════════════════════════════════════════════════════════════
// 429 retry
// ═══════════════════════════════════════════════════════════════════

describe("429 retry", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.stop();
	});

	it("retries 429 with backoff and succeeds", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/retry" });

		const result = await restGet(ctx.serverUrl, op, {}, guide, {
			fresh: true,
		});
		expect(result.data).toEqual({ data: [{ id: "success" }] });
	});
});

// ═══════════════════════════════════════════════════════════════════
// Auth dispatch
// ═══════════════════════════════════════════════════════════════════

describe("auth dispatch", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.stop();
	});

	it("auth.kind: none produces no auth header", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
			auth: { kind: "none" },
		});
		const op = makeOp({ path: "/api/echo-headers" });

		const result = await restGet(ctx.serverUrl, op, {}, guide);
		const body = result.data as Record<string, unknown>;
		const headers = body["headers"] as Record<string, string>;

		expect(headers["authorization"]).toBeUndefined();
	});

	it("oauth2 auth kind is accepted by checkAuth (no auth.kind throw)", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
			auth: {
				kind: "oauth2",
				grant: "client_credentials",
				tokenUrl: "https://api.example.com/oauth/token",
				clientId: { secret: "c" },
			},
		});
		const op = makeOp({ path: "/api/items" });

		// checkAuth accepts oauth2 — token resolution happens in resolve-op,
		// not here, so restGet proceeds to the transport (any error below is a
		// transport error, never an auth.kind rejection).
		try {
			await restGet(ctx.serverUrl, op, {}, guide);
		} catch (e) {
			expect(e).not.toBeInstanceOf(HelperError);
			if (e instanceof HelperError) {
				expect(e.field).not.toBe("auth.kind");
			}
		}
	});

	it("static-key injects store-resolved authHeaders into the request", async () => {
		const guide = makeGuide({
			apiHost: ctx.serverUrl,
			auth: { kind: "static-key" },
		});
		const op = makeOp({ path: "/api/echo-headers" });

		const result = await restGet(ctx.serverUrl, op, {}, guide, {
			authHeaders: { "X-Api-Key": "secret123" },
		});
		const body = result.data as Record<string, unknown>;
		const headers = (body["headers"] as Record<string, string>) ?? {};
		expect(headers["x-api-key"]).toBe("secret123");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Caching
// ═══════════════════════════════════════════════════════════════════

describe("caching", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.stop();
	});

	it("second identical call within TTL returns cached result", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/cache-test" });

		// First call (fresh to bypass any previous cache)
		const result1 = await restGet(ctx.serverUrl, op, {}, guide, {
			fresh: true,
		});
		const data1 = result1.data as Record<string, unknown>;
		expect(data1["data"]).toEqual([{ id: expect.any(Number) }]);

		// Second call (should use cache — same count)
		const result2 = await restGet(ctx.serverUrl, op, {}, guide);
		const data2 = result2.data as Record<string, unknown>;
		expect(data2["count"]).toBe(data1["count"]);
	});

	it("propagates response headers (etag, cache-control) to the caller", async () => {
		// Guards parseHeaders: undici v7 returns headers as a plain object,
		// not the raw pair-array form. A regression makes result.headers {}.
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/cache-test" });

		const result = await restGet(ctx.serverUrl, op, {}, guide, {
			fresh: true,
		});

		expect(result.headers["etag"]).toBe('"cache-test-v1"');
		expect(result.headers["cache-control"]).toContain("max-age=300");
	});

	it("same URL with different Accept headers does not share cache", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });

		// First call with JSON accept — fresh to seed cache.
		const opJson = makeOp({ path: "/api/echo-headers" });
		const result1 = await restGet(ctx.serverUrl, opJson, {}, guide, {
			fresh: true,
		});
		const body1 = result1.data as Record<string, unknown>;
		expect((body1["headers"] as Record<string, string>)["accept"]).toBe(
			"application/json",
		);

		// Second call with XML accept — should NOT return cached JSON result.
		const opXml = makeOp({
			path: "/api/echo-headers",
			accept: "xml",
		});
		const result2 = await restGet(ctx.serverUrl, opXml, {}, guide);
		const body2 = result2.data as Record<string, unknown>;
		expect((body2["headers"] as Record<string, string>)["accept"]).toBe(
			"application/xml",
		);

		// Third call with JSON accept again — should return cached JSON result.
		const result3 = await restGet(ctx.serverUrl, opJson, {}, guide);
		const body3 = result3.data as Record<string, unknown>;
		expect((body3["headers"] as Record<string, string>)["accept"]).toBe(
			"application/json",
		);
	});

	it("same URL with different auth headers does not share cache", async () => {
		// Standard key-less request — fresh to seed the module-level cache.
		const plain = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/echo-headers" });
		await restGet(ctx.serverUrl, op, {}, plain, { fresh: true });

		// Call 1: with X-Api-Key A — must NOT be served from the no-key
		// cache entry seeded above, and must NOT poison it for the keyed
		// callers (auth-bearing responses are never cached).
		const keyA = makeGuide({
			apiHost: ctx.serverUrl,
			auth: { kind: "none", headers: { "X-Api-Key": "DEMO_KEY" } },
		});
		const result1 = await restGet(ctx.serverUrl, op, {}, keyA);
		const body1 = result1.data as Record<string, unknown>;
		expect((body1["headers"] as Record<string, string>)["x-api-key"]).toBe(
			"DEMO_KEY",
		);

		// Call 2: same URL, different key — would hit the cache entry
		// seeded by call 1 under the old bug and echo DEMO_KEY back. Must
		// go to the wire and return the second key.
		const keyB = makeGuide({
			apiHost: ctx.serverUrl,
			auth: { kind: "none", headers: { "X-Api-Key": "REAL_KEY" } },
		});
		const result2 = await restGet(ctx.serverUrl, op, {}, keyB);
		const body2 = result2.data as Record<string, unknown>;
		expect((body2["headers"] as Record<string, string>)["x-api-key"]).toBe(
			"REAL_KEY",
		);

		// Call 3: back to DEMO_KEY — cache must not reuse either keyed call.
		const result3 = await restGet(ctx.serverUrl, op, {}, keyA);
		const body3 = result3.data as Record<string, unknown>;
		expect((body3["headers"] as Record<string, string>)["x-api-key"]).toBe(
			"DEMO_KEY",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Non-2xx status handling
// ═══════════════════════════════════════════════════════════════════

describe("non-2xx status handling", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.stop();
	});

	it("400 with XML body surfaces the real server message, not 'Invalid JSON'", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			path: "/api/error-400-xml",
			accept: "xml",
		});

		try {
			await restGet(ctx.serverUrl, op, {}, guide);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HelperError);
			if (e instanceof HelperError) {
				expect(e.field).toBe("response");
				expect(e.message).toContain("400");
				expect(e.message).toContain("fecha no cumple el formato");
				expect(e.message).not.toContain("Invalid JSON");
				expect(e.found).toBe("400");
				expect(e.expected).toBe("HTTP 2xx");
			}
		}
	});

	it("500 surfaces status + body text", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/error-500" });

		try {
			await restGet(ctx.serverUrl, op, {}, guide);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HelperError);
			if (e instanceof HelperError) {
				expect(e.field).toBe("response");
				expect(e.message).toContain("500");
				expect(e.message).toContain("internal server error");
				expect(e.found).toBe("500");
			}
		}
	});

	it("403 with plan-gated JSON surfaces the server reason + plan hint", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/error-403-plan" });

		try {
			await restGet(ctx.serverUrl, op, {}, guide);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HelperError);
			if (e instanceof HelperError) {
				expect(e.message).toContain("403");
				expect(e.message).toContain("plan doesn't support this endpoint");
				expect(e.message).toContain("plan/subscription limitation");
			}
		}
	});

	it("403 with generic JSON surfaces the server reason, no plan hint", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/error-403-generic" });

		try {
			await restGet(ctx.serverUrl, op, {}, guide);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HelperError);
			if (e instanceof HelperError) {
				expect(e.message).toContain("403");
				expect(e.message).toContain("forbidden");
				expect(e.message).not.toContain("plan/subscription limitation");
			}
		}
	});

	it("2xx still parses normally", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({ path: "/api/items" });

		const result = await restGet(ctx.serverUrl, op, {}, guide, {
			fresh: true,
		});
		expect(result.data).toEqual({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
	});

	it("paginate throws HelperError on first-page 4xx", async () => {
		const guide = makeGuide({ apiHost: ctx.serverUrl });
		const op = makeOp({
			via: "paginate",
			path: "/api/error-400-xml",
			accept: "xml",
			params: {},
			pagination: {
				style: "offset-limit",
				pageParam: "page",
				itemsPath: "items",
			},
		});

		await expect(paginate(ctx.serverUrl, op, {}, guide)).rejects.toThrow(
			HelperError,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// SSRF guard (M1) — IPv4-mapped IPv6 bypass + baseline blocks
// ═══════════════════════════════════════════════════════════════════

describe("ssrfGuard — IPv4-mapped IPv6 (M1)", () => {
	it("blocks IPv4-mapped loopback in hex form", () => {
		// Node renders http://[::ffff:127.0.0.1]/ as "[::ffff:7f00:1]" —
		// the old decimal "::ffff:127" check never matched this.
		expect(ssrfGuard("http://[::ffff:127.0.0.1]/").ok).toBe(false);
	});

	it("blocks IPv4-mapped private + metadata ranges", () => {
		expect(ssrfGuard("http://[::ffff:10.0.0.1]/").ok).toBe(false);
		expect(ssrfGuard("http://[::ffff:192.168.1.1]/").ok).toBe(false);
		expect(ssrfGuard("http://[::ffff:169.254.169.254]/").ok).toBe(false);
	});

	it("still blocks plain IPv4 private/metadata/loopback", () => {
		expect(ssrfGuard("http://127.0.0.1/").ok).toBe(false);
		expect(ssrfGuard("http://10.0.0.1/").ok).toBe(false);
		expect(ssrfGuard("http://169.254.169.254/").ok).toBe(false);
	});

	it("allows public hostnames", () => {
		expect(ssrfGuard("https://api.example.com/v1/foo").ok).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════
// fetchUrl guardRedirects (M3) — redirect-target SSRF guarding
// ═══════════════════════════════════════════════════════════════════

describe("fetchUrl — fallbackCharset", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});
	afterAll(async () => {
		await ctx.stop();
	});

	it("falls back to fallbackCharset when the response omits a charset", async () => {
		// Server serves ISO-8859-1 bytes with no charset parameter.
		const { body } = await fetchUrl(`${ctx.serverUrl}/api/latin1-no-charset`, {
			fallbackCharset: "iso-8859-1",
			fresh: true,
		});
		expect(body).toBe("áéíóú");
	});

	it("uses utf-8 by default when no fallbackCharset is supplied", async () => {
		const { body } = await fetchUrl(`${ctx.serverUrl}/api/latin1-no-charset`, {
			fresh: true,
		});
		expect(body).not.toBe("áéíóú");
		expect(body).toBe("�����");
	});

	it("header charset wins over fallbackCharset", async () => {
		// Server declares charset=utf-8; supplying a latin-1 fallback must
		// NOT override it — the header charset always wins.
		const { body } = await fetchUrl(`${ctx.serverUrl}/api/utf8-with-charset`, {
			fallbackCharset: "iso-8859-1",
			fresh: true,
		});
		expect(body).toBe("áéíóú");
	});
});

describe("fetchUrl — guardRedirects (M3)", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.stop();
	});

	it("blocks a 302 redirect to the cloud metadata endpoint", async () => {
		// fetchUrl does NOT ssrf-check the initial URL (paginate owns that),
		// so hitting the 127.0.0.1 test server is fine. The redirect target
		// (169.254.169.254) must be blocked before it is fetched.
		const before = ctx.requestCounts.get("/redirect-to-metadata") ?? 0;
		await expect(
			fetchUrl(`${ctx.serverUrl}/redirect-to-metadata`, {
				guardRedirects: true,
			}),
		).rejects.toThrow(/Redirect to blocked host/i);

		// The redirect endpoint was hit exactly once (the SSRF block is not
		// transient, so fetchUrl must not retry).
		const after = ctx.requestCounts.get("/redirect-to-metadata") ?? 0;
		expect(after - before).toBe(1);
	});
});
