/**
 * earthquake.usgs.gov — post-response transform tests (bare CI, no
 * network).
 *
 * The recipe's 20 summary feeds + `queryEvents` declare `transform: true` in
 * guide.md; the named `transform` export in the co-located `helper.ts`
 * reshape+projects each GeoJSON `Feature` (positional
 * `geometry.coordinates: [lon, lat, depth]` → flat `lon`/`lat`/`depth`, and
 * `properties` projected to a lean field set).
 *
 * This file covers:
 *  - the real helper's transform logic against both hookpoint shapes:
 *    whole `FeatureCollection` (restGet feeds) and single `Feature`
 *    (paginate per-item `queryEvents`) — pure function, direct import;
 *  - the full wiring: mocked transport → `loadTransform` finds the real
 *    helper → the restGet hookpoint transforms the feed's features;
 *  - the paginate per-item path: mocked transport → `paginate` applies the
 *    transform to each `features[]` item, and a throwing transform routes
 *    the item to `failedItems` (raw) rather than dropping it.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", () => ({
	fetchUrl: vi.fn(),
}));

import { restGet, paginate } from "../../core/helpers.js";
import { loadTransform } from "../../core/local-helpers.js";
import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";
import { transform } from "./helper.js";
import type { ApiGuide, Operation } from "../../core/api-guide-types.js";

// ── Fixtures — a GeoJSON FeatureCollection (summary feed shape) ───────

const FEATURE_A = {
	type: "Feature",
	id: "nc73649170",
	geometry: { type: "Point", coordinates: [-122.4, 38.8, 7.2] },
	properties: {
		mag: 1.2,
		place: "10 km NW of Napa, CA",
		time: 1783400000130,
		updated: 1783400100000,
		url: "https://earthquake.usgs.gov/earthquakes/eventpage/nc73649170",
		detail: "https://earthquake.usgs.gov/…/detail/nc73649170.geojson",
		felt: 3,
		cdi: 2.1,
		mmi: 1.9,
		alert: null,
		status: "automatic",
		tsunami: 0,
		sig: 44,
		net: "nc",
		code: "73649170",
		ids: ",nc73649170,",
		sources: ",nc,",
		types: ",origin,phase-data,",
		nst: 22,
		dmin: 0.013,
		rms: 0.17,
		gap: 56,
		magType: "md",
		type: "earthquake",
		title: "M 1.2 - 10 km NW of Napa, CA",
	},
} as const;

const FEATURE_B = {
	type: "Feature",
	id: "us7000abcd",
	geometry: { type: "Point", coordinates: [151.2, -33.9, 10.0] },
	properties: {
		mag: 4.8,
		place: "12 km SE of Sydney, Australia",
		time: 1783401000000,
		updated: 1783401100000,
		url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
		status: "reviewed",
		tsunami: 1,
		magType: "mb",
		type: "earthquake",
		title: "M 4.8 - 12 km SE of Sydney, Australia",
	},
} as const;

const FEATURE_COLLECTION = {
	type: "FeatureCollection",
	metadata: { count: 2, title: "USGS All Earthquakes, Past Hour" },
	features: [FEATURE_A, FEATURE_B],
} as unknown;

const FC_BODY = JSON.stringify(FEATURE_COLLECTION);

let tmpDir: string;

/**
 * Temp guide dir with the REAL guide.md + helper.ts copied verbatim from
 * this recipe — so the fixture can't drift from the shipped recipe.
 */
async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpDir, "guides-"));
	const domainDir = join(guidesDir, "earthquake.usgs.gov");
	mkdirSync(domainDir, { recursive: true });
	for (const file of ["guide.md", "helper.ts"] as const) {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf-8");
		writeFileSync(join(domainDir, file), source, "utf-8");
	}

	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	const guide = loaded.guides["earthquake.usgs.gov"]!;
	return { guide };
}

function findOp(guide: ApiGuide, name: string): Operation {
	const op = guide.operations.find((o) => o.name === name);
	if (!op) throw new Error(`op ${name} not found`);
	return op;
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-host-usgs-transform-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// transform logic (the helper as pure function)
// ═══════════════════════════════════════════════════════════════════

describe("earthquake.usgs.gov transform (real helper.ts)", () => {
	it("reshape+projects a whole FeatureCollection (restGet feed shape)", () => {
		const result = transform(FEATURE_COLLECTION, {
			operation: "getAllHour",
			domain: "earthquake.usgs.gov",
		}) as {
			type: string;
			metadata: unknown;
			features: Record<string, unknown>[];
		};

		// Envelope preserved.
		expect(result["type"]).toBe("FeatureCollection");
		expect(result["metadata"]).toEqual({
			count: 2,
			title: "USGS All Earthquakes, Past Hour",
		});

		expect(result.features).toEqual([
			{
				id: "nc73649170",
				mag: 1.2,
				place: "10 km NW of Napa, CA",
				time: 1783400000130,
				url: "https://earthquake.usgs.gov/earthquakes/eventpage/nc73649170",
				status: "automatic",
				tsunami: 0,
				magType: "md",
				type: "earthquake",
				title: "M 1.2 - 10 km NW of Napa, CA",
				lon: -122.4,
				lat: 38.8,
				depth: 7.2,
			},
			{
				id: "us7000abcd",
				mag: 4.8,
				place: "12 km SE of Sydney, Australia",
				time: 1783401000000,
				url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
				status: "reviewed",
				tsunami: 1,
				magType: "mb",
				type: "earthquake",
				title: "M 4.8 - 12 km SE of Sydney, Australia",
				lon: 151.2,
				lat: -33.9,
				depth: 10.0,
			},
		]);

		// Projection dropped the noise fields.
		const first = result.features[0]!;
		expect(first["updated"]).toBeUndefined();
		expect(first["felt"]).toBeUndefined();
		expect(first["detail"]).toBeUndefined();
		expect(first["geometry"]).toBeUndefined();
	});

	it("reshape+projects a single Feature (paginate per-item shape)", () => {
		const result = transform(FEATURE_A, {
			operation: "queryEvents",
			domain: "earthquake.usgs.gov",
		}) as Record<string, unknown>;

		expect(result).toEqual({
			id: "nc73649170",
			mag: 1.2,
			place: "10 km NW of Napa, CA",
			time: 1783400000130,
			url: "https://earthquake.usgs.gov/earthquakes/eventpage/nc73649170",
			status: "automatic",
			tsunami: 0,
			magType: "md",
			type: "earthquake",
			title: "M 1.2 - 10 km NW of Napa, CA",
			lon: -122.4,
			lat: 38.8,
			depth: 7.2,
		});
	});

	it("passes through non-object / feature-less bodies untouched (raw fallback)", () => {
		// Non-object.
		expect(
			transform("plain text", {
				operation: "getAllHour",
				domain: "earthquake.usgs.gov",
			}),
		).toBe("plain text");

		// Object without a features array and without feature shape → passes
		// through untouched (shape-guard, mirroring the CDX / opensearch
		// helpers). Not a real USGS body, but the transform stays non-lossy
		// rather than degrading or throwing.
		const odd = { foo: 1 };
		expect(
			transform(odd, {
				operation: "getAllHour",
				domain: "earthquake.usgs.gov",
			}),
		).toBe(odd);
	});

	it("empty features array is preserved (empty feed is a valid result)", () => {
		const empty = transform(
			{ type: "FeatureCollection", metadata: { count: 0 }, features: [] },
			{ operation: "getSignificantHour", domain: "earthquake.usgs.gov" },
		) as { features: unknown[] };
		expect(empty.features).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════
// wiring — mocked transport → loadTransform → restGet hookpoint
// ═══════════════════════════════════════════════════════════════════

describe("summary feed transform through the real pipeline (mocked transport)", () => {
	it("returns the reshape+projected features from the FeatureCollection", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: FC_BODY,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = findOp(guide, "getAllHour");
		const transformFn = await loadTransform("earthquake.usgs.gov");
		expect(typeof transformFn).toBe("function");

		const result = await restGet(
			"https://earthquake.usgs.gov",
			op,
			{},
			guide,
			undefined,
			transformFn ?? undefined,
			"earthquake.usgs.gov",
		);

		const data = result.data as { features: Record<string, unknown>[] };
		expect(Array.isArray(data.features)).toBe(true);
		expect(data.features.length).toBe(2);
		expect(data.features[0]!.lon).toBe(-122.4);
		expect(data.features[0]!.lat).toBe(38.8);
		expect(data.features[0]!.depth).toBe(7.2);
		expect(data.features[0]!["geometry"]).toBeUndefined();
		expect(result.transformWarning).toBeUndefined();
	});

	it("a throwing transform keeps the raw FeatureCollection + warns (no disable)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: FC_BODY,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = findOp(guide, "getAllHour");
		const throwing = (): unknown => {
			throw new Error("boom");
		};

		const result = await restGet(
			"https://earthquake.usgs.gov",
			op,
			{},
			guide,
			undefined,
			throwing,
			"earthquake.usgs.gov",
		);

		// Raw FeatureCollection preserved with the warning; op not disabled.
		expect(result.data).toEqual(FEATURE_COLLECTION);
		expect(result.transformWarning).toBe("boom");
	});
});

// ═══════════════════════════════════════════════════════════════════
// wiring — paginate per-item transform (queryEvents)
// ═══════════��═══════════════════��═══════════════════════════════════

describe("queryEvents transform through the real pipeline (mocked transport)", () => {
	it("applies the transform to each paginated feature item", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: FC_BODY,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = findOp(guide, "queryEvents");
		const transformFn = await loadTransform("earthquake.usgs.gov");

		const result = await paginate(
			"https://earthquake.usgs.gov",
			op,
			{ minmagnitude: 4 },
			guide,
			{},
			transformFn ?? undefined,
			"earthquake.usgs.gov",
		);

		expect(result.items.length).toBe(2);
		const first = result.items[0] as Record<string, unknown>;
		expect(first["lon"]).toBe(-122.4);
		expect(first["lat"]).toBe(38.8);
		expect(first["depth"]).toBe(7.2);
		expect(first["geometry"]).toBeUndefined();
		expect(first["updated"]).toBeUndefined();
		expect(result.failedItems).toBeUndefined();
	});

	it("a throwing per-item transform routes the item to failedItems (raw, not dropped)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: FC_BODY,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = findOp(guide, "queryEvents");
		const throwing = (): unknown => {
			throw new Error("boom");
		};

		const result = await paginate(
			"https://earthquake.usgs.gov",
			op,
			{ minmagnitude: 4 },
			guide,
			{},
			throwing,
			"earthquake.usgs.gov",
		);

		// Every item failed → all in failedItems (raw), none dropped.
		expect(result.items.length).toBe(0);
		expect(result.failedItems).toEqual([FEATURE_A, FEATURE_B]);
		expect(result.totalFetched).toBe(2);
	});
});
