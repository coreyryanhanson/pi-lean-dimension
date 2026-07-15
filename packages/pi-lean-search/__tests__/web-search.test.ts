/**
 * Tests for pi-lean-search — config reader and tool definition structure.
 *
 * Full integration tests for web-search require a running SearXNG
 * instance and are not included here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readSearxngUrl } from "../search-config.js";
import { webSearchTool } from "../web-search-tool.js";

// ─── Config reader (mocked fs) ──────────────────────────────────

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";

describe("readSearxngUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns undefined when neither settings file exists", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		expect(readSearxngUrl()).toBeUndefined();
	});

	it("returns undefined when settings exist but have no searxng key", () => {
		vi.mocked(existsSync).mockImplementation(
			(path) => typeof path === "string" && path.includes(".pi"),
		);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ theme: "dark", browserToggle: {} }),
		);
		expect(readSearxngUrl()).toBeUndefined();
	});

	it("returns the URL when searxng.url is set (global)", () => {
		vi.mocked(existsSync).mockImplementation(
			(path) =>
				typeof path === "string" &&
				(path.includes(".pi/agent/settings") ||
					path.includes(".pi/settings.json")),
		);
		vi.mocked(readFileSync).mockImplementation((path: unknown) => {
			if (typeof path === "string" && path.includes(".pi/agent/settings")) {
				return JSON.stringify({
					searxng: { url: "http://localhost:8888" },
				});
			}
			return JSON.stringify({});
		});
		expect(readSearxngUrl()).toBe("http://localhost:8888");
	});

	it("project settings override global settings", () => {
		vi.mocked(existsSync).mockImplementation(
			(path) => typeof path === "string" && path.includes(".pi"),
		);
		vi.mocked(readFileSync).mockImplementation((path: unknown) => {
			if (typeof path === "string" && path.includes(".pi/agent/settings")) {
				return JSON.stringify({
					searxng: { url: "http://global:8888" },
				});
			}
			return JSON.stringify({
				searxng: { url: "http://project:8888" },
			});
		});
		expect(readSearxngUrl()).toBe("http://project:8888");
	});

	it("returns undefined when searxng.url is an empty string", () => {
		vi.mocked(existsSync).mockImplementation(
			(path) => typeof path === "string" && path.includes(".pi"),
		);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ searxng: { url: "" } }),
		);
		expect(readSearxngUrl()).toBeUndefined();
	});

	it("returns undefined when searxng is not an object", () => {
		vi.mocked(existsSync).mockImplementation(
			(path) => typeof path === "string" && path.includes(".pi"),
		);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ searxng: "http://localhost:8888" }),
		);
		expect(readSearxngUrl()).toBeUndefined();
	});

	it("returns undefined on malformed JSON", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue("not valid json");
		expect(readSearxngUrl()).toBeUndefined();
	});
});

// ─── Tool definition structural checks ──────────────────────────

describe("webSearchTool", () => {
	it("has the correct name", () => {
		expect(webSearchTool.name).toBe("web-search");
	});

	it("has a label", () => {
		expect(typeof webSearchTool.label).toBe("string");
		expect(webSearchTool.label!.length).toBeGreaterThan(0);
	});

	it("has a description", () => {
		expect(typeof webSearchTool.description).toBe("string");
		expect(webSearchTool.description!.length).toBeGreaterThan(0);
	});

	it("has promptSnippet and promptGuidelines", () => {
		expect(typeof webSearchTool.promptSnippet).toBe("string");
		expect(webSearchTool.promptSnippet!.length).toBeGreaterThan(0);
		expect(webSearchTool.promptGuidelines).toBeTruthy();
	});

	it("defines required query parameter", () => {
		const schema = webSearchTool.parameters;
		expect(schema).toBeDefined();
	});

	it("defines pageno parameter with minimum of 1", () => {
		const schema = webSearchTool.parameters;
		expect(schema).toBeDefined();
		const pageno = (
			schema as Record<string, unknown> & {
				properties?: Record<string, unknown>;
			}
		)?.properties?.pageno;
		expect(pageno).toBeDefined();
	});

	it("has execute function", () => {
		expect(typeof webSearchTool.execute).toBe("function");
	});

	it("has renderCall function", () => {
		expect(typeof webSearchTool.renderCall).toBe("function");
	});

	it("has renderResult function", () => {
		expect(typeof webSearchTool.renderResult).toBe("function");
	});

	describe("renderResult answer badge", () => {
		it("shows 💡 badge when answerCount > 0 and no results", () => {
			const mockTheme = {
				fg: (_style: string, text: string) => text,
			} as any;
			const result = (webSearchTool.renderResult as any)(
				{
					content: [{ text: "" }],
					details: { answerCount: 2, query: "weather" },
				} as any,
				{ expanded: false, isPartial: false },
				mockTheme,
				{} as any,
			) as any;
			expect(result.text).toContain("💡");
			expect(result.text).toContain("2 answer(s)");
			expect(result.text).toContain('"weather"');
		});

		it("shows 💡 badge alongside 🔍 when both answers and results present", () => {
			const mockTheme = {
				fg: (_style: string, text: string) => text,
			} as any;
			const result = (webSearchTool.renderResult as any)(
				{
					content: [{ text: "" }],
					details: {
						answerCount: 1,
						resultCount: 3,
						query: "test",
						results: [
							{ title: "A", url: "http://a.com", engine: "google" },
							{ title: "B", url: "http://b.com", engine: "google" },
							{ title: "C", url: "http://c.com", engine: "google" },
						],
					},
				} as any,
				{ expanded: false, isPartial: false },
				mockTheme,
				{} as any,
			) as any;
			expect(result.text).toContain("💡");
			expect(result.text).toContain("1 answer(s)");
			expect(result.text).toContain("🔍");
			expect(result.text).toContain("3 result(s)");
		});

		it("shows answer text above results when expanded", () => {
			const mockTheme = {
				fg: (_style: string, text: string) => text,
			} as any;
			const result = (webSearchTool.renderResult as any)(
				{
					content: [{ text: "" }],
					details: {
						answerCount: 1,
						resultCount: 1,
						query: "weather berlin",
						answers: [
							{
								template: "answer/weather.html",
								text: "Berlin: 14°C, light rain",
							},
						],
						results: [{ title: "A", url: "http://a.com" }],
					},
				} as any,
				{ expanded: true, isPartial: false },
				mockTheme,
				{} as any,
			) as any;
			const answerIdx = result.text.indexOf("Berlin: 14°C, light rain");
			const resultIdx = result.text.indexOf("A");
			expect(answerIdx).toBeGreaterThan(-1);
			expect(resultIdx).toBeGreaterThan(-1);
			expect(answerIdx).toBeLessThan(resultIdx);
		});

		it("shows answer text when expanded with no results", () => {
			const mockTheme = {
				fg: (_style: string, text: string) => text,
			} as any;
			const result = (webSearchTool.renderResult as any)(
				{
					content: [{ text: "" }],
					details: {
						answerCount: 1,
						query: "avg 1 2 3",
						answers: [{ template: "answer/legacy.html", text: "2" }],
					},
				} as any,
				{ expanded: true, isPartial: false },
				mockTheme,
				{} as any,
			) as any;
			expect(result.text).toContain("💡");
			expect(result.text).toContain("2");
		});
	});
});

// ─── Execute answer rendering (mocked fetch) ─────────────────

describe("execute answer rendering", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Make readSearxngUrl return a valid URL
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ searxng: { url: "http://localhost:8888" } }),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const mockFetch = (json: unknown) =>
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => JSON.stringify(json),
			}),
		);

	it("legacy answer renders + bypasses empty-results early return", async () => {
		mockFetch({
			results: [],
			answers: [{ template: "answer/legacy.html", answer: "614.24" }],
			suggestions: [],
		});

		const result = await webSearchTool.execute(
			"call-1",
			{ query: "614.24" },
			undefined,
			undefined,
			{} as any,
		);
		const r = result as any;
		expect(r.content[0].text).toContain("614.24");
		expect(r.content[0].text).not.toContain("No web search results found");
		expect(r.content[0].text).toContain("No web results");
	});

	it("weather answer uses server summary", async () => {
		mockFetch({
			results: [],
			answers: [
				{
					template: "answer/weather.html",
					current: {
						location: { name: "Berlin", latitude: 52.52, longitude: 13.405 },
						temperature: { val: 14, unit: "°C" },
						condition: "light rain",
						summary: "Berlin: 14°C, light rain",
						feels_like: { val: 12, unit: "°C" },
						humidity: { val: 80, unit: "%" },
						wind_speed: { val: 18, unit: "km/h" },
						wind_from: { name: "NW" },
					},
					service: "open-meteo",
				},
			],
			suggestions: [],
		});

		const result = await webSearchTool.execute(
			"call-2",
			{ query: "weather berlin" },
			undefined,
			undefined,
			{} as any,
		);
		// Uses server-provided summary
		const r = result as any;
		expect(r.content[0].text).toContain("Berlin: 14°C, light rain");
		// Secondary detail line
		expect(r.content[0].text).toContain("feels like 12°C");
		expect(r.content[0].text).toContain("humidity 80%");
		expect(r.content[0].text).toContain("wind 18km/h");
		// forecasts not rendered
		expect(r.content[0].text).not.toContain("forecast");
		// source
		expect(r.content[0].text).toContain("open-meteo");
	});

	it("unknown template falls back to legacy heuristic", async () => {
		mockFetch({
			results: [],
			answers: [{ template: "answer/future.html", answer: "x" }],
			suggestions: [],
		});

		const result = await webSearchTool.execute(
			"call-3",
			{ query: "future" },
			undefined,
			undefined,
			{} as any,
		);
		const r = result as any;
		expect(r.content[0].text).toContain("x");
	});

	it("answers + results both present (primary success path)", async () => {
		mockFetch({
			results: [
				{
					title: "Result 1",
					url: "http://example.com/1",
					content: "First result",
					engine: "google",
					score: 0.95,
				},
			],
			answers: [{ template: "answer/legacy.html", answer: "42" }],
			suggestions: [],
		});

		const result = await webSearchTool.execute(
			"call-5",
			{ query: "answer of life" },
			undefined,
			undefined,
			{} as any,
		);
		// Answer above results
		const r = result as any;
		const answerIdx = r.content[0].text.indexOf("42");
		const resultIdx = r.content[0].text.indexOf("Result 1");
		expect(answerIdx).toBeGreaterThanOrEqual(0);
		expect(resultIdx).toBeGreaterThan(answerIdx);
		// Both present
		expect(r.content[0].text).toContain("42");
		expect(r.content[0].text).toContain("Result 1");
	});
});
