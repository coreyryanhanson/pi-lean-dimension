/**
 * frost-sensorthings axis guide — quoted dotted keys + nextLink, mocked
 * transport. Covers the dotted-key axis guide-driven: OData v4 pagination
 * lives in literal keys `@iot.nextLink` / `@iot.count` (dots are part of
 * the key name), resolved only via the quoted-bracket form `['…']`. The
 * walk passes page 1, surfaces `@iot.count` as `serverTotal`, and
 * terminates when the last page omits the key. nextLink stays
 * string-strict (a numeric nextLink terminates). No live endpoint.
 *
 * Payloads are real (Fraunhofer EEA air-quality instance), captured live
 * and stripped leaner.
 */

import {
	describe,
	it,
	expect,
	vi,
	beforeAll,
	afterAll,
	beforeEach,
} from "vitest";
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
import { fetchUrl } from "../../core/transport.js";

// Drain any under-consumed Once-queue so a leaky test can't shift its
// leftover pages into the next test (mockReset also clears calls).
beforeEach(() => {
	vi.mocked(fetchUrl).mockReset();
});

const PAGE1 = JSON.stringify({
	"@iot.count": 5638,
	value: [
		{
			"@iot.selfLink":
				"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things(1)",
			"@iot.id": 1,
			name: "STA.09.LIES",
			description: "Measurement station STA.09.LIES",
			properties: {
				countryCode: "AT",
				namespace: "AT.0008.20.AQ",
				owner: "http://dd.eionet.europa.eu",
			},
			"Datastreams@iot.navigationLink":
				"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things(1)/Datastreams",
		},
		{
			"@iot.selfLink":
				"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things(2)",
			"@iot.id": 2,
			name: "STA.06.170",
			description: "Measurement station STA.06.170",
			properties: {
				countryCode: "AT",
				namespace: "AT.0008.20.AQ",
				owner: "http://dd.eionet.europa.eu",
			},
			"Datastreams@iot.navigationLink":
				"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things(2)/Datastreams",
		},
	],
	// The dotted key: literal `@iot.nextLink`, not a path expression.
	"@iot.nextLink":
		"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things?$top=2&$skip=2&$count=true",
});

// Terminal page: no `@iot.nextLink` → pagination stops.
const PAGE2 = JSON.stringify({
	value: [
		{
			"@iot.selfLink":
				"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things(3)",
			"@iot.id": 3,
			name: "Lustenau Wiesenrain",
			description: "Air quality station Lustenau Wiesenrain",
			properties: {
				countryCode: "AT",
				namespace: "AT.0008.20.AQ",
				owner: "http://luft.umweltbundesamt.at",
			},
			"Datastreams@iot.navigationLink":
				"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things(3)/Datastreams",
		},
		{
			"@iot.selfLink":
				"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things(4)",
			"@iot.id": 4,
			name: "Dornbirn Stadtstraße",
			description: "Air quality station Dornbirn Stadtstraße",
			properties: {
				countryCode: "AT",
				namespace: "AT.0008.20.AQ",
				owner: "http://luft.umweltbundesamt.at",
			},
			"Datastreams@iot.navigationLink":
				"https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1/Things(4)/Datastreams",
		},
	],
});

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "frost-sensorthings");
	mkdirSync(domainDir, { recursive: true });
	const source = readFileSync(new URL("./guide.md", import.meta.url), "utf-8");
	writeFileSync(join(domainDir, "guide.md"), source, "utf-8");
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["frost-sensorthings"]! };
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-frost-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("frost-sensorthings dotted-key nextLink pagination (mocked transport)", () => {
	it("walks past page 1 via ['@iot.nextLink'] and surfaces ['@iot.count']", async () => {
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
		const op = guide.operations.find((o) => o.name === "listThings")!;
		// Pagination is declared at guide level and inherited at runtime.
		expect(guide.pagination?.style).toBe("nextLink");
		expect(guide.pagination?.nextLinkPath).toBe("['@iot.nextLink']");
		expect(guide.pagination?.totalCountPath).toBe("['@iot.count']");

		const result = await paginate(guide.apiHost, op, {}, guide, {
			gatherAll: true,
		});

		// Two pages walked; the second request followed the server-supplied
		// @iot.nextLink URL verbatim.
		expect(result.pages).toBe(2);
		expect(
			result.items.map((t) => (t as { "@iot.id": number })["@iot.id"]),
		).toEqual([1, 2, 3, 4]);
		expect(result.serverTotal).toBe(5638);
		expect(result.ceilingHit).toBe(false);
		expect(result.urls[1]).toContain("Things?$top=2&$skip=2&$count=true");
	});

	it("stops after page 1 when @iot.nextLink is absent", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "application/json" },
			body: PAGE2,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "listThings")!;

		const result = await paginate(guide.apiHost, op, {}, guide);
		expect(result.pages).toBe(1);
		expect(result.items.length).toBe(2);
	});
});
