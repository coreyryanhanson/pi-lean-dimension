/**
 * Framework axis tests — pagination styles, mocked at the transport layer.
 *
 * Each axis exercises a distinct pagination mechanism (nextLink, XML,
 * cursor, ETag) against a controlled fixture. The recipe is a vehicle for
 * the framework code path; the transport HTTP layer is mocked via
 * `vi.mock("../core/transport.js")` so these tests run in bare CI with
 * no network.
 *
 * Fixtures live in `__tests__/fixtures/axis/` and are captured from real
 * endpoints, then trimmed to the fields the framework reads. See
 * `capture-axis-fixtures.mjs` to refresh them.
 *
 * Recipe-validity tests (live-endpoint, opt-in via HOST_INTEGRATION=1)
 * live alongside their recipe in `api-guides/<domain>/`.
 */

import { describe, it, expect, vi } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	copyFileSync,
	readdirSync,
	statSync,
	rmSync,
	existsSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_API_GUIDES = join(__dirname, "..", "api-guides");
const FIXTURE_DIR = join(__dirname, "fixtures", "axis");

// ── Recipe setup helpers (same as original, no HOST_INTEGRATION gate) ──

function copyDir(src: string, dest: string): void {
	if (!existsSync(src)) return;
	const entries = readdirSync(src);
	mkdirSync(dest, { recursive: true });
	for (const entry of entries) {
		const srcPath = join(src, entry);
		const destPath = join(dest, entry);
		if (statSync(srcPath).isDirectory()) {
			copyDir(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

function copyDomains(guidesDir: string, ...domains: string[]): void {
	for (const domain of domains) {
		const src = join(REPO_API_GUIDES, domain);
		if (!existsSync(src)) {
			throw new Error(`Recipe folder not found: ${src}`);
		}
		copyDir(src, join(guidesDir, domain));
	}
}

function withTempDirs(
	...domainsToCopy: string[]
): (fn: (dirs: { guidesDir: string }) => Promise<void>) => () => Promise<void> {
	return (fn: (dirs: { guidesDir: string }) => Promise<void>) => {
		return async () => {
			const guidesDir = mkdtempSync(join(tmpdir(), "pi-host-axis-guides-"));

			try {
				copyDomains(guidesDir, ...domainsToCopy);
				await fn({ guidesDir });
			} finally {
				rmSync(guidesDir, { recursive: true, force: true });
			}
		};
	};
}

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

// ── Axis A — nextLink pagination (loc.gov) ─────────────────────────

describe("framework axis A — nextLink pagination", () => {
	it(
		"listSearch fetches first page and extracts items with title",
		withTempDirs("loc.gov")(async ({ guidesDir }) => {
			const { fetchUrl } = await import("../core/transport.js");
			const { loadApiGuidesFromDir } = await import(
				"../core/parse-api-guide.js"
			);
			const { paginate } = await import("../core/helpers.js");
			const { setUserGuidesDir } = await import("../core/guide-store.js");

			const fixture = loadFixture("loc-nextlink-page1.json");
			vi.mocked(fetchUrl).mockResolvedValue({
				status: fixture.status,
				headers: {},
				body: fixture.body,
				cached: false,
			});

			setUserGuidesDir(guidesDir);
			const loaded = loadApiGuidesFromDir(guidesDir);
			const guide = loaded.guides["loc.gov"]!;
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
		}),
		10_000,
	);
});

// ── Axis B — XML response (services.dnb.de) ────────────────────────

describe("framework axis B — XML response parsing", () => {
	it(
		"searchZdb fetches first page and parses XML items",
		withTempDirs("services.dnb.de")(async ({ guidesDir }) => {
			const { fetchUrl } = await import("../core/transport.js");
			const { loadApiGuidesFromDir } = await import(
				"../core/parse-api-guide.js"
			);
			const { paginate } = await import("../core/helpers.js");
			const { setUserGuidesDir } = await import("../core/guide-store.js");

			// Read the XML body directly (not a JSON wrapper).
			const xmlBody = readFileSync(
				join(FIXTURE_DIR, "dnb-xml-page1.xml"),
				"utf-8",
			);
			vi.mocked(fetchUrl).mockResolvedValue({
				status: 200,
				headers: { "content-type": "text/xml;charset=UTF-8" },
				body: xmlBody,
				cached: false,
			});

			setUserGuidesDir(guidesDir);
			const loaded = loadApiGuidesFromDir(guidesDir);
			const guide = loaded.guides["services.dnb.de"]!;
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
			const recordData = first["recordData"] as
				| Record<string, unknown>
				| undefined;
			if (recordData) {
				expect(recordData).toBeTruthy();
			}
		}),
		10_000,
	);
});

// ── Axis C — cursor pagination (resources.data.gov) ────────────────

describe("framework axis C — cursor pagination", () => {
	it(
		"searchDatasets fetches first page and extracts items with _score and description",
		withTempDirs("resources.data.gov")(async ({ guidesDir }) => {
			const { fetchUrl } = await import("../core/transport.js");
			const { loadApiGuidesFromDir } = await import(
				"../core/parse-api-guide.js"
			);
			const { paginate } = await import("../core/helpers.js");
			const { setUserGuidesDir } = await import("../core/guide-store.js");

			const fixture = loadFixture("datagov-cursor-page1.json");
			vi.mocked(fetchUrl).mockResolvedValue({
				status: fixture.status,
				headers: {},
				body: fixture.body,
				cached: false,
			});

			setUserGuidesDir(guidesDir);
			const loaded = loadApiGuidesFromDir(guidesDir);
			const guide = loaded.guides["resources.data.gov"]!;
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
		}),
		10_000,
	);
});

// ── Axis D — ETag / conditional-GET (en.wikipedia.org) ─────────────

describe("framework axis D — ETag header on restGet", () => {
	it(
		"getPageSummary fetches a page summary with etag header",
		withTempDirs("en.wikipedia.org")(async ({ guidesDir }) => {
			const { fetchUrl } = await import("../core/transport.js");
			const { loadApiGuidesFromDir } = await import(
				"../core/parse-api-guide.js"
			);
			const { restGet } = await import("../core/helpers.js");
			const { setUserGuidesDir } = await import("../core/guide-store.js");

			const bodyFixture = loadFixture("wikipedia-pagesummary.json");
			const headersFixture = loadFixture("wikipedia-pagesummary.headers.json");
			vi.mocked(fetchUrl).mockResolvedValue({
				status: bodyFixture.status,
				headers: headersFixture.headers ?? {},
				body: bodyFixture.body,
				cached: false,
			});

			setUserGuidesDir(guidesDir);
			const loaded = loadApiGuidesFromDir(guidesDir);
			const guide = loaded.guides["en.wikipedia.org"]!;
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
		}),
		10_000,
	);
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
	}, 10_000);
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
	}, 10_000);
});
