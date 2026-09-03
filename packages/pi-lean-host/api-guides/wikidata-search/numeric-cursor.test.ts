/**
 * wikidata-search axis guide — dedicated-field numeric cursor, mocked
 * transport. Covers the numeric-cursor coercion axis guide-driven: the
 * continuation value is a dedicated top-level numeric field
 * (`search-continue`), coerced to the wire param (`continue`) on every
 * page; the field is absent on the terminal page, which stops the walk.
 * No live endpoint.
 *
 * Payloads are real (Wikidata wbsearchentities), captured live and
 * stripped leaner.
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
import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";

// Real payloads (search=love, limit=3), field-stripped: id/label/
// description/match. Page 2 echoes the numeric search-continue from page 1.
const PAGE1 = JSON.stringify({
	searchinfo: { search: "love" },
	search: [
		{
			id: "Q316",
			label: "love",
			description: "strong, positive emotion based on affection",
			match: { type: "label", text: "love" },
		},
		{
			id: "Q289778",
			label: "Love",
			description: "1992 studio album by Thalía",
			match: { type: "label", text: "Love" },
		},
		{
			id: "Q105392014",
			label: "Love",
			description: "2021 film directed by Igor Tverdokhlebov",
			match: { type: "label", text: "Love" },
		},
	],
	"search-continue": 3,
});

// Terminal page: fewer hits than `limit` — `search-continue` is absent,
// which (not an empty array) is the end marker. (Zero-hit searches omit
// it the same way.)
const PAGE2 = JSON.stringify({
	searchinfo: { search: "love" },
	search: [
		{
			id: "Q6690277",
			label: "Love",
			description: "2010 video game",
			match: { type: "label", text: "Love" },
		},
		{
			id: "Q15042433",
			label: "Love",
			description: "2013 studio album by Arashi",
			match: { type: "label", text: "Love" },
		},
	],
});

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "wikidata-search");
	mkdirSync(domainDir, { recursive: true });
	const source = readFileSync(new URL("./guide.md", import.meta.url), "utf-8");
	writeFileSync(join(domainDir, "guide.md"), source, "utf-8");
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["wikidata-search"]! };
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-wikidata-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("wikidata-search dedicated-field numeric cursor (mocked transport)", () => {
	it("walks pages by echoing the numeric search-continue and stops when it is absent", async () => {
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
		const op = guide.operations.find((o) => o.name === "searchEntities")!;
		// The pagination block lives on the op.
		expect(op.pagination?.style).toBe("cursor");
		expect(op.pagination?.cursorParam).toBe("continue");
		expect(op.pagination?.cursorPath).toBe("search-continue");

		const result = await paginate(
			guide.apiHost,
			op,
			// limit=3 matches the captured payloads (caritas default is 20);
			// action/language/format ride the guide's declared defaults.
			{ search: "love", limit: "3" },
			guide,
			{ gatherAll: true },
		);

		// Two pages: 3 → 6 → absent.
		expect(result.pages).toBe(2);
		expect(result.items.map((s) => (s as { id: string }).id)).toEqual([
			"Q316",
			"Q289778",
			"Q105392014",
			"Q6690277",
			"Q15042433",
		]);
		expect(result.ceilingHit).toBe(false);

		// The numeric cursor value landed on the wire (coerced to a string)
		// alongside the op's declared defaults.
		expect(result.urls[0]).toContain("action=wbsearchentities");
		expect(result.urls[0]).toContain("language=en");
		expect(result.urls[0]).not.toContain("continue=");
		expect(result.urls[1]).toContain("continue=3");
	});
});
