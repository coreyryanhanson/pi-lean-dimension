/**
 * en.wikipedia.org-action — post-response transform tests (bare CI, no
 * network).
 *
 * The recipe's `openSearch` declares `transform: true` in guide.md; the
 * named `transform` export in the co-located `helper.ts` zips the MediaWiki
 * opensearch bare positional array (`[searchTerm, [titles], [descriptions],
 * [urls]]`) into `[{ title, description, url }, …]`.
 *
 * This file covers:
 *  - the real helper's transform logic against the opensearch shape
 *    (pure function, direct import);
 *  - the full wiring: mocked transport returning the positional array →
 *    `loadTransform` finds the real helper → the restGet hookpoint zips it.
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

import { restGet } from "../../core/helpers.js";
import { loadTransform } from "../../core/local-helpers.js";
import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";
import { transform } from "./helper.js";
import type { ApiGuide, Operation } from "../../core/api-guide-types.js";

// ── Fixture — the opensearch bare positional array ────────────────────

const OPENSEARCH_ARRAY = [
	"solar eclipse",
	["Solar eclipse", "Solar Eclipse (film)"],
	["An eclipse of the Sun.", "A 2007 film."],
	[
		"https://en.wikipedia.org/wiki/Solar_eclipse",
		"https://en.wikipedia.org/wiki/Solar_Eclipse_(film)",
	],
] as unknown[];

const OPENSEARCH_BODY = JSON.stringify(OPENSEARCH_ARRAY);

let tmpDir: string;

/**
 * Temp guide dir with the REAL guide.md + helper.ts copied verbatim from
 * this recipe — so the fixture can't drift from the shipped recipe.
 */
async function setupRecipe(): Promise<{ op: Operation; guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpDir, "guides-"));
	const domainDir = join(guidesDir, "en.wikipedia.org-action");
	mkdirSync(domainDir, { recursive: true });
	for (const file of ["guide.md", "helper.ts"] as const) {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf-8");
		writeFileSync(join(domainDir, file), source, "utf-8");
	}

	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	const guide = loaded.guides["en.wikipedia.org-action"]!;
	const op = guide.operations.find((o) => o.name === "openSearch")!;
	return { op, guide };
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-host-opensearch-transform-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// transform logic (the helper as pure function)
// ═══════════════════════════════════════════════════════════════════

describe("en.wikipedia.org-action transform (real helper.ts)", () => {
	it("zips the parallel column arrays into row objects", () => {
		const result = transform(OPENSEARCH_ARRAY, {
			operation: "openSearch",
			domain: "en.wikipedia.org-action",
		}) as Record<string, unknown>[];

		expect(result).toEqual([
			{
				title: "Solar eclipse",
				description: "An eclipse of the Sun.",
				url: "https://en.wikipedia.org/wiki/Solar_eclipse",
			},
			{
				title: "Solar Eclipse (film)",
				description: "A 2007 film.",
				url: "https://en.wikipedia.org/wiki/Solar_Eclipse_(film)",
			},
		]);
	});

	it("passes through empty / non-array / too-short bodies untouched (raw fallback)", () => {
		// Empty array
		expect(
			transform([], {
				operation: "openSearch",
				domain: "en.wikipedia.org-action",
			}),
		).toEqual([]);

		// Non-array
		const notArray = {
			searchinfo: { totalhits: 3 },
		};
		expect(
			transform(notArray, {
				operation: "openSearch",
				domain: "en.wikipedia.org-action",
			}),
		).toEqual(notArray);

		// Only the search term, no column arrays
		expect(
			transform(["solar eclipse"], {
				operation: "openSearch",
				domain: "en.wikipedia.org-action",
			}),
		).toEqual(["solar eclipse"]);
	});

	it("pads a missing column with null instead of dropping the row", () => {
		// No descriptions column → description null (both rows kept).
		const noDesc = ["q", ["A", "B"], undefined, undefined] as unknown[];
		expect(
			transform(noDesc, {
				operation: "openSearch",
				domain: "en.wikipedia.org-action",
			}),
		).toEqual([
			{ title: "A", description: null, url: null },
			{ title: "B", description: null, url: null },
		]);
	});
});

// ═══════════════════════════════════════════════════════════════════
// wiring — mocked transport → loadTransform → restGet hookpoint
// ═══════════════════════════════════════════════════════════════════

describe("openSearch transform through the real pipeline (mocked transport)", () => {
	it("returns the zipped objects from the opensearch array", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: OPENSEARCH_BODY,
			cached: false,
		});

		const { op, guide } = await setupRecipe();
		const transformFn = await loadTransform("en.wikipedia.org-action");
		expect(typeof transformFn).toBe("function");

		const result = await restGet(
			"https://en.wikipedia.org",
			op,
			{ search: "solar eclipse" },
			guide,
			undefined,
			transformFn ?? undefined,
			"en.wikipedia.org-action",
		);

		expect(Array.isArray(result.data)).toBe(true);
		const rows = result.data as Record<string, unknown>[];
		expect(rows.length).toBe(2);
		expect(Object.keys(rows[0]!)).toEqual(["title", "description", "url"]);
		expect(rows[0]!.title).toBe("Solar eclipse");
		expect(result.transformWarning).toBeUndefined();
	});

	it("a throwing transform on the opensearch shape keeps the raw array + warns (no disable)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: OPENSEARCH_BODY,
			cached: false,
		});

		const { op, guide } = await setupRecipe();
		// Simulated fixture transform — the real helper is pure and never throws.
		const throwing = (): unknown => {
			throw new Error("boom");
		};

		const result = await restGet(
			"https://en.wikipedia.org",
			op,
			{ search: "solar eclipse" },
			guide,
			undefined,
			throwing,
			"en.wikipedia.org-action",
		);

		// Raw array preserved with the warning; op not disabled.
		expect(result.data).toEqual(OPENSEARCH_ARRAY);
		expect(result.transformWarning).toBe("boom");
	});
});
