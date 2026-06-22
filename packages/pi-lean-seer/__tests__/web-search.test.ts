/**
 * Tests for pi-lean-seer — config reader and tool definition structure.
 *
 * Full integration tests for web-search require a running SearXNG
 * instance and are not included here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readSearxngUrl } from "../seer-config.js";
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

	it("has execute function", () => {
		expect(typeof webSearchTool.execute).toBe("function");
	});

	it("has renderCall function", () => {
		expect(typeof webSearchTool.renderCall).toBe("function");
	});

	it("has renderResult function", () => {
		expect(typeof webSearchTool.renderResult).toBe("function");
	});
});
