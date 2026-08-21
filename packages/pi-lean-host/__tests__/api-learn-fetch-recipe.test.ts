/**
 * api-learn fetch-recipe + entry-point split + disambiguation
 * structural tests.
 *
 * Covers:
 *  - 0 guides → domain-specific template (domains pre-filled).
 *  - 1 guide → raw recipe + dirName surfaced.
 *  - N guides → menu; guide selector resolves to the selected raw recipe.
 *  - `new: true` → fresh template regardless of existing guides (no writes).
 *  - Entry-point split: bare = manual + pointer (no recipe body); `{domain,
 *    new: true}` = template only.
 *  - dirName surfacing (sibling-clobber guard): fetch via routing domain +
 *    guide selector surfaces the directory name, which differs from the
 *    routing domain.
 *
 * No network — recipes use a dummy https apiHost; the save path only
 * validates + writes. Structural only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiLearnTool } from "../tools/api-learn.js";
import { contentText } from "../tools/utils.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { parseApiGuide } from "../core/parse-api-guide.js";

let tmpGuidesDir: string;

beforeAll(() => {
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-learn-fetch-"));
	setUserGuidesDir(tmpGuidesDir);
	invalidateCache();
});

afterAll(() => {
	rmSync(tmpGuidesDir, { recursive: true, force: true });
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

function callLearn(
	domain?: string,
	recipe?: string,
	extra?: { new?: boolean; guide?: string },
) {
	const p: Record<string, unknown> = {};
	if (domain !== undefined) p.domain = domain;
	if (recipe !== undefined) p.recipe = recipe;
	if (extra?.new !== undefined) p.new = extra.new;
	if (extra?.guide !== undefined) p.guide = extra.guide;
	return apiLearnTool.execute("test", p, undefined, undefined, undefined as any);
}

describe("api-learn fetch-recipe", () => {
	it("0 guides → placeholder template with domains pre-filled (fails closed)", async () => {
		const text = contentText(await callLearn("fresh.example"));
		expect(text).toContain("```yaml");
		expect(text).toContain("domains: [fresh.example]");
		const m = text.match(/```yaml\n([\s\S]*?)```/);
		expect(m).not.toBeNull();
		const template = m![1]!;
		// Placeholders, not another API's real values (gap 1).
		expect(template).toContain("<base url>");
		expect(template).toContain("<short>");
		expect(template).toContain("<emoji>");
		expect(template).not.toMatch(
			/apidatos|boe\.es|BOE|searchDiary|listConsolidada/,
		);
		// Fail-closed: the as-is template cannot save (placeholder apiHost
		// is rejected by requireHttpUrl).
		expect(parseApiGuide(template, { filename: "fresh.example" }).ok).toBe(false);
	});

	it("1 guide → raw recipe + dirName surfaced", async () => {
		await callLearn("solo.example", recipe("solo.example", "Solo", "getSolo"));
		const text = contentText(await callLearn("solo.example"));
		expect(text).toContain("Directory: solo.example");
		expect(text).toContain("pass the directory name as `domain`");
		// Raw recipe body present (the saved guide.md, incl. schemaVersion stamp).
		expect(text).toContain("getSolo");
		expect(text).toContain("schemaVersion: 0");
		const raw = readFileSync(
			join(tmpGuidesDir, "solo.example", "guide.md"),
			"utf-8",
		);
		expect(text).toContain(raw.trim());
	});

	it("1 guide with dirName ≠ routing domain surfaces the dirName (sibling-clobber guard)", async () => {
		await callLearn("foo-api", recipe("foo.example", "Foo", "getFoo"));
		const text = contentText(await callLearn("foo.example"));
		expect(text).toContain("Directory: foo-api");
		expect(text).toContain('api-learn({domain: "foo-api", recipe: "..."})');
	});

	it("N guides → disambiguation menu by shortName; guide selector resolves", async () => {
		// Two guides claim archive.org (multi-recipe).
		await callLearn(
			"archive.org",
			recipe("archive.org", "Archive", "getArchive"),
		);
		await callLearn(
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
		expect(picked).toContain("getWayback");
		expect(picked).not.toContain("getArchive");
	});

	it("N guides with unknown guide selector → error naming available guides", async () => {
		const res = await callLearn("archive.org", undefined, { guide: "nope" });
		const text = contentText(res);
		expect(text).toContain("No guide named 'nope'");
		expect(text).toContain("Available guides:");
		expect(res.details).toMatchObject({ error: "no_guide_by_shortname" });
	});

	it("new: true → fresh template regardless of existing guides, no writes", async () => {
		// archive.org already has 2 guides.
		const text = contentText(
			await callLearn("archive.org", undefined, { new: true }),
		);
		expect(text).toContain("domains: [archive.org]");
		// Template, not an existing recipe.
		expect(text).not.toContain("getArchive");
		expect(text).not.toContain("getWayback");
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
	it("bare → manual + pointer, no recipe body", async () => {
		const text = contentText(await callLearn());
		expect(text).toContain("authoring manual");
		expect(text).toContain("new: true");
		expect(text).not.toContain("```yaml");
		expect(text).not.toContain("searchDiary");
	});

	it("{domain, new: true} → template only, no instruction block", async () => {
		const text = contentText(
			await callLearn("split.example", undefined, { new: true }),
		);
		expect(text).toContain("```yaml");
		expect(text).toContain("domains: [split.example]");
		expect(text).not.toContain("Required fields");
		expect(text).not.toContain("Executor semantics");
	});
});

describe("api-learn save path unchanged", () => {
	it("{domain, recipe} validates-then-writes", async () => {
		const text = contentText(
			await callLearn("save.example", recipe("save.example", "Save", "getSave")),
		);
		expect(text).toContain("Guide saved");
		expect(
			readFileSync(join(tmpGuidesDir, "save.example", "guide.md"), "utf-8"),
		).toContain("getSave");
	});
});
