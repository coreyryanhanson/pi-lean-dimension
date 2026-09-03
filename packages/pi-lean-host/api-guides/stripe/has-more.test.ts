/**
 * stripe axis guide — boolean hasMorePath exhaustion + derived-id cursor,
 * mocked transport. Covers the boolean-exhaustion axis guide-driven: the
 * walk advances on `has_more: true`, stops cleanly on `has_more: false`
 * (no ceiling ⚠), and the past-the-end empty page Stripe would otherwise
 * serve is never fetched. An envelope with the flag absent falls back to
 * the pre-existing semantics (empty-`data` stop). No live endpoint.
 *
 * Payloads are real (Stripe /v1/charges), captured live and stripped
 * leaner.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiGuide } from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { fetchUrl } from "../../core/transport.js";
import { paginate } from "../../core/helpers.js";
import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";

// Drain any under-consumed Once-queue so a leaky test can't shift its
// leftover pages into the next test (mockReset also clears calls).
beforeEach(() => {
	vi.mocked(fetchUrl).mockReset();
});

// Real payloads (GET /v1/charges, limit=2), field-stripped:
// id/object/amount/currency. Stripe's list envelope is uniform.
const page = (ids: string[], hasMore: unknown) =>
	JSON.stringify({
		object: "list",
		data: ids.map((id) => ({
			id,
			object: "charge",
			amount: 1200,
			currency: "usd",
		})),
		has_more: hasMore,
		url: "/v1/charges",
	});

const PAGE1 = page(["ch_3NsL00", "ch_3NsL01"], true);
// has_more: false — the done-flag stop. No further request should be made.
const PAGE2 = page(["ch_3NsL02"], false);
// Absent-flag page (not observed on Stripe, but the fallback contract):
// non-empty data, no has_more → old semantics (walk continues).
const PAGE2_NO_FLAG = JSON.stringify({
	object: "list",
	data: [{ id: "ch_3NsL02", object: "charge", amount: 1200, currency: "usd" }],
	url: "/v1/charges",
});
// Past-the-end empty page — the structural stop hasMorePath makes moot.
const PAGE3_EMPTY = page([], false);

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "stripe");
	mkdirSync(domainDir, { recursive: true });
	const source = readFileSync(new URL("./guide.md", import.meta.url), "utf-8");
	writeFileSync(join(domainDir, "guide.md"), source, "utf-8");
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["stripe"]! };
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-stripe-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("stripe boolean hasMorePath exhaustion (mocked transport)", () => {
	it("has_more: true advances; has_more: false stops cleanly and the past-the-end empty page is never fetched", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "application/json" },
				body: PAGE1,
				cached: false,
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "application/json" },
				body: PAGE2,
				cached: false,
			});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "listCharges")!;
		// The plan's target recipe, verbatim — at guide level (Stripe's list
		// envelope is uniform, so ops carry no pagination of their own;
		// paginate falls back to guide.pagination).
		expect(op.pagination).toBeUndefined();
		expect(guide.pagination?.style).toBe("cursor");
		expect(guide.pagination?.cursorParam).toBe("starting_after");
		expect(guide.pagination?.cursorPath).toBe("data[-1].id");
		expect(guide.pagination?.hasMorePath).toBe("has_more");

		const result = await paginate(guide.apiHost, op, { limit: "2" }, guide, {
			gatherAll: true,
		});

		// Clean stop on the done-flag: 2 pages, no ⚠, no ceiling hit.
		expect(result.pages).toBe(2);
		expect(result.ceilingHit).toBe(false);
		expect(result.items.map((c) => (c as { id: string }).id)).toEqual([
			"ch_3NsL00",
			"ch_3NsL01",
			"ch_3NsL02",
		]);

		// The derived-id cursor advanced from page 1's LAST id…
		expect(result.urls[1]).toContain("starting_after=ch_3NsL01");
		// …and the walk ended WITHOUT fetching the past-the-end empty page —
		// the one-wasted-request behavior Stripe shows without hasMorePath.
		expect(mock).toHaveBeenCalledTimes(2);
	});

	it("absent has_more falls back to unchanged semantics (empty-data stop)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "application/json" },
				body: PAGE1,
				cached: false,
			})
			// Flag absent (undefined carve-out) → walk continues per old rules…
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "application/json" },
				body: PAGE2_NO_FLAG,
				cached: false,
			})
			// …until the structural empty-data stop fires.
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "application/json" },
				body: PAGE3_EMPTY,
				cached: false,
			});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "listCharges")!;

		const result = await paginate(guide.apiHost, op, { limit: "2" }, guide, {
			gatherAll: true,
		});

		expect(result.pages).toBe(3);
		expect(result.ceilingHit).toBe(false);
		expect(result.items.map((c) => (c as { id: string }).id)).toEqual([
			"ch_3NsL00",
			"ch_3NsL01",
			"ch_3NsL02",
		]);
		// The cursor still derived from the last item even on the flagless page.
		expect(result.urls[2]).toContain("starting_after=ch_3NsL02");
		expect(mock).toHaveBeenCalledTimes(3);
	});
});
