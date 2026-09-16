/**
 * Tests for pi-lean-search — config reader and tool definition structure.
 *
 * Full integration tests for web-search require a running SearXNG
 * instance and are not included here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOLSET_EVENTS } from "pi-tool-masking";
import { readSearxngUrl } from "../search-config.js";
import { webSearchTool, buildSearchUrl } from "../web-search-tool.js";
import searchExtension, { _resetStateForTest } from "../index.js";

// Mock Pi used for integration-style tests (toolset wiring, glyph rendering).
// ─── Mock helpers ─────────────────────────────────────────────────────

const REGISTRY_KEY = "__piToolMaskingRegistry";

function mockSearchPi(initialActive?: string[]) {
	let active = initialActive ?? ["web-search"];
	const eventEmitter = new EventEmitter();
	const handlers = new Map<string, Array<(...args: any[]) => void>>();

	// A minimal mock of the ExtensionAPI. We intentionally don't mock
	// _everything_ — only the methods the extension code actually calls.
	const pi = {
		getAllTools: vi.fn(() => [{ name: "web-search", description: "search" }]),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((names: string[]) => {
			active = [...names];
		}),
		appendEntry: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(<T>(event: string, handler: (event: T, ctx: any) => void) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler as any);
			return () => {};
		}),
		get events() {
			return {
				emit: (channel: string, data: unknown) => eventEmitter.emit(channel, data),
				on: (channel: string, handler: (data: unknown) => void) => {
					eventEmitter.on(channel, handler);
					return () => eventEmitter.off(channel, handler);
				},
			};
		},
	} as unknown as ExtensionAPI;

	return { pi, events: eventEmitter, handlers };
}

// ─── Config reader (mocked fs) ──────────────────────────────────

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("readSearxngUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("honors PI_CODING_AGENT_DIR for the global settings path", () => {
		process.env.PI_CODING_AGENT_DIR = "/custom/agent/dir";
		vi.mocked(readFileSync).mockImplementation((path: unknown) => {
			if (path === "/custom/agent/dir/settings.json") {
				return JSON.stringify({ searxng: { url: "http://custom:8888" } });
			}
			return JSON.stringify({});
		});
		expect(readSearxngUrl()).toBe("http://custom:8888");
	});

	it("falls back to ~/.pi/agent when PI_CODING_AGENT_DIR is unset", () => {
		vi.mocked(readFileSync).mockImplementation((path: unknown) => {
			if (path === join(homedir(), ".pi", "agent", "settings.json")) {
				return JSON.stringify({ searxng: { url: "http://default:8888" } });
			}
			return JSON.stringify({});
		});
		expect(readSearxngUrl()).toBe("http://default:8888");
	});

	it("returns undefined when neither settings file exists (readFileSync throws)", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("ENOENT: no such file");
		});
		expect(readSearxngUrl()).toBeUndefined();
	});

	it("returns undefined when settings exist but have no searxng key", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ theme: "dark" }));
		expect(readSearxngUrl()).toBeUndefined();
	});

	it("project settings override global settings", () => {
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
		vi
			.mocked(readFileSync)
			.mockReturnValue(JSON.stringify({ searxng: { url: "" } }));
		expect(readSearxngUrl()).toBeUndefined();
	});

	it("returns undefined when searxng is not an object", () => {
		vi
			.mocked(readFileSync)
			.mockReturnValue(JSON.stringify({ searxng: "http://localhost:8888" }));
		expect(readSearxngUrl()).toBeUndefined();
	});

	it("returns undefined on malformed JSON", () => {
		vi.mocked(readFileSync).mockReturnValue("not valid json");
		expect(readSearxngUrl()).toBeUndefined();
	});
});

// ─── Tool definition structural checks ──────────────────────────

describe("webSearchTool", () => {
	// The exact name is load-bearing: SEARCH_WEB_SPEC.names uses Set.has()
	// membership to mask/restore it with the /web co-activation toggle.
	it("has the correct name", () => {
		expect(webSearchTool.name).toBe("web-search");
	});

	// Optional in ToolDefinition; the tool drops out of the system prompt
	// (available-tools + guidelines sections) without these.
	it("opts into system-prompt surfacing", () => {
		expect(webSearchTool.promptSnippet).toBeTruthy();
		expect(webSearchTool.promptGuidelines).toBeTruthy();
	});

	describe("renderResult answer badge", () => {
		const theme = { fg: (_style: string, text: string) => text } as any;
		const render = (details: unknown, expanded = false) =>
			(webSearchTool.renderResult as any)(
				{ content: [{ text: "" }], details },
				{ expanded, isPartial: false },
				theme,
				{} as any,
			) as { text: string };

		it("shows 💡 badge when answerCount > 0 and no results", () => {
			const result = render({ answerCount: 2, query: "weather" });
			expect(result.text).toContain("💡");
			expect(result.text).toContain("2 answer(s)");
			expect(result.text).toContain('"weather"');
		});

		it("shows 💡 badge alongside 🔍 when both answers and results present", () => {
			const result = render({
				answerCount: 1,
				resultCount: 3,
				query: "test",
				results: [
					{ title: "A", url: "http://a.com", engine: "google" },
					{ title: "B", url: "http://b.com", engine: "google" },
					{ title: "C", url: "http://c.com", engine: "google" },
				],
			});
			expect(result.text).toContain("💡");
			expect(result.text).toContain("1 answer(s)");
			expect(result.text).toContain("🔍");
			expect(result.text).toContain("3 result(s)");
		});

		it("shows answer text above results when expanded", () => {
			const result = render(
				{
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
				true,
			);
			const answerIdx = result.text.indexOf("Berlin: 14°C, light rain");
			const resultIdx = result.text.indexOf("A");
			expect(answerIdx).toBeGreaterThan(-1);
			expect(resultIdx).toBeGreaterThan(-1);
			expect(answerIdx).toBeLessThan(resultIdx);
		});

		it("shows answer text when expanded with no results", () => {
			const result = render(
				{
					answerCount: 1,
					query: "avg 1 2 3",
					answers: [{ template: "answer/legacy.html", text: "2" }],
				},
				true,
			);
			expect(result.text).toContain("💡");
			expect(result.text).toContain("2");
		});
	});
});

// ─── buildSearchUrl (pure URL construction) ──────────────────

describe("buildSearchUrl", () => {
	const baseOptions = {
		pageno: 1,
		language: "",
		safesearch: "",
		time_range: "",
		category: "",
		engines: "",
	};

	it("strips trailing slashes from the base URL", () => {
		const url = buildSearchUrl("http://localhost:8888///", "test", baseOptions);
		expect(url).toBe("http://localhost:8888/search?format=json&q=test");
	});

	it("maps category to the SearXNG 'categories' param", () => {
		const url = buildSearchUrl("http://localhost:8888", "test", {
			...baseOptions,
			category: "general",
		});
		expect(url).toContain("categories=general");
		expect(url).not.toContain("category=");
	});

	it("only sets pageno when greater than 1", () => {
		const first = buildSearchUrl("http://localhost:8888", "test", baseOptions);
		expect(first).not.toContain("pageno=");

		const second = buildSearchUrl("http://localhost:8888", "test", {
			...baseOptions,
			pageno: 2,
		});
		expect(second).toContain("pageno=2");
	});

	it("passes through optional params when set", () => {
		const url = buildSearchUrl("http://localhost:8888", "test", {
			...baseOptions,
			language: "en",
			safesearch: "1",
			time_range: "day",
			engines: "duckduckgo,bing",
		});
		const params = new URL(url).searchParams;
		expect(params.get("language")).toBe("en");
		expect(params.get("safesearch")).toBe("1");
		expect(params.get("time_range")).toBe("day");
		expect(params.get("engines")).toBe("duckduckgo,bing");
	});
});

// ─── Execute answer rendering (mocked fetch) ─────────────────

describe("execute answer rendering", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Make readSearxngUrl return a valid URL
		vi
			.mocked(readFileSync)
			.mockReturnValue(
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

	// Headers arrive at once; the body read only settles on abort.
	const mockStallingFetch = () =>
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) =>
				Promise.resolve({
					ok: true,
					status: 200,
					text: () =>
						new Promise((_resolve, reject) => {
							init.signal?.addEventListener(
								"abort",
								() =>
									reject(new DOMException("The operation was aborted", "AbortError")),
								{ once: true },
							);
						}),
				}),
			),
		);

	const runSearch = (params: Record<string, unknown>) =>
		webSearchTool.execute("call", params as any, undefined, undefined, {} as any);

	it("degrades gracefully when searxng.url is unconfigured", async () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ theme: "dark" }));
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = (await runSearch({ query: "anything" })) as any;
		expect(r.details.unconfigured).toBe(true);
		expect(r.content[0].text).toContain("Web search is not configured");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("times out when the body stalls after the headers arrive", async () => {
		vi.useFakeTimers();
		try {
			mockStallingFetch();

			const pending = runSearch({ query: "stalled", timeout: 1 });

			// Fire the abort timer deterministically instead of waiting on it.
			await vi.advanceTimersByTimeAsync(1000);
			const result = await pending;

			const r = result as any;
			expect(r.details.timedOut).toBe(true);
			expect(r.content[0].text).toContain("timed out after 1s");
		} finally {
			vi.useRealTimers();
		}
	});

	it("legacy answer renders + bypasses empty-results early return", async () => {
		mockFetch({
			results: [],
			answers: [{ template: "answer/legacy.html", answer: "614.24" }],
			suggestions: [],
		});

		const result = await runSearch({ query: "614.24" });
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

		const result = await runSearch({ query: "weather berlin" });
		// Uses server-provided summary
		const r = result as any;
		expect(r.content[0].text).toContain("Berlin: 14°C, light rain");
		// Secondary detail line
		expect(r.content[0].text).toContain("feels like 12°C");
		expect(r.content[0].text).toContain("humidity 80%");
		expect(r.content[0].text).toContain("wind 18km/h");
		// source
		expect(r.content[0].text).toContain("open-meteo");
	});

	it("unknown template falls back to legacy heuristic", async () => {
		mockFetch({
			results: [],
			answers: [{ template: "answer/future.html", answer: "x" }],
			suggestions: [],
		});

		const result = await runSearch({ query: "future" });
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

		const result = await runSearch({ query: "answer of life" });
		// Answer above results
		const r = result as any;
		const answerIdx = r.content[0].text.indexOf("42");
		const resultIdx = r.content[0].text.indexOf("Result 1");
		expect(answerIdx).toBeGreaterThanOrEqual(0);
		expect(resultIdx).toBeGreaterThan(answerIdx);
	});
});

// Clean module-level state between tests.
beforeEach(() => {
	_resetStateForTest();
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)["__piToolMaskingModuleState"];
});

// ==================================================================
//  Toolset wiring: pi-lean-dimension.web ↔ pi-lean-dimension.search co-activation mirror
// ==================================================================
describe("pi-lean-dimension.web co-activation mirror", () => {
	it("disables pi-lean-dimension.search when pi-lean-dimension.web changed fires with enabled: false", async () => {
		const { pi, events } = mockSearchPi();
		searchExtension(pi);

		events.emit(TOOLSET_EVENTS.changed, {
			id: "pi-lean-dimension.web",
			enabled: false,
		});

		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.not.arrayContaining(["web-search"]),
		);
	});

	it("enables pi-lean-dimension.search when pi-lean-dimension.web changed fires with enabled: true", async () => {
		const { pi, events } = mockSearchPi([]);
		searchExtension(pi);

		events.emit(TOOLSET_EVENTS.changed, {
			id: "pi-lean-dimension.web",
			enabled: true,
		});

		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.arrayContaining(["web-search"]),
		);
	});

	// Allowlist focus (an upstream pi-tool-masking consumer) holds the line —
	// the mirror must not co-activate, so a stale library `doRestore` emitting
	// a web `changed` during resume can't disable search or write a {enabled}
	// entry. Set the shared module state directly.
	it("skips co-activation while allowlist focus is active", async () => {
		const { pi, events } = mockSearchPi(["web-search"]);
		searchExtension(pi);
		(globalThis as any)["__piToolMaskingModuleState"] = {
			defaultResolutionMode: "allowlist",
		};

		(pi.setActiveTools as any).mockClear();
		events.emit(TOOLSET_EVENTS.changed, {
			id: "pi-lean-dimension.web",
			enabled: false,
		});

		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ─── session_start: health probe + status glyph ──────────────

describe("session_start glyph", () => {
	function mockCtx() {
		const setStatus = vi.fn();
		const notify = vi.fn();
		const ctx = {
			ui: {
				setStatus,
				notify,
				// Style-tagged passthrough so glyph color states are assertable.
				theme: { fg: (c: string, t: string) => `${c}:${t}` },
			},
		};
		return { ctx: ctx as any, setStatus, notify };
	}

	async function fireSessionStart(reason: string) {
		const { pi, handlers } = mockSearchPi();
		searchExtension(pi);
		const { ctx, setStatus, notify } = mockCtx();
		// index.ts registers its handler after defineToolset's, so it's last.
		await handlers.get("session_start")!.at(-1)!({ reason }, ctx);
		return { setStatus, notify };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("unconfigured at startup: clears slot and warns once", async () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ theme: "dark" }));

		const { setStatus, notify } = await fireSessionStart("startup");

		expect(setStatus).toHaveBeenCalledWith("search", "");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("not configured"),
			"warning",
		);
	});

	const configuredSettings = () =>
		vi
			.mocked(readFileSync)
			.mockReturnValue(
				JSON.stringify({ searxng: { url: "http://localhost:8888" } }),
			);

	it("reachable at startup: healthy accent glyph + info notify", async () => {
		configuredSettings();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

		const { setStatus, notify } = await fireSessionStart("startup");

		expect(setStatus).toHaveBeenCalledWith("search", "accent:● searxng");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("available"),
			"info",
		);
	});

	it("unreachable at startup: error glyph + warning notify", async () => {
		configuredSettings();
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

		const { setStatus, notify } = await fireSessionStart("startup");

		expect(setStatus).toHaveBeenCalledWith("search", "error:● searxng");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("unreachable"),
			"warning",
		);
	});
});
