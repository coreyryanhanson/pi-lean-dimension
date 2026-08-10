/**
 * USGS Earthquake API recipe validity tests — endpoint coverage + live fetch sanity.
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

const DOMAIN = "earthquake.usgs.gov";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper) ──

const fetchOp = createFetchOp(DOMAIN);

// ═══════════════════════════════════════════════════════════════════
// Baseline: parse + recipe shape
// ═══════════════════════════════════════════════════════════════════

describe("USGS live integration smoke", () => {
	itWhen(
		"parses and loads the USGS recipe from a temp user dir",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain(DOMAIN);
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides[DOMAIN]!;
			expect(guide.apiHost).toBe("https://earthquake.usgs.gov");
			expect(guide.auth.kind).toBe("none");
			// 20 summary feeds + detail + query + count + 5 metadata ops.
			expect(guide.operations.length).toBe(28);
		}),
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — GeoJSON summary feeds (20, incl. the pre-existing getAllHour)
// ═══════════════════════════════════════════════════════════════════

describe("USGS Group A — summary feeds", () => {
	// All 20 feeds are the same GeoJSON FeatureCollection contract.
	const FEEDS = [
		["getAllHour", "all_hour"],
		["getSignificantHour", "significant_hour"],
		["get4_5Hour", "4.5_hour"],
		["get2_5Hour", "2.5_hour"],
		["get1_0Hour", "1.0_hour"],
		["getAllDay", "all_day"],
		["getSignificantDay", "significant_day"],
		["get4_5Day", "4.5_day"],
		["get2_5Day", "2.5_day"],
		["get1_0Day", "1.0_day"],
		["getAllWeek", "all_week"],
		["getSignificantWeek", "significant_week"],
		["get4_5Week", "4.5_week"],
		["get2_5Week", "2.5_week"],
		["get1_0Week", "1.0_week"],
		["getAllMonth", "all_month"],
		["getSignificantMonth", "significant_month"],
		["get4_5Month", "4.5_month"],
		["get2_5Month", "2.5_month"],
		["get1_0Month", "1.0_month"],
	] as const;

	for (const [name, suffix] of FEEDS) {
		itWhen(
			`${name} returns a GeoJSON FeatureCollection for ${suffix}.geojson`,
			withTempDirs(DOMAIN)(async ({ guidesDir }) => {
				const result = (await fetchOp(guidesDir, name)) as {
					data: {
						type?: unknown;
						features?: unknown[];
					};
				};
				expect(result.data.type).toBe("FeatureCollection");
				// Threshold/significant feeds can legitimately be empty (a quiet
				// hour has no M4.5+ events) — the shape, not the fill, is the contract.
				expect(Array.isArray(result.data.features)).toBe(true);
			}),
			20_000,
		);
	}
});

// ═══════════════════════════════════════════════════════════════════
// Group B — GeoJSON detail
// ═══════════════════════════════════════════════════════════════════

describe("USGS Group B — event detail", () => {
	itWhen(
		"getDetail returns a single Feature for an event id taken from the all_day feed",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			// Pick a real event id from the feed (all_day is reliably populated).
			const feed = (await fetchOp(guidesDir, "getAllDay")) as {
				data: { features?: { id?: string }[] };
			};
			const eventId = feed.data.features?.[0]?.id;
			expect(typeof eventId).toBe("string");

			const result = (await fetchOp(guidesDir, "getDetail", {
				eventId,
			})) as {
				data: { type?: unknown; properties?: Record<string, unknown> };
			};
			expect(result.data.type).toBe("Feature");
			// `products` is not present for every event — the properties block is.
			expect(result.data.properties).toBeTruthy();
			expect(typeof result.data.properties!["time"]).toBe("number");
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — FDSN query (paginated)
// ═══════════════════════════════════════════════════════════════════

describe("USGS Group C — FDSN event query", () => {
	itWhen(
		"queryEvents fetches the first page via the declared paginate executor",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			// No params: offset seeds from the recipe default (1 — USGS rejects
			// offset=0), limit from pagination config (50), single page.
			const result = (await fetchOp(guidesDir, "queryEvents")) as {
				items: {
					id?: string;
					properties?: unknown;
					geometry?: unknown;
					lon?: unknown;
					mag?: unknown;
				}[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items.length).toBeLessThanOrEqual(50);
			expect(typeof result.items[0]!.id).toBe("string");
			// Post-response transform (queryEvents gates `transform: true`): the
			// positional geometry + fat properties bag are hoisted into flat
			// scalars — `properties`/`geometry` are gone, `lon`/`mag` present.
			expect(result.items[0]!.mag).toBeTypeOf("number");
			expect(typeof result.items[0]!.lon).toBe("number");
			expect(result.items[0]!.properties).toBeUndefined();
			expect(result.items[0]!.geometry).toBeUndefined();
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — FDSN count
// ═══════════════════════════════════════════════════════════════════

describe("USGS Group D — FDSN event count", () => {
	itWhen(
		"countEvents returns a count (bare number) for a bounded window",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "countEvents", {
				starttime: "2026-07-01",
				endtime: "2026-07-02",
			})) as { data: unknown };
			// No `format` param → the endpoint returns a bare integer (the
			// {count, maxAllowed} object form only appears with format=geojson).
			expect(typeof result.data).toBe("number");
			expect((result.data as number) >= 0).toBe(true);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group E — FDSN service metadata
// ═══════════════════════════════════════════════════════════════════

describe("USGS Group E — FDSN service metadata", () => {
	itWhen(
		"listCatalogs returns the catalog list (XML, regardless of Accept)",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listCatalogs")) as {
				data: { Catalogs?: { Catalog?: unknown } };
			};
			expect(result.data.Catalogs).toBeTruthy();
			expect(result.data.Catalogs!["Catalog"]).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"listContributors returns the contributor list (XML, regardless of Accept)",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listContributors")) as {
				data: { Contributors?: { Contributor?: unknown } };
			};
			expect(result.data.Contributors).toBeTruthy();
			expect(result.data.Contributors!["Contributor"]).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getApplicationJson returns the FDSN parameter description",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getApplicationJson")) as {
				data: { catalogs?: unknown[] };
			};
			expect(Array.isArray(result.data.catalogs)).toBe(true);
			expect(result.data.catalogs!.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getApplicationWadl returns the WADL interface description (XML)",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getApplicationWadl")) as {
				data: Record<string, unknown>;
			};
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		20_000,
	);

	itWhen(
		"getVersion returns the service version string (plain text)",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getVersion")) as {
				data: unknown;
			};
			expect(typeof result.data).toBe("string");
			expect(String(result.data).length).toBeGreaterThan(0);
		}),
		20_000,
	);
});
