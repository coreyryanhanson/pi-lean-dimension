/**
 * LoC (Library of Congress) recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Tests the live LoC JSON API: parses the recipe, executes every defined
 * operation against the live endpoint, and asserts the response has the
 * expected shape.
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

const DOMAIN = "loc.gov";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper) ──

const fetchOp = createFetchOp(DOMAIN);

// Known-good, slash-free IDs probed live (2026-08) so the restGet assertions
// are stable. Slash-containing ids (e.g. `powmia/pwmaster_1`) are rejected by
// the pipeline because the path token is URL-encoded — see plan notes.
const TEST_ITEM_ID = "2001704258";
const TEST_RESOURCE_ID = "pga.03206";
const TEST_COLLECTION = "vietnam-era-pow-mia-database";

// ═══════════════════════════════════════════════════════════════════
// Parsing baseline + pre-existing ops
// ═══════════════════════════════════════════════════════════════════

describe("LoC live integration smoke", () => {
	itWhen(
		"parses and loads the LoC recipe from a temp user dir",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("loc.gov");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["loc.gov"]!;
			expect(guide.apiHost).toBe("https://www.loc.gov");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(7);
		}),
	);

	itWhen(
		"listSearch fetches first page via the declared paginate executor",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listSearch", {
				q: "earthquake",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getItem fetches a single item record",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getItem", {
				id: TEST_ITEM_ID,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(typeof result.data["item"]).toBe("object");
			expect(result.data["item"]).not.toBeNull();
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Collections
// ═══════════════════════════════════════════════════════════════════

describe("LoC Group A — collections", () => {
	itWhen(
		"listCollections returns a non-empty results array with nextLink pagination",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listCollections")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getCollection returns collection metadata (title present)",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getCollection", {
				name: TEST_COLLECTION,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(typeof result.data["title"]).toBe("string");
			expect(String(result.data["title"]).length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Items by format
// ═══════════════════════════════════════════════════════════════════

describe("LoC Group B — items by format", () => {
	itWhen(
		"listItemsByFormat returns a non-empty results array for format=maps",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listItemsByFormat", {
				format: "maps",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Search index
// ═══════════════════════════════════════════════════════════════════

describe("LoC Group C — search index", () => {
	itWhen(
		"searchFieldIndex returns a non-empty facets array for field=location",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchFieldIndex", {
				field: "location",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — Resource endpoint
// ═══════════════════════════════════════════════════════════════════

describe("LoC Group D — resource endpoint", () => {
	itWhen(
		"getResource returns the resource object for a real resource id",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getResource", {
				resource_id: TEST_RESOURCE_ID,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(typeof result.data["resource"]).toBe("object");
			expect(result.data["resource"]).not.toBeNull();
		}),
		20_000,
	);
});
