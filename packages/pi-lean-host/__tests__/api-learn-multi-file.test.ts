/**
 * api-learn multi-file staging + mirror-save + helper-validation structural
 * tests (mocked-fs, no network).
 *
 * Covers the api-learn multi-file staging / mirror-save / helper-validation cases:
 *  - fetch-recipe stages all siblings (guide.md + helper + verify.json)
 *  - directory-path save ({domain, dir}) reads + mirrors present files
 *  - mirror-save present → overwrite
 *  - mirror-save absent → deletion-safety gate refuses without
 *    confirmDeletions; re-call confirms, deletes, and surfaces the deletion
 *  - deletion gate does NOT fire on the common path (all siblings staged)
 *  - guide declares helper/transform but no staged helper → refuse
 *  - no declaration → no helper check (saves fine)
 *  - staged helper that won't load (syntax error) → refuse
 *  - staged helper missing a declared export (default / transform) → refuse
 *  - verify.json written as-is (no save-time JSON validation)
 *  - non-existent dir → clear error, guides dir untouched
 * Edge cases: no siblings; new:true over existing (distinct + same shortName);
 * path-traversal domain.
 *
 * No network — recipes use a dummy https apiHost; the save path only reads
 * the staged dir + writes. Structural only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	existsSync,
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

let tmpGuidesDir: string;
let tmpStagingRoot: string;

beforeAll(() => {
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-learn-multi-"));
	setUserGuidesDir(tmpGuidesDir);
	tmpStagingRoot = mkdtempSync(join(tmpdir(), "host-learn-multi-staging-"));
	setStagingRoot(tmpStagingRoot);
	invalidateCache();
});

afterAll(() => {
	rmSync(tmpGuidesDir, { recursive: true, force: true });
	rmSync(tmpStagingRoot, { recursive: true, force: true });
});

const API = "https://api.example.com";

/** A one-op recipe; optionally declares helper / transform usage. */
function recipe(
	domain: string,
	shortName: string,
	opts?: { helper?: boolean; transform?: boolean },
): string {
	return `---
kind: api
domains: [${domain}]
shortName: ${shortName}
apiHost: ${API}
operations:
  - name: get
    via: restGet
    path: /items/{id}
    accept: json
${opts?.helper ? "    helper: true" : ""}${opts?.helper ? "\n" : ""}${opts?.transform ? "    transform: true\n" : ""}    params:
      id:
        description: item id
---
`;
}

function dirFor(shortName: string): string {
	return join(tmpGuidesDir, shortName.toLowerCase());
}

/** Write guide.md (and optional siblings) directly into the guides dir. */
function writeGuide(shortName: string, domain: string, src: string): void {
	const d = dirFor(shortName);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "guide.md"), src, "utf-8");
	invalidateCache();
}

/** Staged dir path (what save takes as `dir`). */
function stagedDirPath(domain: string): string {
	return join(tmpStagingRoot, domain);
}

/** Stage a recipe (guide.md only) into the staged dir; returns the dir path. */
function stageRecipe(domain: string, src: string): string {
	const dir = stagedDirPath(domain);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), src, "utf-8");
	return dir;
}

/** Stage a helper.mjs into the staged dir. */
function stageHelper(domain: string, content: string): void {
	const dir = stagedDirPath(domain);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "helper.mjs"), content, "utf-8");
}

function callLearn(p: Record<string, unknown>) {
	return apiLearnTool.execute("test", p, undefined, undefined, undefined as any);
}

const DEFAULT_EXPORT = `export default function(params, ctx) {
  return { ...params, _done: true };
}
`;
const TRANSFORM_ONLY = `export function transform(data, ctx) {
  return data;
}
`;
const SYNTAX_ERROR = `export default function(params, ctx) {
  return { ...params, broken: ;
}
`;

describe("api-learn multi-file staging + save", () => {
	it("fetch-recipe stages all present siblings (guide.md + helper + verify.json)", async () => {
		writeGuide(
			"Sib",
			"sib.example",
			recipe("sib.example", "Sib", { helper: true }),
		);
		writeFileSync(join(dirFor("Sib"), "helper.mjs"), DEFAULT_EXPORT, "utf-8");
		writeFileSync(
			join(dirFor("Sib"), "verify.json"),
			'{"get": {"id": "real-1"}}',
			"utf-8",
		);
		invalidateCache();

		const text = contentText(await callLearn({ domain: "sib.example" }));
		expect(text).toContain(stagedDirPath("sib"));
		expect(text).toContain("Siblings staged: helper.mjs, verify.json");

		// All three files landed in the staged dir with matching content.
		expect(
			readFileSync(join(stagedDirPath("sib"), "guide.md"), "utf-8"),
		).toContain("get");
		expect(readFileSync(join(stagedDirPath("sib"), "helper.mjs"), "utf-8")).toBe(
			DEFAULT_EXPORT,
		);
		expect(readFileSync(join(stagedDirPath("sib"), "verify.json"), "utf-8")).toBe(
			'{"get": {"id": "real-1"}}',
		);
	});

	it("edge: no siblings → fetch stages only guide.md", async () => {
		writeGuide("Solo", "solo2.example", recipe("solo2.example", "Solo"));
		const text = contentText(await callLearn({ domain: "solo2.example" }));
		expect(text).not.toContain("Siblings staged");
		// Fetch keys the staged dir by slug(shortName) = "solo".
		expect(existsSync(join(stagedDirPath("solo"), "helper.mjs"))).toBe(false);
		expect(existsSync(join(stagedDirPath("solo"), "verify.json"))).toBe(false);
		expect(existsSync(join(stagedDirPath("solo"), "guide.md"))).toBe(true);
	});

	it("directory-path save reads + mirrors all present files", async () => {
		const dir = stageRecipe("mirror.example", recipe("mirror.example", "Mirror"));
		stageHelper("mirror.example", DEFAULT_EXPORT);
		writeFileSync(join(dir, "verify.json"), '{"get": {"id": "x"}}', "utf-8");
		const res = await callLearn({ domain: "mirror.example", dir });
		const text = contentText(res);
		expect(text).toContain("Guide saved");
		expect(text).toContain("Written: helper.mjs, verify.json");
		expect(readFileSync(join(dirFor("Mirror"), "helper.mjs"), "utf-8")).toBe(
			DEFAULT_EXPORT,
		);
		expect(readFileSync(join(dirFor("Mirror"), "verify.json"), "utf-8")).toBe(
			'{"get": {"id": "x"}}',
		);
	});

	it("mirror-save present → overwrites the guides-dir counterpart", async () => {
		// Guides dir already has a helper with old content.
		writeGuide("Ov", "ov2.example", recipe("ov2.example", "Ov"));
		writeFileSync(join(dirFor("Ov"), "helper.mjs"), "// old\n", "utf-8");

		const dir = stageRecipe("ov2.example", recipe("ov2.example", "Ov"));
		stageHelper("ov2.example", "// new\n");
		await callLearn({ domain: "ov2.example", dir });
		expect(readFileSync(join(dirFor("Ov"), "helper.mjs"), "utf-8")).toBe(
			"// new\n",
		);
	});

	it("mirror-save absent → gate refuses without confirmDeletions; re-call confirms", async () => {
		// Guides dir has a helper; staged dir does not.
		writeGuide("Gate", "gate.example", recipe("gate.example", "Gate"));
		writeFileSync(join(dirFor("Gate"), "helper.mjs"), "// exists\n", "utf-8");

		const dir = stageRecipe("gate.example", recipe("gate.example", "Gate"));
		const refused = await callLearn({ domain: "gate.example", dir });
		const refText = contentText(refused);
		expect(refused.details).toMatchObject({
			error: "deletion_refused",
			doomed: ["helper.mjs"],
		});
		expect(refText).toContain("Save refused");
		expect(refText).toContain("helper.mjs");
		expect(refText).toContain("confirmDeletions: true");
		// Nothing written or deleted.
		expect(readFileSync(join(dirFor("Gate"), "helper.mjs"), "utf-8")).toBe(
			"// exists\n",
		);

		const confirmed = await callLearn({
			domain: "gate.example",
			dir,
			confirmDeletions: true,
		});
		expect(contentText(confirmed)).toContain("Guide saved");
		expect(contentText(confirmed)).toContain("Deleted: helper.mjs");
		expect(existsSync(join(dirFor("Gate"), "helper.mjs"))).toBe(false);
	});

	it("deletion gate does NOT fire on the common path (all siblings staged)", async () => {
		writeGuide("Common", "common.example", recipe("common.example", "Common"));
		writeFileSync(join(dirFor("Common"), "helper.mjs"), "// h\n", "utf-8");

		// fetch → stages all siblings.
		await callLearn({ domain: "common.example" });
		const stagedDir = stagedDirPath("common");
		expect(existsSync(join(stagedDir, "helper.mjs"))).toBe(true);

		// edit + save from the fetched staged dir → no gate.
		const res = await callLearn({ domain: "common.example", dir: stagedDir });
		expect(contentText(res)).toContain("Guide saved");
		expect(contentText(res)).not.toContain("save refused");
	});

	it("non-existent dir → clear error, guides dir untouched", async () => {
		const res = await callLearn({
			domain: "ghost.example",
			dir: join(tmpStagingRoot, "ghost.example"),
		});
		const text = contentText(res);
		expect(res.details).toMatchObject({ error: "staged_dir_unreadable" });
		expect(text).toContain("Could not read staged guide");
		expect(text).toContain("NOT saved");
		expect(existsSync(dirFor("Ghost"))).toBe(false);
	});

	it("verify.json written as-is (no save-time JSON validation)", async () => {
		const dir = stageRecipe("raw.example", recipe("raw.example", "Raw"));
		// Malformed JSON — must be written verbatim, not rejected.
		writeFileSync(join(dir, "verify.json"), "{ not valid json", "utf-8");
		const res = await callLearn({ domain: "raw.example", dir });
		expect(contentText(res)).toContain("Guide saved");
		expect(readFileSync(join(dirFor("Raw"), "verify.json"), "utf-8")).toBe(
			"{ not valid json",
		);
	});

	it("path-traversal domain → assertSafeDomain rejects before any write", async () => {
		const res = await callLearn({
			domain: "../../escape",
			dir: stagedDirPath("../../escape"),
		});
		expect(contentText(res)).toContain("Invalid domain");
		expect(res.details).toMatchObject({ error: "invalid_domain" });
	});
});

describe("api-learn save-time helper validation", () => {
	it("declaration + absent staged helper → refuse, offers scaffold-or-drop", async () => {
		const dir = stageRecipe(
			"decl.example",
			recipe("decl.example", "Decl", { helper: true }),
		);
		const res = await callLearn({ domain: "decl.example", dir });
		const text = contentText(res);
		expect(res.details).toMatchObject({
			error: "helper_declared_missing_staged",
		});
		expect(text).toContain("Save refused");
		expect(text).toContain("helper: true");
		expect(text).toContain("api-scaffold");
		// Nothing written.
		expect(existsSync(dirFor("Decl"))).toBe(false);
	});

	it("no declaration → no helper check (saves fine with no staged helper)", async () => {
		const dir = stageRecipe("nodecl.example", recipe("nodecl.example", "Nodecl"));
		const res = await callLearn({ domain: "nodecl.example", dir });
		expect(contentText(res)).toContain("Guide saved");
		// No helper written.
		expect(existsSync(join(dirFor("Nodecl"), "helper.mjs"))).toBe(false);
	});

	it("staged helper that won't load (syntax error) → refuse", async () => {
		const dir = stageRecipe(
			"syn.example",
			recipe("syn.example", "Syn", { helper: true }),
		);
		stageHelper("syn.example", SYNTAX_ERROR);
		const res = await callLearn({ domain: "syn.example", dir });
		const text = contentText(res);
		expect(res.details).toMatchObject({ error: "helper_load_failed" });
		expect(text).toContain("failed to load");
		expect(existsSync(dirFor("Syn"))).toBe(false);
	});

	it("helper: true but staged helper has no default export → refuse", async () => {
		const dir = stageRecipe(
			"nodefault.example",
			recipe("nodefault.example", "Nodefault", { helper: true }),
		);
		stageHelper("nodefault.example", TRANSFORM_ONLY);
		const res = await callLearn({ domain: "nodefault.example", dir });
		const text = contentText(res);
		expect(res.details).toMatchObject({
			error: "helper_missing_default_export",
		});
		expect(text).toContain("no default export");
		expect(existsSync(dirFor("Nodefault"))).toBe(false);
	});

	it("transform: true but staged helper has no transform export → refuse", async () => {
		const dir = stageRecipe(
			"notransform.example",
			recipe("notransform.example", "Notransform", { transform: true }),
		);
		stageHelper("notransform.example", DEFAULT_EXPORT);
		const res = await callLearn({ domain: "notransform.example", dir });
		const text = contentText(res);
		expect(res.details).toMatchObject({
			error: "helper_missing_transform_export",
		});
		expect(text).toContain("no transform export");
		expect(existsSync(dirFor("Notransform"))).toBe(false);
	});

	it("satisfied declaration (helper + transform) → saves fine", async () => {
		const dir = stageRecipe(
			"both2.example",
			recipe("both2.example", "Both2", { helper: true, transform: true }),
		);
		stageHelper(
			"both2.example",
			DEFAULT_EXPORT +
				`\nexport function transform(data, ctx) {\n  return data;\n}\n`,
		);
		const res = await callLearn({ domain: "both2.example", dir });
		expect(contentText(res)).toContain("Guide saved");
	});
});

describe("api-learn new:true over existing directories", () => {
	it("distinct shortName → own dir; existing guide + siblings untouched", async () => {
		// Existing guide "Old" (folder old/) with a helper.
		writeGuide(
			"Old",
			"newdistinct.example",
			recipe("newdistinct.example", "Old"),
		);
		writeFileSync(join(dirFor("Old"), "helper.mjs"), "// keep\n", "utf-8");

		// Author a NEW guide (new:true → template) with a distinct shortName.
		const dir = stageRecipe(
			"newdistinct.example",
			recipe("newdistinct.example", "Brandnew"),
		);
		const res = await callLearn({ domain: "newdistinct.example", dir });
		expect(contentText(res)).toContain("Guide saved");
		// New guide in its own folder; old guide + helper untouched.
		expect(existsSync(join(dirFor("Brandnew"), "guide.md"))).toBe(true);
		expect(readFileSync(join(dirFor("Old"), "helper.mjs"), "utf-8")).toBe(
			"// keep\n",
		);
	});

	it("same shortName → deletion gate refuses; confirmDeletions proceeds", async () => {
		// Existing guide "Same" (folder same/) with a helper.
		writeGuide("Same", "newsame.example", recipe("newsame.example", "Same"));
		writeFileSync(join(dirFor("Same"), "helper.mjs"), "// doomed\n", "utf-8");

		// new:true template reuses shortName "Same" → self-keyed target is the
		// existing same/ folder; the unstaged helper would be wiped → gate.
		const dir = stageRecipe("newsame.example", recipe("newsame.example", "Same"));
		const refused = await callLearn({ domain: "newsame.example", dir });
		expect(refused.details).toMatchObject({
			error: "deletion_refused",
			doomed: ["helper.mjs"],
		});

		const confirmed = await callLearn({
			domain: "newsame.example",
			dir,
			confirmDeletions: true,
		});
		expect(contentText(confirmed)).toContain("Guide saved");
		expect(existsSync(join(dirFor("Same"), "helper.mjs"))).toBe(false);
	});
});
