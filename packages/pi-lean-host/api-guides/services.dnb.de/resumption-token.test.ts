/**
 * services.dnb.de synthetic axis guide — resumptionToken + XML, mocked
 * transport. Covers the `resumptionToken` pagination style guide-driven:
 * the opaque token from each page is echoed into the next request's
 * `resumptionToken` param, and a terminal token (no `#text`) stops
 * pagination. `totalCountPath` surfaces `@_completeListSize` as
 * `serverTotal`. No live endpoint.
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

const PAGE1_XML = `<OAI-PMH><ListRecords><record><metadata><title>One</title></metadata></record><record><metadata><title>Two</title></metadata></record><resumptionToken completeListSize="3">token-abc</resumptionToken></ListRecords></OAI-PMH>`;

// Terminal page: no `#text` on the resumptionToken → pagination stops.
const PAGE2_XML = `<OAI-PMH><ListRecords><record><metadata><title>Three</title></metadata></record><resumptionToken completeListSize="3"/></ListRecords></OAI-PMH>`;

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "services.dnb.de");
	mkdirSync(domainDir, { recursive: true });
	const source = readFileSync(new URL("./guide.md", import.meta.url), "utf-8");
	writeFileSync(join(domainDir, "guide.md"), source, "utf-8");
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["services.dnb.de"]! };
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-dnb-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("services.dnb.de resumptionToken pagination (mocked transport)", () => {
	it("walks pages via the echoed token and stops at the terminal token", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "text/xml;charset=UTF-8" },
				body: PAGE1_XML,
				cached: false,
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "text/xml;charset=UTF-8" },
				body: PAGE2_XML,
				cached: false,
			});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "oaiListRecords")!;
		expect(op.pagination?.style).toBe("resumptionToken");

		const result = await paginate(guide.apiHost, op, {}, guide, {
			gatherAll: true,
		});

		// Two pages: page 1 (2 records + token), page 2 (1 record + terminal).
		expect(result.items.length).toBe(3);
		expect(result.totalFetched).toBe(3);
		expect(result.pages).toBe(2);
		expect(result.serverTotal).toBe(3);
		expect(result.ceilingHit).toBe(false);

		// The second request echoed the opaque token into resumptionToken.
		const secondUrl = result.urls[1]!;
		expect(secondUrl).toContain("resumptionToken=token-abc");
	});

	it("stops after the first page when the token is absent (single page)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/xml;charset=UTF-8" },
			body: PAGE1_XML,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "oaiListRecords")!;

		const result = await paginate(guide.apiHost, op, {}, guide);
		expect(result.pages).toBe(1);
		expect(result.items.length).toBe(2);
	});
});
