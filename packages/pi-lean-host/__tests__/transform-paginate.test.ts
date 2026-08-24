/**
 * Post-response transform for `via: paginate`, mocked at the transport
 * layer (mirrors axis-units.test.ts — no network).
 *
 * Covers the paginate per-item hookpoint + `failedItems` output shape:
 *  - all items transform → `failedItems` absent, `totalFetched` matches.
 *  - a throwing item lands raw in `failedItems`; nothing is dropped.
 *  - every item throwing → `items` empty, `failedItems` holds all raw.
 *  - empty page with transform → `items` empty, `failedItems` absent.
 *  - ceiling caps `totalFetched` regardless of transform failures.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../core/transport.js")>(
		"../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { loadApiGuidesFromDir } from "../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { paginate } from "../core/helpers.js";
import type { ApiGuide, Operation } from "../core/api-guide-types.js";

// ── Fixtures ────────────────────────────────────────────────────────

const PAGE1 = {
	items: [{ id: 1 }, { id: 2 }, { id: 3 }],
	next: "/page2",
};
const PAGE2 = {
	items: [{ id: 4 }, { id: 5 }],
	next: null,
};

/** Guide with a single `via: paginate` nextLink op; `transform` only when set. */
function makeRecipe(transform?: boolean): string {
	const transformLine =
		transform === undefined ? "" : `    transform: ${transform}\n`;
	return `---
kind: api
domains: [fixture.test]
icon: 📡
shortName: Fixture
updated: 2026-07-17
apiHost: https://fixture.test
verified: 2026-07-17
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: list
    via: paginate
    path: /items
    accept: json
${transformLine}    pagination:
      style: nextLink
      itemsPath: items
      nextLinkPath: next
    params:
      q:
        default: all
---
Fixture transform paginate guide.
`;
}

// ── Setup helpers ──────────────────────────────────────────────────

let tmpDir: string;

function setupGuides(
	transform: boolean | undefined = true,
	gatherAllMax?: number,
): { op: Operation; guide: ApiGuide } {
	const guidesDir = mkdtempSync(join(tmpDir, "guides-"));
	const domainDir = join(guidesDir, "fixture");
	mkdirSync(domainDir, { recursive: true });
	let recipe = makeRecipe(transform);
	if (gatherAllMax !== undefined) {
		recipe = recipe.replace(
			"    params:",
			`    gatherAllMax: ${gatherAllMax}\n    params:`,
		);
	}
	writeFileSync(join(domainDir, "guide.md"), recipe, "utf-8");

	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	const guide = loaded.guides["fixture"]!;
	const op = guide.operations.find((o) => o.name === "list")!;
	return { op, guide };
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-host-transform-paginate-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const OPTS = { gatherAll: true, skipSsrfGuard: true };

describe("paginate post-response transform hookpoint", () => {
	it("all items transform → failedItems absent, totalFetched === item count", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const mocked = vi.mocked(fetchUrl);
		mocked.mockImplementation(async (url) => ({
			status: 200,
			headers: {},
			body: JSON.stringify(String(url).includes("/page2") ? PAGE2 : PAGE1),
			cached: false,
		}));
		const { op, guide } = setupGuides(true);

		const result = await paginate(
			guide.apiHost,
			op,
			{},
			guide,
			OPTS,
			(item) => {
				const it = item as { id: number };
				return { ...it, t: true };
			},
			"fixture.test",
		);

		expect(result.items).toHaveLength(5);
		expect(result.items.every((i) => (i as { t: boolean }).t === true)).toBe(
			true,
		);
		expect("failedItems" in result).toBe(false);
		expect(result.totalFetched).toBe(5);
	});

	it("one item throws → raw in failedItems, rest transformed, totalFetched preserved", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const mocked = vi.mocked(fetchUrl);
		mocked.mockImplementation(async (url) => ({
			status: 200,
			headers: {},
			body: JSON.stringify(String(url).includes("/page2") ? PAGE2 : PAGE1),
			cached: false,
		}));
		const { op, guide } = setupGuides(true);

		const result = await paginate(
			guide.apiHost,
			op,
			{},
			guide,
			OPTS,
			(item) => {
				const it = item as { id: number };
				if (it.id === 3) throw new Error("boom3");
				return { ...it, t: true };
			},
			"fixture.test",
		);

		// The failing item (raw) is in failedItems; the rest are transformed.
		expect(result.items).toHaveLength(4);
		expect(result.items.every((i) => (i as { t: boolean }).t === true)).toBe(
			true,
		);
		expect(result.failedItems).toEqual([{ id: 3 }]);
		expect(result.totalFetched).toBe(5);
	});

	it("transform throws on every item → items empty, failedItems holds all raw", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const mocked = vi.mocked(fetchUrl);
		mocked.mockImplementation(async (url) => ({
			status: 200,
			headers: {},
			body: JSON.stringify(String(url).includes("/page2") ? PAGE2 : PAGE1),
			cached: false,
		}));
		const { op, guide } = setupGuides(true);

		const result = await paginate(
			guide.apiHost,
			op,
			{},
			guide,
			OPTS,
			() => {
				throw new Error("always");
			},
			"fixture.test",
		);

		expect(result.items).toHaveLength(0);
		expect(result.failedItems).toEqual([
			{ id: 1 },
			{ id: 2 },
			{ id: 3 },
			{ id: 4 },
			{ id: 5 },
		]);
		expect(result.totalFetched).toBe(5);
	});

	it("empty page with transform → items empty, failedItems absent, totalFetched 0", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const mocked = vi.mocked(fetchUrl);
		mocked.mockImplementation(async () => ({
			status: 200,
			headers: {},
			body: JSON.stringify({ items: [], next: null }),
			cached: false,
		}));
		const { op, guide } = setupGuides(true);

		const result = await paginate(
			guide.apiHost,
			op,
			{},
			guide,
			OPTS,
			(item) => item,
			"fixture.test",
		);

		expect(result.items).toHaveLength(0);
		expect("failedItems" in result).toBe(false);
		expect(result.totalFetched).toBe(0);
	});

	it("ceiling caps totalFetched even when items fail transform", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const mocked = vi.mocked(fetchUrl);
		// One 3-item page; id 1 and 2 fail transform, id 3 succeeds. Ceiling 3.
		mocked.mockImplementation(async () => ({
			status: 200,
			headers: {},
			body: JSON.stringify(PAGE1),
			cached: false,
		}));
		const { op, guide } = setupGuides(true, 3);

		const result = await paginate(
			guide.apiHost,
			op,
			{},
			guide,
			OPTS,
			(item) => {
				const it = item as { id: number };
				if (it.id === 1 || it.id === 2) throw new Error("boom");
				return { ...it, t: true };
			},
			"fixture.test",
		);

		// Ceiling (3) caps the total raw items processed, failures included.
		expect(result.totalFetched).toBe(3);
		expect(result.ceilingHit).toBe(true);
		expect(result.failedItems).toEqual([{ id: 1 }, { id: 2 }]);
		expect(result.items).toEqual([{ id: 3, t: true }]);
	});

	it("no transformFn → raw items, failedItems absent (unchanged path)", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const mocked = vi.mocked(fetchUrl);
		mocked.mockImplementation(async (url) => ({
			status: 200,
			headers: {},
			body: JSON.stringify(String(url).includes("/page2") ? PAGE2 : PAGE1),
			cached: false,
		}));
		const { op, guide } = setupGuides(false);

		const result = await paginate(guide.apiHost, op, {}, guide, OPTS);

		expect(result.items).toEqual([
			{ id: 1 },
			{ id: 2 },
			{ id: 3 },
			{ id: 4 },
			{ id: 5 },
		]);
		expect("failedItems" in result).toBe(false);
		expect(result.totalFetched).toBe(5);
	});
});
