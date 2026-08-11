/**
 * arXiv recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Tests the live arXiv API (`export.arxiv.org/api/query`): parses the recipe,
 * executes every defined operation against the live endpoint, and asserts the
 * response has the expected shape. The `max_results=1` / single-id array
 * assertion is the design-doc A1 proof; the unprefixed-field + serverTotal
 * assertions are the A2 proof.
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1.
 * Co-located with the guide it tests.
 */

import { describe, expect } from "vitest";
import {
	withTempDirs,
	createFetchOp,
	itWhen,
} from "../_shared/test-harness.js";

const DOMAIN = "arxiv.org";

// Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper —
// arXiv needs no pacing/retry/auth overlay, and each test issues 1 request).
const fetchOp = createFetchOp(DOMAIN);

// A real arXiv ID (permanent — abstracts never age out).
const KNOWN_ID = "cond-mat/0011267";

describe("arXiv live integration smoke", () => {
	itWhen(
		"parses and loads the arXiv recipe from a temp user dir",
		withTempDirs("arxiv.org")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("arxiv.org");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["arxiv.org"]!;
			expect(guide.apiHost).toBe("https://export.arxiv.org");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(3);
		}),
	);

	itWhen(
		"search fetches a clean first page with unprefixed fields and serverTotal (A2)",
		withTempDirs("arxiv.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "search", {
				search_query: "all:electron",
			})) as { items: Record<string, unknown>[]; serverTotal?: number };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			// A2, totalCountPath: `feed.totalResults` resolves (OpenSearch prefix stripped).
			expect(result.serverTotal).toBeGreaterThan(0);
			// A2, inner fields: `arxiv:`-prefixed extensions are unprefixed.
			const first = result.items[0]!;
			expect(first["primary_category"]).toBeTruthy();
			// Error-sentinel guard: a normal page collects only real entries
			// (arXiv returns a 500 / error entry past the result set, never here).
			for (const item of result.items) {
				expect(String(item["id"])).toContain("/abs/");
				expect(String(item["id"])).not.toContain("/api/errors");
			}
		}),
		20_000,
	);

	itWhen(
		"fetchByIds fetches a single known ID as a boxed one-entry array (A1)",
		withTempDirs("arxiv.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "fetchByIds", {
				id_list: KNOWN_ID,
			})) as { items: Record<string, unknown>[]; serverTotal?: number };
			// A1: a single `<entry>` must box into an array of length 1, not a bare object.
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items).toHaveLength(1);
			expect(result.serverTotal).toBe(1);
			expect(String(result.items[0]!["id"])).toContain("/abs/");
		}),
		20_000,
	);

	itWhen(
		"searchRecent lists recent results for a category with recency sort defaulted",
		withTempDirs("arxiv.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchRecent", {
				search_query: "cat:cs.LG",
			})) as { items: Record<string, unknown>[]; serverTotal?: number };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			// Sort defaults bake in submittedDate/descending; entries carry `published`.
			expect(String(result.items[0]!["published"])).toBeTruthy();
			expect(result.serverTotal).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"search with a guaranteed-no-match query returns empty items and serverTotal 0",
		withTempDirs("arxiv.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "search", {
				search_query: "ti:zzzzzzzzzzzzqqqqqqqq",
			})) as { items: unknown[]; serverTotal?: number };
			expect(result.items).toEqual([]);
			expect(result.serverTotal).toBe(0);
		}),
		20_000,
	);
});
