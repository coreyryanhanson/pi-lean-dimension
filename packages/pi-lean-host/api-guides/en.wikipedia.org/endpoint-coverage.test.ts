/**
 * Wikipedia REST API recipe validity tests — endpoint coverage + live fetch
 * sanity.
 *
 * Parses the recipe, executes every operation against the live endpoint, and
 * asserts the response has the expected shape. Skipped in bare CI — opt in
 * via HOST_INTEGRATION=1. Co-located with the guide it tests.
 */

import { describe, expect } from "vitest";
import { withTempDirs, itWhen } from "../_shared/test-harness.js";

// ── Per-recipe fetch helper (domain-specific; stays here, not in the harness) ──

async function fetchOp(
	guidesDir: string,
	name: string,
	params: Record<string, unknown> = {},
) {
	const { loadApiGuidesFromDir } = await import(
		"../../core/parse-api-guide.js"
	);
	const { restGet } = await import("../../core/helpers.js");
	const { setUserGuidesDir } = await import("../../core/guide-store.js");

	setUserGuidesDir(guidesDir);
	const loaded = loadApiGuidesFromDir(guidesDir);
	const guide = loaded.guides["en.wikipedia.org"]!;
	const op = guide.operations.find((o) => o.name === name)!;
	// All Wikipedia REST ops are single-resource restGet (no pagination).
	return restGet(guide.apiHost, op, params, guide);
}

const TITLE = "Earth";

// ═══════════════════════════════════════════════════════════════════
// Baseline
// ═══════════════════════════════════════════════════════════════════

describe("Wikipedia REST live integration smoke", () => {
	itWhen(
		"parses and loads the recipe; broken getFeaturedFeed is removed",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("en.wikipedia.org");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["en.wikipedia.org"]!;
			expect(guide.apiHost).toBe("https://en.wikipedia.org");
			expect(guide.auth.kind).toBe("none");
			const names = guide.operations.map((o) => o.name);
			// The broken /feed/featured/ op was removed (returns 404, absent
			// from the current OpenAPI spec).
			expect(names).not.toContain("getFeaturedFeed");
			// getPageSummary kept + 11 added.
			expect(guide.operations.length).toBe(12);
		}),
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — stable page metadata + HTML
// ═══════════════════════════════════════════════════════════════════

describe("Wikipedia REST Group A — page metadata + HTML", () => {
	itWhen(
		"getPageSummary returns title + extract for a stable title",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageSummary", {
				title: TITLE,
			})) as { data: { title?: string; extract?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.title).toBeTruthy();
			expect(result.data.extract).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getPageRevisionMetadata returns items with title + rev",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageRevisionMetadata", {
				title: TITLE,
			})) as { data: { items?: Array<{ title?: unknown; rev?: unknown }> } };
			expect(Array.isArray(result.data.items)).toBe(true);
			expect((result.data.items ?? []).length).toBeGreaterThan(0);
			expect(result.data.items![0]!.title).toBeTruthy();
			expect(result.data.items![0]!.rev).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getPageRevisionMetadataAt returns items with rev for a real revision",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const latest = (await fetchOp(guidesDir, "getPageRevisionMetadata", {
				title: TITLE,
			})) as { data: { items?: Array<{ rev?: unknown }> } };
			const rev = latest.data.items![0]!.rev;
			expect(rev).toBeTruthy();
			const result = (await fetchOp(guidesDir, "getPageRevisionMetadataAt", {
				title: TITLE,
				revision: rev,
			})) as { data: { items?: Array<{ rev?: unknown }> } };
			expect(Array.isArray(result.data.items)).toBe(true);
			expect(result.data.items![0]!.rev).toBe(rev);
		}),
		20_000,
	);

	itWhen(
		"getPageHtml returns non-empty HTML for a stable title",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageHtml", {
				title: TITLE,
			})) as { data: string };
			expect(typeof result.data).toBe("string");
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getPageHtmlAt returns non-empty HTML for a real revision",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const latest = (await fetchOp(guidesDir, "getPageRevisionMetadata", {
				title: TITLE,
			})) as { data: { items?: Array<{ rev?: unknown }> } };
			const rev = latest.data.items![0]!.rev;
			const result = (await fetchOp(guidesDir, "getPageHtmlAt", {
				title: TITLE,
				revision: rev,
			})) as { data: string };
			expect(typeof result.data).toBe("string");
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — media list
// ═══════════════════════════════════════════════════════════════════

describe("Wikipedia REST Group B — media list", () => {
	itWhen(
		"getPageMediaList returns an items array",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageMediaList", {
				title: TITLE,
			})) as { data: { items?: unknown[] } };
			expect(Array.isArray(result.data.items)).toBe(true);
			expect(result.data.items!.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getPageMediaListAt returns an items array for a real revision",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const latest = (await fetchOp(guidesDir, "getPageRevisionMetadata", {
				title: TITLE,
			})) as { data: { items?: Array<{ rev?: unknown }> } };
			const rev = latest.data.items![0]!.rev;
			const result = (await fetchOp(guidesDir, "getPageMediaListAt", {
				title: TITLE,
				revision: rev,
			})) as { data: { items?: unknown[] } };
			expect(Array.isArray(result.data.items)).toBe(true);
			expect(result.data.items!.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — lint + mobile-html
// ═══════════════════════════════════════════════════════════════════

describe("Wikipedia REST Group C — lint + mobile-html", () => {
	itWhen(
		"getPageLint returns an array of linter issues",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageLint", {
				title: TITLE,
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"getPageLintAt returns an array for a real revision",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const latest = (await fetchOp(guidesDir, "getPageRevisionMetadata", {
				title: TITLE,
			})) as { data: { items?: Array<{ rev?: unknown }> } };
			const rev = latest.data.items![0]!.rev;
			const result = (await fetchOp(guidesDir, "getPageLintAt", {
				title: TITLE,
				revision: rev,
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"getPageMobileHtml returns non-empty HTML",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageMobileHtml", {
				title: TITLE,
			})) as { data: string };
			expect(typeof result.data).toBe("string");
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getPageMobileHtmlAt returns non-empty HTML for a real revision",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const latest = (await fetchOp(guidesDir, "getPageRevisionMetadata", {
				title: TITLE,
			})) as { data: { items?: Array<{ rev?: unknown }> } };
			const rev = latest.data.items![0]!.rev;
			const result = (await fetchOp(guidesDir, "getPageMobileHtmlAt", {
				title: TITLE,
				revision: rev,
			})) as { data: string };
			expect(typeof result.data).toBe("string");
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — citation
// ═══════════════════════════════════════════════════════════════════

describe("Wikipedia REST Group D — citation", () => {
	itWhen(
		"getCitation (zotero) returns a JSON array of citation data",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getCitation", {
				format: "zotero",
				query: TITLE,
			})) as { data: unknown[] };
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});
