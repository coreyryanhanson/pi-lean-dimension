/**
 * web.archive.org — post-response transform tests (bare CI, no network).
 *
 * The recipe's `queryCdx` declares `transform: true` in guide.md; the named
 * `transform` export in the co-located `helper.ts` zips the CDX
 * array-of-arrays (element 0 = field header) into row objects.
 *
 * This file covers:
 *  - the real helper's transform logic against the CDX header+row shape
 *    (pure function, direct import — no network);
 *  - the full wiring: mocked transport returning the CDX array-of-arrays →
 *    `loadTransform` finds the real helper → the restGet hookpoint zips it
 *    (the end-to-end scenario for `queryCdx` without network).
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
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { restGet } from "../../core/helpers.js";
import { loadTransform } from "../../core/local-helpers.js";
import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";
import { transform } from "./helper.js";
import type { ApiGuide, Operation } from "../../core/api-guide-types.js";

// ── Fixtures — the CDX output=json array-of-arrays (header + rows) ─────

const CDX_FIELDS = [
	"urlkey",
	"timestamp",
	"original",
	"mimetype",
	"statuscode",
	"digest",
	"length",
];

const CDX_ARRAY = [
	CDX_FIELDS,
	[
		"com,example)/",
		"20020120142510",
		"http://example.com:80/",
		"text/html",
		"200",
		"HT2D…",
		"1792",
	],
	[
		"com,example)/",
		"20020328012821",
		"http://www.example.com:80/",
		"text/html",
		"200",
		"UY3I…",
		"481",
	],
] as unknown[];

const CDX_BODY = JSON.stringify(CDX_ARRAY);

let tmpDir: string;

/**
 * Temp guide dir with the REAL guide.md + helper.ts copied verbatim from
 * this recipe — so the fixture can't drift from the shipped recipe (a
 * removed `transform: true` here fails loudly instead of testing a
 * synthetic recipe).
 */
async function setupRecipe(): Promise<{ op: Operation; guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpDir, "guides-"));
	const domainDir = join(guidesDir, "web.archive.org");
	mkdirSync(domainDir, { recursive: true });
	for (const file of ["guide.md", "helper.ts"] as const) {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf-8");
		writeFileSync(join(domainDir, file), source, "utf-8");
	}

	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	const guide = loaded.guides["web.archive.org"]!;
	const op = guide.operations.find((o) => o.name === "queryCdx")!;
	return { op, guide };
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-host-cdx-transform-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// transform logic (the helper as pure function — no network)
// ═══════════════════════════════════════════════════════════════════

describe("web.archive.org transform (real helper.ts)", () => {
	it("zips the CDX header + rows into plain objects", () => {
		const result = transform(CDX_ARRAY, {
			operation: "queryCdx",
			domain: "web.archive.org",
		}) as Record<string, unknown>[];

		expect(result).toEqual([
			{
				urlkey: "com,example)/",
				timestamp: "20020120142510",
				original: "http://example.com:80/",
				mimetype: "text/html",
				statuscode: "200",
				digest: "HT2D…",
				length: "1792",
			},
			{
				urlkey: "com,example)/",
				timestamp: "20020328012821",
				original: "http://www.example.com:80/",
				mimetype: "text/html",
				statuscode: "200",
				digest: "UY3I…",
				length: "481",
			},
		]);
		expect(Object.keys(result[0]!)).toEqual(CDX_FIELDS);
	});

	it("passes through empty / non-array bodies untouched (raw fallback)", () => {
		const empty = transform([], {
			operation: "queryCdx",
			domain: "web.archive.org",
		});
		expect(empty).toEqual([]);

		const notArray = transform(
			{ rows: 1 },
			{
				operation: "queryCdx",
				domain: "web.archive.org",
			},
		);
		expect(notArray).toEqual({ rows: 1 });

		// Header-only (no rows) → zero zipped objects (nothing to zip).
		const headerOnly = transform(CDX_ARRAY.slice(0, 1), {
			operation: "queryCdx",
			domain: "web.archive.org",
		});
		expect(headerOnly).toEqual([]);

		// A row shorter than the header pads missing cells with null.
		const ragged = transform([CDX_FIELDS.slice(0, 2), ["a", "b", "c"]], {
			operation: "queryCdx",
			domain: "web.archive.org",
		});
		expect(ragged).toEqual([{ urlkey: "a", timestamp: "b" }]);
	});
});

// ═══════════════════════════════════════════════════════════════════
// wiring — mocked transport → loadTransform → restGet hookpoint
// ═══════════════════════════════════════════════════════════════════

describe("queryCdx transform through the real pipeline (mocked transport)", () => {
	it("returns the zipped objects from the CDX array-of-arrays", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: CDX_BODY,
			cached: false,
		});

		const { op, guide } = await setupRecipe();
		const transformFn = await loadTransform("web.archive.org");
		expect(typeof transformFn).toBe("function");

		const result = await restGet(
			"https://web.archive.org",
			op,
			{ url: "example.com" },
			guide,
			undefined,
			transformFn ?? undefined,
			"web.archive.org",
		);

		expect(Array.isArray(result.data)).toBe(true);
		const rows = result.data as Record<string, unknown>[];
		expect(rows.length).toBe(2);
		expect(Object.keys(rows[0]!)).toEqual(CDX_FIELDS);
		expect(rows[0]!.urlkey).toBe("com,example)/");
		expect(result.transformWarning).toBeUndefined();
	});

	it("a throwing transform on the CDX shape keeps the raw arrays + warns (no disable)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: CDX_BODY,
			cached: false,
		});

		const { op, guide } = await setupRecipe();
		// Simulated fixture transform — the real helper is pure and never throws.
		const throwing = (): unknown => {
			throw new Error("boom");
		};

		const result = await restGet(
			"https://web.archive.org",
			op,
			{ url: "example.com" },
			guide,
			undefined,
			throwing,
			"web.archive.org",
		);

		// Raw array-of-arrays preserved with the warning; op not disabled.
		expect(result.data).toEqual(CDX_ARRAY);
		expect(result.transformWarning).toBe("boom");
	});
});
