/**
 * en.wikipedia.org-action (Wikimedia Action API) recipe validity tests —
 * endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every operation against the live
 * `https://en.wikipedia.org/w/api.php`, and asserts the response has the
 * expected shape (200 + expected keys in the JSON; `itemsPath` for
 * `paginate` ops).
 *
 * The Action guide claims `domains: [wikipedia.org]` (shared with the
 * REST guide in `en.wikipedia.org/`), so fetchOp routes through `DOMAIN =
 * "wikipedia.org"` and relies on op-name resolution across the two
 * matching guides — the multi-recipe acceptance path.
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

const DOMAIN = "wikipedia.org";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; delay wrapper stays here) ──

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const _fetch = createFetchOp(DOMAIN);

async function fetchOp(
	guidesDir: string,
	name: string,
	params: Record<string, unknown> = {},
) {
	await delay(150);
	return _fetch(guidesDir, name, params);
}

/** First page object out of a `query.pages` id→page map. */
function firstPage(body: unknown): Record<string, unknown> {
	const pages = (body as { query?: { pages?: Record<string, unknown> } }).query
		?.pages;
	expect(pages).toBeTruthy();
	const page = Object.values(pages ?? {})[0];
	expect(page).toBeTruthy();
	return page as Record<string, unknown>;
}

// ── Stable identifiers (live 2026-08 probes) ────────────────────────
const PAGE = "Wikipedia"; // stable top-level article
const CATEGORY = "Category:History";
const USER = "Jimbo Wales";
const TITLE_PREFIX = "wiki";

// ═══════════════════════════════════════════════════════════════════
// Baseline
// ═══════════════════════════════════════════════════════════════════

describe("Action API baseline", () => {
	itWhen(
		"parses and loads the recipe with all 29 ops",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(loaded.malformed).toHaveLength(0);
			const guide = loaded.guides["en.wikipedia.org-action"]!;
			expect(guide.apiHost).toBe("https://en.wikipedia.org");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(29);
		}),
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Search
// ═══════════════════════════════════════════════════════════════════

describe("EnWiki Action Group A — search", () => {
	itWhen(
		"searchPages returns results via offset-limit paginate",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchPages", {
				srsearch: "Douglas Adams",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ title: expect.any(String) });
		}),
		30_000,
	);

	itWhen(
		"openSearch returns the zipped row objects via restGet",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "openSearch", {
				search: "Douglas Adams",
			})) as {
				data: { title: string; description: unknown; url: unknown }[];
			};
			// Post-response transform (openSearch gates `transform: true`): the
			// raw `[term, titles[], descriptions[], urls[]]` array is zipped
			// into one row object per result.
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(0);
			expect(result.data[0]!.title).toBeTypeOf("string");
			expect(result.data[0]!.title).toBeTruthy();
			expect(typeof result.data[0]!.url).toBe("string");
		}),
		30_000,
	);

	itWhen(
		"prefixSearch returns results via offset-limit paginate (psoffset)",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "prefixSearch", {
				pssearch: TITLE_PREFIX,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ title: expect.any(String) });
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Page content & properties
// ═══════════════════════════════════════════════════════════════════

describe("EnWiki Action B — page content & properties", () => {
	itWhen(
		"parsePage renders page HTML at {parse.text.*}",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "parsePage", {
				page: PAGE,
			})) as {
				data: { parse?: { text?: { ["*"]?: unknown } } };
			};
			expect(result.data.parse).toBeTruthy();
			const html = result.data.parse!.text?.["*"];
			expect(typeof html).toBe("string");
			expect((html as string).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPageContent returns raw wikitext",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageContent", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.revisions)).toBe(true);
			expect(typeof (page.revisions as unknown[])[0]).toBe("object");
		}),
		30_000,
	);

	itWhen(
		"getPageInfo returns page metadata",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageInfo", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(page.title).toBe(PAGE);
			expect(typeof page.length).toBe("number");
		}),
		30_000,
	);

	itWhen(
		"getPageCategories returns a non-empty categories list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageCategories", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.categories)).toBe(true);
			expect((page.categories as unknown[]).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPageLinks returns a non-empty links list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageLinks", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.links)).toBe(true);
			expect((page.links as unknown[]).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPageImages returns a non-empty images list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageImages", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.images)).toBe(true);
			expect((page.images as unknown[]).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPageExtLinks returns a non-empty extlinks list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageExtLinks", {
				titles: PAGE,
			})) as {
				data: Record<string, unknown>;
			};
			const page = firstPage(result.data);
			expect(Array.isArray(page.extlinks)).toBe(true);
			expect((page.extlinks as unknown[]).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPageTemplates returns a non-empty templates list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageTemplates", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.templates)).toBe(true);
			expect((page.templates as unknown[]).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPageRedirects returns a list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageRedirects", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.redirects)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getPageLangLinks returns a non-empty langlinks list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageLangLinks", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.langlinks)).toBe(true);
			expect((page.langlinks as unknown[]).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPageContributors returns a non-empty contributors list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageContributors", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.contributors)).toBe(true);
			expect((page.contributors as unknown[]).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getPageCategoryInfo returns a categoryinfo stats object",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageCategoryInfo", {
				titles: CATEGORY,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(page.categoryinfo).toBeTruthy();
			expect(typeof page.categoryinfo).toBe("object");
		}),
		30_000,
	);

	itWhen(
		"getPageRevisions returns a non-empty revisions list",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPageRevisions", {
				titles: PAGE,
			})) as { data: Record<string, unknown> };
			const page = firstPage(result.data);
			expect(Array.isArray(page.revisions)).toBe(true);
			expect((page.revisions as unknown[]).length).toBeGreaterThan(0);
			expect((page.revisions as Record<string, unknown>[])[0]).toMatchObject({
				revid: expect.any(Number),
			});
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Catalog lists (tokenBag paginate)
// ═══════════════════════════════════════════════════════════════════

describe("EnWiki Action C — catalog lists", () => {
	itWhen(
		"listAllPages returns results via tokenBag paginate",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listAllPages")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ title: expect.any(String) });
		}),
		30_000,
	);

	itWhen(
		"listCategoryMembers returns category members",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listCategoryMembers", {
				cmtitle: CATEGORY,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ title: expect.any(String) });
		}),
		30_000,
	);

	itWhen(
		"listAllCategories returns categories",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listAllCategories", {
				acfrom: "History",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"listBacklinks returns pages linking to target",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listBacklinks", {
				bltitle: PAGE,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ title: expect.any(String) });
		}),
		30_000,
	);

	itWhen(
		"listUserContribs returns a user's contributions",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listUserContribs", {
				ucuser: USER,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ user: USER });
		}),
		30_000,
	);

	itWhen(
		"listLogEvents returns log entries",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listLogEvents")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"listRandom returns random pages",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listRandom")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ title: expect.any(String) });
		}),
		30_000,
	);

	itWhen(
		"listAllUsers returns registered users",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listAllUsers", {
				aulimit: 5,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ name: expect.any(String) });
		}),
		30_000,
	);

	itWhen(
		"listProtectedTitles returns an array (may be empty)",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listProtectedTitles", {
				ptlimit: 5,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — Site metadata + user lookup
// ═══════════════════════════════════════════════════════════════════

describe("enwiki Action D — site metadata + user lookup", () => {
	itWhen(
		"getSiteInfo returns wiki general info",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSiteInfo")) as {
				data: { query?: { general?: Record<string, unknown> } };
			};
			expect(result.data.query?.general).toBeTruthy();
			expect(typeof result.data.query!.general!.sitename).toBe("string");
		}),
		30_000,
	);

	itWhen(
		"getUserInfo returns a user's public info",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getUserInfo", {
				ususers: USER,
			})) as { data: { query?: { users?: unknown[] } } };
			const users = result.data.query?.users ?? [];
			expect(Array.isArray(users)).toBe(true);
			expect(users.length).toBeGreaterThan(0);
			expect(users[0]).toMatchObject({ name: USER });
		}),
		30_000,
	);

	itWhen(
		"listExtUrlUsage returns pages linking to a URL",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listExtUrlUsage", {
				euquery: "wikipedia.org",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.items[0]).toMatchObject({ title: expect.any(String) });
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Existing op — recent changes (regression)
// ═══════════════════════════════════════════════════════════════════

describe("EnWiki Action existing op — listRecentChanges", () => {
	itWhen(
		"listRecentChanges still returns via tokenBag paginate",
		withTempDirs(
			"en.wikipedia.org",
			"en.wikipedia.org-action",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listRecentChanges")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});
