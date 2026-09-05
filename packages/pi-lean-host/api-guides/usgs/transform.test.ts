/**
 * usgs synthetic axis guide — transform-builtin, mocked
 * transport. Covers the `transform: true × via: restGet` and
 * `transform: true × via: paginate` combos + `failedItems` routing, plus
 * `xml`/`exec-restGet`/`exec-paginate`/`transport`. No live endpoint.
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
import type { ApiGuide, Operation } from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { restGet, paginate } from "../../core/helpers.js";
import { loadTransform } from "../../core/local-helpers.js";
import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";
import { transform } from "./helper.ts";

// ── Fixture — a GeoJSON FeatureCollection ───────────────────────────

const FEATURE_A = {
	type: "Feature",
	id: "nc1",
	geometry: { type: "Point", coordinates: [-122.4, 38.8, 7.2] },
	properties: {
		mag: 1.2,
		place: "10 km NW of Napa, CA",
		time: 1783400000130,
		url: "https://example.com/event/nc1",
		status: "automatic",
		tsunami: 0,
		magType: "md",
		type: "earthquake",
		title: "M 1.2 - 10 km NW of Napa, CA",
	},
} as const;

const FEATURE_B = {
	type: "Feature",
	id: "nc2",
	geometry: { type: "Point", coordinates: [151.2, -33.9, 10.0] },
	properties: {
		mag: 4.8,
		place: "12 km SE of Sydney, Australia",
		time: 1783401000000,
		url: "https://example.com/event/nc2",
		status: "reviewed",
		tsunami: 1,
		magType: "mb",
		type: "earthquake",
		title: "M 4.8 - 12 km SE of Sydney, Australia",
	},
} as const;

const FC = {
	type: "FeatureCollection",
	metadata: { count: 2, title: "Past Hour" },
	features: [FEATURE_A, FEATURE_B],
} as unknown;
const FC_BODY = JSON.stringify(FC);

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "usgs");
	mkdirSync(domainDir, { recursive: true });
	for (const file of ["guide.md", "helper.ts"] as const) {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf-8");
		writeFileSync(join(domainDir, file), source, "utf-8");
	}
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["usgs"]! };
}

function findOp(guide: ApiGuide, name: string): Operation {
	const op = guide.operations.find((o) => o.name === name);
	if (!op) throw new Error(`op ${name} not found`);
	return op;
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-usgs-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("usgs transform (real helper.ts)", () => {
	it("reshape+projects a whole FeatureCollection (restGet feed shape)", () => {
		const result = transform(FC, {
			operation: "getAllHour",
			domain: "usgs",
		}) as { features: Record<string, unknown>[] };
		const first = result.features[0]!;
		expect(first["lon"]).toBe(-122.4);
		expect(first["lat"]).toBe(38.8);
		expect(first["depth"]).toBe(7.2);
		expect(first["geometry"]).toBeUndefined();
		expect(first["mag"]).toBe(1.2);
	});

	it("reshape+projects a single Feature (paginate per-item shape)", () => {
		const result = transform(FEATURE_A, {
			operation: "queryEvents",
			domain: "usgs",
		}) as Record<string, unknown>;
		expect(result["lon"]).toBe(-122.4);
		expect(result["geometry"]).toBeUndefined();
	});

	it("passes through a non-feature body untouched (non-lossy)", () => {
		expect(
			transform("plain text", {
				operation: "getAllHour",
				domain: "usgs",
			}),
		).toBe("plain text");
	});
});

describe("restGet transform through the real pipeline (mocked transport)", () => {
	it("applies the transform to the feed's features + no warning", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: FC_BODY,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = findOp(guide, "getAllHour");
		const transformFn = await loadTransform("usgs");
		expect(typeof transformFn).toBe("function");

		const result = await restGet(guide.apiHost, op, {}, guide, {
			transformFn: transformFn ?? undefined,
			dirName: "usgs",
		});
		const data = result.data as { features: Record<string, unknown>[] };
		expect(data.features[0]!.lon).toBe(-122.4);
		expect(data.features[0]!["geometry"]).toBeUndefined();
		expect(result.transformWarning).toBeUndefined();
	});

	it("a throwing transform keeps the raw body + warns (no disable)", async () => {
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
		const result = await restGet(guide.apiHost, op, {}, guide, {
			transformFn: throwing,
			dirName: "usgs",
		});
		expect(result.data).toEqual(FC);
		expect(result.transformWarning).toBe("boom");
	});
});

describe("queryEvents per-item transform through the real pipeline (mocked transport)", () => {
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
		const transformFn = await loadTransform("usgs");

		const result = await paginate(guide.apiHost, op, { minmagnitude: 4 }, guide, {
			transformFn: transformFn ?? undefined,
			dirName: "usgs",
		});
		expect(result.items.length).toBe(2);
		const first = result.items[0] as Record<string, unknown>;
		expect(first["lon"]).toBe(-122.4);
		expect(first["lat"]).toBe(38.8);
		expect(first["depth"]).toBe(7.2);
		expect(first["geometry"]).toBeUndefined();
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
		const result = await paginate(guide.apiHost, op, { minmagnitude: 4 }, guide, {
			transformFn: throwing,
			dirName: "usgs",
		});
		expect(result.items.length).toBe(0);
		expect(result.failedItems).toEqual([FEATURE_A, FEATURE_B]);
		expect(result.totalFetched).toBe(2);
	});
});
