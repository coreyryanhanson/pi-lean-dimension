/**
 * GBIF recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every operation against the live endpoint, and
 * asserts the response has the expected shape (200 + non-empty body /
 * expected `itemsPath` for `paginate` ops / bare property for `restGet` ops /
 * bare number for `countOccurrences`).
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

const DOMAIN = "api.gbif.org";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; delay+retry wrapper stays here) ──

// GBIF has no strict anonymous rate limit; a small delay keeps the 37-op live
// sweep polite without slowing it meaningfully.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const _fetch = createFetchOp(DOMAIN);

async function fetchOp(
	guidesDir: string,
	name: string,
	params: Record<string, unknown> = {},
) {
	await delay(150);
	const { HelperError } = await import("../../core/helpers.js");
	// GBIF sits behind a Varnish/CDN that intermittently answers transient
	// HTTP 503 ("Backend fetch failed"). Retry with backoff so a CDN blip
	// doesn't mask a correct recipe in the live gate.
	for (let attempt = 0; ; attempt++) {
		try {
			return _fetch(guidesDir, name, params);
		} catch (e) {
			const transient =
				e instanceof HelperError && e.message.includes("Unexpected HTTP 503");
			if (attempt < 3 && transient) {
				await delay(1500 * (attempt + 1));
				continue;
			}
			throw e;
		}
	}
}

// ── Stable identifiers (backbone usage keys + live records) ─────────
const WOLF = 5219173; // Canis lupus, GBIF backbone usage key
const VERBATIM_SRC = 206095529; // a source-dataset record with a verbatim row
const BACKBONE_DATASET = "d7dddbf4-2cf0-4f39-9b2a-bb099caae36c";
const OCCURRENCE = 5936628685; // a live wolf occurrence
const LIT_UUID = "bc860204-52b8-35a8-9f4f-7c9d55043864";

// ═══════════════════════════════════════════════════════════════════
// Baseline
// ═══════════════════════════════════════════════════════════════════

describe("GBIF live integration smoke", () => {
	itWhen(
		"parses and loads the recipe with all 36 ops",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("api.gbif.org");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["api.gbif.org"]!;
			expect(guide.apiHost).toBe("https://api.gbif.org");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(36);
		}),
	);

	itWhen(
		"listSpecies returns results via the declared paginate executor",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listSpecies")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Species search & match
// ═══════════════════════════════════════════════════════════════════

describe("GBIF Group A — species search & match", () => {
	itWhen(
		"searchSpecies returns results via paginate",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchSpecies", {
				q: "Canis lupus",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"suggestSpecies returns a non-empty suggestions array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "suggestSpecies", {
				q: "Canis",
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"matchSpecies returns usage + match diagnostics",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "matchSpecies", {
				scientificName: "Canis lupus",
			})) as {
				data: {
					usage?: { key?: unknown };
					diagnostics?: { matchType?: unknown };
				};
			};
			expect(result.data).toBeTruthy();
			expect(result.data.usage?.key).toBeTruthy();
			expect(result.data.diagnostics?.matchType).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"matchSpeciesV1 returns a flat match with matchType",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "matchSpeciesV1", {
				name: "Canis lupus",
			})) as { data: { matchType?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.matchType).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"lookupSpeciesId returns an array (may be empty for unindexed IDs)",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "lookupSpeciesId", {
				identifier: String(WOLF),
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"lookupSpeciesJoin returns non-empty identifier entries",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "lookupSpeciesJoin", {
				identifier: String(WOLF),
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Species detail sub-resources
// ═══════════════════════════════════════════════════════════════════

describe("GBIF Group B — species detail sub-resources", () => {
	itWhen(
		"getSpecies returns the name-usage record",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpecies", {
				usageKey: String(WOLF),
			})) as { data: { key?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.key).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getSpeciesVernacularNames returns a results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesVernacularNames", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesVerbatim returns the source record for a source usageKey",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesVerbatim", {
				usageKey: String(VERBATIM_SRC),
			})) as { data: { key?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.key).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getSpeciesTypeSpecimens returns a results array (may be empty)",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesTypeSpecimens", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.results)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesToc returns a toc object",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesToc", {
				usageKey: String(WOLF),
			})) as { data: { toc?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.toc).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getSpeciesSynonyms returns a non-empty results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesSynonyms", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesProfiles returns a non-empty results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesProfiles", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesRelated returns a non-empty results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesRelated", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesReferences returns a non-empty results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesReferences", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesParents returns a non-empty array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesParents", {
				usageKey: String(WOLF),
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesNameParsed returns the parsed name object",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesNameParsed", {
				usageKey: String(WOLF),
			})) as { data: object };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		30_000,
	);

	itWhen(
		"getSpeciesMetrics returns the metrics object",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesMetrics", {
				usageKey: String(WOLF),
			})) as { data: object };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		30_000,
	);

	itWhen(
		"getSpeciesMedia returns a non-empty results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesMedia", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesIucnStatus returns a category",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesIucnStatus", {
				usageKey: String(WOLF),
			})) as { data: { category?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.category).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getSpeciesIdentifiers returns a results array (may be empty)",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesIdentifiers", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.results)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesDistributions returns a non-empty results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesDistributions", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesDescriptions returns a non-empty results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesDescriptions", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesCombinations returns an array (may be empty)",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesCombinations", {
				usageKey: String(WOLF),
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesChildren returns a non-empty results array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesChildren", {
				usageKey: String(WOLF),
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSpeciesAllChildren returns a non-empty array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesAllChildren", {
				usageKey: String(WOLF),
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Root usages & name parser
// ═══════════════════════════════════════════════════════════════════

describe("GBIF Group C — root usages & parser", () => {
	itWhen(
		"getSpeciesRootUsages returns root name usages",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSpeciesRootUsages", {
				datasetKey: BACKBONE_DATASET,
			})) as { data: { results?: unknown[] } };
			expect(Array.isArray(result.data.results)).toBe(true);
			expect((result.data.results ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"parseSpeciesName parses a scientific name into an array",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "parseSpeciesName", {
				name: "Canis lupus",
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — Occurrence reads
// ═══════════════════════════════════════════════════════════════════

describe("GBIF Group D — occurrence reads", () => {
	itWhen(
		"getOccurrence returns a single record",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getOccurrence", {
				key: String(OCCURRENCE),
			})) as { data: { key?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.key).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"searchOccurrences returns results via paginate",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchOccurrences", {
				taxonKey: String(WOLF),
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getOccurrenceVerbatim returns the verbatim record",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getOccurrenceVerbatim", {
				key: String(OCCURRENCE),
			})) as { data: object };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		30_000,
	);

	itWhen(
		"getOccurrenceFragment returns the raw fragment record",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getOccurrenceFragment", {
				key: String(OCCURRENCE),
			})) as { data: { basisOfRecord?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.basisOfRecord).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"countOccurrences returns a bare positive number",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "countOccurrences", {
				taxonKey: String(WOLF),
			})) as { data: unknown };
			expect(typeof result.data).toBe("number");
			expect(result.data as number).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group E — Literature
// ═══════════════════════════════════════════════════════════════════

describe("GBIF Group E — literature", () => {
	itWhen(
		"searchLiterature returns results via paginate",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchLiterature", {
				q: "biodiversity",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getLiterature returns a single item",
		withTempDirs("api.gbif.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getLiterature", {
				uuid: LIT_UUID,
			})) as { data: object };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		30_000,
	);
});
