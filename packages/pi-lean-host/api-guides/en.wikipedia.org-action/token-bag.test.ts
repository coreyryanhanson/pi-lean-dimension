/**
 * en.wikipedia.org-action synthetic axis guide — tokenBag + transform
 * (paginate), mocked transport. Covers the `tokenBag` pagination style
 * guide-driven (merge continuation keys into the next request) and
 * `transform: true × via: paginate` (`failedItems` routing on throw). No
 * live endpoint.
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
import type { ApiGuide } from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { paginate } from "../../core/helpers.js";
import { loadTransform } from "../../core/local-helpers.js";
import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";
import { transform } from "./helper.ts";

const PAGE1 = JSON.stringify({
	batchcomplete: "",
	continue: { rccontinue: "2025-01-02T03:04:05Z|abc", continue: "||" },
	query: {
		recentchanges: [
			{ pageid: 1, title: "A", timestamp: "t1", user: "u1", type: "edit" },
			{ pageid: 2, title: "B", timestamp: "t2", user: "u2", type: "edit" },
		],
	},
});

// Terminal page: no `continue` bag, so tokenBag has nothing to echo → stop.
const PAGE2 = JSON.stringify({
	query: {
		recentchanges: [
			{ pageid: 3, title: "C", timestamp: "t3", user: "u3", type: "new" },
		],
	},
});

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "en.wikipedia.org-action");
	mkdirSync(domainDir, { recursive: true });
	for (const file of ["guide.md", "helper.ts"] as const) {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf-8");
		writeFileSync(join(domainDir, file), source, "utf-8");
	}
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["en.wikipedia.org-action"]! };
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-wiki-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("en.wikipedia.org-action tokenBag + transform (mocked transport)", () => {
	it("walks pages via the merged token bag and applies the per-item transform", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: PAGE1,
				cached: false,
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: PAGE2,
				cached: false,
			});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "listRecentChanges")!;
		expect(op.pagination?.style).toBe("tokenBag");

		const transformFn = await loadTransform("en.wikipedia.org-action");
		expect(typeof transformFn).toBe("function");

		const result = await paginate(
			guide.apiHost,
			op,
			{},
			guide,
			{ gatherAll: true },
			transformFn ?? undefined,
			"en.wikipedia.org-action",
		);

		// Two pages: 2 + 1 recentchanges, each projected by the transform.
		expect(result.items.length).toBe(3);
		expect(result.pages).toBe(2);
		expect(result.failedItems).toBeUndefined();

		const first = result.items[0] as Record<string, unknown>;
		expect(first["pageid"]).toBe(1);
		expect(first["title"]).toBe("A");
		expect(Object.keys(first).sort()).toEqual([
			"pageid",
			"timestamp",
			"title",
			"type",
			"user",
		]);

		// The second request merged the continuation bag into the query.
		const secondUrl = result.urls[1]!;
		expect(secondUrl).toContain("rccontinue=2025-01-02T03%3A04%3A05Z%7Cabc");
	});

	it("transform is a lean non-lossy projection", () => {
		expect(
			transform(
				{ pageid: 9, title: "X", timestamp: "t", user: "u", type: "edit" },
				{ operation: "listRecentChanges", domain: "en.wikipedia.org-action" },
			),
		).toEqual({ pageid: 9, title: "X", timestamp: "t", user: "u", type: "edit" });
		expect(
			transform("plain", {
				operation: "listRecentChanges",
				domain: "en.wikipedia.org-action",
			}),
		).toBe("plain");
	});

	it("a throwing per-item transform routes items to failedItems (raw)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: PAGE1,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "listRecentChanges")!;
		const throwing = (): unknown => {
			throw new Error("boom");
		};

		const result = await paginate(
			guide.apiHost,
			op,
			{},
			guide,
			{},
			throwing,
			"en.wikipedia.org-action",
		);

		expect(result.items.length).toBe(0);
		expect(result.failedItems).toHaveLength(2);
		expect(result.totalFetched).toBe(2);
	});
});
