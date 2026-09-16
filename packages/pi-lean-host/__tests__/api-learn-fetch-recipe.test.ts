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
 *  - Write-path behaviour (validation refusals, collision warnings,
 *    stamping, authoring manual) — moved here from tools.test.ts.
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
import {
	apiLearnTool,
	OAUTH2_CC_EXAMPLE,
	OAUTH2_AC_EXAMPLE,
} from "../tools/api-learn.js";
import { setStagingRoot } from "../core/staging.js";
import { contentText } from "../tools/utils.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { parseApiGuide } from "../core/parse-api-guide.js";
import { mockTheme } from "./test-utils.js";

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
schemaVersion: 1
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
		// The prose-body (agent-instructions) ability is surfaced, not lost.
		expect(draft).toContain("agent-instruction prose");
		expect(draft).toContain("the closing ---");
		// Fail-closed: the as-is template cannot save (placeholder apiHost
		// is rejected by requireHttpUrl).
		expect(parseApiGuide(draft, { filename: "fresh.example" }).ok).toBe(false);
		// oauth2 shape taught in the template (commented authorization_code block).
		expect(draft).toContain("grant: authorization_code");
		expect(draft).toContain("authorizeUrl");
	});

	it("worked oauth2 manual examples parse as-is", () => {
		for (const ex of [OAUTH2_CC_EXAMPLE, OAUTH2_AC_EXAMPLE]) {
			// Dedent the 4-space manual indent to top-level YAML.
			const auth = ex.replace(/^ {4}/gm, "");
			const raw = `---\nkind: api\nschemaVersion: 1\ndomains: [example.com]\napiHost: https://api.example.com\nshortName: ex\n${auth}\noperations:\n  - name: list\n    via: restGet\n    path: /items\n---\n`;
			const res = parseApiGuide(raw, { filename: "example.com" });
			if (!res.ok) {
				throw new Error(
					`worked oauth2 example failed to parse: ${res.error.field} — ${res.error.expected} (found: ${res.error.found})`,
				);
			}
			expect(res.guide.auth.kind).toBe("oauth2");
		}
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

	it("slug collision: api_dev_full / api-dev-full → second save refused with rename-shortName advice", async () => {
		// Both shortNames slug to "api-dev-full" — the second save targets the
		// same directory, where the overwrite guard now acts as a slug-collision
		// detector (a different shortName already on disk) and refuses.
		await saveRecipe(
			"api-dev-full",
			recipe("example.dev", "api_dev_full", "getFull"),
		);
		const res = await saveRecipe(
			"api-dev-full",
			recipe("example.dev", "api-dev-full", "getFull"),
		);
		const text = contentText(res);
		expect(text).toContain("Refusing to overwrite");
		expect(text).toContain("NOT saved");
		// Prescriptive guidance: rename the shortName so it slugs distinctly.
		expect(text).toContain("slug collision");
		expect(text).toContain("Rename");
		expect(res.details).toMatchObject({
			error: "overwrite_refused",
			existing: "api_dev_full",
			incoming: "api-dev-full",
		});
		// First guide untouched on disk.
		const saved = readFileSync(
			join(tmpGuidesDir, "api-dev-full", "guide.md"),
			"utf-8",
		);
		expect(saved).toContain("getFull");
	});

	it("stale guide.md on disk → save refused (overwrite guard parses it first)", async () => {
		// A pre-v1 guide fails the schemaVersion hard gate, so the overwrite
		// guard sees it as unparseable and refuses — even for a same-shortName
		// update. The only recovery is /api delete, never a re-save.
		const dir = join(tmpGuidesDir, "stale-guard");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "guide.md"),
			recipe("stale.example", "Stale Guard", "getOld").replace(
				"schemaVersion: 1",
				"schemaVersion: 0",
			),
			"utf-8",
		);
		const res = await saveRecipe(
			"stale.example",
			recipe("stale.example", "Stale Guard", "getNew"),
		);
		const text = contentText(res);
		expect(text).toContain("Refusing to overwrite");
		expect(text).toContain("NOT saved");
		expect(text).toContain("won't parse");
		expect(text).toContain("/api delete stale-guard");
		expect(res.details).toMatchObject({
			error: "overwrite_refused",
			existing: null,
			incoming: "Stale Guard",
		});
		// The stale guide is untouched on disk.
		const onDisk = readFileSync(join(dir, "guide.md"), "utf-8");
		expect(onDisk).toContain("getOld");
		expect(onDisk).toMatch(/^schemaVersion: 0$/m);
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

// ═════════════════════════════════════════════════════════════════
// api-learn — validate, write, no-half-write, example
// (moved from tools.test.ts; recipes use the dummy API host — no network)
// ═════════════════════════════════════════════════════════════════

/** An invalid recipe (missing leading / in path). */
const INVALID_RECIPE = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: things/{id}
---
body
`;

describe("api-learn", () => {
	it("prepends the authoring manual to template and fetch-recipe pulls", async () => {
		// Template path ({domain, new: true}) — the manual travels with the
		// staged draft.
		const templateText = contentText(
			await callLearn("example.com", undefined, { new: true }),
		);
		// Fetch-existing path ({domain}, no dir) — the manual travels
		// with the staged raw recipe.
		await saveRecipe("boe.es", recipe("boe.es", "BOE", "searchDiary"));
		invalidateCache();
		const fetchText = contentText(await callLearn("boe.es"));
		for (const text of [templateText, fetchText]) {
			expect(text).toContain("authoring manual");
			// Field reference + defaults + semantics stay.
			expect(text).toContain("Required fields");
			expect(text).toContain("a LIST of operation mappings");
			expect(text).toContain("Key defaults");
			expect(text).toContain("Executor semantics");
			expect(text).toContain("joinUrl` strips a leading `/");
			expect(text).toContain("pagination.base` seeds the page param");
			expect(text).toContain("Page-size resolution (offset-limit/page)");
			expect(text).toContain("→ omit (server default applies)");
			expect(text).toContain("optional: true` on a ref");
			// Guide-prose (agent-instructions) ability is taught, not lost.
			expect(text).toContain("Guide prose");
			expect(text).toContain("Guide notes");
			// Points at the template entry point; no recipe body.
			expect(text).toContain("new: true");
			expect(text).not.toContain("searchDiary");
			expect(text).not.toContain("```yaml");
		}
	});

	it("validates and writes a valid recipe", async () => {
		const text = contentText(
			await saveRecipe("boe.es", recipe("boe.es", "BOE", "searchDiary")),
		);
		expect(text).toContain("Guide saved");
		expect(text).toContain("boe.es");
		expect(text).toContain("searchDiary");
		expect(text).toContain("api-fetch");

		const filepath = join(tmpGuidesDir, "boe", "guide.md");
		const content = readFileSync(filepath, "utf-8");
		expect(content).toContain("apiHost:");
	});

	// Companion — save summary echoes the resolved auth mapping (names only,
	// never values): wrong-shape is loud, right-shape-but-wrong-name
	// is eyeballable at save.
	it("save summary names the auth header→secret mapping, never values", async () => {
		const recipeText = `---\nkind: api\ndomains: [authmap.example]\nshortName: AuthMap\napiHost: ${API}\nauth:\n  kind: static-key\n  secretRefs:\n    Authorization:\n      secret: apiKey\n      prefix: "Bearer "\n    X-Example-Pro-Key:\n      secret: example_key\n      prefix: ""\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		const text = contentText(await saveRecipe("authmap.example", recipeText));
		expect(text).toContain("Auth: static-key");
		expect(text).toContain("Authorization ← secret apiKey (Bearer )");
		expect(text).toContain("X-Example-Pro-Key ← secret example_key");
		// Empty prefix (bare-key header) renders without an empty paren.
		expect(text).not.toContain("example_key ()");
		// Names only — never the store values.
		expect(text).not.toContain("s3cr3t");
	});

	it("rejects an invalid recipe without writing", async () => {
		const text = contentText(await saveRecipe("broken", INVALID_RECIPE));
		expect(text).toContain("Validation error");
		expect(text).toContain("operations[0].path");
		expect(text).toContain("NOT saved");

		const filepath = join(tmpGuidesDir, "broken", "guide.md");
		expect(() => readFileSync(filepath, "utf-8")).toThrow();
	});

	// A validation failure names the failing field with expected/found and
	// never writes. The manual-pointer tail is gone — the author already saw
	// the manual on the pull that staged the draft.
	it("reports validation failures with field/expected/found and does not save", async () => {
		// Wrong-auth shape: name/secret fields instead of secretRefs/headerPrefixes.
		const authText = contentText(
			await saveRecipe(
				"authbad.example",
				`---\nschemaVersion: 1\ndomains: [authbad.example]\napiHost: https://api.example.com\nauth:\n  kind: static-key\n  name: X-EXAMPLE_PRO_API_KEY\n  secret: api_key\noperations:\n  - name: get\n    via: restGet\n    path: /things\n---\n`,
			),
		);
		expect(authText).toContain("auth.name");
		expect(authText).toContain("NOT saved");

		// Bad via.
		const viaText = contentText(
			await saveRecipe(
				"viabad.example",
				`---\nschemaVersion: 1\ndomains: [viabad.example]\napiHost: https://api.example.com\noperations:\n  - name: get\n    via: post\n    path: /things\n---\n`,
			),
		);
		expect(viaText).toContain("operations[0].via");
		expect(viaText).toContain("NOT saved");

		// Unmapped field (frontmatter).
		const fmText = contentText(await saveRecipe("fmbad.example", "just prose"));
		expect(fmText).toContain("frontmatter");
		expect(fmText).toContain("NOT saved");
	});

	it("rejects a description over 200 chars without writing", async () => {
		// Strict-on-write: the parser accepts any length (lenient-on-read),
		// but api-learn rejects >200 before writing.
		const longDesc = "x".repeat(201);
		const long = `---\nschemaVersion: 1\nkind: api\ndomains: [toolong.example]\ndescription: ${longDesc}\napiHost: ${API}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		const result = await saveRecipe("toolong.example", long);
		const text = contentText(result);
		expect(text).toContain("NOT saved");
		expect(text).toContain("description");
		expect(text).toContain("201");
		expect(result.details).toMatchObject({ error: "description_too_long" });
		expect(() =>
			readFileSync(join(tmpGuidesDir, "toolong-example", "guide.md"), "utf-8"),
		).toThrow();
	});

	it("accepts a description at exactly 200 chars", async () => {
		const desc = "x".repeat(200);
		const boundary = `---\nschemaVersion: 1\nkind: api\ndomains: [boundary.example]\ndescription: ${desc}\napiHost: ${API}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		const text = contentText(await saveRecipe("boundary.example", boundary));
		expect(text).toContain("Guide saved");
	});

	it("warns (does not reject) when domains collide with another guide", async () => {
		// Two guides, same `domains:` key, different directories. Valid — that's
		// the multi-recipe point. The write succeeds with a warning.
		const first = `---\nschemaVersion: 1\nkind: api\ndomains: [collide.example]\norganization: collide.org\ndescription: First surface.\nshortName: First\napiHost: ${API}\noperations:\n  - name: getFirst\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		const second = `---\nschemaVersion: 1\nkind: api\ndomains: [collide.example]\norganization: collide.org\ndescription: Second surface.\nshortName: Second\napiHost: ${API}\noperations:\n  - name: getSecond\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		const firstText = contentText(await saveRecipe("collide-first", first));
		expect(firstText).toContain("Guide saved");
		expect(firstText).not.toContain("Multi-recipe");
		invalidateCache();
		const secondText = contentText(await saveRecipe("collide-second", second));
		expect(secondText).toContain("Guide saved");
		expect(secondText).toContain("Multi-recipe");
		// The collision warning renders the slug (slug("Second") = "second"),
		// not the `domain` arg "collide-second".
		expect(secondText).toContain("writing to directory `second`");
		expect(secondText).toContain("collide.example");
	});

	it("warns about a missing description when colliding", async () => {
		// When the second guide collides and omits description:, api-learn
		// recommends adding one (the primary disambiguation signal).
		const first = `---\nschemaVersion: 1\nkind: api\ndomains: [nodesc.example]\norganization: nodesc.org\ndescription: First surface.\nshortName: First\napiHost: ${API}\noperations:\n  - name: getFirst\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		const second = `---\nschemaVersion: 1\nkind: api\ndomains: [nodesc.example]\norganization: nodesc.org\nshortName: Second\napiHost: ${API}\noperations:\n  - name: getSecond\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		await saveRecipe("nodesc-first", first);
		invalidateCache();
		const text = contentText(await saveRecipe("nodesc-second", second));
		expect(text).toContain("Guide saved");
		expect(text).toContain("Multi-recipe");
		expect(text).toContain("description");
		expect(text).toContain("recommended");
	});

	it("collision warning names /api delete as the recovery gesture", async () => {
		// The agent has no delete tool — when an existing guide is wrong, the
		// collision warning must point at the human-typed /api delete command,
		// naming the colliding directory (the one to remove).
		const first = `---\nschemaVersion: 1\nkind: api\ndomains: [recover.example]\norganization: recover.org\nshortName: First\napiHost: ${API}\noperations:\n  - name: getFirst\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		const second = `---\nschemaVersion: 1\nkind: api\ndomains: [recover.example]\norganization: recover.org\nshortName: Second\napiHost: ${API}\noperations:\n  - name: getSecond\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		await saveRecipe("recover-first", first);
		invalidateCache();
		const text = contentText(await saveRecipe("recover-second", second));
		expect(text).toContain("Multi-recipe");
		// The existing guide's dirName is slug(shortName) = "first".
		expect(text).toContain("/api delete first");
		expect(text).toContain("the agent has no delete tool");
	});

	it("does not warn when updating the same guide's own directory", async () => {
		// Updating `foo.example` when `foo.example` already claims the domain is
		// not a collision — same dirName. No warning.
		const r1 = `---\nschemaVersion: 1\nkind: api\ndomains: [solo.example]\nshortName: Solo\napiHost: ${API}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		const r2 = r1.replace("name: get\n", "name: getMore\n");
		await saveRecipe("solo.example", r1);
		invalidateCache();
		const text = contentText(await saveRecipe("solo.example", r2));
		expect(text).toContain("Guide saved");
		expect(text).not.toContain("Multi-recipe");
	});

	// The template is the docs-side discoverability: no hardcoded
	// updated/verified dates (the tool stamps them when omitted) and a
	// static-key auth block to crib from.
	it("template has no hardcoded updated/verified dates", async () => {
		const text = contentText(
			await callLearn("example.com", undefined, { new: true }),
		);
		expect(text).toContain(stagedPath("example.com"));
		const example = readFileSync(stagedPath("example.com"), "utf-8");
		expect(example).not.toMatch(/^updated:/m);
		expect(example).not.toMatch(/^verified:/m);
		expect(example).toContain("stamped by the tool when omitted");
	});

	it("template documents the static-key auth block", async () => {
		const text = contentText(
			await callLearn("example.com", undefined, { new: true }),
		);
		expect(text).toContain(stagedPath("example.com"));
		const example = readFileSync(stagedPath("example.com"), "utf-8");
		expect(example).toContain("kind: static-key");
		expect(example).toContain("secret: <secret-name>");
		expect(example).toContain("secretRefs:");
		expect(example).toContain('prefix: "Bearer "');
	});

	it("replaces an explicit divergent schemaVersion on save", async () => {
		const stampReplace = `---\nkind: api\nschemaVersion: 5\ndomains: [stamp-replace.example]\nshortName: StampReplace\napiHost: ${API}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		await saveRecipe("stamp-replace.example", stampReplace);
		const raw = readFileSync(
			join(tmpGuidesDir, "stampreplace", "guide.md"),
			"utf-8",
		);
		expect(raw).toMatch(/^schemaVersion: 1$/m);
		expect(raw).not.toMatch(/^schemaVersion: 5$/m);
	});

	it("never touches a schemaVersion string in the prose body", async () => {
		const stampProse = `---\nkind: api\ndomains: [stamp-prose.example]\nshortName: StampProse\napiHost: ${API}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\nThe schemaVersion: 5 in this prose must stay untouched.\n`;
		await saveRecipe("stamp-prose.example", stampProse);
		const raw = readFileSync(
			join(tmpGuidesDir, "stampprose", "guide.md"),
			"utf-8",
		);
		// Frontmatter got the stamp...
		expect(raw).toMatch(/^schemaVersion: 1$/m);
		// ...and the prose line is untouched (still schemaVersion: 5).
		expect(raw).toContain(
			"The schemaVersion: 5 in this prose must stay untouched.",
		);
	});

	it("preserves comments and key order when stamping", async () => {
		const stampOrder = `---\nkind: api\ndomains: [stamp-order.example]\n# a comment that must survive\nshortName: StampOrder\napiHost: ${API}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		await saveRecipe("stamp-order.example", stampOrder);
		const raw = readFileSync(
			join(tmpGuidesDir, "stamporder", "guide.md"),
			"utf-8",
		);
		expect(raw).toContain("# a comment that must survive");
		// Key order preserved; schemaVersion inserted after operations, before
		// the closing --- (no YAML round-trip).
		const idxDomains = raw.indexOf("domains:");
		const idxShort = raw.indexOf("shortName:");
		const idxApi = raw.indexOf("apiHost:");
		const idxOps = raw.indexOf("operations:");
		const idxSV = raw.indexOf("schemaVersion: 1");
		expect(idxDomains).toBeLessThan(idxShort);
		expect(idxShort).toBeLessThan(idxApi);
		expect(idxApi).toBeLessThan(idxOps);
		expect(idxOps).toBeLessThan(idxSV);
	});
});
