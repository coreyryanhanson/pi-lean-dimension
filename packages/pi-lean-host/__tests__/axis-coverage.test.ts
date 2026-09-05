/**
 * `axis-coverage.test.ts` — regression tripwire for the guide-driven
 * framework axes.
 *
 * This is NOT the proof of coverage — the co-located mocked-transport tests
 * (`api-guides/<domain>/`) and `__tests__/axis-units.test.ts` execute the
 * ops and assert axis-specific behavior. This file is a structural guard
 * against silently removing an axis guide or dropping an axis-exercising
 * op during the split (real recipes live in caritas now; the synthetic
 * axis set keeps host green by construction).
 *
 * It encodes the axis-set audit matrix:
 *  - the kept set has exactly the finalized 14 synthetic guides;
 *  - the union covers all sixteen guide-driven axes;
 *  - all six pagination styles are present (offset-limit, page, nextLink,
 *    cursor, resumptionToken, tokenBag);
 *  - all three realized auth kinds appear (none, static-key, oauth2).
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

// ── The finalized axis set ─────────────────────────────────────────

const AXIS_DIRS = [
	"boe",
	"usgs",
	"github",
	"internet-archive",
	"wayback-availability",
	"dnb",
	"wikimedia-action",
	"twitch",
	"twitch-user",
	"frost-sensorthings",
	"wikidata-search",
	"inaturalist",
	"stripe",
	"telegram-bot",
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
		expect(found.length).toBe(14);
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

	it("covers all three realized auth kinds (none + static-key + oauth2)", () => {
		const kinds = new Set(Object.values(GUIDES).map((g) => g.auth.kind));
		expect(kinds.has("none")).toBe(true);
		expect(kinds.has("static-key")).toBe(true);
		expect(kinds.has("oauth2")).toBe(true);
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

	it("static-key-auth (incl. path-secret auth: a guide declaring secretPathRefs)", () => {
		const pathSecret = Object.values(GUIDES).some(
			(g) =>
				g.auth.kind === "static-key" &&
				Object.keys(g.auth.secretPathRefs ?? {}).length > 0,
		);
		expect(Object.values(GUIDES).some((g) => g.auth.kind === "static-key")).toBe(
			true,
		);
		expect(pathSecret).toBe(true);
	});

	it("oauth2-auth (a client_credentials AND an authorization_code guide)", () => {
		const grants = new Set(
			Object.values(GUIDES)
				.filter((g) => g.auth.kind === "oauth2")
				.map((g) => (g.auth as { grant?: string }).grant),
		);
		expect(grants.has("client_credentials")).toBe(true);
		expect(grants.has("authorization_code")).toBe(true);
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

	it("requires-any-of (an at-least-one-of group on an op)", () => {
		expect(allOps.some((o) => (o.requiresAnyOf?.length ?? 0) > 0)).toBe(true);
	});

	it("dotted-key (a quoted-bracket nextLinkPath targeting a literal dot key)", () => {
		const quotedDot = (
			p: { style?: string; nextLinkPath?: string } | undefined,
		) => p?.style === "nextLink" && p.nextLinkPath?.includes("['@iot.") === true;
		expect(
			paginateOps.some((o) => quotedDot(o.pagination)) ||
				Object.values(GUIDES).some((g) => quotedDot(g.pagination)),
		).toBe(true);
	});

	it("numeric-cursor (a dedicated-field numeric cursorPath, cursor style)", () => {
		expect(
			paginateOps.some(
				(o) =>
					o.pagination?.style === "cursor" && o.pagination.cursorParam !== undefined,
			),
		).toBe(true);
	});

	it("derived-id negative-index cursor (a cursorPath into items[-1], cursor style)", () => {
		expect(
			paginateOps.some(
				(o) =>
					o.pagination?.style === "cursor" &&
					o.pagination.cursorPath?.includes("[-1]") === true,
			),
		).toBe(true);
	});

	it("boolean hasMorePath (a hasMorePath done-flag on a paginate op)", () => {
		expect(
			paginateOps.some((o) => o.pagination?.hasMorePath !== undefined) ||
				Object.values(GUIDES).some((g) => g.pagination?.hasMorePath !== undefined),
		).toBe(true);
	});
});

// Per-guide spot checks — each single-coverage axis maps 1:1 to a guide
// whose primary purpose is that axis (regression-isolation rule).
describe("axis-coverage — single-coverage guide ownership", () => {
	it("local-helper is owned by boe (helper: true op, not elsewhere required)", () => {
		expect(opOf(GUIDES["boe"]).some((o) => o.helper === true)).toBe(true);
		expect(existsSync(join(GUIDES_DIR, "boe", "helper.ts"))).toBe(true);
	});

	it("static-key-auth is owned by github", () => {
		expect(GUIDES["github"]?.auth.kind).toBe("static-key");
	});

	it("path-secret-auth is owned by telegram-bot (path-only secretPathRefs)", () => {
		const g = GUIDES["telegram-bot"];
		expect(g?.auth.kind).toBe("static-key");
		if (g?.auth.kind === "static-key") {
			// Path-only: no secret header or query refs — the token rides the URL path.
			expect(g.auth.secretPathRefs).toEqual({ token: { secret: "bot_token" } });
			expect(g.auth.secretRefs ?? {}).toEqual({});
			expect(g.auth.secretQueryRefs ?? {}).toEqual({});
		}
		const getMe = opOf(g).find((o) => o.name === "getMe");
		expect(getMe?.path).toContain("{token}");
	});

	it("ssrf-guard is owned by internet-archive's nextLink op", () => {
		expect(
			opOf(GUIDES["internet-archive"]).some(
				(o) => o.via === "paginate" && o.pagination?.style === "nextLink",
			),
		).toBe(true);
	});

	it("resumptionToken is owned by dnb", () => {
		expect(
			opOf(GUIDES["dnb"]).some((o) => o.pagination?.style === "resumptionToken"),
		).toBe(true);
	});

	it("tokenBag is owned by wikimedia-action", () => {
		expect(
			opOf(GUIDES["wikimedia-action"]).some(
				(o) => o.pagination?.style === "tokenBag",
			),
		).toBe(true);
	});

	it("requires-any-of is owned by wikimedia-action's queryPages op", () => {
		const op = opOf(GUIDES["wikimedia-action"]).find(
			(o) => o.name === "queryPages",
		);
		expect(op?.requiresAnyOf).toEqual(["titles", "pageids", "revids"]);
	});

	it("multi-recipe-domains is owned by the archive.org pair", () => {
		const pair = ["internet-archive", "wayback-availability"];
		const domains = pair
			.map((d) => GUIDES[d])
			.filter((g): g is ApiGuide => g !== undefined);
		expect(domains.length).toBe(2);
		for (const g of domains) {
			expect(g.domains?.includes("archive.org")).toBe(true);
		}
	});

	it("dotted-key is owned by frost-sensorthings's guide-level quoted-bracket pagination", () => {
		const g = GUIDES["frost-sensorthings"];
		expect(g?.pagination?.style).toBe("nextLink");
		expect(g?.pagination?.nextLinkPath).toBe("['@iot.nextLink']");
		expect(g?.pagination?.totalCountPath).toBe("['@iot.count']");
	});

	it("numeric-cursor is owned by wikidata-search's search-continue cursor op", () => {
		const op = opOf(GUIDES["wikidata-search"]).find(
			(o) => o.name === "searchEntities",
		);
		expect(op?.pagination?.style).toBe("cursor");
		expect(op?.pagination?.cursorParam).toBe("continue");
		expect(op?.pagination?.cursorPath).toBe("search-continue");
	});

	it("derived-id negative-index cursor is owned by inaturalist's listObservations op", () => {
		const op = opOf(GUIDES["inaturalist"]).find(
			(o) => o.name === "listObservations",
		);
		expect(op?.pagination?.style).toBe("cursor");
		expect(op?.pagination?.cursorParam).toBe("id_above");
		expect(op?.pagination?.cursorPath).toBe("results[-1].id");
	});

	it("boolean hasMorePath is owned by stripe's guide-level has_more block", () => {
		const g = GUIDES["stripe"];
		expect(g?.pagination?.style).toBe("cursor");
		expect(g?.pagination?.cursorPath).toBe("data[-1].id");
		expect(g?.pagination?.hasMorePath).toBe("has_more");
	});

	it("oauth2-client-credentials is owned by twitch", () => {
		expect(GUIDES["twitch"]?.auth.kind).toBe("oauth2");
		if (GUIDES["twitch"]?.auth.kind === "oauth2") {
			expect(GUIDES["twitch"].auth.grant).toBe("client_credentials");
		}
	});

	it("oauth2-auth-code + multi-grant slot coexistence are owned by the twitch-user guide", () => {
		const auth = GUIDES["twitch-user"]?.auth;
		expect(auth?.kind).toBe("oauth2");
		if (auth?.kind === "oauth2") {
			expect(auth.grant).toBe("authorization_code");
		}
		// The pair shares the twitch.tv store domain with distinct grants —
		// the fixture-level non-clobber precondition.
		expect(GUIDES["twitch"]?.domains?.includes("twitch.tv")).toBe(true);
		expect(GUIDES["twitch-user"]?.domains?.includes("twitch.tv")).toBe(true);
	});
});
