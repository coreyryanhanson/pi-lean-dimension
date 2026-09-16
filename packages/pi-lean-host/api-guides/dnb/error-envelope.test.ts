/**
 * dnb synthetic axis guide — the `errorPath` error-envelope axis, mocked
 * transport. Covers the OAI-PMH XML envelope guide-driven (the real dnb
 * guide.md on disk), plus the World Bank caritas mirror inline
 * (single-element JSON array whose error page misses `itemsPath` entirely —
 * the canonical placement-pin shape, with `serverTotal` interplay).
 * Generic errorPath semantics (presence, scrub, URL) live in
 * __tests__/helpers.test.ts. No live endpoint.
 *
 * Semantics pinned here: the placement pin (an error page that misses
 * itemsPath fails the walk instead of silently yielding items: []), the
 * mid-gatherAll partial-loss tradeoff, and declared-absent = not an error.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperError } from "../../core/helpers.js";
import type { ApiGuide } from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { paginate } from "../../core/helpers.js";
import { stageGuides } from "../../__tests__/test-utils.js";

const XML_HEADERS = { "content-type": "text/xml;charset=UTF-8" };
const JSON_HEADERS = { "content-type": "application/json" };

// ── OAI-PMH (real dnb guide, paginate) ─────────────────────────────

// Error page: <error> sits directly under the root, and there is no
// <ListRecords> at all — itemsPath misses entirely. Only an error page
// that misses itemsPath fails if the check were mis-slotted below the
// exhaustion breaks (silent items: []); this shape pins the placement.
const OAI_ERROR_XML = `<OAI-PMH><error code="noRecordsMatch">No records match the request</error></OAI-PMH>`;

const OAI_PAGE_XML = `<OAI-PMH><ListRecords><record><metadata><title>One</title></metadata></record><resumptionToken completeListSize="1"/></ListRecords></OAI-PMH>`;

// ── World Bank (inline op, paginate) ───────────────────────────────

const WB_ERROR_JSON = `[{"message":[{"id":"120","key":"InvalidQueryParameterValue","value":"Invalid value for parameter page"}]}]`;
const WB_OK_JSON = `[{"page":1,"pages":1,"per_page":50,"total":1},[{"indicator":{"id":"SP.POP.TOTL"},"value":1000}]]`;

let tmpBase: string;

// 200-response mock shorthand — every case in this file is an HTTP 200
// (the whole point of the error-envelope axis).
async function mock200(
	headers: Record<string, string>,
	body: string,
	times?: number,
) {
	const { fetchUrl } = await import("../../core/transport.js");
	const mock = vi.mocked(fetchUrl);
	const value = { status: 200, headers, body, cached: false };
	if (times === undefined) mock.mockResolvedValue(value);
	else mock.mockResolvedValueOnce(value);
}

async function loadDnbGuide(): Promise<ApiGuide> {
	const { guides } = stageGuides(tmpBase, new URL("../", import.meta.url), [
		"dnb",
	]);
	return guides["dnb"]!;
}

// Inline-guide builder for the World Bank mirror.
function mirrorGuide(ops: ApiGuide["operations"]): ApiGuide {
	return {
		kind: "api",
		content: "",
		updated: "2026-09-02",
		category: "site",
		source: "builtin",
		icon: "🧪",
		shortName: "Mirror",
		domains: ["mirror.test"],
		apiHost: "https://mirror.test",
		verified: "2026-09-02",
		gatherAllMax: 100,
		auth: { kind: "none" },
		responseShape: { format: "json", charset: "utf-8" },
		operations: ops,
	};
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-dnb-errorenv-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("dnb errorPath — OAI-PMH XML envelope (guide-driven, paginate)", () => {
	it("an error page (no itemsPath) throws before any item is collected", async () => {
		await mock200(XML_HEADERS, OAI_ERROR_XML);

		const guide = await loadDnbGuide();
		const op = guide.operations.find((o) => o.name === "oaiListRecords")!;
		expect(op.errorPath).toBe("OAI-PMH.error");

		const err = await paginate(guide.apiHost, op, {}, guide, {
			gatherAll: true,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(HelperError);
		const helperErr = err as HelperError;
		expect(helperErr.message).toContain("noRecordsMatch");
		expect(helperErr.message).toContain("OAI-PMH.error");
		expect(helperErr.message).toContain("HTTP status was 200");
		// URL rides the error, same contract as checkResponseStatus.
		expect(helperErr.url).toContain("/oai/repository");
	});

	it("a mid-walk error page during gatherAll throws (partial-loss tradeoff)", async () => {
		await mock200(
			XML_HEADERS,
			OAI_PAGE_XML.replace(
				'<resumptionToken completeListSize="1"/>',
				'<resumptionToken completeListSize="3">token-abc</resumptionToken>',
			),
			1,
		);
		await mock200(XML_HEADERS, OAI_ERROR_XML);

		const guide = await loadDnbGuide();
		const op = guide.operations.find((o) => o.name === "oaiListRecords")!;
		// Mid-walk pin: capture the pre-walk fetch count, then assert the walk
		// fetched exactly twice — a clean page 1 plus the erroring page 2
		// (guards against the persistent-mock mistake that made an earlier
		// version of this test fail on page 1).
		const { fetchUrl } = await import("../../core/transport.js");
		const callsBefore = vi.mocked(fetchUrl).mock.calls.length;
		const err = await paginate(guide.apiHost, op, {}, guide, {
			gatherAll: true,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(HelperError);
		expect(vi.mocked(fetchUrl).mock.calls.length - callsBefore).toBe(2);
	});

	it("a clean page succeeds (declared-absent = not an error)", async () => {
		await mock200(XML_HEADERS, OAI_PAGE_XML);

		const guide = await loadDnbGuide();
		const op = guide.operations.find((o) => o.name === "oaiListRecords")!;
		const result = await paginate(guide.apiHost, op, {}, guide);
		expect(result.items.length).toBe(1);
		expect(result.pages).toBe(1);
	});
});

describe("World Bank mirror — single-element array envelope (paginate, inline op)", () => {
	// The canonical placement-pin shape: success is [meta, records] with
	// itemsPath "1"; the error page is a single-element array whose only
	// member is the message list, so itemsPath misses entirely.
	const guide = mirrorGuide([
		{
			name: "indicatorData",
			via: "paginate",
			path: "/country/{code}/indicator/{indicator}",
			accept: "json",
			params: { code: {}, indicator: {} },
			pathParams: ["code", "indicator"],
			errorPath: "0.message",
			pagination: {
				style: "page",
				itemsPath: "1",
				pageParam: "page",
				pageSizeParam: "per_page",
				totalCountPath: "0.total",
			},
		},
	]);

	it("error page (itemsPath missing) → HelperError, not silent items: []", async () => {
		await mock200(JSON_HEADERS, WB_ERROR_JSON);
		const err = await paginate(
			guide.apiHost,
			guide.operations[0]!,
			{
				code: "DE",
				indicator: "SP.POP.TOTL",
				page: "-1",
			},
			guide,
			{ gatherAll: true },
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(HelperError);
		expect((err as HelperError).message).toContain(
			"Invalid value for parameter page",
		);
	});

	it("success page [meta, records] → items collected", async () => {
		await mock200(JSON_HEADERS, WB_OK_JSON);
		const result = await paginate(
			guide.apiHost,
			guide.operations[0]!,
			{
				code: "DE",
				indicator: "SP.POP.TOTL",
			},
			guide,
		);
		expect(result.items.length).toBe(1);
		expect(result.serverTotal).toBe(1);
	});
});
