/**
 * Open Library recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every operation against the live endpoint, and
 * asserts the response has the expected shape (200 + non-empty body /
 * expected `itemsPath` for `paginate` ops / bare non-empty array for the
 * recentchanges family).
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

const DOMAIN = "openlibrary.org";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; delay wrapper stays here) ──

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const _fetch = createFetchOp(DOMAIN);

async function fetchOp(
	guidesDir: string,
	name: string,
	params: Record<string, unknown> = {},
) {
	// Open Library limits unidentified traffic to 1 req/s. No identifying UA is
	// set by the pipeline, so pace the 20-op live sweep to avoid 403s.
	await delay(400);
	return _fetch(guidesDir, name, params);
}

// ═══════════════════════════════════════════════════════════════════
// Baseline
// ═══════════════════════════════════════════════════════════════════

describe("Open Library live integration smoke", () => {
	itWhen(
		"parses and loads the recipe with all 20 ops",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("openlibrary.org");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["openlibrary.org"]!;
			expect(guide.apiHost).toBe("https://openlibrary.org");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(20);
			// queryThings opts into passthrough (open param surface).
			expect(
				guide.operations.find((o) => o.name === "queryThings")?.passthrough,
			).toBe(true);
		}),
	);

	itWhen(
		"searchBooks returns docs via the declared paginate executor",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchBooks", {
				q: "lord of the rings",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Author lookups
// ═══════════════════════════════════════════════════════════════════

describe("Open Library Group A — author lookups", () => {
	itWhen(
		"searchAuthors returns docs via paginate",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchAuthors", {
				q: "rowling",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getAuthor returns an author record",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getAuthor", {
				olid: "OL23919A",
			})) as { data: { key?: unknown } };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
			expect(result.data.key).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getWorksByAuthor returns entries via paginate",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getWorksByAuthor", {
				olid: "OL23919A",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Work & Edition lookups
// ═══════════════════════════════════════════════════════════════════

describe("Open Library Group B — work & edition lookups", () => {
	itWhen(
		"getWork returns a work record",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getWork", {
				olid: "OL15626917W",
			})) as { data: { key?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.key).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getEditionsByWork returns entries via paginate",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getEditionsByWork", {
				olid: "OL15626917W",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getEdition returns an edition record",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getEdition", {
				olid: "OL7170815M",
			})) as { data: { key?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.key).toBeTruthy();
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Subjects
// ═══════════════════════════════════════════════════════════════════

describe("Open Library Group C — subjects", () => {
	itWhen(
		"getSubject returns works via paginate",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSubject", {
				subject: "love",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — Recent changes (bare top-level array)
// ═══════════════════════════════════════════════════════════════════

describe("Open Library Group D — recent changes", () => {
	itWhen(
		"getRecentChanges returns a bare array",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getRecentChanges", {
				limit: 2,
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getRecentChangesByDate returns a bare array for a known day",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getRecentChangesByDate", {
				year: 2026,
				month: "08",
				day: "05",
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getRecentChangesByKind returns a bare array for a known kind",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getRecentChangesByKind", {
				kind: "add-book",
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group E — Lists, read-only
// ═══════════════════════════════════════════════════════════════════

describe("Open Library Group E — lists", () => {
	itWhen(
		"getUserLists returns entries for a public user",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getUserLists", {
				username: "katekicks8083531",
			})) as { data: { entries?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.entries)).toBe(true);
			expect((result.data.entries ?? []).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getListsForSeed returns entries for a work seed",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getListsForSeed", {
				seed_type: "works",
				seed_id: "OL15626917W",
			})) as { data: { entries?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.entries)).toBe(true);
			expect((result.data.entries ?? []).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"searchLists returns docs for a query",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchLists", {
				q: "climate",
			})) as { data: { docs?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.docs)).toBe(true);
			expect((result.data.docs ?? []).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getList returns list metadata",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getList", {
				username: "katekicks8083531",
				list_id: "OL220835L",
			})) as { data: { name?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.name).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getListSeeds returns seeds",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getListSeeds", {
				username: "katekicks8083531",
				list_id: "OL220835L",
			})) as { data: { entries?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.entries)).toBe(true);
			expect((result.data.entries ?? []).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getListEditions returns editions",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getListEditions", {
				username: "katekicks8083531",
				list_id: "OL220835L",
			})) as { data: { entries?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.entries)).toBe(true);
			expect((result.data.entries ?? []).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getListSubjects returns subjects",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getListSubjects", {
				username: "katekicks8083531",
				list_id: "OL220835L",
			})) as { data: object };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group F — Read API (legacy)
// ═══════════════════════════════════════════════════════════════════

describe("Open Library Group F — Read API", () => {
	itWhen(
		"getVolumeById returns records for an ISBN",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getVolumeById", {
				id_type: "isbn",
				id_value: "9780385533225",
			})) as { data: { records?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.records).toBeTruthy();
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group G — Infogami /query.json (passthrough)
// ═══════════════════════════════════════════════════════════════════

describe("Open Library Group G — query.json passthrough", () => {
	itWhen(
		"queryThings forwards an undeclared type-specific key to the wire",
		withTempDirs("openlibrary.org")(async ({ guidesDir }) => {
			// `isbn_10` is NOT declared in the recipe's params; passthrough must
			// forward it as-is. The declared `type`/`limit` are validated as usual.
			const result = (await fetchOp(guidesDir, "queryThings", {
				type: "/type/edition",
				isbn_10: "0789312239",
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});
