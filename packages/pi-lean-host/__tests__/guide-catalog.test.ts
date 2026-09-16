/**
 * Guide-catalog structural tests: projectToGuide() projection, slug()
 * sanitization, the directory loader + catalog formatter, and the
 * stampFrontmatterField save-stamp editor.
 *
 * Split out of parse-api-guide.test.ts — these test
 * core/guide-catalog.ts + core/path-template.ts concerns, not the parser
 * schema. BOE_RECIPE/expectOk are duplicated (not imported) so both files
 * stay standalone test modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseApiGuide,
	stampFrontmatterField,
} from "../core/parse-api-guide.js";
import {
	projectToGuide,
	loadApiGuidesFromDir,
	formatApiGuideCatalog,
} from "../core/guide-catalog.js";
import { slug } from "../core/path-template.js";
import { type ApiGuide } from "../core/api-guide-types.js";

const BOE_RECIPE = `---
schemaVersion: 1
kind: api
domains: [boe.es, www.boe.es]
icon: ⚖️
shortName: BOE
updated: 2026-07-17
apiHost: https://apidatos.boe.es/v1
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

pagination:
  style: offset-limit
  pageParam: page
  pageSizeParam: limit
  pageSize: 50
  itemsPath: data

responseShape:
  format: json
  charset: utf-8

operations:
  - name: searchDiary
    via: restGet
    path: /diario/{date}
    accept: json
    params:
      limit:
        default: 50
    helper: true
    parse:
      format: xml
      charset: iso-8859-1

  - name: listConsolidada
    via: paginate
    path: /legislacion-consolidada
    accept: json
    pagination:
      style: cursor
      cursorParam: cursor
      cursorPath: pagination.nextCursor
      itemsPath: results
    gatherAllMax: 1000
---
# BOE Legislación Consolidada — structured API access

Use \`api-fetch\` with \`operation\` \`searchDiary\` to pull a day's dispatch.
`;

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

describe("projectToGuide", () => {
	it("strips recipe fields and retains kind: api", () => {
		const guide = expectOk(BOE_RECIPE, { filename: "boe.es" });
		const proj = projectToGuide(guide);

		const keys = Object.keys(proj);
		const RECIPE_KEYS = [
			"apiHost",
			"operations",
			"pagination",
			"auth",
			"helper",
			"verified",
			"gatherAllMax",
			"responseShape",
		];
		for (const k of RECIPE_KEYS) {
			expect(keys).not.toContain(k);
		}

		expect(proj.kind).toBe("api");
		expect(proj.domains).toEqual(["boe.es", "www.boe.es"]);
		expect(proj.icon).toBe("⚖️");
		expect(proj.shortName).toBe("BOE");
		expect(proj.updated).toBe("2026-07-17");
		expect(proj.content).toContain("BOE Legislación Consolidada");
		expect(proj.category).toBe("site");
	});

	it("projection carries no helper reference", () => {
		const guide = expectOk(BOE_RECIPE, { filename: "boe.es" });
		const proj = projectToGuide(guide);
		// Helper is a recipe (op-level) field; the Guide projection has no such key.
		expect("helper" in proj).toBe(false);
		expect("operations" in proj).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════
// slug() — the shortName → identity-folder sanitizer
// ═══════════════════════════════════════════════════════════════════

describe("slug()", () => {
	it("lowercases and replaces non-[a-z0-9-] runs with a single '-'", () => {
		expect(slug("BOE")).toBe("boe");
		expect(slug("My Provider Pro!")).toBe("my-provider-pro");
		expect(slug("Example Dev Inc")).toBe("example-dev-inc");
		expect(slug("a/b")).toBe("a-b");
	});

	it("transliterates Latin diacritics instead of dropping them", () => {
		expect(slug("Café")).toBe("cafe");
		expect(slug("Überwald")).toBe("uberwald");
		expect(slug("Bjørk")).toBe("bjork");
		expect(slug("Münchhausen")).toBe("munchhausen");
	});

	it("collapses repeated '-' and strips leading/trailing '-'", () => {
		expect(slug("a--b")).toBe("a-b");
		expect(slug("-foo-")).toBe("foo");
	});

	it("slug-collision pair: api_dev_full and api-dev-full both slug to api-dev-full", () => {
		expect(slug("api_dev_full")).toBe("api-dev-full");
		expect(slug("api-dev-full")).toBe("api-dev-full");
	});

	it("throws on empty or all-symbol shortName (slug flattens to empty)", () => {
		expect(() => slug("")).toThrow(/shortName/);
		expect(() => slug("!!!")).toThrow(/shortName/);
		expect(() => slug("..")).toThrow(/shortName/);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Loader + catalog — one malformed guide doesn't block the store
// ═══════════════════════════════════════════════════════════════════

describe("loadApiGuidesFromDir + formatApiGuideCatalog", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists a healthy and a malformed guide together", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			// Healthy guide in subdirectory
			const boeDir = join(dir, "boe");
			mkdirSync(boeDir, { recursive: true });
			writeFileSync(join(boeDir, "guide.md"), BOE_RECIPE);

			// Malformed guide in subdirectory
			const brokenDir = join(dir, "broken");
			mkdirSync(brokenDir, { recursive: true });
			writeFileSync(
				join(brokenDir, "guide.md"),
				`---
schemaVersion: 1
domains: [broken.com]
apiHost: https://api.broken.com
operations:
  - name: get
    via: restPost
    path: /things
---
body
`,
			);

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual(["boe"]);
			expect(loaded.malformed).toHaveLength(1);
			expect(loaded.malformed[0]!.filename).toBe("broken");
			expect(loaded.malformed[0]!.error.field).toBe("operations[0].via");

			const catalog = formatApiGuideCatalog(loaded);
			expect(catalog).toContain("BOE");
			expect(catalog).toContain("⚠ malformed");
			expect(catalog).toContain("broken");
			expect(catalog).toContain("operations[0].via");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("collapses the catalog by organization (org line + orgless fallback)", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			const orgRecipe = (d: string, shortName: string, domains: string) => `---
schemaVersion: 1
kind: api
domains: [${domains}]
organization: archive.org
description: ${shortName} surface.
icon: 🏛️
shortName: ${shortName}
updated: 2026-07-17
apiHost: https://${d}
verified: 2026-07-17
gatherAllMax: 500
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: get
    via: restGet
    path: /x
    accept: json
---
org guide.
`;
			for (const [domain, folder, shortName] of [
				["archive.org", "archive", "Archive"],
				["web.archive.org", "wayback", "Wayback"],
			] as const) {
				mkdirSync(join(dir, folder), { recursive: true });
				writeFileSync(
					join(dir, folder, "guide.md"),
					orgRecipe(domain, shortName, domain),
				);
			}
			// Orgless guide keeps the per-guide line (fallback).
			mkdirSync(join(dir, "boe"), { recursive: true });
			writeFileSync(join(dir, "boe", "guide.md"), BOE_RECIPE);

			const loaded = loadApiGuidesFromDir(dir);
			const catalog = formatApiGuideCatalog(loaded);
			// One org-collapsed line for archive.org with guide count + domain set.
			expect(catalog).toContain(
				"🏛️ archive.org — 2 guides (archive.org, web.archive.org)",
			);
			// Orgless BOE keeps the per-guide shape (icon + shortName + ops).
			expect(catalog).toContain("⚖️ BOE — boe.es, www.boe.es");
			expect(catalog).not.toContain("🏛️ BOE");
			// Footer mentions the disambiguation menu.
			expect(catalog).toContain("disambiguation menu");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns empty result for a nonexistent directory", () => {
		const loaded = loadApiGuidesFromDir(
			join(tmpdir(), "host-guides-nonexistent-xyz"),
		);
		expect(loaded.guides).toEqual({});
		expect(loaded.malformed).toEqual([]);
		expect(formatApiGuideCatalog(loaded)).toContain("no guides");
	});

	it("skips subdirectories without guide.md", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			// A subdir without guide.md — skipped
			mkdirSync(join(dir, "no-guide"), { recursive: true });
			writeFileSync(join(dir, "no-guide", "helper.ts"), "export default p => p;");

			// A valid subdir with guide.md — loaded
			mkdirSync(join(dir, "boe"), { recursive: true });
			writeFileSync(join(dir, "boe", "guide.md"), BOE_RECIPE);

			// Flat .md files at top level — ignored
			writeFileSync(join(dir, "README.txt"), "not a guide");

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual(["boe"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes a divergent folder (entry !== slug(shortName)) to malformed", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// BOE_RECIPE has shortName: BOE → slug "boe"; folder is "boe.es" —
			// the pre-migration state. Under enforcement the guide does NOT load.
			mkdirSync(join(dir, "boe.es"), { recursive: true });
			writeFileSync(join(dir, "boe.es", "guide.md"), BOE_RECIPE);

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual([]);
			expect(loaded.malformed).toHaveLength(1);
			expect(loaded.malformed[0]!.filename).toBe("boe.es");
			expect(loaded.malformed[0]!.error.field).toBe("shortName");
			expect(loaded.malformed[0]!.error.found).toBe("folder 'boe.es'");
			expect(loaded.malformed[0]!.error.fix).toContain("mv");
			expect(loaded.malformed[0]!.error.fix).toContain("boe");
			// The per-guide fix names the mv only; no /reload instruction on the
			// fix line itself.
			expect(loaded.malformed[0]!.error.fix).not.toContain("/reload");
			// The malformed guide is warned about at load, and the catalog
			// renders its actionable fix.
			const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
			expect(msg).toContain("Malformed guide");
			expect(msg).toContain("boe.es");
			const catalog = formatApiGuideCatalog(loaded);
			expect(catalog).toContain("fix:");
			expect(catalog).not.toContain("/reload");
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes warnings through the notify callback when provided", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const notify = vi.fn();
		try {
			// Divergent folder (boe.es vs slug "boe") — must surface loudly.
			mkdirSync(join(dir, "boe.es"), { recursive: true });
			writeFileSync(join(dir, "boe.es", "guide.md"), BOE_RECIPE);

			const loaded = loadApiGuidesFromDir(dir, notify);
			expect(Object.keys(loaded.guides)).toEqual([]);
			expect(loaded.malformed).toHaveLength(1);
			// The per-guide warning goes through notify, not console.warn.
			expect(notify).toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			const msgs = notify.mock.calls.map((c) => String(c[0])).join("\n");
			expect(msgs).toContain("Malformed guide");
			expect(msgs).toContain("boe.es");
			// Every notify call uses the warning kind (ctx.ui.notify signature).
			expect(notify.mock.calls.every((c) => c[1] === "warning")).toBe(true);
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a divergent + convergent pair sharing shortName loads only the convergent one", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Old divergent folder (pre-migration) + new convergent folder
			// (slug). Only the convergent one loads.
			mkdirSync(join(dir, "boe.es"), { recursive: true });
			writeFileSync(join(dir, "boe.es", "guide.md"), BOE_RECIPE);
			mkdirSync(join(dir, "boe"), { recursive: true });
			writeFileSync(join(dir, "boe", "guide.md"), BOE_RECIPE);

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual(["boe"]);
			expect(loaded.malformed).toHaveLength(1);
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes an empty/all-symbol shortName to malformed without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			for (const bad of ["'!!!'", "''"]) {
				mkdirSync(join(dir, "bad"), { recursive: true });
				writeFileSync(
					join(dir, "bad", "guide.md"),
					BOE_RECIPE.replace("shortName: BOE", `shortName: ${bad}`),
				);

				const loaded = loadApiGuidesFromDir(dir);
				expect(Object.keys(loaded.guides)).toEqual([]);
				expect(loaded.malformed).toHaveLength(1);
				expect(loaded.malformed[0]!.filename).toBe("bad");
				expect(loaded.malformed[0]!.error.field).toBe("shortName");
				expect(loaded.malformed[0]!.error.fix).toContain("shortName");
				rmSync(join(dir, "bad"), { recursive: true, force: true });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a divergent guide loads after an agent-assisted rename to slug(shortName)", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			// BOE_RECIPE has shortName: BOE → slug "boe"; folder is "boe.es" —
			// the pre-migration state routes to malformed.
			mkdirSync(join(dir, "boe.es"), { recursive: true });
			writeFileSync(join(dir, "boe.es", "guide.md"), BOE_RECIPE);
			let loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual([]);
			expect(loaded.malformed).toHaveLength(1);

			// The migration instruction (mv boe.es boe); /reload lives in the banner.
			renameSync(join(dir, "boe.es"), join(dir, "boe"));
			loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual(["boe"]);
			expect(loaded.malformed).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// stampFrontmatterField — save-stamp blank-line separation (G3)
// ═══════════════════════════════════════════════════════════════════

describe("stampFrontmatterField", () => {
	it("inserts a blank line before a new key when the preceding line is non-empty", () => {
		const out = stampFrontmatterField(
			"---\nfoo: bar\n---\n",
			"schemaVersion",
			"0",
		);
		expect(out).toBe("---\nfoo: bar\n\nschemaVersion: 0\n---\n");
	});

	it("does not double-blank when the preceding line is already empty", () => {
		const out = stampFrontmatterField(
			"---\nfoo: bar\n\n---\n",
			"schemaVersion",
			"0",
		);
		expect(out).toBe("---\nfoo: bar\n\nschemaVersion: 0\n---\n");
	});

	it("replaces an existing key without introducing a blank line (idempotent re-stamp)", () => {
		const out = stampFrontmatterField(
			"---\nfoo: bar\nschemaVersion: 0\n---\n",
			"schemaVersion",
			"1",
		);
		expect(out).toBe("---\nfoo: bar\nschemaVersion: 1\n---\n");
	});

	it("replaces a valueless key line instead of duplicating it", () => {
		// A bare `schemaVersion:` would otherwise survive the replace and
		// collide with the appended stamp (duplicate YAML key).
		const out = stampFrontmatterField(
			"---\nfoo: bar\nschemaVersion:\n---\n",
			"schemaVersion",
			"1",
		);
		expect(out).toBe("---\nfoo: bar\nschemaVersion: 1\n---\n");
	});
});
