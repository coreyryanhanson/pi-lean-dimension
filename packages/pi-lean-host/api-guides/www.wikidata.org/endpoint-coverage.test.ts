/**
 * Wikidata recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every operation against the live endpoint, and
 * asserts the response has the expected shape (200 + non-empty body /
 * expected `itemsPath` for `paginate` ops).
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

const DIR = "www.wikidata.org";
const DOMAIN = "wikidata.org";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; delay wrapper stays here) ──

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const _fetch = createFetchOp(DOMAIN);

async function fetchOp(
	guidesDir: string,
	name: string,
	params: Record<string, unknown> = {},
) {
	await delay(100);
	return _fetch(guidesDir, name, params);
}

// ── Stable identifiers (live, 2026-07-21 probes) ──────────────────
const Q42 = "Q42"; // Douglas Adams (item)
const P31 = "P31"; // instance of (property)
const P569 = "P569"; // date of birth (property)

// ═══════════════════════════════════════════════════════════════════
// Baseline
// ═══════════════════════════════════════════════════════════════════

describe("Wikidata live integration smoke", () => {
	itWhen(
		"parses and loads the recipe with all 9 ops",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("www.wikidata.org");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["www.wikidata.org"]!;
			expect(guide.apiHost).toBe("https://www.wikidata.org");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(9);
		}),
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Action API: entity search
// ═══════════════════════════════════════════════════════════════════

describe("Wikidata Group A — entity search", () => {
	itWhen(
		"searchEntities returns results via paginate",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchEntities", {
				search: "Douglas Adams",
				language: "en",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ id: expect.any(String) });
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Action API: claims retrieval
// ═══════════════════════════════════════════════════════════════════

describe("Wikidata Group B — claims retrieval", () => {
	itWhen(
		"getClaims returns a non-empty property→claims map",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getClaims", {
				entity: Q42,
			})) as { data: { claims?: Record<string, unknown[]> } };
			expect(result.data).toBeTruthy();
			expect(typeof result.data.claims).toBe("object");
			expect(Object.keys(result.data.claims ?? {}).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getClaims honors the property filter",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getClaims", {
				entity: Q42,
				property: P569,
			})) as { data: { claims?: Record<string, unknown[]> } };
			const claims = result.data.claims ?? {};
			expect(Object.keys(claims)).toEqual([P569]);
			expect(claims[P569]?.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C + E — REST API: item & property retrieval
// ═══════════════════════════════════════════════════════════════════

describe("Wikidata Groups C+E — REST item & property retrieval", () => {
	itWhen(
		"getItemREST returns the full item",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getItemREST", {
				item_id: Q42,
			})) as { data: { id?: unknown; type?: unknown; labels?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.id).toBe(Q42);
			expect(result.data.type).toBe("item");
			expect(typeof result.data.labels).toBe("object");
		}),
		30_000,
	);

	itWhen(
		"getPropertyREST returns the full property",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPropertyREST", {
				property_id: P31,
			})) as {
				data: { id?: unknown; type?: unknown; data_type?: unknown };
			};
			expect(result.data).toBeTruthy();
			expect(result.data.id).toBe(P31);
			expect(result.data.type).toBe("property");
			expect(result.data.data_type).toBeTruthy();
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D + F — REST API: statement sub-resources
// ═══════════════════════════════════════════════════════════════════

describe("Wikidata Groups D+F — REST statement sub-resources", () => {
	itWhen(
		"getItemStatements returns a property→array map",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getItemStatements", {
				item_id: Q42,
			})) as { data: Record<string, unknown[]> };
			expect(result.data).toBeTruthy();
			expect(Object.keys(result.data).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getItemStatements honors the property filter",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getItemStatements", {
				item_id: Q42,
				property: P569,
			})) as { data: Record<string, unknown[]> };
			expect(Object.keys(result.data)).toEqual([P569]);
			expect(result.data[P569]?.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPropertyStatements returns a property→array map",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPropertyStatements", {
				property_id: P31,
			})) as { data: Record<string, unknown[]> };
			expect(result.data).toBeTruthy();
			expect(Object.keys(result.data).length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group G — REST API: search
// ═══════════════════════════════════════════════════════════════════

describe("Wikidata Group G — REST search", () => {
	itWhen(
		"searchItemsREST returns results via paginate",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchItemsREST", {
				q: "Douglas Adams",
				language: "en",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ id: expect.any(String) });
		}),
		30_000,
	);

	itWhen(
		"searchPropertiesREST returns results via paginate",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchPropertiesREST", {
				q: "population",
				language: "en",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ id: expect.any(String) });
		}),
		30_000,
	);
});
