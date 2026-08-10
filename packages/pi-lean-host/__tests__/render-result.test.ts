/**
 * renderResult tests for the host api tools.
 *
 * Step 5 of the api-render-result plan: pure synchronous assertions on
 * the `renderResult` method of api-fetch / api-guide / api-learn. No
 * `execute` is invoked — we feed synthetic result objects directly.
 *
 * Mock theme: `fg` returns its text argument unstyled, so assertions
 * observe the raw string content regardless of color/style applied.
 */

import { describe, it, expect } from "vitest";
import { apiFetchTool } from "../tools/api-fetch.js";
import { apiGuideTool } from "../tools/api-guide.js";
import { apiLearnTool } from "../tools/api-learn.js";

// ── Mock theme ───────────────────────────────────────────────────
// fg(style, text) -> text  (drop styling so assertions see raw text).
const mockTheme = {
	fg: (_style: string, text: string) => text,
	bold: (s: string) => s,
} as any;

/** Invoke a tool's renderResult with the standard 4-arg signature. */
function renderResult(
	tool: { renderResult?: Function },
	result: any,
	opts: { expanded: boolean; isPartial?: boolean },
): { text: string } {
	return (tool.renderResult as any)(
		result,
		{ expanded: opts.expanded, isPartial: opts.isPartial ?? false },
		mockTheme,
		{},
	) as { text: string };
}

/** Build a body string of exactly `n` chars with distinctive bookends. */
function bodyOf(n: number): string {
	const bookends = "BODY_START_" + "_BODY_END"; // 20 chars
	const pad = "x".repeat(Math.max(0, n - bookends.length));
	return `BODY_START_${pad}_BODY_END`;
}

// ═══════════════════════════════════════════════════════════════════
// api-fetch
// ═══════════════════════════════════════════════════════════════════

describe("api-fetch renderResult", () => {
	it("isPartial returns a Fetching… one-liner", () => {
		const out = renderResult(
			apiFetchTool,
			{ content: [], details: {} },
			{ isPartial: true, expanded: false },
		);
		expect(out.text).toBe("Fetching…");
	});

	it("collapsed shows header + chars (expand) hint, no body", () => {
		const content = bodyOf(1500);
		const out = renderResult(
			apiFetchTool,
			{
				content: [{ type: "text", text: content }],
				details: {
					domain: "boe.es",
					operation: "searchDiary",
					shortName: "BOE",
					via: "restGet",
					request: {
						method: "GET",
						url: "https://api.boe.es/v1/diario/2026-07-17",
					},
				},
			},
			{ expanded: false },
		);
		expect(out.text).toContain("📡 BOE");
		expect(out.text).toContain("searchDiary");
		expect(out.text).toContain("GET https://api.boe.es/v1/diario/2026-07-17");
		expect(out.text).toContain("1500 chars (expand)");
		// Collapsed must not leak the body slice.
		expect(out.text).not.toContain("BODY_START_");
	});

	it("expanded shows header + body slice + more-chars suffix, no expand hint", () => {
		const content = bodyOf(1500);
		const out = renderResult(
			apiFetchTool,
			{
				content: [{ type: "text", text: content }],
				details: {
					domain: "boe.es",
					operation: "searchDiary",
					shortName: "BOE",
					via: "restGet",
					request: {
						method: "GET",
						url: "https://api.boe.es/v1/diario/2026-07-17",
					},
				},
			},
			{ expanded: true },
		);
		expect(out.text).toContain("📡 BOE");
		// Expanded shows the beginning of the body (limit 1000).
		expect(out.text).toContain("BODY_START_");
		// Content exceeds the 1000-char limit → more-chars suffix appears.
		expect(out.text).toContain("… 500 more chars");
		// No collapsed hint in expanded state.
		expect(out.text).not.toContain("(expand)");
	});

	it("paginate details render the item-count line", () => {
		const content = bodyOf(200);
		const out = renderResult(
			apiFetchTool,
			{
				content: [{ type: "text", text: content }],
				details: {
					domain: "boe.es",
					operation: "listConsolidada",
					shortName: "BOE",
					via: "paginate",
					request: {
						method: "GET",
						url: "https://api.boe.es/v1/legislacion-consolidada",
					},
					totalFetched: 42,
					ceilingHit: false,
				},
			},
			{ expanded: false },
		);
		expect(out.text).toContain("📡 BOE");
		expect(out.text).toContain("listConsolidada");
		// totalFetched produces the 📦 item line.
		expect(out.text).toContain("📦 42 item(s) fetched");
		expect(out.text).toContain("200 chars (expand)");
	});

	it("error details render a red Fetch failed single line", () => {
		const out = renderResult(
			apiFetchTool,
			{
				content: [{ type: "text", text: "No API guide for 'x.example'." }],
				details: { error: "no_guide", domain: "x.example" },
			},
			{ expanded: false },
		);
		// Mock theme drops color, so we assert the text content + prefix.
		expect(out.text).toContain("Fetch failed:");
		expect(out.text).toContain("No API guide for 'x.example'.");
		// No header or expand hint on the error path.
		expect(out.text).not.toContain("📡");
		expect(out.text).not.toContain("(expand)");
	});
});

// ═══════════════════════════════════════════════════════════════════
// api-guide
// ═══════════════════════════════════════════════════════════════════

describe("api-guide renderResult", () => {
	it("isPartial returns a Loading… one-liner", () => {
		const out = renderResult(
			apiGuideTool,
			{ content: [], details: {} },
			{ isPartial: true, expanded: false },
		);
		expect(out.text).toBe("Loading…");
	});

	it("collapsed guide-found shows header + chars (expand) hint", () => {
		const content = bodyOf(1200);
		const out = renderResult(
			apiGuideTool,
			{
				content: [{ type: "text", text: content }],
				details: {
					guide: "BOE",
					domains: ["boe.es"],
					apiHost: "https://apidatos.boe.es/v1",
					operations: 2,
				},
			},
			{ expanded: false },
		);
		expect(out.text).toContain("📖 BOE");
		expect(out.text).toContain("2 operations");
		expect(out.text).toContain("1200 chars (expand)");
		expect(out.text).not.toContain("BODY_START_");
	});

	it("expanded guide-found shows body slice + more-chars suffix, no expand hint", () => {
		const content = bodyOf(1200);
		const out = renderResult(
			apiGuideTool,
			{
				content: [{ type: "text", text: content }],
				details: {
					guide: "BOE",
					domains: ["boe.es"],
					apiHost: "https://apidatos.boe.es/v1",
					operations: 2,
				},
			},
			{ expanded: true },
		);
		expect(out.text).toContain("📖 BOE");
		expect(out.text).toContain("BODY_START_");
		// limit 800 → 1200 - 800 = 400 more chars.
		expect(out.text).toContain("… 400 more chars");
		expect(out.text).not.toContain("(expand)");
	});

	it("collapsed catalog shows 📖 catalog — N guides header", () => {
		const content = "API guide catalog:\n  - BOE (boe.es)";
		const out = renderResult(
			apiGuideTool,
			{
				content: [{ type: "text", text: content }],
				details: { guideCount: 3 },
			},
			{ expanded: false },
		);
		expect(out.text).toContain("📖 catalog");
		expect(out.text).toContain("3 guides");
		expect(out.text).toContain(`${content.length} chars (expand)`);
	});

	it("expanded catalog shows the catalog body, no expand hint", () => {
		const content = "API guide catalog:\n  - BOE (boe.es)\n  - X (x.com)";
		const out = renderResult(
			apiGuideTool,
			{
				content: [{ type: "text", text: content }],
				details: { guideCount: 2 },
			},
			{ expanded: true },
		);
		expect(out.text).toContain("📖 catalog");
		// Short body fits within the 800-char limit → shown in full, no suffix.
		expect(out.text).toContain("API guide catalog:");
		expect(out.text).not.toContain("(expand)");
	});

	it("no-guide (empty details) renders the 📖 No guide header", () => {
		const content =
			"No API guide for 'unknown.example'. Call api-learn to author one.";
		const out = renderResult(
			apiGuideTool,
			{
				content: [{ type: "text", text: content }],
				details: {},
			},
			{ expanded: false },
		);
		expect(out.text).toContain("📖 No guide");
		expect(out.text).toContain(`${content.length} chars (expand)`);
	});
});

// ═══════════════════════════════════════════════════════════════════
// api-learn
// ═══════════════════════════════════════════════════════════════════

describe("api-learn renderResult", () => {
	it("isPartial returns a Saving… one-liner", () => {
		const out = renderResult(
			apiLearnTool,
			{ content: [], details: {} },
			{ isPartial: true, expanded: false },
		);
		expect(out.text).toBe("Saving…");
	});

	it("collapsed saved-guide shows header + chars (expand) hint", () => {
		const content = bodyOf(900);
		const out = renderResult(
			apiLearnTool,
			{
				content: [{ type: "text", text: content }],
				details: {
					domain: "boe.es",
					operations: 3,
					verified: "2026-07-17",
					filePath: "/tmp/guides/boe.es/guide.md",
				},
			},
			{ expanded: false },
		);
		expect(out.text).toContain("📝 Saved guide for boe.es");
		expect(out.text).toContain("3 ops");
		expect(out.text).toContain("900 chars (expand)");
		expect(out.text).not.toContain("BODY_START_");
	});

	it("expanded saved-guide shows body slice + more-chars suffix, no expand hint", () => {
		const content = bodyOf(900);
		const out = renderResult(
			apiLearnTool,
			{
				content: [{ type: "text", text: content }],
				details: {
					domain: "boe.es",
					operations: 3,
					verified: "2026-07-17",
					filePath: "/tmp/guides/boe.es/guide.md",
				},
			},
			{ expanded: true },
		);
		expect(out.text).toContain("📝 Saved guide for boe.es");
		expect(out.text).toContain("BODY_START_");
		// limit 600 → 900 - 600 = 300 more chars.
		expect(out.text).toContain("… 300 more chars");
		expect(out.text).not.toContain("(expand)");
	});

	it("collapsed worked-example shows 📝 Worked example header", () => {
		const content = "# Example recipe\n```yaml\n---\nkind: api\n...\n```";
		const out = renderResult(
			apiLearnTool,
			{
				content: [{ type: "text", text: content }],
				details: {},
			},
			{ expanded: false },
		);
		expect(out.text).toContain("📝 Worked example");
		expect(out.text).toContain(`${content.length} chars (expand)`);
	});

	it("error details render a red ⚠ single line", () => {
		const out = renderResult(
			apiLearnTool,
			{
				content: [
					{ type: "text", text: "Recipe is required when domain is provided." },
				],
				details: { error: "missing_recipe" },
			},
			{ expanded: false },
		);
		expect(out.text).toContain("⚠");
		expect(out.text).toContain("Recipe is required when domain is provided.");
		// No header or expand hint on the error path.
		expect(out.text).not.toContain("Saved guide");
		expect(out.text).not.toContain("Worked example");
		expect(out.text).not.toContain("(expand)");
	});
});
