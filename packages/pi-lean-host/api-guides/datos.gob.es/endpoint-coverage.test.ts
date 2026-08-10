/**
 * datos.gob.es recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every defined operation against the live
 * endpoint, and asserts the response has the expected shape.
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

const DOMAIN = "datos.gob.es";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper) ──

const fetchOp = createFetchOp(DOMAIN);

/**
 * Unwrap the LDA items array from either executor's result.
 * `paginate` returns accumulated `{items}`; `restGet` returns `{data}` with
 * the envelope (`data.result.items`).
 */
function unwrapItems(result: unknown): unknown[] {
	const r = result as {
		items?: unknown;
		data?: { result?: { items?: unknown } };
	};
	const items = Array.isArray(r.items) ? r.items : r.data?.result?.items;
	return Array.isArray(items) ? items : [];
}

// ═══════════════════════════════════════════════════════════════════
// Baseline: parse + recipe shape
// ═══════════════════════════════════════════════════════════════════

describe("datos.gob.es live integration smoke", () => {
	itWhen(
		"listDatasets returns an LDA envelope with non-empty items",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "listDatasets");
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"parses and loads the datos.gob.es recipe from a temp user dir",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain(DOMAIN);
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides[DOMAIN]!;
			expect(guide.apiHost).toBe("https://datos.gob.es");
			expect(guide.auth.kind).toBe("none");
			// listDatasets + 7 dataset search + 1 detail + 3 distributions +
			// 3 lookup tables + 2 NTI public sector + 5 NTI territory.
			expect(guide.operations.length).toBe(22);
		}),
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Dataset search/lookup
// ═══════════════════════════════════════════════════════════════════

describe("datos.gob.es Group A — dataset search/lookup", () => {
	// The 7 paginated search ops share the LDA envelope; each carries a
	// docs-example filter value verified to return results live (2026-08).
	const SEARCH_OPS: [string, Record<string, unknown>][] = [
		["searchDatasetsByTitle", { title: "empleo" }],
		["searchDatasetsByPublisher", { id: "E05068001" }],
		["searchDatasetsByTheme", { id: "hacienda" }],
		["searchDatasetsByFormat", { format: "csv" }],
		["searchDatasetsByKeyword", { keyword: "salud" }],
		[
			"searchDatasetsBySpatial",
			{ spatialWord1: "Autonomia", spatialWord2: "Pais-Vasco" },
		],
		[
			"searchDatasetsModifiedBetween",
			{ beginDate: "2024-01-01", endDate: "2024-12-31" },
		],
	];

	for (const [name, params] of SEARCH_OPS) {
		itWhen(
			`${name} returns an LDA envelope with non-empty items`,
			withTempDirs(DOMAIN)(async ({ guidesDir }) => {
				const result = await fetchOp(guidesDir, name, params);
				const items = unwrapItems(result);
				expect(items.length).toBeGreaterThan(0);
			}),
			20_000,
		);
	}

	itWhen(
		"getDatasetById returns the envelope for a dataset id taken from listDatasets",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			// Derive a real dataset id from the browse list's first item.
			const browse = await fetchOp(guidesDir, "listDatasets");
			const first = unwrapItems(browse)[0] as { _about?: string } | undefined;
			const id = first?._about?.split("/").pop();
			expect(typeof id).toBe("string");

			const result = await fetchOp(guidesDir, "getDatasetById", { id });
			expect(unwrapItems(result).length).toBe(1);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Distribution endpoints
// ═══════════════════════════════════════════════════════════════════

describe("datos.gob.es Group B — distributions", () => {
	itWhen(
		"listDistributions returns an LDA envelope with non-empty items",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "listDistributions");
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"searchDistributionsByDataset returns distributions for a dataset id from listDatasets",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const browse = await fetchOp(guidesDir, "listDatasets");
			const first = unwrapItems(browse)[0] as { _about?: string } | undefined;
			const id = first?._about?.split("/").pop();
			expect(typeof id).toBe("string");

			const result = await fetchOp(guidesDir, "searchDistributionsByDataset", {
				id,
			});
			const items = unwrapItems(result);
			// Not every dataset has distributions published; empty is tolerated.
			if (items.length > 0) {
				expect((items[0] as { _about?: string })._about).toContain(
					"/resource/",
				);
			}
		}),
		20_000,
	);

	itWhen(
		"searchDistributionsByFormat returns distributions for format token csv",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "searchDistributionsByFormat", {
				format: "csv",
			});
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Lookup tables
// ═══════════════════════════════════════════════════════════════════

describe("datos.gob.es Group C — lookup tables", () => {
	itWhen(
		"listPublishers returns an LDA envelope with non-empty items",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "listPublishers");
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	// Known server-side failure, kept for honesty: /apidata/catalog/spatial 500s
	// with {E211} Base URI is null — the LDA serializer chokes on a single corrupt
	// vocabulary item (<miteco-hvd>, a relative URI with no base) on page 0. Not a
	// WAF block, not a format/param issue (every format 500s on page 0; _page=1
	// returns 200). See the plan's "Implementation notes". Bare CI (the binding
	// gate) skips this; live is best-effort per the rollout's C2 rule.
	itWhen(
		"listSpatial returns an LDA envelope with non-empty items",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "listSpatial");
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"listThemes returns an LDA envelope with non-empty items",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "listThemes");
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — NTI public-sector taxonomy
// ═══════════════════════════════════════════════════════════════════

describe("datos.gob.es Group D — NTI public sector", () => {
	itWhen(
		"listPublicSectors returns an LDA envelope with non-empty items",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "listPublicSectors");
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getPublicSectorById returns the envelope for sector slug comercio",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "getPublicSectorById", {
				id: "comercio",
			});
			const items = unwrapItems(result);
			expect(items.length).toBeGreaterThan(0);
			expect((items[0] as { _about?: string })._about).toContain(
				"/kos/sector-publico/sector/comercio",
			);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group E — NTI territory
// ═══════════════════════════════════════════════════════════════════

describe("datos.gob.es Group E — NTI territory", () => {
	itWhen(
		"listProvinces returns an LDA envelope with non-empty items",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "listProvinces");
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getProvinceById returns the envelope for province Madrid",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "getProvinceById", {
				id: "Madrid",
			});
			const items = unwrapItems(result);
			expect(items.length).toBeGreaterThan(0);
			expect((items[0] as { _about?: string })._about).toContain(
				"/Provincia/Madrid",
			);
		}),
		20_000,
	);

	itWhen(
		"listAutonomousRegions returns an LDA envelope with non-empty items",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "listAutonomousRegions");
			expect(unwrapItems(result).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getAutonomousRegionById returns the envelope for region Comunidad-Madrid",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "getAutonomousRegionById", {
				id: "Comunidad-Madrid",
			});
			const items = unwrapItems(result);
			expect(items.length).toBeGreaterThan(0);
			expect((items[0] as { _about?: string })._about).toContain(
				"/Autonomia/Comunidad-Madrid",
			);
		}),
		20_000,
	);

	itWhen(
		"getCountrySpain returns the envelope for the España country resource",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await fetchOp(guidesDir, "getCountrySpain");
			const items = unwrapItems(result);
			expect(items.length).toBeGreaterThan(0);
			expect((items[0] as { _about?: string })._about).toContain(
				"/Pais/España",
			);
		}),
		20_000,
	);
});
