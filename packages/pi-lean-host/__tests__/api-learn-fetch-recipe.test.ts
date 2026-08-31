/**
 * api-learn fetch-recipe + entry-point split + disambiguation + file staging
 * structural tests.
 *
 * Covers:
 *  - 0 guides → template written to /tmp/pi-lean-host/<domain>/guide.md;
 *    result surfaces the path; fail-closed still holds (template-as-is
 *    rejected by the parser).
 *  - 1 guide → draft written to the path; result surfaces path + dirName;
 *    draft contents equal the saved raw recipe (incl. schemaVersion stamp).
 *  - N guides → menu unchanged; selected guide's recipe written to the path.
 *  - `new: true` → template written to the path; existing guides untouched.
 *  - Save from `dir` → validates-then-writes `guide.md`; the
 *    `schemaVersion` stamp lands on `guide.md`.
 *  - Missing `dir` → clear error, `guide.md` untouched.
 *  - Inline `recipe` param is no longer a parameter (YAGNI removal).
 *  - Path-traversal domain still rejected by `assertSafeDomain`.
 *  - TUI rendering — `renderCall` shows the 📝 icon for a `dir`-
 *    bearing save call and 📖 for fetch; `renderResult` labels unchanged.
 *
 * No network — recipes use a dummy https apiHost; the save path only
 * validates + writes. Structural only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiLearnTool, setStagingRoot } from "../tools/api-learn.js";
import { contentText } from "../tools/utils.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { parseApiGuide } from "../core/parse-api-guide.js";

let tmpGuidesDir: string;
let tmpStagingRoot: string;

beforeAll(() => {
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-learn-fetch-"));
	setUserGuidesDir(tmpGuidesDir);
	tmpStagingRoot = mkdtempSync(join(tmpdir(), "host-learn-staging-"));
	setStagingRoot(tmpStagingRoot);
	invalidateCache();
});

afterAll(() => {
	rmSync(tmpGuidesDir, { recursive: true, force: true });
	rmSync(tmpStagingRoot, { recursive: true, force: true });
});

const API = "https://api.example.com";

function recipe(domain: string, shortName: string, opName: string): string {
	return `---
kind: api
domains: [${domain}]
shortName: ${shortName}
apiHost: ${API}
operations:
  - name: ${opName}
    via: restGet
    path: /x
    accept: json
---
`;
}

/** Staged guide.md path for a domain (mirrors api-learn's staging). */
function stagedPath(domain: string): string {
	return join(tmpStagingRoot, domain, "guide.md");
}

/** Staged dir path for a domain (what save takes as `dir`). */
function stagedDirPath(domain: string): string {
	return join(tmpStagingRoot, domain);
}

/** Save a recipe by staging it to the draft dir, then calling with dir. */
function saveRecipe(domain: string, recipe: string) {
	mkdirSync(join(tmpStagingRoot, domain), { recursive: true });
	writeFileSync(stagedPath(domain), recipe, "utf-8");
	return apiLearnTool.execute(
		"test",
		{ domain, dir: stagedDirPath(domain) },
		undefined,
		undefined,
		undefined as any,
	);
}

function callLearn(
	domain: string,
	dir?: string,
	extra?: { new?: boolean; guide?: string },
) {
	const p: Record<string, unknown> = { domain };
	if (dir !== undefined) p.dir = dir;
	if (extra?.new !== undefined) p.new = extra.new;
	if (extra?.guide !== undefined) p.guide = extra.guide;
	return apiLearnTool.execute("test", p, undefined, undefined, undefined as any);
}

// ── Mock theme (fg returns text unstyled) ────────────────────────
const mockTheme = {
	fg: (_style: string, text: string) => text,
	bold: (s: string) => s,
} as any;

describe("api-learn fetch-recipe", () => {
	it("0 guides → template written to staging path (fails closed)", async () => {
		const res = await callLearn("fresh.example");
		const text = contentText(res);
		// Result surfaces the staged file path, not an inline yaml block.
		expect(text).toContain("written to");
		expect(text).toContain(stagedPath("fresh.example"));
		expect(text).not.toContain("```yaml");
		// The authoring manual travels with the staged template.
		expect(text).toContain("authoring manual");
		// Draft written to the deterministic path.
		const draft = readFileSync(stagedPath("fresh.example"), "utf-8");
		expect(draft).toContain("domains: [fresh.example]");
		// Placeholders, not another API's real values.
		expect(draft).toContain("<base url>");
		expect(draft).toContain("<short>");
		expect(draft).toContain("<emoji>");
		expect(draft).not.toMatch(/apidatos|boe\.es|BOE|searchDiary|listConsolidada/);
		// Fail-closed: the as-is template cannot save (placeholder apiHost
		// is rejected by requireHttpUrl).
		expect(parseApiGuide(draft, { filename: "fresh.example" }).ok).toBe(false);
	});

	it("1 guide → raw recipe staged; result surfaces path + dirName", async () => {
		await saveRecipe("solo.example", recipe("solo.example", "Solo", "getSolo"));
		const text = contentText(await callLearn("solo.example"));
		// dirName is slug(shortName) = "solo"; fetch-recipe staging keys on
		// the same value.
		expect(text).toContain("Directory: solo");
		expect(text).toContain(stagedDirPath("solo"));
		expect(text).toContain("edit the staged file");
		// The authoring manual travels with the staged raw recipe.
		expect(text).toContain("authoring manual");
		// Draft contents equal the saved raw recipe (incl. schemaVersion stamp).
		const raw = readFileSync(join(tmpGuidesDir, "solo", "guide.md"), "utf-8");
		const draft = readFileSync(stagedPath("solo"), "utf-8");
		expect(draft).toBe(raw);
		expect(draft).toContain("getSolo");
		expect(draft).toContain("schemaVersion: 1");
	});

	it("1 guide with dirName ≠ routing domain surfaces the dirName (self-keyed identity)", async () => {
		await saveRecipe("foo-api", recipe("foo.example", "Foo", "getFoo"));
		const text = contentText(await callLearn("foo.example"));
		expect(text).toContain("Directory: foo");
		// Re-save self-keys off shortName — no "pass the directory name as
		// domain" advice remains.
		expect(text).toContain("self-keyed by shortName");
		expect(text).not.toContain('domain: "foo-api"');
	});

	it("N guides → disambiguation menu by shortName; guide selector resolves", async () => {
		// Two guides claim archive.org (multi-recipe).
		await saveRecipe(
			"archive.org",
			recipe("archive.org", "Archive", "getArchive"),
		);
		await saveRecipe(
			"archive.org-wayback",
			recipe("archive.org", "Wayback", "getWayback"),
		);

		const menu = contentText(await callLearn("archive.org"));
		expect(menu).toContain("2 API guides for 'archive.org'");
		expect(menu).toContain("Archive");
		expect(menu).toContain("Wayback");
		// Menu only — nothing fetched yet.
		expect(menu).not.toContain("Directory:");

		const picked = contentText(
			await callLearn("archive.org", undefined, { guide: "wayback" }),
		);
		expect(picked).toContain("Directory: wayback");
		expect(picked).toContain(stagedDirPath("wayback"));
		// Selected guide's recipe written to the staging path (slug(shortName)).
		const draft = readFileSync(stagedPath("wayback"), "utf-8");
		expect(draft).toContain("getWayback");
		expect(draft).not.toContain("getArchive");
	});

	it("N guides with unknown guide selector → error naming available guides", async () => {
		const res = await callLearn("archive.org", undefined, { guide: "nope" });
		const text = contentText(res);
		expect(text).toContain("No guide named 'nope'");
		expect(text).toContain("Available guides:");
		expect(res.details).toMatchObject({ error: "no_guide_by_shortname" });
	});

	it("new: true → fresh template written to path, existing guides untouched", async () => {
		// archive.org already has 2 guides.
		const text = contentText(
			await callLearn("archive.org", undefined, { new: true }),
		);
		expect(text).toContain(stagedPath("archive.org"));
		const draft = readFileSync(stagedPath("archive.org"), "utf-8");
		expect(draft).toContain("domains: [archive.org]");
		// Template, not an existing recipe.
		expect(draft).not.toContain("getArchive");
		expect(draft).not.toContain("getWayback");
		// Existing guides untouched on disk (keyed by slug(shortName)).
		expect(
			readFileSync(join(tmpGuidesDir, "archive", "guide.md"), "utf-8"),
		).toContain("getArchive");
		expect(
			readFileSync(join(tmpGuidesDir, "wayback", "guide.md"), "utf-8"),
		).toContain("getWayback");
	});
});

describe("api-learn entry-point split", () => {
	it("{domain, new: true} → template staged, manual travels with the pull", async () => {
		const text = contentText(
			await callLearn("split.example", undefined, { new: true }),
		);
		expect(text).toContain(stagedPath("split.example"));
		// The authoring manual is prepended to the template result.
		expect(text).toContain("authoring manual");
		expect(text).toContain("Required fields");
		expect(text).toContain("Executor semantics");
		// Template content lives in the staged file, not the result text.
		const draft = readFileSync(stagedPath("split.example"), "utf-8");
		expect(draft).toContain("domains: [split.example]");
	});
});

describe("api-learn save path (dir)", () => {
	it("save from dir → validates-then-writes guide.md with schemaVersion stamp", async () => {
		const text = contentText(
			await saveRecipe("save.example", recipe("save.example", "Save", "getSave")),
		);
		expect(text).toContain("Guide saved");
		const saved = readFileSync(join(tmpGuidesDir, "save", "guide.md"), "utf-8");
		expect(saved).toContain("getSave");
		expect(saved).toMatch(/^schemaVersion: 1$/m);
	});

	it("slug collision: cmc_full / cmc-full → second save refused with rename-shortName advice", async () => {
		// Both shortNames slug to "cmc-full" — the second save targets the
		// same directory, where the overwrite guard now acts as a slug-collision
		// detector (a different shortName already on disk) and refuses.
		await saveRecipe(
			"cmc-full",
			recipe("coinmarketcap.com", "cmc_full", "getFull"),
		);
		const res = await saveRecipe(
			"cmc-full",
			recipe("coinmarketcap.com", "cmc-full", "getFull"),
		);
		const text = contentText(res);
		expect(text).toContain("Refusing to overwrite");
		expect(text).toContain("NOT saved");
		// Prescriptive guidance: rename the shortName so it slugs distinctly.
		expect(text).toContain("slug collision");
		expect(text).toContain("Rename");
		expect(res.details).toMatchObject({
			error: "overwrite_refused",
			existing: "cmc_full",
			incoming: "cmc-full",
		});
		// First guide untouched on disk.
		const saved = readFileSync(
			join(tmpGuidesDir, "cmc-full", "guide.md"),
			"utf-8",
		);
		expect(saved).toContain("getFull");
	});

	it("empty / all-symbol shortName → save refused with prescriptive error before any write", async () => {
		// Single-quoted YAML so the parser sees a string (bare `!!!` is a YAML
		// tag and fails at parse, not at slug()); both slug to empty.
		for (const bad of ["'!!!'", "''"]) {
			const res = await saveRecipe(
				"bad.example",
				`---\nkind: api\ndomains: [bad.example]\nshortName: ${bad}\napiHost: ${API}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`,
			);
			const text = contentText(res);
			expect(text).toContain("Invalid shortName");
			expect(text).toContain("NOT saved");
			expect(res.details).toMatchObject({ error: "invalid_shortname" });
		}
		// Nothing written.
		expect(() =>
			readFileSync(join(tmpGuidesDir, "bad.example", "guide.md"), "utf-8"),
		).toThrow();
	});

	it("re-save of the same guide lands back in the same folder (self-keying, no ghost)", async () => {
		await saveRecipe("self.example", recipe("self.example", "Self", "getOld"));
		// Re-save the same shortName via a different `domain` arg — the write
		// target is slug(shortName), so it lands in the same folder.
		const res = await saveRecipe(
			"some-other-arg",
			recipe("self.example", "Self", "getNew"),
		);
		expect(contentText(res)).toContain("Guide saved");
		const saved = readFileSync(join(tmpGuidesDir, "self", "guide.md"), "utf-8");
		expect(saved).toContain("getNew");
		expect(saved).not.toContain("getOld");
		// No ghost folder for the other arg.
		expect(() =>
			readFileSync(join(tmpGuidesDir, "some-other-arg", "guide.md"), "utf-8"),
		).toThrow();
	});

	it("same shortName to an existing directory → update proceeds", async () => {
		await saveRecipe(
			"update.example",
			recipe("update.example", "Same", "getOld"),
		);
		const res = await saveRecipe(
			"update.example",
			recipe("update.example", "Same", "getNew"),
		);
		expect(contentText(res)).toContain("Guide saved");
		const saved = readFileSync(join(tmpGuidesDir, "same", "guide.md"), "utf-8");
		expect(saved).toContain("getNew");
	});

	it("missing dir → clear error, guide.md untouched", async () => {
		const res = await callLearn(
			"ghost.example",
			join(tmpStagingRoot, "ghost.example"),
		);
		const text = contentText(res);
		expect(text).toContain("Could not read staged guide");
		expect(text).toContain("NOT saved");
		expect(res.details).toMatchObject({ error: "staged_dir_unreadable" });
		expect(() =>
			readFileSync(join(tmpGuidesDir, "ghost.example", "guide.md"), "utf-8"),
		).toThrow();
	});

	it("inline `recipe` param is no longer a parameter (YAGNI removal)", () => {
		const props =
			(apiLearnTool.parameters as { properties?: Record<string, unknown> })
				.properties ?? {};
		expect(props.recipe).toBeUndefined();
		expect(props.recipeFile).toBeUndefined();
		expect(props.dir).toBeDefined();
	});

	it("path-traversal domain still rejected by assertSafeDomain", async () => {
		const res = await callLearn("../../escape", stagedDirPath("../../escape"));
		const text = contentText(res);
		expect(text).toContain("Invalid domain");
		expect(res.details).toMatchObject({
			error: "invalid_domain",
			domain: "../../escape",
		});
	});
});

describe("api-learn TUI rendering", () => {
	it("renderCall shows the 📝 icon for a dir-bearing save call", () => {
		const out = apiLearnTool.renderCall!(
			{ domain: "save.example", dir: stagedDirPath("save.example") },
			mockTheme,
			undefined as any,
		);
		expect((out as unknown as { text: string }).text).toContain("📝");
		expect((out as unknown as { text: string }).text).not.toContain("📖");
	});

	it("renderCall shows the 📖 icon for a fetch-recipe call", () => {
		const out = apiLearnTool.renderCall!(
			{ domain: "solo.example" },
			mockTheme,
			undefined as any,
		);
		expect((out as unknown as { text: string }).text).toContain("📖");
		expect((out as unknown as { text: string }).text).not.toContain("📝");
	});
});
