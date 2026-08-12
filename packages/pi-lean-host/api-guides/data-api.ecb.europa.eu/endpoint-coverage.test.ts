/**
 * ECB Data Portal recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Tests the live ECB SDMX 2.1 REST service (`https://data-api.ecb.europa.eu/service`):
 * parses the recipe and executes every defined operation against the live endpoint.
 * The `getData` SDMX-ML assertion is the design-doc A2 hard proof — a prefix-everywhere
 * XML response (`message:GenericData`, `generic:Series`, `generic:Obs`, `common:…`)
 * whose parsed keys must resolve prefix-free (`GenericData.DataSet.Series`) thanks to
 * the `removeNSPrefix` fix, without literal colon-key paths.
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

const DOMAIN = "data-api.ecb.europa.eu";

// Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper —
// ECB needs no pacing/retry/auth overlay, and each test issues 1 request).
const fetchOp = createFetchOp(DOMAIN);

// A stable, bounded EXR (exchange-rate) query: two currencies against EUR,
// one month window — small, fast, and returns >1 series so `Series` is an array.
const EXR_MULTI = {
	flowRef: "EXR",
	key: "M.USD+GBP.EUR.SP00.A",
	startPeriod: "2020-01",
	endPeriod: "2020-02",
	detail: "dataonly",
};

interface Series {
	SeriesKey?: { Value?: { "@_id"?: string; "@_value"?: string }[] };
	Obs?: unknown;
}

describe("ECB Data Portal live integration smoke", () => {
	itWhen(
		"parses and loads the ECB recipe from a temp user dir",
		withTempDirs("data-api.ecb.europa.eu")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("data-api.ecb.europa.eu");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["data-api.ecb.europa.eu"]!;
			expect(guide.apiHost).toBe("https://data-api.ecb.europa.eu/service");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(5);
		}),
	);

	itWhen(
		"getData resolves the prefix-free itemsPath on live prefix-everywhere SDMX-ML (A2 hard proof)",
		withTempDirs("data-api.ecb.europa.eu")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getData", EXR_MULTI)) as {
				data: {
					GenericData?: {
						DataSet?: { Series?: Series[] };
					};
				};
			};
			// A2: `GenericData.DataSet.Series` must resolve WITHOUT literal
			// colon-keys (`message:GenericData` / `generic:Series`) — the
			// `removeNSPrefix` fix strips the prefix on every element.
			const series = result.data.GenericData?.DataSet?.Series;
			expect(Array.isArray(series)).toBe(true);
			expect(series!.length).toBeGreaterThan(0);
			// Each series carries a SeriesKey (dimension codes) + Obs list.
			for (const s of series!) {
				expect(s.SeriesKey).toBeTruthy();
				expect(Array.isArray(s.SeriesKey!.Value)).toBe(true);
				expect(s.Obs).toBeTruthy();
			}
		}),
		20_000,
	);

	itWhen(
		"getData returns a single series as an object (restGet, no A1 boxing)",
		withTempDirs("data-api.ecb.europa.eu")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getData", {
				flowRef: "EXR",
				key: "M.USD.EUR.SP00.A",
				startPeriod: "2020-01",
				endPeriod: "2020-02",
				detail: "dataonly",
			})) as {
				data: {
					GenericData?: {
						DataSet?: { Series?: Series[] | Series };
					};
				};
			};
			const series = result.data.GenericData?.DataSet?.Series;
			// restGet single-shot: a one-series response is a plain object
			// (A1's array boxing is a paginate-only fix, not exercised here).
			expect(series).toBeTruthy();
			expect(Array.isArray(series)).toBe(false);
		}),
		20_000,
	);

	itWhen(
		"getDataJson returns SDMX-JSON with dataSets[0].series keyed by index",
		withTempDirs("data-api.ecb.europa.eu")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getDataJson", {
				flowRef: "EXR",
				key: "M.USD.EUR.SP00.A",
				startPeriod: "2020-01",
				endPeriod: "2020-02",
			})) as {
				data: {
					dataSets?: { series?: Record<string, { observations?: unknown }> }[];
				};
			};
			expect(result.data.dataSets).toBeTruthy();
			const series = result.data.dataSets![0]?.series;
			expect(series).toBeTruthy();
			// Compact SDMX-JSON keys series by integer index ("0:0:0:0:0").
			const firstKey = Object.keys(series!)[0]!;
			expect(firstKey).toMatch(/^\d+:\d+:\d+:\d+:\d+$/);
			expect(series![firstKey]!.observations).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getDataCsv returns raw CSV text (format: text passthrough)",
		withTempDirs("data-api.ecb.europa.eu")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getDataCsv", {
				flowRef: "EXR",
				key: "M.USD.EUR.SP00.A",
				startPeriod: "2020-01",
				endPeriod: "2020-02",
			})) as { data: string };
			// Raw text passthrough: the body is a plain CSV string.
			expect(typeof result.data).toBe("string");
			expect(result.data).toContain("KEY,FREQ,CURRENCY");
			expect(result.data).toContain("EXR.M.USD.EUR.SP00.A");
			expect(result.data).toContain("2020-01");
		}),
		20_000,
	);

	itWhen(
		"listStructures lists dataflows prefix-free (discovery entry)",
		withTempDirs("data-api.ecb.europa.eu")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listStructures", {
				resource: "dataflow",
			})) as {
				data: {
					Structure?: {
						Structures?: { Dataflows?: { Dataflow?: { "@_id"?: string }[] } };
					};
				};
			};
			// A2: `Structure.Structures.Dataflows.Dataflow` resolves prefix-free
			// on the structure shape too (no `message:Structure` / `message:Dataflows`).
			const flows = result.data.Structure?.Structures?.Dataflows?.Dataflow;
			expect(Array.isArray(flows)).toBe(true);
			expect(flows!.length).toBeGreaterThan(0);
			// The EXR (exchange-rate) dataflow is always present in the list.
			const ids = flows!.map((f) => f["@_id"]);
			expect(ids).toContain("EXR");
		}),
		20_000,
	);

	itWhen(
		"getStructure resolves a specific artefact prefix-free (A2, structure shape)",
		withTempDirs("data-api.ecb.europa.eu")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getStructure", {
				resource: "datastructure",
				agencyID: "ECB",
				resourceID: "ECB_EXR1",
				version: "1.0",
			})) as {
				data: {
					Structure?: {
						Structures?: { DataStructures?: { DataStructure?: unknown } };
					};
				};
			};
			const ds =
				result.data.Structure?.Structures?.DataStructures?.DataStructure;
			expect(ds).toBeTruthy();
		}),
		20_000,
	);
});
