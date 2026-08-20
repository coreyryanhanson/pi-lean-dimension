/**
 * schemaVersion — breaking-change detection, never a gate.
 *
 * Proves GUIDE_SCHEMA_VERSION + the `schemaVersion` frontmatter field are
 * detection, not enforcement:
 *  - absent-on-read defaults to 0 (the floor), so an unversioned guide flags
 *    as potentially stale after any schema bump rather than silently
 *    inheriting the new current.
 *  - a valid-integer frontmatter value is kept; a malformed value falls back
 *    to 0 (never a parse gate).
 *  - a stale guide (schemaVersion < current) warns non-blockingly in the
 *    api-guide catalog / disambiguation menu / detail and on api-fetch; a
 *    current guide does not.
 *  - the guide always loads and runs — never a gate.
 *
 * During beta GUIDE_SCHEMA_VERSION === 0, so no real guide is stale yet. The
 * detection tests force staleness via the pure helper `isStaleSchema(0, 1)`
 * and by passing a bumped `current` arg to the render functions — they do
 * not depend on a real bump.
 */

import { describe, it, expect } from "vitest";
import {
	parseApiGuide,
	isStaleSchema,
	staleSchemaLine,
	formatGuideListings,
	formatApiGuideCatalog,
} from "../core/parse-api-guide.js";
import { GUIDE_SCHEMA_VERSION } from "../core/api-guide-types.js";
import type { ApiGuide, LoadedApiGuides } from "../core/api-guide-types.js";

const SCHEMA_VERSIONED = `---
kind: api
schemaVersion: 0
domains:
  - example.com
apiHost: https://api.example.com
auth:
  kind: none
responseShape:
  format: json
operations:
  - name: items
    via: restGet
    path: /items
  - name: all
    via: paginate
    path: /all
    pagination:
      style: offset-limit
      itemsPath: items
      pageParam: page
      pageSizeParam: pageSize
---
Body
`;

/** Same recipe with the schemaVersion line (and its surrounding) removed. */
const UNVERSIONED = SCHEMA_VERSIONED.replace("schemaVersion: 0\n", "");

function expectOk(
	raw: string,
	opts?: Parameters<typeof parseApiGuide>[1],
): ApiGuide {
	const res = parseApiGuide(raw, opts);
	if (!res.ok) {
		throw new Error(
			`expected ok, got error: ${res.error.field} — ${res.error.expected} (found: ${res.error.found})`,
		);
	}
	return res.guide;
}

// A minimal recipe for building synthetic catalog inputs.
const MINIMAL = `---
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
Prose body.
`;

describe("GUIDE_SCHEMA_VERSION constant", () => {
	it("is 0 and exported", () => {
		expect(GUIDE_SCHEMA_VERSION).toBe(0);
	});
});

describe("schemaVersion — floor default (absent → 0, not current)", () => {
	it("surfaces schemaVersion on the parsed guide when present", () => {
		const guide = expectOk(SCHEMA_VERSIONED, { filename: "example.com" });
		expect(guide.schemaVersion).toBe(0);
	});

	it("defaults absent schemaVersion to 0 (the floor — not current)", () => {
		const guide = expectOk(UNVERSIONED, { filename: "example.com" });
		// An unversioned guide must flag as potentially-stale after any bump,
		// not silently inherit the new current — hence the floor, not
		// GUIDE_SCHEMA_VERSION.
		expect(guide.schemaVersion).toBe(0);
	});

	it("keeps an explicit valid schemaVersion", () => {
		const explicit = SCHEMA_VERSIONED.replace(
			"schemaVersion: 0",
			"schemaVersion: 3",
		);
		const guide = expectOk(explicit, { filename: "example.com" });
		expect(guide.schemaVersion).toBe(3);
	});

	it("a forward value (999) parses identically and is surfaced", () => {
		const forward = SCHEMA_VERSIONED.replace(
			"schemaVersion: 0",
			"schemaVersion: 999",
		);
		const guide = expectOk(forward, { filename: "example.com" });
		expect(guide.schemaVersion).toBe(999);

		// Same operations + auth as the 0 and absent cases — never changes output.
		const base = expectOk(SCHEMA_VERSIONED, { filename: "example.com" });
		const absent = expectOk(UNVERSIONED, { filename: "example.com" });
		expect(guide.operations).toEqual(base.operations);
		expect(guide.operations).toEqual(absent.operations);
		expect(guide.auth).toEqual(base.auth);
		expect(guide.auth).toEqual(absent.auth);
	});

	it("a malformed schemaVersion falls back to 0, never a parse gate", () => {
		// Non-integer/negative values fall back to the floor (0), not
		// undefined, and never reject the guide.
		for (const bad of [
			"schemaVersion: notanumber",
			"schemaVersion: 1.5",
			"schemaVersion: -3",
		]) {
			const raw = SCHEMA_VERSIONED.replace("schemaVersion: 0", bad);
			const result = parseApiGuide(raw, { filename: "example.com" });
			expect(result.ok, `should parse with ${JSON.stringify(bad)}`).toBe(true);
			if (result.ok) {
				expect(result.guide.schemaVersion).toBe(0);
			}
		}
	});
});

describe("isStaleSchema — pure staleness predicate", () => {
	it("truth table: stale, current, and forward-stamped", () => {
		expect(isStaleSchema(0, 1)).toBe(true);
		expect(isStaleSchema(1, 1)).toBe(false);
		// A guide stamped ahead of current is not stale — it was authored
		// against a newer schema than the running host.
		expect(isStaleSchema(2, 1)).toBe(false);
	});
});

describe("schemaVersion — detection surfaces (never a gate)", () => {
	it("staleSchemaLine renders the warning for a stale guide, undefined for current", () => {
		const stale = expectOk(SCHEMA_VERSIONED, { filename: "example.com" });
		expect(staleSchemaLine(stale, 1)).toBe(
			"  ⚠ schemaVersion 0 < current 1 — guide may need updating",
		);
		// Current (== current) and forward (> current) guides do not warn.
		expect(staleSchemaLine(stale, 0)).toBeUndefined();
		const forward = expectOk(
			SCHEMA_VERSIONED.replace("schemaVersion: 0", "schemaVersion: 2"),
			{ filename: "example.com" },
		);
		expect(staleSchemaLine(forward, 1)).toBeUndefined();
	});

	it("formatGuideListings flags a stale guide in the disambiguation menu", () => {
		const stale = expectOk(SCHEMA_VERSIONED, { filename: "example.com" });
		const current = expectOk(
			SCHEMA_VERSIONED.replace("schemaVersion: 0", "schemaVersion: 1"),
			{ filename: "example.com" },
		);
		const menu = formatGuideListings([{ guide: stale }, { guide: current }], 1);
		expect(menu).toContain(
			"⚠ schemaVersion 0 < current 1 — guide may need updating",
		);
		// Exactly one stale guide → exactly one warning line (the current
		// guide's entry has none).
		expect(menu.match(/⚠ schemaVersion/g)).toHaveLength(1);
	});

	it("catalog flags a stale orgless guide with the per-guide ⚠ line", () => {
		const loaded: LoadedApiGuides = {
			guides: {
				"stale.example": expectOk(
					SCHEMA_VERSIONED.replace(
						"domains:\n  - example.com",
						"domains:\n  - stale.example",
					),
					{ filename: "stale.example" },
				),
			},
			malformed: [],
		};
		const catalog = formatApiGuideCatalog(loaded, 1);
		expect(catalog).toContain(
			"⚠ schemaVersion 0 < current 1 — guide may need updating",
		);
	});

	it("catalog appends a ⚠ glyph to an org row containing any stale guide", () => {
		const orgRecipe = (d: string, sv: number) =>
			SCHEMA_VERSIONED.replace(
				"domains:\n  - example.com",
				`organization: example.org\ndomains:\n  - ${d}`,
			).replace("schemaVersion: 0", `schemaVersion: ${sv}`);
		// One stale + one current in the same org → glyph.
		const mixed: LoadedApiGuides = {
			guides: {
				"a.example": expectOk(orgRecipe("a.example", 0), {
					filename: "a.example",
				}),
				"b.example": expectOk(orgRecipe("b.example", 1), {
					filename: "b.example",
				}),
			},
			malformed: [],
		};
		const mixedCatalog = formatApiGuideCatalog(mixed, 1);
		expect(mixedCatalog).toContain(
			"🏛️ example.org — 2 guides (a.example, b.example) ⚠",
		);

		// All current → no glyph.
		const allCurrent: LoadedApiGuides = {
			guides: {
				"a.example": expectOk(orgRecipe("a.example", 1), {
					filename: "a.example",
				}),
				"b.example": expectOk(orgRecipe("b.example", 1), {
					filename: "b.example",
				}),
			},
			malformed: [],
		};
		const currentCatalog = formatApiGuideCatalog(allCurrent, 1);
		expect(currentCatalog).toContain(
			"🏛️ example.org — 2 guides (a.example, b.example)",
		);
		expect(currentCatalog).not.toContain("(a.example, b.example) ⚠");
	});

	it("never gates load — a stale guide still parses and runs", () => {
		// The floor default and the warning are render-only: parsing succeeds
		// and the operations are identical whether the guide is stale or
		// unversioned; the minimal guide parses with the same auth default.
		const stale = expectOk(SCHEMA_VERSIONED, { filename: "example.com" });
		const unversioned = expectOk(UNVERSIONED, { filename: "example.com" });
		const plain = expectOk(MINIMAL, { filename: "example.com" });
		expect(stale.operations).toEqual(unversioned.operations);
		expect(stale.auth).toEqual(plain.auth);
		expect(plain.auth).toEqual({ kind: "none" });
	});
});
