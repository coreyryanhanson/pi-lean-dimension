/**
 * inaturalist axis guide — derived-id negative-index cursor, mocked
 * transport. Covers the derived-id cursor axis guide-driven: the cursor is
 * the last item's integer id (`results[-1].id`) fed back as `id_above`,
 * coerced to the wire param on every page; pages never overlap; the empty
 * final `results` array terminates the walk. Also pins the op-level
 * pagination override (guide-level page style → cursor on this op). No
 * live endpoint.
 *
 * Payloads are real (iNaturalist /v1/observations), captured live and
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

// Real payloads (taxon_name=Danaus plexippus, per_page=2), field-stripped:
// id/taxon.name/user.login. Page 2 echoes page 1's LAST id as id_above
// (coerced integer). The past-the-end request returns an empty results
// array — iNat's structural end marker.
const PAGE1 = JSON.stringify({
	total_results: 4,
	page: 1,
	per_page: 2,
	results: [
		{
			id: 21189851,
			taxon: { name: "Danaus plexippus" },
			user: { login: "inat-user-a" },
		},
		{
			id: 21189898,
			taxon: { name: "Danaus plexippus" },
			user: { login: "inat-user-b" },
		},
	],
});

const PAGE2 = JSON.stringify({
	total_results: 4,
	page: 2,
	per_page: 2,
	results: [
		{
			id: 21190012,
			taxon: { name: "Danaus plexippus" },
			user: { login: "inat-user-c" },
		},
		{
			id: 21190044,
			taxon: { name: "Danaus plexippus" },
			user: { login: "inat-user-d" },
		},
	],
});

const PAGE3 = JSON.stringify({
	total_results: 4,
	page: 3,
	per_page: 2,
	results: [],
});

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "inaturalist");
	mkdirSync(domainDir, { recursive: true });
	const source = readFileSync(new URL("./guide.md", import.meta.url), "utf-8");
	writeFileSync(join(domainDir, "guide.md"), source, "utf-8");
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["inaturalist"]! };
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-inat-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("inaturalist derived-id negative-index cursor (mocked transport)", () => {
	it("walks pages by echoing results[-1].id as id_above, never overlaps, and terminates on the empty final page", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock.mockClear();
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
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "application/json" },
				body: PAGE3,
				cached: false,
			});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "listObservations")!;
		// The op-level override beat the guide-level page style.
		expect(op.pagination?.style).toBe("cursor");
		expect(op.pagination?.cursorParam).toBe("id_above");
		expect(op.pagination?.cursorPath).toBe("results[-1].id");

		const result = await paginate(
			guide.apiHost,
			op,
			// per_page=2 matches the captured payloads (caritas default is 30);
			// order_by/order ride the op's declared defaults.
			{ taxon_name: "Danaus plexippus", per_page: "2" },
			guide,
			{ gatherAll: true },
		);

		// Three pages: ids 1–2 → 3–4 → empty (structural stop, clean —
		// not a ceiling hit).
		expect(result.pages).toBe(3);
		expect(result.ceilingHit).toBe(false);
		expect(result.items.map((o) => (o as { id: number }).id)).toEqual([
			21189851, 21189898, 21190012, 21190044,
		]);
		expect(result.serverTotal).toBe(4);

		// Page-2+ non-overlap: the cursor is the PREVIOUS page's last id,
		// coerced from the unquoted JSON integer to the wire param.
		expect(result.urls[1]).toContain("id_above=21189898");
		expect(result.urls[2]).toContain("id_above=21190044");
		expect(result.urls[0]).not.toContain("id_above=");
		expect(result.urls[0]).toContain("order_by=id");
		expect(result.urls[0]).toContain("order=asc");
	});
});
