/**
 * Framework axis tests — pagination styles, mocked at the transport layer.
 *
 * Each axis exercises a distinct pagination mechanism (nextLink, XML,
 * cursor, ETag) against a controlled fixture. The recipe is a vehicle for
 * the framework code path; the transport HTTP layer is mocked via
 * `vi.mock("../core/transport.js")` so these tests run in bare CI with
 * no network.
 *
 * Every guide is an INLINE YAML string parsed via `parseApiGuide()` — no
 * on-disk recipe dependency. (The real recipes live in the caritas repo.)
 * Fixtures live in `__tests__/fixtures/axis/` and are captured from real
 * endpoints, then trimmed to the fields the framework reads. See
 * `capture-axis-fixtures.mjs` to refresh them.
 *
 * This file is the consolidated home for the pagination/XML/ETag axes.
 * The synthetic axis guides' co-located mocked-transport tests cover the
 * axes NOT owned here (multi-recipe dispatch, transform, local-helper,
 * static-key-auth, tokenBag).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fetchUrl } from "../core/transport.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Mock the transport layer BEFORE any imports that use it.
// vi.mock is hoisted; the factory creates a fresh vi.fn() for fetchUrl.
vi.mock("../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../core/transport.js")>(
		"../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

// Drain any under-consumed Once-queue so a leaky test can't shift its
// leftover pages into the next test (mockReset also clears calls).
beforeEach(() => {
	vi.mocked(fetchUrl).mockReset();
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures", "axis");

// ── Fixture loader ──────────────────────────────────────────────────

interface FixtureFile {
	status: number;
	body: string;
	headers?: Record<string, string>;
	_note?: string;
}

function loadFixture(name: string): FixtureFile {
	const p = join(FIXTURE_DIR, name);
	return JSON.parse(readFileSync(p, "utf-8")) as FixtureFile;
}

// ── Axis AA — effective page size (caller override honored) ─────────

describe("framework axis AA — effective page size", () => {
	it("paginate honors the caller's page size and advances by it", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { paginate } = await import("../core/helpers.js");

		// 3 items per page; gatherAll walks pages until the ceiling (6) is hit.
		const body = JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body,
			cached: false,
		});

		const parsed = parseApiGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: listThings
    via: paginate
    path: /things
    pagination:
      style: offset-limit
      itemsPath: items
      pageParam: start
      pageSizeParam: limit
      pageSize: 10
    params:
      start:
        default: 1
      limit:
        default: 10
---
`);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		const op = guide.operations.find((o) => o.name === "listThings")!;

		// Caller passes limit: 3 — must win over the op default (10) and
		// pagCfg.pageSize (10), and the offset advance must use 3 as well.
		const result = await paginate(guide.apiHost, op, { limit: 3 }, guide, {
			gatherAll: true,
			gatherAllMax: 6,
			skipSsrfGuard: true,
		});

		expect(result.items.length).toBe(6);
		expect(result.pages).toBe(2);

		// First page: seed start=1, caller's limit=3 (not 10).
		expect(result.urls[0]).toContain("start=1");
		expect(result.urls[0]).toContain("limit=3");
		expect(result.urls[0]).not.toContain("limit=10");

		// Second page: offset advanced by the effective size (3) → start=4,
		// not by the stale pagCfg.pageSize (10) → start=11.
		expect(result.urls[1]).toContain("start=4");
		expect(result.urls[1]).toContain("limit=3");
		expect(result.urls[1]).not.toContain("start=11");
	});
});

// ── Axis AB — pagination `base` seed (#5) ───────────────────────────

describe("framework axis AB — pagination base seed", () => {
	it("base seeds the page param and the caller override still wins", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { paginate } = await import("../core/helpers.js");

		const body = JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body,
			cached: false,
		});

		// `base: 1` seeds `start` at 1 without the double-declaration hack;
		// no `params.start.default` needed. pageSize left to pagCfg (10).
		const parsed = parseApiGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: listThings
    via: paginate
    path: /things
    pagination:
      style: offset-limit
      itemsPath: items
      pageParam: start
      pageSizeParam: limit
      pageSize: 10
      base: 1
---
`);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		const op = guide.operations.find((o) => o.name === "listThings")!;

		// No caller params: base seeds start=1, size falls to pagCfg (10).
		const seeded = await paginate(guide.apiHost, op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 6,
			skipSsrfGuard: true,
		});
		expect(seeded.urls[0]).toContain("start=1");
		expect(seeded.urls[1]).toContain("start=11");
		expect(seeded.urls[1]).toContain("limit=10");

		// Caller override still wins over base (offset-limit style).
		const overridden = await paginate(guide.apiHost, op, { start: 5 }, guide, {
			gatherAll: true,
			gatherAllMax: 6,
			skipSsrfGuard: true,
		});
		expect(overridden.urls[0]).toContain("start=5");
		expect(overridden.urls[0]).not.toContain("start=1");
	});
});

// ── Axis A — nextLink pagination ────────────────────────────────────

describe("framework axis A — nextLink pagination", () => {
	it("listSearch fetches first page and extracts items with title", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { paginate } = await import("../core/helpers.js");

		const fixture = loadFixture("loc-nextlink-page1.json");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: fixture.status,
			headers: {},
			body: fixture.body,
			cached: false,
		});

		const parsed = parseApiGuide(`---
kind: api
domains: [www.loc.gov]
apiHost: https://www.loc.gov
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: listSearch
    via: paginate
    path: /search/
    pagination:
      style: nextLink
      itemsPath: results
      nextLinkPath: pagination.next
    params:
      fo:
        default: json
      q:
        required: true
      c:
        default: 2
---
`);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		const op = guide.operations.find((o) => o.name === "listSearch")!;

		const result = await paginate(
			guide.apiHost,
			op,
			{ q: "earthquake", c: 2 },
			guide,
			{ skipSsrfGuard: true },
		);

		expect(result.items.length).toBeGreaterThan(0);
		expect(result.totalFetched).toBeGreaterThan(0);
		expect(result.ceilingHit).toBe(false);

		const first = result.items[0] as Record<string, unknown>;
		expect(first["title"]).toBeTruthy();
	});
});

// ── Axis B — XML response ───────────────────────────────────────────

describe("framework axis B — XML response parsing", () => {
	it("searchZdb fetches first page and parses XML items", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { paginate } = await import("../core/helpers.js");

		// Read the XML body directly (not a JSON wrapper).
		const xmlBody = readFileSync(join(FIXTURE_DIR, "dnb-xml-page1.xml"), "utf-8");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/xml;charset=UTF-8" },
			body: xmlBody,
			cached: false,
		});

		const parsed = parseApiGuide(`---
kind: api
domains: [dnb.de]
apiHost: https://services.dnb.de
auth: { kind: none }
responseShape:
  format: xml
  charset: utf-8
operations:
  - name: searchZdb
    via: paginate
    path: /sru/zdb
    accept: xml
    pagination:
      style: offset-limit
      itemsPath: searchRetrieveResponse.records.record
      pageParam: startRecord
      pageSizeParam: maximumRecords
      pageSize: 2
    params:
      query:
        required: true
      maximumRecords:
        default: 2
---
`);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		const op = guide.operations.find((o) => o.name === "searchZdb")!;

		const result = await paginate(
			guide.apiHost,
			op,
			{ query: "Wasser", maximumRecords: 2 },
			guide,
		);

		expect(result.items.length).toBeGreaterThan(0);
		expect(result.totalFetched).toBeGreaterThan(0);

		const first = result.items[0] as Record<string, unknown>;
		const recordData = first["recordData"] as Record<string, unknown> | undefined;
		if (recordData) {
			expect(recordData).toBeTruthy();
		}
	});
});

// ── Axis C — cursor pagination ──────────────────────────────────────

describe("framework axis C — cursor pagination", () => {
	it("searchDatasets fetches first page and extracts items with _score and description", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { paginate } = await import("../core/helpers.js");

		const fixture = loadFixture("datagov-cursor-page1.json");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: fixture.status,
			headers: {},
			body: fixture.body,
			cached: false,
		});

		const parsed = parseApiGuide(`---
kind: api
domains: [resources.data.gov]
apiHost: https://api.gsa.gov
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: searchDatasets
    via: paginate
    path: /technology/datagov/v4/search
    pagination:
      style: cursor
      itemsPath: results
      cursorParam: cursor
      cursorPath: after
    params:
      q:
        required: true
      per_page:
        default: 2
---
`);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		const op = guide.operations.find((o) => o.name === "searchDatasets")!;

		const result = await paginate(
			guide.apiHost,
			op,
			{ q: "water", per_page: 2 },
			guide,
		);

		expect(result.items.length).toBeGreaterThan(0);
		expect(result.totalFetched).toBeGreaterThan(0);

		const first = result.items[0] as Record<string, unknown>;
		expect(first["_score"]).toBeDefined();
		expect(first["description"]).toBeTruthy();
	});
});

// ── Axis C2 — cursor page-size seeding (framework fallback) ─────────

// Resolution precedence (cursor): caller-supplied param → op-param
// `default:` → `pagination.pageSize` → omit (server default applies).
// Uses the exact post-deletion Twitch shape where noted (`pageSizeParam`
// present, `pageSize` absent).
describe("framework axis C2 — cursor page-size seeding", () => {
	async function runCursor(opts: {
		paginationExtra?: string;
		opParams?: string;
		callerParams?: Record<string, unknown>;
	}) {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { paginate } = await import("../core/helpers.js");

		const fixture = loadFixture("datagov-cursor-page1.json");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: fixture.status,
			headers: {},
			body: fixture.body,
			cached: false,
		});

		const parsed = parseApiGuide(`---
kind: api
domains: [twitch.example]
apiHost: https://api.example
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: followedStreams
    via: paginate
    path: /helix/streams/followed
    pagination:
      style: cursor
      itemsPath: results
      cursorParam: after
      cursorPath: after
${opts.paginationExtra ?? ""}${opts.opParams ?? ""}---
`);
		if (!parsed.ok)
			throw new Error(`guide failed to parse: ${parsed.error.field}`);
		const guide = parsed.guide;
		const op = guide.operations[0]!;
		return paginate(guide.apiHost, op, opts.callerParams ?? {}, guide);
	}

	it("caller-supplied size lands on the page URL (wins over pagCfg.pageSize)", async () => {
		const result = await runCursor({
			paginationExtra: "      pageSizeParam: first\n      pageSize: 20\n",
			opParams:
				"    params:\n      first:\n        description: Max items per page\n",
			callerParams: { first: 50 },
		});
		expect(result.urls[0]).toContain("first=50");
		expect(result.params["first"]).toBe("50");
	});

	it("op-param default lands when the caller omits the size (pinned pre-existing behavior)", async () => {
		const result = await runCursor({
			paginationExtra: "      pageSizeParam: first\n      pageSize: 20\n",
			opParams: "    params:\n      first:\n        default: 100\n",
		});
		expect(result.urls[0]).toContain("first=100");
		expect(result.params["first"]).toBe("100");
	});

	it("pagCfg.pageSize seeds when caller + op default are absent", async () => {
		const result = await runCursor({
			paginationExtra: "      pageSizeParam: first\n      pageSize: 20\n",
		});
		expect(result.urls[0]).toContain("first=20");
	});

	it("seeded value appears in result.params (honesty claim)", async () => {
		const result = await runCursor({
			paginationExtra: "      pageSizeParam: first\n      pageSize: 20\n",
		});
		expect(result.params["first"]).toBe("20");
	});

	it("caller-supplied value dropped by the closed contract still suppresses seeding", async () => {
		// `first` is NOT declared in op params → dropped from effectiveParams;
		// the raw-params check still sees it, so no seed overrides it.
		const result = await runCursor({
			paginationExtra: "      pageSizeParam: first\n      pageSize: 20\n",
			callerParams: { first: 50 },
		});
		expect(result.urls[0]).not.toContain("first=20");
		expect(result.urls[0]).not.toContain("first=50");
		expect(result.params["first"]).toBeUndefined();
	});

	it("nothing seeds when all three are absent (Twitch post-deletion shape)", async () => {
		const result = await runCursor({
			paginationExtra: "      pageSizeParam: first\n",
		});
		expect(result.urls[0]).not.toContain("first=");
		expect(result.params["first"]).toBeUndefined();
	});
});

// ── Axis D — ETag / conditional-GET (restGet) ───────────────────────

describe("framework axis D — ETag header on restGet", () => {
	it("getPageSummary fetches a page summary with etag header", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { restGet } = await import("../core/helpers.js");

		const bodyFixture = loadFixture("wikipedia-pagesummary.json");
		const headersFixture = loadFixture("wikipedia-pagesummary.headers.json");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: bodyFixture.status,
			headers: headersFixture.headers ?? {},
			body: bodyFixture.body,
			cached: false,
		});

		const parsed = parseApiGuide(`---
kind: api
domains: [en.wikipedia.org]
apiHost: https://en.wikipedia.org
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: getPageSummary
    via: restGet
    path: /api/rest_v1/page/summary/{title}
---
`);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		const op = guide.operations.find((o) => o.name === "getPageSummary")!;

		const result = await restGet(
			guide.apiHost,
			op,
			{ title: "JavaScript" },
			guide,
		);

		expect(result.data).toBeTruthy();
		const body = result.data as Record<string, unknown>;
		expect(body["title"]).toBe("JavaScript");
		expect(body["extract"]).toBeTruthy();

		const etag = result.headers["etag"];
		expect(etag).toBeTruthy();
		expect(typeof etag).toBe("string");
		expect((etag as string).length).toBeGreaterThan(0);
	});
});

// ── Axis E — A1 XML single-record array normalization (eutils) ─────

describe("framework axis E — A1 single-record XML boxing", () => {
	it("esearch retmax=1 boxes a single <Id> into an array", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { paginate } = await import("../core/helpers.js");

		const xmlBody = readFileSync(
			join(FIXTURE_DIR, "eutils-esearch-retmax1.xml"),
			"utf-8",
		);
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/xml;charset=UTF-8" },
			body: xmlBody,
			cached: false,
		});

		const parsed = parseApiGuide(`---
kind: api
domains:
  - eutils.ncbi.nlm.nih.gov
apiHost: https://eutils.ncbi.nlm.nih.gov
auth:
  kind: none
responseShape:
  format: xml
  charset: utf-8
operations:
  - name: esearch
    via: paginate
    path: /entrez/eutils/esearch.fcgi
    pagination:
      style: offset-limit
      itemsPath: eSearchResult.IdList.Id
      pageParam: retstart
      pageSizeParam: retmax
      pageSize: 1
      totalCountPath: eSearchResult.Count
    params:
      db:
        default: pubmed
      term:
        required: true
---
`);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		const op = guide.operations.find((o) => o.name === "esearch")!;

		const result = await paginate(
			guide.apiHost,
			op,
			{ term: "cancer", retmax: 1 },
			guide,
			{ skipSsrfGuard: true },
		);

		// A1 proof: the single <Id> is boxed into a one-element array,
		// not dropped (pre-fix it resolved to a scalar → `break`, empty).
		expect(result.items.length).toBe(1);
		expect(result.items[0]).toBe(42572859);
		expect(result.totalFetched).toBe(1);
		expect(result.serverTotal).toBe(3);
	});
});

// ── Axis F — A2 namespaced XML (ECB SDMX shape) ────────────────────

describe("framework axis F — A2 namespaced XML prefix stripping", () => {
	it("prefix-free itemsPath resolves on message:/generic:-prefixed XML", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const { paginate } = await import("../core/helpers.js");

		const xmlBody = readFileSync(
			join(FIXTURE_DIR, "ecb-sdmx-genericdata.xml"),
			"utf-8",
		);
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/xml;charset=UTF-8" },
			body: xmlBody,
			cached: false,
		});

		const parsed = parseApiGuide(`---
kind: api
domains:
  - data-api.ecb.europa.eu
apiHost: https://data-api.ecb.europa.eu
auth:
  kind: none
responseShape:
  format: xml
  charset: utf-8
operations:
  - name: getExchangeRates
    via: paginate
    path: /service/data/EXR
    pagination:
      style: offset-limit
      itemsPath: GenericData.DataSet.Series.Obs
      pageParam: startPeriod
      pageSizeParam: endPeriod
      pageSize: 1
    params:
      format:
        default: sdmx-ml
---
`);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		const op = guide.operations.find((o) => o.name === "getExchangeRates")!;

		const result = await paginate(guide.apiHost, op, {}, guide, {
			skipSsrfGuard: true,
		});

		// A2 proof: prefix-free itemsPath resolves on prefix-everywhere XML.
		expect(result.items.length).toBe(2);
		const first = result.items[0] as Record<string, unknown>;
		// Inner fields are also unprefixed (removeNSPrefix is global).
		const obsValue = first["ObsValue"] as Record<string, unknown> | undefined;
		expect(obsValue).toBeTruthy();
		expect(obsValue!["@_value"]).toBe(0.9);
	});
});

// ── Axis G — quoted dotted keys + numeric cursors ─────────────

// Dot-containing JSON keys (`@odata.nextLink`, `@iot.nextLink`,
// `@odata.count`) are literal key names, not path separators — they resolve
// only via the quoted-bracket form `['…']` / `["…"]`. Numeric
// continuation values coerce to strings in the cursor and resumptionToken
// branches (nextLink stays string-strict). Both fix silent-truncation bugs
// that reported an incomplete gather as complete.

describe("framework axis G — quoted dotted keys + numeric cursors", () => {
	async function parseGuide(yaml: string) {
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const parsed = parseApiGuide(yaml);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		return { guide, op: guide.operations[0]! };
	}

	async function mockBody(body: string) {
		const { fetchUrl } = await import("../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body,
			cached: false,
		});
	}

	it("quoted nextLinkPath ['@odata.nextLink'] walks past page 1", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { paginate } = await import("../core/helpers.js");

		const page1 = JSON.stringify({
			value: [{ id: 1 }, { id: 2 }],
			"@odata.count": 42,
			"@odata.nextLink": "https://api.test/page2",
		});
		const page2 = JSON.stringify({ value: [{ id: 3 }] });
		vi
			.mocked(fetchUrl)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: page1,
				cached: false,
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: page2,
				cached: false,
			});

		const { guide, op } = await parseGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: odataList
    via: paginate
    path: /things
    pagination:
      style: nextLink
      itemsPath: value
      nextLinkPath: "['@odata.nextLink']"
      totalCountPath: "['@odata.count']"
---
`);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});

		expect(result.pages).toBe(2);
		expect(result.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		// OData exposes totals via the same dotted-key family.
		expect(result.serverTotal).toBe(42);
	});

	it("numeric cursors advance, including numeric 0", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { paginate } = await import("../core/helpers.js");

		const body = (cursor: number | null) =>
			JSON.stringify({ items: [{ id: cursor }], next_cursor: cursor });
		vi
			.mocked(fetchUrl)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: body(5),
				cached: false,
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: body(0),
				cached: false,
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: JSON.stringify({ items: [{ id: -1 }], next_cursor: null }),
				cached: false,
			});

		const { guide, op } = await parseGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: cursorList
    via: paginate
    path: /things
    pagination:
      style: cursor
      itemsPath: items
      cursorParam: cursor
      cursorPath: next_cursor
---
`);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});

		expect(result.pages).toBe(3);
		// Numeric 5 and numeric 0 both landed on the wire as the next cursor.
		expect(result.urls[1]).toContain("cursor=5");
		expect(result.urls[2]).toContain("cursor=0");
	});

	it("empty-string and missing cursors still terminate", async () => {
		const { paginate } = await import("../core/helpers.js");

		const { guide, op } = await parseGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: cursorList
    via: paginate
    path: /things
    pagination:
      style: cursor
      itemsPath: items
      cursorParam: cursor
      cursorPath: next_cursor
---
`);

		await mockBody(JSON.stringify({ items: [{ id: 1 }], next_cursor: "" }));
		const empty = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
		});
		expect(empty.pages).toBe(1);

		await mockBody(JSON.stringify({ items: [{ id: 1 }] }));
		const missing = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
		});
		expect(missing.pages).toBe(1);
	});

	it("numeric nextLink terminates (nextLink stays string-strict)", async () => {
		const { paginate } = await import("../core/helpers.js");

		await mockBody(JSON.stringify({ value: [{ id: 1 }], "@odata.nextLink": 42 }));
		const { guide, op } = await parseGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: odataList
    via: paginate
    path: /things
    pagination:
      style: nextLink
      itemsPath: value
      nextLinkPath: "['@odata.nextLink']"
---
`);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
		});
		// A numeric "next URL" is garbage — stop, don't send a bogus request.
		expect(result.pages).toBe(1);
	});

	it("constant numeric cursor terminates via the gatherAllMax ceiling", async () => {
		const { paginate } = await import("../core/helpers.js");

		// Every page returns the same numeric cursor — the coercion leans on
		// the ceiling as its safety net against an endless walk.
		await mockBody(
			JSON.stringify({
				items: [{ id: 1 }, { id: 2 }, { id: 3 }],
				next_cursor: 7,
			}),
		);
		const { guide, op } = await parseGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: cursorList
    via: paginate
    path: /things
    pagination:
      style: cursor
      itemsPath: items
      cursorParam: cursor
      cursorPath: next_cursor
---
`);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 6,
		});
		expect(result.ceilingHit).toBe(true);
	});

	it("numeric resumptionToken advances (resumptionToken branch)", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { paginate } = await import("../core/helpers.js");

		vi
			.mocked(fetchUrl)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: JSON.stringify({ items: [{ id: 1 }], resumptionToken: 42 }),
				cached: false,
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body: JSON.stringify({ items: [{ id: 2 }], resumptionToken: null }),
				cached: false,
			});

		const { guide, op } = await parseGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: tokenList
    via: paginate
    path: /things
    pagination:
      style: resumptionToken
      itemsPath: items
      tokenParam: resumptionToken
      tokenPath: resumptionToken
---
`);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
		});
		expect(result.pages).toBe(2);
		expect(result.urls[1]).toContain("resumptionToken=42");
	});

	it("tokenBag strips quoted-bracket dress from the wire param name", async () => {
		const { paginate } = await import("../core/helpers.js");

		await mockBody(
			JSON.stringify({
				items: [{ id: 1 }],
				// The quoted-bracket form targets a literal dot-containing KEY.
				"continue.rccontinue": "abc",
				next: "tok",
			}),
		);
		const { guide, op } = await parseGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: bagList
    via: paginate
    path: /things
    pagination:
      style: tokenBag
      itemsPath: items
      continuationParams:
        - "['continue.rccontinue']"
        - "['next']"
---
`);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
		});
		// Both quoted keys resolve; the wire params are the bare
		// names, not the bracketed junk.
		expect(result.urls[1]).toContain("rccontinue=abc");
		expect(result.urls[1]).toContain("next=tok");
		expect(result.urls[1]).not.toContain("%5B");
	});
});

// ── Axis H — hasMorePath boolean exhaustion (style-agnostic done-flag) ─

// Stripe-style envelopes carry no cursor-field exhaustion: `{ data: [...],
// has_more: bool }` where the next cursor is DERIVED from the last item.
// `hasMorePath` is the stop-condition half — resolved-falsy stops cleanly,
// `undefined` never stops (fail-open toward the ceiling ⚠, never silent
// truncation), plain truthiness with no coercion (`"false"` advances).
describe("framework axis H — hasMorePath boolean exhaustion", () => {
	async function parseGuide(yaml: string) {
		const { parseApiGuide } = await import("../core/parse-api-guide.js");
		const parsed = parseApiGuide(yaml);
		if (!parsed.ok) throw new Error("guide failed to parse");
		const guide = parsed.guide;
		return { guide, op: guide.operations[0]! };
	}

	function stripeBody(ids: string[], hasMore: unknown): string {
		return JSON.stringify({
			data: ids.map((id) => ({ id })),
			has_more: hasMore,
		});
	}

	async function mockPages(pages: string[]) {
		const { fetchUrl } = await import("../core/transport.js");
		let mock = vi.mocked(fetchUrl);
		for (const body of pages) {
			mock = mock.mockResolvedValueOnce({
				status: 200,
				headers: {},
				body,
				cached: false,
			});
		}
	}

	// Stripe's list recipe, verbatim from the live-verified caritas guide —
	// exercises the derived-id cursor (data[-1].id) and the hasMorePath stop
	// in one walk.
	const STRIPE_GUIDE = `---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: json
  charset: utf-8
operations:
  - name: listCharges
    via: paginate
    path: /v1/charges
    pagination:
      style: cursor
      itemsPath: data
      cursorParam: starting_after
      cursorPath: "data[-1].id"
      hasMorePath: has_more
---
`;

	it("has_more: false stops cleanly (no ceilingHit); has_more: true advances", async () => {
		const { paginate } = await import("../core/helpers.js");
		const { guide, op } = await parseGuide(STRIPE_GUIDE);

		await mockPages([
			stripeBody(["ch_1", "ch_2"], true),
			stripeBody(["ch_3"], false),
		]);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});
		expect(result.pages).toBe(2);
		expect(result.items).toEqual([
			{ id: "ch_1" },
			{ id: "ch_2" },
			{ id: "ch_3" },
		]);
		expect(result.ceilingHit).toBe(false);
		expect(result.urls[1]).toContain("starting_after=ch_2");
	});

	it("explicit null at the path stops (same truthiness class as false)", async () => {
		const { paginate } = await import("../core/helpers.js");
		const { guide, op } = await parseGuide(STRIPE_GUIDE);

		await mockPages([stripeBody(["ch_1"], null)]);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});
		expect(result.pages).toBe(1);
		expect(result.items).toEqual([{ id: "ch_1" }]);
		expect(result.ceilingHit).toBe(false);
	});

	it("numeric 0 and empty string stop (truthiness contract)", async () => {
		const { paginate } = await import("../core/helpers.js");
		for (const falsy of [0, ""]) {
			const { guide, op } = await parseGuide(STRIPE_GUIDE);
			await mockPages([stripeBody(["ch_1"], falsy)]);
			const result = await paginate("https://api.test", op, {}, guide, {
				gatherAll: true,
				gatherAllMax: 10,
				skipSsrfGuard: true,
			});
			expect(result.pages, `has_more=${JSON.stringify(falsy)}`).toBe(1);
			expect(result.ceilingHit).toBe(false);
		}
	});

	it('the string "false" advances — no coercion, truthiness by design', async () => {
		const { paginate } = await import("../core/helpers.js");
		const { guide, op } = await parseGuide(STRIPE_GUIDE);

		// "false" is truthy in JS → advances; the walk then ends on the
		// empty-page rule (never via the flag).
		await mockPages([stripeBody(["ch_1"], "false"), stripeBody([], "false")]);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});
		expect(result.pages).toBe(2);
	});

	it("declared-but-missing path (resolves undefined every page) never truncates the walk", async () => {
		const { paginate } = await import("../core/helpers.js");
		// Typo'd path → undefined carve-out → old semantics apply: the walk
		// continues past page 1 (fail-open toward bounded annoyance) and ends
		// on the pre-existing empty-page rule.
		const { guide, op } = await parseGuide(
			STRIPE_GUIDE.replace("hasMorePath: has_more", 'hasMorePath: "nope.missing"'),
		);

		await mockPages([
			stripeBody(["ch_1"], true),
			stripeBody(["ch_2"], true),
			stripeBody([], true),
		]);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});
		expect(result.pages).toBe(3);
		expect(result.items).toEqual([{ id: "ch_1" }, { id: "ch_2" }]);
		expect(result.ceilingHit).toBe(false);
	});

	it("ceiling and has_more: false on the same page → ceilingHit wins", async () => {
		const { paginate } = await import("../core/helpers.js");
		const { guide, op } = await parseGuide(STRIPE_GUIDE);

		// Exactly fills the ceiling AND the flag says done — the run was
		// genuinely cut short, so ceilingHit must win over the clean stop.
		await mockPages([stripeBody(["ch_1", "ch_2"], false)]);
		const capped = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 2,
			skipSsrfGuard: true,
		});
		expect(capped.pages).toBe(1);
		expect(capped.ceilingHit).toBe(true);

		// Same body, roomier ceiling → the flag's clean stop.
		const { guide: g2, op: op2 } = await parseGuide(STRIPE_GUIDE);
		await mockPages([stripeBody(["ch_1", "ch_2"], false)]);
		const clean = await paginate("https://api.test", op2, {}, g2, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});
		expect(clean.pages).toBe(1);
		expect(clean.ceilingHit).toBe(false);
	});

	it("empty final page: the pre-existing empty-page break wins — the flag is never read on an itemless page", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { paginate } = await import("../core/helpers.js");
		const { guide, op } = await parseGuide(STRIPE_GUIDE);

		// has_more: true on the empty page — if the check ran there it would
		// advance to a page 3; the empty-page rule must break first. (Call-count
		// delta: the transport mock is module-level and shared across tests.)
		const callsBefore = vi.mocked(fetchUrl).mock.calls.length;
		await mockPages([stripeBody(["ch_1"], true), stripeBody([], true)]);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});
		expect(result.pages).toBe(2);
		expect(vi.mocked(fetchUrl).mock.calls.length - callsBefore).toBe(2);
		expect(result.ceilingHit).toBe(false);
	});

	it("XML pin: lowercase <has_more>false</has_more> parses to real boolean false and stops", async () => {
		const { paginate } = await import("../core/helpers.js");
		const { guide, op } = await parseGuide(`---
kind: api
domains: [api.test]
apiHost: https://api.test
auth: { kind: none }
responseShape:
  format: xml
  charset: utf-8
operations:
  - name: listThings
    via: paginate
    path: /things
    accept: xml
    pagination:
      style: page
      itemsPath: resp.items.item
      pageParam: page
      pageSizeParam: limit
      hasMorePath: resp.has_more
---
`);

		// Pins the repo's fast-xml-parser config: lowercase tag text converts
		// to real booleans (capitalized variants stay strings — that's the
		// documented bounded-annoyance corner, not a bug).
		await mockPages([
			"<resp><items><item><id>1</id></item><item><id>2</id></item></items><has_more>true</has_more></resp>",
			"<resp><items><item><id>3</id></item></items><has_more>false</has_more></resp>",
		]);
		const result = await paginate("https://api.test", op, {}, guide, {
			gatherAll: true,
			gatherAllMax: 10,
			skipSsrfGuard: true,
		});
		expect(result.pages).toBe(2);
		expect(result.ceilingHit).toBe(false);
	});
});
