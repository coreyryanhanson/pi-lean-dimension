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
 *  - Save from `recipeFile` → validates-then-writes `guide.md`; the
 *    `schemaVersion` stamp lands on `guide.md`.
 *  - Missing `recipeFile` → clear error, `guide.md` untouched.
 *  - Inline `recipe` param is no longer a parameter (YAGNI removal).
 *  - Path-traversal domain still rejected by `assertSafeDomain`.
 *  - TUI rendering — `renderCall` shows the 📝 icon for a `recipeFile`-
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

/** Staged draft path for a domain (mirrors api-learn's stagingPathFor). */
function stagedPath(domain: string): string {
	return join(tmpStagingRoot, domain, "guide.md");
}

/** Save a recipe by staging it to the draft file, then calling with recipeFile. */
function saveRecipe(domain: string, recipe: string) {
	mkdirSync(join(tmpStagingRoot, domain), { recursive: true });
	writeFileSync(stagedPath(domain), recipe, "utf-8");
	return apiLearnTool.execute(
		"test",
		{ domain, recipeFile: stagedPath(domain) },
		undefined,
		undefined,
		undefined as any,
	);
}

function callLearn(
	domain: string,
	recipeFile?: string,
	extra?: { new?: boolean; guide?: string },
) {
	const p: Record<string, unknown> = { domain };
	if (recipeFile !== undefined) p.recipeFile = recipeFile;
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
		// Placeholders, not another API's real values (gap 1).
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
		expect(text).toContain("Directory: solo.example");
		expect(text).toContain(stagedPath("solo.example"));
		expect(text).toContain("edit the staged file");
		// The authoring manual travels with the staged raw recipe.
		expect(text).toContain("authoring manual");
		// Draft contents equal the saved raw recipe (incl. schemaVersion stamp).
		const raw = readFileSync(
			join(tmpGuidesDir, "solo.example", "guide.md"),
			"utf-8",
		);
		const draft = readFileSync(stagedPath("solo.example"), "utf-8");
		expect(draft).toBe(raw);
		expect(draft).toContain("getSolo");
		expect(draft).toContain("schemaVersion: 0");
	});

	it("1 guide with dirName ≠ routing domain surfaces the dirName (sibling-clobber guard)", async () => {
		await saveRecipe("foo-api", recipe("foo.example", "Foo", "getFoo"));
		const text = contentText(await callLearn("foo.example"));
		expect(text).toContain("Directory: foo-api");
		expect(text).toContain('api-learn({domain: "foo-api", recipeFile:');
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
		expect(picked).toContain("Directory: archive.org-wayback");
		expect(picked).toContain(stagedPath("archive.org"));
		// Selected guide's recipe written to the staging path.
		const draft = readFileSync(stagedPath("archive.org"), "utf-8");
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
		// Existing guides untouched on disk.
		expect(
			readFileSync(join(tmpGuidesDir, "archive.org", "guide.md"), "utf-8"),
		).toContain("getArchive");
		expect(
			readFileSync(join(tmpGuidesDir, "archive.org-wayback", "guide.md"), "utf-8"),
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

describe("api-learn save path (recipeFile)", () => {
	it("save from recipeFile → validates-then-writes guide.md with schemaVersion stamp", async () => {
		const text = contentText(
			await saveRecipe("save.example", recipe("save.example", "Save", "getSave")),
		);
		expect(text).toContain("Guide saved");
		const saved = readFileSync(
			join(tmpGuidesDir, "save.example", "guide.md"),
			"utf-8",
		);
		expect(saved).toContain("getSave");
		expect(saved).toMatch(/^schemaVersion: 0$/m);
	});

	it("missing recipeFile → clear error, guide.md untouched", async () => {
		const res = await callLearn(
			"ghost.example",
			join(tmpStagingRoot, "ghost.example", "guide.md"),
		);
		const text = contentText(res);
		expect(text).toContain("Could not read recipe file");
		expect(text).toContain("NOT saved");
		expect(res.details).toMatchObject({ error: "recipe_file_unreadable" });
		expect(() =>
			readFileSync(join(tmpGuidesDir, "ghost.example", "guide.md"), "utf-8"),
		).toThrow();
	});

	it("inline `recipe` param is no longer a parameter (YAGNI removal)", () => {
		const props =
			(apiLearnTool.parameters as { properties?: Record<string, unknown> })
				.properties ?? {};
		expect(props.recipe).toBeUndefined();
		expect(props.recipeFile).toBeDefined();
	});

	it("path-traversal domain still rejected by assertSafeDomain", async () => {
		const res = await callLearn("../../escape", stagedPath("../../escape"));
		const text = contentText(res);
		expect(text).toContain("Invalid domain");
		expect(res.details).toMatchObject({
			error: "invalid_domain",
			domain: "../../escape",
		});
	});
});

describe("api-learn TUI rendering", () => {
	it("renderCall shows the 📝 icon for a recipeFile-bearing save call", () => {
		const out = apiLearnTool.renderCall!(
			{ domain: "save.example", recipeFile: stagedPath("save.example") },
			mockTheme,
			undefined as any,
		);
		expect(out.text).toContain("📝");
		expect(out.text).not.toContain("📖");
	});

	it("renderCall shows the 📖 icon for a fetch-recipe call", () => {
		const out = apiLearnTool.renderCall!(
			{ domain: "solo.example" },
			mockTheme,
			undefined as any,
		);
		expect(out.text).toContain("📖");
		expect(out.text).not.toContain("📝");
	});
});
