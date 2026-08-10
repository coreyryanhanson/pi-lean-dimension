/**
 * resources.data.gov recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every defined operation against the live
 * endpoint, and asserts the response has the expected shape.
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1.
 * Co-located with the guide it tests.
 *
 * Note: every operation requires the `X-Api-Key` header, configured at guide
 * level in `guide.md` (auth.headers) and injected by `restGet`/`paginate`.
 * The shipped placeholder is `DEMO_KEY` — a free no-signup dev key with a
 * tight limit (10 requests per long window per the live `x-ratelimit`
 * headers). To run the live suite against a registered api.data.gov key
 * (1,000 req/hr), set `DATA_GOV_API_KEY` in the environment; `fetchOp`
 * overlays it onto the guide's `auth.headers` at runtime, reusing the
 * existing header seam — no framework change.
 *
 * CI note (GitHub Actions): `npm run test:ci` never sets HOST_INTEGRATION,
 * so all tests here are skipped in CI — no key, no network. The 7 live ops
 * additionally require DATA_GOV_API_KEY: a keyless `HOST_INTEGRATION=1`
 * run would fall back to DEMO_KEY and fail on its ~10-req rate wall, not on
 * the assertions, so those skip unless a key is present. Only the offline
 * parse smoke runs on HOST_INTEGRATION alone.
 */

import { describe, it, expect } from "vitest";
import { withTempDirs, itWhen } from "../_shared/test-harness.js";

const HOST_INTEGRATION = process.env["HOST_INTEGRATION"] === "1";
// Live ops need a real key — DEMO_KEY (the shipped placeholder) is
// rate-limited to ~10 requests per long window (see plan note 3).
const HAS_KEY = Boolean(process.env["DATA_GOV_API_KEY"]);
const itWhenLive = HOST_INTEGRATION && HAS_KEY ? it : it.skip; // network ops

const DOMAIN = "resources.data.gov";

// ── Per-recipe fetch helper (domain-specific; stays here, not in the harness) ──

async function fetchOp(
	guidesDir: string,
	name: string,
	params: Record<string, unknown> = {},
) {
	const { loadApiGuidesFromDir } = await import(
		"../../core/parse-api-guide.js"
	);
	const { restGet, paginate } = await import("../../core/helpers.js");
	const { setUserGuidesDir } = await import("../../core/guide-store.js");

	setUserGuidesDir(guidesDir);
	const loaded = loadApiGuidesFromDir(guidesDir);
	const guide = loaded.guides[DOMAIN]!;
	// Allow a registered api.data.gov key (1,000 req/hr) to override the
	// shipped DEMO_KEY placeholder (10 req/long-window) at live-test time.
	// Post-parse object mutation — restGet reads guide.auth.headers per call,
	// so no framework/recipe change is needed. Falls back to DEMO_KEY when
	// DATA_GOV_API_KEY is unset.
	const apiKey = process.env["DATA_GOV_API_KEY"];
	if (apiKey) {
		guide.auth.headers = { ...guide.auth.headers, "X-Api-Key": apiKey };
	}
	const op = guide.operations.find((o) => o.name === name)!;
	// Dispatch on the operation's declared executor so the paginated op
	// exercises the real `paginate` path, not a restGet stand-in.
	return op.via === "paginate"
		? paginate(guide.apiHost, op, params, guide)
		: restGet(guide.apiHost, op, params, guide);
}

// ═══════════════════════════════════════════════════════════════════
// Baseline: parse + recipe shape
// ═══════════════════════════════════════════════════════════════════

describe("resources.data.gov live integration smoke", () => {
	itWhen(
		"parses and loads the Data.gov recipe from a temp user dir",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain(DOMAIN);
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides[DOMAIN]!;
			expect(guide.apiHost).toBe("https://api.gsa.gov");
			expect(guide.auth.kind).toBe("none");
			// The DEMO_KEY header is injected for every request via auth.headers.
			expect(guide.auth.headers?.["X-Api-Key"]).toBe("DEMO_KEY");
			// searchDatasets + 3 lookup tables + location geometry + 3 harvest.
			expect(guide.operations.length).toBe(8);
		}),
	);

	itWhenLive(
		"searchDatasets (pre-existing op) returns a page via the declared cursor paginator",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			// Dispatch on op.via → paginate (cursor). The recipe's per_page
			// default (2) bounds the page; no gatherAll, so one request.
			const result = (await fetchOp(guidesDir, "searchDatasets")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Dataset metadata lookups
// ═══════════════════════════════════════════════════════════════════

describe("resources.data.gov Group A — dataset metadata", () => {
	itWhenLive(
		"getKeywords returns the most-used keywords with counts",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getKeywords")) as {
				data: { keywords?: { keyword?: string; count?: number }[] };
			};
			expect(Array.isArray(result.data.keywords)).toBe(true);
			expect(result.data.keywords!.length).toBeGreaterThan(0);
			expect(typeof result.data.keywords![0]!.keyword).toBe("string");
			expect(typeof result.data.keywords![0]!.count).toBe("number");
		}),
		20_000,
	);

	itWhenLive(
		"getOrganizations returns the publishing organizations with slugs",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getOrganizations")) as {
				data: { organizations?: { slug?: string }[] };
			};
			expect(Array.isArray(result.data.organizations)).toBe(true);
			expect(result.data.organizations!.length).toBeGreaterThan(0);
			expect(typeof result.data.organizations![0]!.slug).toBe("string");
		}),
		20_000,
	);

	itWhenLive(
		"searchLocations autocompletes Colorado into a non-empty locations list",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchLocations", {
				q: "Colorado",
			})) as {
				data: { locations?: { display_name?: string; id?: string }[] };
			};
			expect(Array.isArray(result.data.locations)).toBe(true);
			expect(result.data.locations!.length).toBeGreaterThan(0);
			expect(typeof result.data.locations![0]!.id).toBe("string");
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Location geometry (id derived from searchLocations in-test)
// ═══════════════════════════════════════════════════════════════════

describe("resources.data.gov Group B — location geometry", () => {
	itWhenLive(
		"getLocationGeometry returns GeoJSON geometry for a location id from searchLocations",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			// Derive a real location id (numeric, from the autocomplete index).
			const search = (await fetchOp(guidesDir, "searchLocations", {
				q: "Colorado",
			})) as { data: { locations?: { id?: string }[] } };
			const locationId = search.data.locations?.[0]?.id;
			expect(typeof locationId).toBe("string");

			const result = (await fetchOp(guidesDir, "getLocationGeometry", {
				location_id: locationId,
			})) as { data: { geometry?: string; id?: string } };
			// The geometry is a JSON-ENCODED GeoJSON string, not an inline object.
			expect(typeof result.data.geometry).toBe("string");
			expect((result.data.geometry ?? "").includes('"type"')).toBe(true);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Harvest record inspection (documented 404 error-shape per plan)
// ═══════════════════════════════════════════════════════════════════

describe("resources.data.gov Group C — harvest records", () => {
	// A deterministic fake UUID exercises the documented error contract. No
	// 200-producing record UUID is derivable from the API surface: even the
	// harvest_record UUIDs embedded in search results 404. A 401/403 (bad key)
	// or a network error would surface as a different error — asserting the
	// 404 shape is the honesty-preserving reachability + error-shape check the
	// plan's Testing section calls for.
	const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

	itWhenLive(
		"getHarvestRecord resolves and returns the documented 404 error shape",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await expect(
				fetchOp(guidesDir, "getHarvestRecord", { record_id: FAKE_UUID }),
			).rejects.toThrow(/Unexpected HTTP 404/);
		}),
		20_000,
	);

	itWhenLive(
		"getHarvestRecordRaw resolves and returns the documented 404 error shape",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await expect(
				fetchOp(guidesDir, "getHarvestRecordRaw", {
					record_id: FAKE_UUID,
				}),
			).rejects.toThrow(/Unexpected HTTP 404/);
		}),
		20_000,
	);

	itWhenLive(
		"getHarvestRecordTransformed resolves and returns the documented 404 error shape",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await expect(
				fetchOp(guidesDir, "getHarvestRecordTransformed", {
					record_id: FAKE_UUID,
				}),
			).rejects.toThrow(/Unexpected HTTP 404/);
		}),
		20_000,
	);
});
