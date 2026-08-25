/**
 * api-scaffold structural tests (mocked-fs, no network).
 *
 * Covers the api-scaffold test cases that are testable in isolation (the
 * learn-gating case lives in api-toggle.test.ts):
 *  - helper: true → commented-out stub written to /tmp/pi-lean-host/<dirName>/helper.ts
 *  - verify: true → sentinels for path {token}, required-no-default query,
 *    and every requiresAnyOf member — and all-runnable ops contribute none
 *  - additive merge — existing guides-dir real values preserved, new
 *    sentinels added for newly-unsatisfiable params
 *  - all-runnable guide → empty verify.json scaffold ({})
 *  - refuse-to-overwrite — existing staged sibling errors (delete + re-call)
 *  - dirName derived (slug(shortName)) and surfaced with the staged dir path
 *  - N-guide domain: guide selector scaffolds the selected guide; absent
 *    selector yields the disambiguation menu
 *  - neither verify nor helper → validation error, no /tmp write
 *  - both true → both files written to the same staged dir in one call
 *  - malformed guides-dir verify.json → clear error, no /tmp write
 *
 * Every test uses its own guide so staged-dir state never leaks across
 * cases (staging is keyed by slug(shortName)). No network — recipes use a
 * dummy https apiHost; the scaffold only reads the parsed guide + writes
 * /tmp. Structural only.
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
import { apiScaffoldTool, setStagingRoot } from "../tools/api-scaffold.js";
import { contentText } from "../tools/utils.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { slug } from "../core/path-template.js";

// ── Mock theme (fg returns text unstyled) ────────────────────────
const mockTheme = {
	fg: (_style: string, text: string) => text,
	bold: (s: string) => s,
} as any;

let tmpGuidesDir: string;
let tmpStagingRoot: string;

beforeAll(() => {
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-scaffold-guides-"));
	setUserGuidesDir(tmpGuidesDir);
	tmpStagingRoot = mkdtempSync(join(tmpdir(), "host-scaffold-staging-"));
	setStagingRoot(tmpStagingRoot);
	invalidateCache();
});

afterAll(() => {
	rmSync(tmpGuidesDir, { recursive: true, force: true });
	rmSync(tmpStagingRoot, { recursive: true, force: true });
});

/** Stage a guide's recipe into the guides dir (dirName = slug(shortName)). */
function writeGuide(shortName: string, domain: string, recipe: string): void {
	const dirName = slug(shortName);
	mkdirSync(join(tmpGuidesDir, dirName), { recursive: true });
	writeFileSync(join(tmpGuidesDir, dirName, "guide.md"), recipe, "utf-8");
	invalidateCache();
}

function stagedDir(dirName: string): string {
	return join(tmpStagingRoot, dirName);
}

function callScaffold(p: Record<string, unknown>) {
	return apiScaffoldTool.execute(
		"test",
		p,
		undefined,
		undefined,
		undefined as any,
	);
}

const API = "https://api.example.com";

/** A 3-op guide: two ops with unsatisfiable params + one fully-runnable. */
function mixedRecipe(domain: string, shortName: string): string {
	return `---
kind: api
domains: [${domain}]
shortName: ${shortName}
apiHost: ${API}
operations:
  - name: getItem
    via: restGet
    path: /items/{id}
    accept: json
    params:
      id:
        description: item id
  - name: search
    via: restGet
    path: /search
    accept: json
    requiresAnyOf: [query, tag, category]
    params:
      query:
        description: free text
      tag:
        description: tag filter
      category:
        description: category filter
  - name: list
    via: restGet
    path: /list
    accept: json
    params:
      limit:
        required: true
        description: page size
  - name: runnable
    via: restGet
    path: /runnable
    accept: json
    params:
      q:
        default: all
---
`;
}

/** A single-op guide with one path {token} (no query/group shapes). */
function tokenRecipe(
	domain: string,
	shortName: string,
	opName: string,
): string {
	return `---
kind: api
domains: [${domain}]
shortName: ${shortName}
apiHost: ${API}
operations:
  - name: ${opName}
    via: restGet
    path: /item/{id}
    accept: json
    params:
      id:
        description: item id
---
`;
}

describe("api-scaffold", () => {
	it("neither verify nor helper → validation error, no /tmp write", async () => {
		writeGuide("Scaff", "scaff.example", mixedRecipe("scaff.example", "Scaff"));
		const res = await callScaffold({ domain: "scaff.example" });
		const text = contentText(res);
		expect(res.details).toMatchObject({ error: "nothing_to_scaffold" });
		expect(text).toMatch(/at least one of verify: true or helper: true/);
		// No staged dir created.
		expect(existsSync(stagedDir("scaff"))).toBe(false);
	});

	it("helper: true → commented-out stub written to the staged dir", async () => {
		writeGuide(
			"Helper",
			"helper.example",
			tokenRecipe("helper.example", "Helper", "getHelper"),
		);
		const res = await callScaffold({ domain: "helper.example", helper: true });
		const text = contentText(res);
		expect(res.details).toMatchObject({
			mode: "helper",
			dirName: "helper",
			helperPath: join(stagedDir("helper"), "helper.ts"),
		});
		expect(text).toContain(stagedDir("helper"));
		const stub = readFileSync(join(stagedDir("helper"), "helper.ts"), "utf-8");
		expect(stub).toContain("Helper for helper.example");
		expect(stub).toContain("export default function(");
		expect(stub).toContain("export function transform(");
		// Both exports commented out — no uncommented export statements.
		expect(stub).not.toMatch(/^export (default )?function/m);
	});

	it("verify: true → sentinels for path token, required-no-default query, and every requiresAnyOf member; runnable op excluded", async () => {
		writeGuide("Scaff", "scaff.example", mixedRecipe("scaff.example", "Scaff"));
		const res = await callScaffold({ domain: "scaff.example", verify: true });
		expect(res.details).toMatchObject({
			mode: "verify",
			dirName: "scaff",
			verifyPath: join(stagedDir("scaff"), "verify.json"),
		});
		const merged = JSON.parse(
			readFileSync(join(stagedDir("scaff"), "verify.json"), "utf-8"),
		);
		expect(merged).toEqual({
			getItem: { id: "__FILL_ME__" },
			search: {
				query: "__FILL_ME__",
				tag: "__FILL_ME__",
				category: "__FILL_ME__",
			},
			list: { limit: "__FILL_ME__" },
		});
		// Fully-runnable op contributes no entry.
		expect(merged.runnable).toBeUndefined();
		// Authoring manual prepended to the result.
		expect(contentText(res)).toContain("__FILL_ME__");
		expect(contentText(res)).toContain("fill any ONE member");
	});

	it("verify additive merge → existing real values preserved, new sentinels added", async () => {
		writeGuide("Merge", "merge.example", mixedRecipe("merge.example", "Merge"));
		// Pre-seed a guides-dir verify.json with real values for two already-
		// satisfied params; the rest are still unsatisfiable.
		writeFileSync(
			join(tmpGuidesDir, "merge", "verify.json"),
			JSON.stringify({
				getItem: { id: "real-123" },
				search: { query: "real-query" },
			}),
			"utf-8",
		);
		const res = await callScaffold({ domain: "merge.example", verify: true });
		expect(res.details).not.toMatchObject({ error: expect.anything() });
		const merged = JSON.parse(
			readFileSync(join(stagedDir("merge"), "verify.json"), "utf-8"),
		);
		// Real values preserved verbatim.
		expect(merged.getItem.id).toBe("real-123");
		expect(merged.search.query).toBe("real-query");
		// Newly-unsatisfiable params get sentinels.
		expect(merged.search.tag).toBe("__FILL_ME__");
		expect(merged.search.category).toBe("__FILL_ME__");
		expect(merged.list.limit).toBe("__FILL_ME__");
	});

	it("no unsatisfiable params → empty verify.json scaffold", async () => {
		writeGuide(
			"Runnable",
			"runnable.example",
			`---
kind: api
domains: [runnable.example]
shortName: Runnable
apiHost: ${API}
operations:
  - name: list
    via: restGet
    path: /list
    accept: json
    params:
      q:
        default: all
      limit:
        default: 10
---
`,
		);
		const res = await callScaffold({
			domain: "runnable.example",
			verify: true,
		});
		expect(res.details).toMatchObject({ dirName: "runnable" });
		const merged = JSON.parse(
			readFileSync(join(stagedDir("runnable"), "verify.json"), "utf-8"),
		);
		expect(merged).toEqual({});
	});

	it("refuse-to-overwrite → existing staged verify.json errors, names delete-then-re-call", async () => {
		writeGuide("Ov", "ov.example", tokenRecipe("ov.example", "Ov", "getOv"));
		// Pre-stage a verify.json (simulating a prior scaffold).
		mkdirSync(stagedDir("ov"), { recursive: true });
		writeFileSync(
			join(stagedDir("ov"), "verify.json"),
			JSON.stringify({ getOv: { id: "already" } }),
			"utf-8",
		);
		const res = await callScaffold({ domain: "ov.example", verify: true });
		const text = contentText(res);
		expect(res.details).toMatchObject({
			error: "refuse_overwrite",
			file: "verify.json",
			dirName: "ov",
		});
		expect(text).toContain("already exists");
		expect(text).toContain("Delete the file from /tmp");
		// The existing staged file is untouched.
		expect(readFileSync(join(stagedDir("ov"), "verify.json"), "utf-8")).toContain(
			"already",
		);
	});

	it("refuse-to-overwrite also gates helper.ts", async () => {
		writeGuide("Hov", "hov.example", tokenRecipe("hov.example", "Hov", "getHov"));
		mkdirSync(stagedDir("hov"), { recursive: true });
		writeFileSync(join(stagedDir("hov"), "helper.ts"), "// existing\n", "utf-8");
		const res = await callScaffold({ domain: "hov.example", helper: true });
		expect(res.details).toMatchObject({
			error: "refuse_overwrite",
			file: "helper.ts",
			dirName: "hov",
		});
	});

	it("both verify + helper true → both files written to one staged dir, dirName surfaced", async () => {
		writeGuide(
			"Both",
			"both.example",
			tokenRecipe("both.example", "Both", "getBoth"),
		);
		const res = await callScaffold({
			domain: "both.example",
			verify: true,
			helper: true,
		});
		expect(res.details).toMatchObject({
			mode: "both",
			dirName: "both",
			helperPath: join(stagedDir("both"), "helper.ts"),
			verifyPath: join(stagedDir("both"), "verify.json"),
		});
		expect(existsSync(join(stagedDir("both"), "helper.ts"))).toBe(true);
		expect(existsSync(join(stagedDir("both"), "verify.json"))).toBe(true);
		// Result surfaces dirName + staged dir + both paths.
		const text = contentText(res);
		expect(text).toContain("both");
		expect(text).toContain("helper.ts");
		expect(text).toContain("verify.json");
	});

	it("N-guide domain → menu without selector; guide selector scaffolds the selected one", async () => {
		writeGuide(
			"First",
			"multi.example",
			tokenRecipe("multi.example", "First", "getFirst"),
		);
		writeGuide(
			"Second",
			"multi.example",
			tokenRecipe("multi.example", "Second", "getSecond"),
		);

		const menu = await callScaffold({ domain: "multi.example", verify: true });
		const menuText = contentText(menu);
		expect(menu.details).toMatchObject({ mode: "menu", disambiguation: 2 });
		expect(menuText).toContain("2 API guides for 'multi.example'");
		expect(menuText).toContain("First");
		expect(menuText).toContain("Second");
		// Nothing scaffolded yet.
		expect(existsSync(stagedDir("first"))).toBe(false);
		expect(existsSync(stagedDir("second"))).toBe(false);

		const picked = await callScaffold({
			domain: "multi.example",
			guide: "second",
			verify: true,
		});
		expect(picked.details).toMatchObject({ dirName: "second" });
		const merged = JSON.parse(
			readFileSync(join(stagedDir("second"), "verify.json"), "utf-8"),
		);
		expect(merged).toEqual({ getSecond: { id: "__FILL_ME__" } });
		// The unselected guide was not scaffolded.
		expect(existsSync(stagedDir("first"))).toBe(false);
	});

	it("malformed guides-dir verify.json → clear error, no /tmp write", async () => {
		writeGuide(
			"Badmerge",
			"badmerge.example",
			tokenRecipe("badmerge.example", "Badmerge", "getBad"),
		);
		writeFileSync(
			join(tmpGuidesDir, "badmerge", "verify.json"),
			"{ not valid json",
			"utf-8",
		);
		const res = await callScaffold({
			domain: "badmerge.example",
			verify: true,
		});
		const text = contentText(res);
		expect(res.details).toMatchObject({
			error: "malformed_verify_json",
			dirName: "badmerge",
		});
		expect(text).toContain("malformed");
		// No /tmp write; guides dir untouched.
		expect(existsSync(stagedDir("badmerge"))).toBe(false);
		expect(
			readFileSync(join(tmpGuidesDir, "badmerge", "verify.json"), "utf-8"),
		).toBe("{ not valid json");
	});
});

describe("api-scaffold TUI rendering", () => {
	it("renderCall shows the 🛠 icon when both verify + helper are requested", () => {
		const out = apiScaffoldTool.renderCall!(
			{ domain: "both.example", verify: true, helper: true },
			mockTheme,
			undefined as any,
		);
		expect(out.text).toContain("🛠");
	});

	it("renderResult labels a disambiguation menu with the domain", () => {
		const out = apiScaffoldTool.renderResult!(
			{
				content: [{ type: "text", text: "2 API guides for 'multi.example'" }],
				details: { mode: "menu", domain: "multi.example", disambiguation: 2 },
			} as any,
			{ expanded: false, isPartial: false },
			mockTheme,
			undefined as any,
		);
		expect(out.text).toContain("menu");
		expect(out.text).toContain("multi.example");
	});

	it("renderResult labels a success result with dirName + staged dir", () => {
		const out = apiScaffoldTool.renderResult!(
			{
				content: [{ type: "text", text: "🛠 Scaffolded…" }],
				details: {
					mode: "verify",
					domain: "scaff.example",
					dirName: "scaff",
					stagedDir: stagedDir("scaff"),
				},
			} as any,
			{ expanded: false, isPartial: false },
			mockTheme,
			undefined as any,
		);
		expect(out.text).toContain("scaff");
		expect(out.text).toContain(stagedDir("scaff"));
	});
});
