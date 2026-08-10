/**
 * BOE helper tests — date format + query DSL (bare CI) + live endpoint compose.
 *
 * Bare-CI tests import the real `helper.ts` directly and run on every commit.
 * Live tests (gated by HOST_INTEGRATION=1) prove the composed helper + restGet
 * pipeline works against the real BOE endpoint.
 *
 * Co-located with the helper and guide it tests.
 */

import { describe, it, expect } from "vitest";
import { withTempDirs } from "../_shared/test-harness.js";
import boeHelper from "./helper.js";

const HOST_INTEGRATION = process.env["HOST_INTEGRATION"] === "1";
const itWhen = HOST_INTEGRATION ? it : it.skip;

const CTX = { operation: "listConsolidada", domain: "boe.es" };

// ═══════════════════════════════════════════════════════════════════
// Bare-CI transform tests (always run)
// ═══════════════════════════════════════════════════════════════════

describe("BOE helper — date transform", () => {
	it("passes through already-aaaammdd dates for fecha (path param)", () => {
		const out = boeHelper(
			{ fecha: "20250101" },
			{ ...CTX, operation: "getSumario" },
		);
		expect(out["fecha"]).toBe("20250101");
	});

	it("converts ISO fecha (YYYY-MM-DD) to aaaammdd for path param", () => {
		const out = boeHelper(
			{ fecha: "2025-01-15" },
			{ ...CTX, operation: "getSumario" },
		);
		expect(out["fecha"]).toBe("20250115");
	});

	it("leaves non-date params untouched", () => {
		const out = boeHelper({ limit: 10, offset: 0 }, CTX);
		expect(out["limit"]).toBe(10);
		expect(out["offset"]).toBe(0);
	});
});

describe("BOE helper — query DSL transform", () => {
	it("wraps a plain single-word term as texto:<term>", () => {
		const out = boeHelper({ query: "crisis" }, CTX);
		expect(out["query"]).toBe(
			'{"query":{"query_string":{"query":"texto:crisis"}}}',
		);
	});

	it("auto-quotes a multi-word term so phrase search works", () => {
		const out = boeHelper({ query: "crisis economica" }, CTX);
		expect(out["query"]).toBe(
			'{"query":{"query_string":{"query":"texto:\\"crisis economica\\""}}}',
		);
	});

	it("passes a JSON-object query through verbatim (full DSL)", () => {
		const dsl =
			'{"query":{"query_string":{"query":"titulo:crisis"}},"sort":[{"fecha_publicacion":"desc"}]}';
		const out = boeHelper({ query: dsl }, CTX);
		expect(out["query"]).toBe(dsl);
	});

	it("serializes a caller-supplied DSL object verbatim (not [object Object])", () => {
		const dsl = { query: { query_string: { query: "texto:regularización" } } };
		const out = boeHelper({ query: dsl }, CTX);
		expect(out["query"]).toBe(JSON.stringify(dsl));
		expect(String(out["query"])).not.toContain("[object Object]");
	});

	it("serializes a field-specific DSL object verbatim", () => {
		const dsl = { query: { query_string: { query: "titulo:crisis" } } };
		const out = boeHelper({ query: dsl }, CTX);
		expect(out["query"]).toBe(JSON.stringify(dsl));
	});

	it("wraps an inner-content object missing the outer `query` key", () => {
		const inner = { query_string: { query: "titulo:crisis" } };
		const out = boeHelper({ query: inner }, CTX);
		expect(out["query"]).toBe(JSON.stringify({ query: inner }));
	});

	it("wraps inner content with range, preserving range alongside query_string", () => {
		const inner = {
			query_string: { query: "texto:crisis" },
			range: { fecha_publicacion: { gte: "19990101", lte: "19991231" } },
		};
		const out = boeHelper({ query: inner }, CTX);
		expect(out["query"]).toBe(JSON.stringify({ query: inner }));
	});

	it("passes a JSON-object query through even with leading whitespace", () => {
		const dsl = '  {"query":{"query_string":{"query":"texto:foo"}}}';
		const out = boeHelper({ query: dsl }, CTX);
		expect(out["query"]).toBe(dsl);
	});

	it("preserves accents in the search term", () => {
		const out = boeHelper({ query: "regularización" }, CTX);
		expect(out["query"]).toBe(
			'{"query":{"query_string":{"query":"texto:regularización"}}}',
		);
	});

	it("leaves an empty query as-is (so it is omitted, not sent)", () => {
		const out = boeHelper({ query: "" }, CTX);
		expect(out["query"]).toBe("");
	});

	it("coerces a non-string query value to string", () => {
		const out = boeHelper({ query: 12345 }, CTX);
		expect(out["query"]).toBe(
			'{"query":{"query_string":{"query":"texto:12345"}}}',
		);
	});

	it("transforms query and passes through from/to (handled by core dateParams)", () => {
		const out = boeHelper(
			{ from: "2025-01-01", to: "2025-12-31", query: "crisis" },
			CTX,
		);
		// from/to now pass through unchanged — core dateParams handles them
		expect(out["from"]).toBe("2025-01-01");
		expect(out["to"]).toBe("2025-12-31");
		expect(out["query"]).toBe(
			'{"query":{"query_string":{"query":"texto:crisis"}}}',
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Live endpoint compose tests (HOST_INTEGRATION=1)
// ═══════════════════════════════════════════════════════════════════

describe("BOE helper — live endpoint compose", () => {
	itWhen(
		"ISO dates pass through callHelper unchanged (core dateParams handles them later)",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const { setUserGuidesDir } = await import("../../core/guide-store.js");
			const { callHelper } = await import("../../core/local-helpers.js");

			setUserGuidesDir(guidesDir);

			const result = await callHelper("boe.es", "listConsolidada", {
				from: "2025-01-01",
				to: "2025-12-31",
				limit: 10,
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				// from/to pass through unchanged — normalization happens in
				// buildQueryParams via core dateParams, not in the helper.
				expect(result.params["from"]).toBe("2025-01-01");
				expect(result.params["to"]).toBe("2025-12-31");
				expect(result.params["limit"]).toBe(10);
			}
		}),
	);

	itWhen(
		"listConsolidada with a plain query term returns matches (helper DSL wrap)",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const { callHelper } = await import("../../core/local-helpers.js");
			const { restGet } = await import("../../core/helpers.js");
			const { setUserGuidesDir } = await import("../../core/guide-store.js");

			setUserGuidesDir(guidesDir);
			const loaded = loadApiGuidesFromDir(guidesDir);
			const guide = loaded.guides["boe.es"]!;
			const op = guide.operations.find((o) => o.name === "listConsolidada")!;

			const helped = await callHelper("boe.es", "listConsolidada", {
				query: "crisis",
				limit: 2,
			});
			expect(helped.ok).toBe(true);
			if (!helped.ok) return;
			expect(helped.params["query"]).toBe(
				'{"query":{"query_string":{"query":"texto:crisis"}}}',
			);

			const result = await restGet(guide.apiHost, op, helped.params, guide);
			expect(result.data).toBeTruthy();
			const body = result.data as Record<string, unknown>;
			expect(body["status"]).toBeTruthy();
			expect(Array.isArray(body["data"])).toBe(true);
		}),
		20_000,
	);
});
