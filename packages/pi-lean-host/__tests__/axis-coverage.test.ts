/**
 * `axis-coverage.test.ts` — regression tripwire for the guide-driven
 * framework axes (Sprint 3, task 4).
 *
 * This is NOT the proof of coverage — the co-located mocked-transport tests
 * (`api-guides/<domain>/`) and `__tests__/axis-units.test.ts` execute the
 * ops and assert axis-specific behavior. This file is a structural guard
 * against silently removing an axis guide or dropping an axis-exercising
 * op during the split (real recipes live in caritas now; the synthetic
 * axis set keeps host green by construction).
 *
 * It encodes the Sprint 2 audit (`docs/design/axis-set-audit.md`) matrix:
 *  - the kept set has exactly the finalized 7 synthetic guides;
 *  - the union covers all nine guide-driven axes;
 *  - all six pagination styles are present (offset-limit, page, nextLink,
 *    cursor, resumptionToken, tokenBag);
 *  - both `transform: true × via` combos (restGet AND paginate) and both
 *    auth kinds appear.
 *
 * Reading an axis guide's ops and matching them to axes — a guide can
 * declare a flag while the behavior is malformed; only the
 * mocked-transport tests catch that. Both layers are required.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApiGuidesFromDir } from "../core/parse-api-guide.js";
import type {
	ApiGuide,
	Operation,
	PaginationStyle,
} from "../core/api-guide-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, "..", "api-guides");

// ── The finalized axis set (Sprint 2 audit §4) ──────────────────────

const AXIS_DIRS = [
	"boe.es",
	"earthquake.usgs.gov",
	"api.github.com",
	"archive.org",
	"archive.org-wayback",
	"services.dnb.de",
	"en.wikipedia.org-action",
];

const GUIDES: Record<string, ApiGuide> =
	loadApiGuidesFromDir(GUIDES_DIR).guides;

const paginateOps = Object.values(GUIDES).flatMap((g) =>
	g.operations.filter((o) => o.via === "paginate"),
);
const restGetOps = Object.values(GUIDES).flatMap((g) =>
	g.operations.filter((o) => o.via === "restGet"),
);
const allOps: Operation[] = Object.values(GUIDES).flatMap((g) => g.operations);

function opOf(guide: ApiGuide | undefined): Operation[] {
	return guide ? guide.operations : [];
}

describe("axis-coverage — kept synthetic axis set", () => {
	it(`is exactly the finalized ${AXIS_DIRS.length} guides (no drift from the audit)`, () => {
		const found = Object.keys(GUIDES).sort();
		expect(found).toEqual([...AXIS_DIRS].sort());
		expect(found.length).toBe(7);
	});

	it("loads with no malformed guides", () => {
		const loaded = loadApiGuidesFromDir(GUIDES_DIR);
		expect(loaded.malformed).toEqual([]);
	});

	it("covers every pagination style in the kept union", () => {
		const foundStyles = new Set(
			paginateOps.map((o) => o.pagination?.style).filter(Boolean),
		);
		const allStyles: PaginationStyle[] = [
			"offset-limit",
			"page",
			"nextLink",
			"cursor",
			"resumptionToken",
			"tokenBag",
		];
		for (const style of allStyles) {
			expect(foundStyles.has(style), `pagination style ${style} is missing`).toBe(
				true,
			);
		}
	});

	it("covers both transform × via combos (restGet AND paginate)", () => {
		expect(restGetOps.some((o) => o.transform === true)).toBe(true);
		expect(paginateOps.some((o) => o.transform === true)).toBe(true);
	});

	it("covers both realized auth kinds (none + static-key)", () => {
		const kinds = new Set(Object.values(GUIDES).map((g) => g.auth.kind));
		expect(kinds.has("none")).toBe(true);
		expect(kinds.has("static-key")).toBe(true);
	});
});

describe("axis-coverage — every guide-driven axis is covered by ≥1 guide", () => {
	it("exec-restGet", () => {
		expect(restGetOps.length).toBeGreaterThan(0);
	});

	it("exec-paginate", () => {
		expect(paginateOps.length).toBeGreaterThan(0);
	});

	it("xml-parsing", () => {
		// A response shape of format: xml (guide-level or op-level parse).
		const xml = Object.values(GUIDES).some(
			(g) =>
				g.responseShape.format === "xml" ||
				g.operations.some((o) => o.parse?.format === "xml"),
		);
		expect(xml).toBe(true);
	});

	it("transform-builtin", () => {
		expect(allOps.some((o) => o.transform === true)).toBe(true);
	});

	it("local-helper (helper: true op with an on-disk helper.ts)", () => {
		const covered = Object.entries(GUIDES).some(
			([dirName, g]) =>
				g.operations.some((o) => o.helper === true) &&
				existsSync(join(GUIDES_DIR, dirName, "helper.ts")),
		);
		expect(covered).toBe(true);
	});

	it("static-key-auth", () => {
		expect(Object.values(GUIDES).some((g) => g.auth.kind === "static-key")).toBe(
			true,
		);
	});

	it("transport (any guide exercises the fetch pipeline)", () => {
		expect(Object.keys(GUIDES).length).toBeGreaterThan(0);
	});

	it("ssrf-guard (a nextLink paginate op — the sole server-supplied-URL path)", () => {
		expect(paginateOps.some((o) => o.pagination?.style === "nextLink")).toBe(
			true,
		);
	});

	it("multi-recipe-domains (≥2 guides claim one domain)", () => {
		const claimCount = new Map<string, number>();
		for (const g of Object.values(GUIDES)) {
			for (const d of g.domains ?? []) {
				claimCount.set(d, (claimCount.get(d) ?? 0) + 1);
			}
		}
		expect([...claimCount.values()].some((n) => n >= 2)).toBe(true);
	});
});

// Per-guide spot checks — each single-coverage axis maps 1:1 to a guide
// whose primary purpose is that axis (audit §4 regression-isolation rule).
describe("axis-coverage — single-coverage guide ownership", () => {
	it("local-helper is owned by boe.es (helper: true op, not elsewhere required)", () => {
		expect(opOf(GUIDES["boe.es"]).some((o) => o.helper === true)).toBe(true);
		expect(existsSync(join(GUIDES_DIR, "boe.es", "helper.ts"))).toBe(true);
	});

	it("static-key-auth is owned by api.github.com", () => {
		expect(GUIDES["api.github.com"]?.auth.kind).toBe("static-key");
	});

	it("ssrf-guard is owned by archive.org's nextLink op", () => {
		expect(
			opOf(GUIDES["archive.org"]).some(
				(o) => o.via === "paginate" && o.pagination?.style === "nextLink",
			),
		).toBe(true);
	});

	it("resumptionToken is owned by services.dnb.de", () => {
		expect(
			opOf(GUIDES["services.dnb.de"]).some(
				(o) => o.pagination?.style === "resumptionToken",
			),
		).toBe(true);
	});

	it("tokenBag is owned by en.wikipedia.org-action", () => {
		expect(
			opOf(GUIDES["en.wikipedia.org-action"]).some(
				(o) => o.pagination?.style === "tokenBag",
			),
		).toBe(true);
	});

	it("multi-recipe-domains is owned by the archive.org pair", () => {
		const pair = ["archive.org", "archive.org-wayback"];
		const domains = pair
			.map((d) => GUIDES[d])
			.filter((g): g is ApiGuide => g !== undefined);
		expect(domains.length).toBe(2);
		for (const g of domains) {
			expect(g.domains?.includes("archive.org")).toBe(true);
		}
	});
});
