/**
 * Tests for browser-toggle.ts — the companion extension that provides
 * /web on | off | status commands for toggling browser automation tools.
 *
 * Tests cover:
 * - Filtering logic (getRegisteredBrowserTools)
 * - State queries (isBrowserEnabled)
 * - State mutations (applyBrowserState, persistState)
 * - Branch-aware restoration (restoreFromBranch)
 * - Config-driven default (readBrowserToggleConfig, applyConfigDefault)
 * - Command registration and handler dispatch
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import browserToggle, {
	getRegisteredBrowserTools,
	isBrowserEnabled,
	applyBrowserState,
	persistState,
	restoreFromBranch,
	getToggleState,
	_resetToggleStateForTest,
	readBrowserToggleConfig,
	applyConfigDefault,
	getRegisteredLearnTools,
	isLearnEnabled,
	applyLearnState,
	migrateLegacyState,
	type BrowserToggleState,
} from "../browser-toggle";

// Mock node:fs so readBrowserToggleConfig and applyConfigDefault can be
// tested without touching the real filesystem.
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

// ─── Fixtures ────────────────────────────────────────────────────

const ALL_BROWSER_TOOLS = [
	{ name: "web-fetch", description: "fetch" },
	{ name: "browser-navigate", description: "navigate" },
	{ name: "browser-snapshot", description: "snapshot" },
	{ name: "browser-click", description: "click" },
	{ name: "browser-type", description: "type" },
	{ name: "browser-scroll", description: "scroll" },
	{ name: "browser-back", description: "back" },
	{ name: "browser-press", description: "press" },
	{ name: "browser-console", description: "console" },
	{ name: "browser-inspect", description: "inspect" },
	{ name: "web-guide", description: "guide" },
];

const SOME_BROWSER_TOOLS = [
	{ name: "web-fetch", description: "fetch" },
	{ name: "browser-navigate", description: "navigate" },
	{ name: "browser-console", description: "console" },
];

const NON_BROWSER_TOOLS = [
	{ name: "read", description: "read files" },
	{ name: "bash", description: "shell" },
	{ name: "edit", description: "edit files" },
	{ name: "write", description: "write files" },
	{ name: "grep", description: "search" },
	{ name: "find", description: "find files" },
	{ name: "ls", description: "list files" },
];

// ─── Mock builders ───────────────────────────────────────────────

interface MockPiOptions {
	tools?: Array<{ name: string; description?: string }>;
	activeTools?: string[];
}

/**
 * Build a minimal ExtensionAPI mock for testing the helper functions.
 * Only implements the methods that the helpers actually call.
 */
function mockPi(opts: MockPiOptions = {}): ExtensionAPI {
	const allTools = opts.tools ?? [];
	let active = opts.activeTools ?? allTools.map((t) => t.name);

	return {
		getAllTools: vi.fn(() => allTools as any),
		getActiveTools: vi.fn(() => active),
		setActiveTools: vi.fn((names: string[]) => {
			active = names;
		}),
		appendEntry: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI;
}

/**
 * Build a minimal ExtensionContext mock for restoreFromBranch tests.
 */
function mockContext(
	branchEntries: Array<{
		type: string;
		customType?: string;
		data?: unknown;
	}>,
): ExtensionContext {
	return {
		sessionManager: {
			getBranch: vi.fn(() => branchEntries as any),
		},
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
}

// ==================================================================
//  getRegisteredBrowserTools
// ==================================================================
describe("getRegisteredBrowserTools", () => {
	it("returns empty array when no tools are registered", () => {
		const pi = mockPi({ tools: [] });
		expect(getRegisteredBrowserTools(pi)).toEqual([]);
	});

	it("returns empty array when only non-browser tools are registered", () => {
		const pi = mockPi({ tools: NON_BROWSER_TOOLS });
		expect(getRegisteredBrowserTools(pi)).toEqual([]);
	});

	it("returns only browser tools when mixed with other tools", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
		});
		expect(getRegisteredBrowserTools(pi)).toEqual(
			ALL_BROWSER_TOOLS.map((t) => t.name),
		);
	});

	it("returns all 13 browser tools when fully loaded", () => {
		const pi = mockPi({ tools: ALL_BROWSER_TOOLS });
		expect(getRegisteredBrowserTools(pi)).toEqual(
			ALL_BROWSER_TOOLS.map((t) => t.name),
		);
	});

	it("returns a subset when only some browser tools are registered", () => {
		const pi = mockPi({ tools: SOME_BROWSER_TOOLS });
		expect(getRegisteredBrowserTools(pi)).toEqual(
			SOME_BROWSER_TOOLS.map((t) => t.name),
		);
	});

	it("is case-sensitive (tool names are always lowercase)", () => {
		const pi = mockPi({
			tools: [
				{ name: "Web-Fetch" },
				{ name: "BROWSER-NAVIGATE" },
				{ name: "web-fetch" },
			],
		});
		// Only the exact-lowercase match should be returned
		expect(getRegisteredBrowserTools(pi)).toEqual(["web-fetch"]);
	});

	it("ignores tool metadata beyond the name field", () => {
		const tools = [
			{ name: "web-fetch", description: "a", extra: 1 },
			{ name: "browser-scroll", description: "b", promptGuidelines: [] },
		];
		const pi = mockPi({ tools: tools as any });
		expect(getRegisteredBrowserTools(pi)).toEqual([
			"web-fetch",
			"browser-scroll",
		]);
	});
});

// ==================================================================
//  isBrowserEnabled
// ==================================================================
describe("isBrowserEnabled", () => {
	it("returns true when all browser tools are active", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		expect(isBrowserEnabled(pi)).toBe(true);
	});

	it("returns false when no browser tools are active", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		expect(isBrowserEnabled(pi)).toBe(false);
	});

	it("returns true when at least one browser tool is active (partial)", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: ["read", "bash", "web-fetch", "browser-navigate"],
		});
		expect(isBrowserEnabled(pi)).toBe(true);
	});

	it("returns true when no browser tools exist (vacuously enabled)", () => {
		const pi = mockPi({
			tools: NON_BROWSER_TOOLS,
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		expect(isBrowserEnabled(pi)).toBe(true);
	});

	it("returns false when active set is empty and browser tools exist", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: [],
		});
		expect(isBrowserEnabled(pi)).toBe(false);
	});
});

// ==================================================================
//  applyBrowserState
// ==================================================================
describe("applyBrowserState(true) — enable", () => {
	it("adds browser tools to the active set", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, true);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		expect(calledWith).toEqual(
			expect.arrayContaining(ALL_BROWSER_TOOLS.map((t) => t.name)),
		);
	});

	it("preserves non-browser tools when enabling", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, true);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		for (const tool of NON_BROWSER_TOOLS.map((t) => t.name)) {
			expect(calledWith).toContain(tool);
		}
	});

	it("does not duplicate already-active browser tools", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				"web-fetch",
				"browser-navigate",
			],
		});
		applyBrowserState(pi, true);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		// Each browser tool appears exactly once
		for (const tool of ALL_BROWSER_TOOLS.map((t) => t.name)) {
			expect(calledWith.filter((n) => n === tool)).toHaveLength(1);
		}
	});

	it("reports the union of current and browser tools (no duplicates)", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, true);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		const expected = [
			...NON_BROWSER_TOOLS.map((t) => t.name),
			...ALL_BROWSER_TOOLS.map((t) => t.name),
		];
		expect(new Set(calledWith)).toEqual(new Set(expected));
	});

	it("is a no-op when no browser tools are registered", () => {
		const pi = mockPi({
			tools: NON_BROWSER_TOOLS,
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, true);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("applyBrowserState(false) — disable", () => {
	it("removes browser tools from the active set", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				...ALL_BROWSER_TOOLS.map((t) => t.name),
			],
		});
		applyBrowserState(pi, false);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		for (const tool of ALL_BROWSER_TOOLS.map((t) => t.name)) {
			expect(calledWith).not.toContain(tool);
		}
	});

	it("preserves non-browser tools when disabling", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				...ALL_BROWSER_TOOLS.map((t) => t.name),
			],
		});
		applyBrowserState(pi, false);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		for (const tool of NON_BROWSER_TOOLS.map((t) => t.name)) {
			expect(calledWith).toContain(tool);
		}
	});

	it("is a no-op when no browser tools are registered", () => {
		const pi = mockPi({
			tools: NON_BROWSER_TOOLS,
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, false);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("is a no-op when no browser tools are active (removes nothing)", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, false);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		expect(calledWith).toEqual(NON_BROWSER_TOOLS.map((t) => t.name));
	});

	it("can be applied repeatedly without error", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				...ALL_BROWSER_TOOLS.map((t) => t.name),
			],
		});
		applyBrowserState(pi, false);
		applyBrowserState(pi, false);
		expect(pi.setActiveTools).toHaveBeenCalledTimes(2);
		// Second call should also produce a clean set (no browser tools)
		const calledWith: string[] = (pi.setActiveTools as ReturnType<typeof vi.fn>)
			.mock.calls[1]![0] as string[];
		for (const tool of ALL_BROWSER_TOOLS.map((t) => t.name)) {
			expect(calledWith).not.toContain(tool);
		}
	});
});

// ==================================================================
//  persistState
// ==================================================================
describe("persistState", () => {
	it("calls appendEntry with customType 'browser-toggle-state'", () => {
		const pi = mockPi();
		persistState(pi, {
			browserToolsEnabled: true,
			learnToolsEnabled: false,
			defaultProfile: "none",
		});
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"browser-toggle-state",
			expect.any(Object),
		);
	});

	it("stores browserToolsEnabled: true and learnToolsEnabled: false on /web on", () => {
		const pi = mockPi();
		persistState(pi, {
			browserToolsEnabled: true,
			learnToolsEnabled: false,
			defaultProfile: "none",
		});
		expect(pi.appendEntry).toHaveBeenCalledWith("browser-toggle-state", {
			browserToolsEnabled: true,
			learnToolsEnabled: false,
			defaultProfile: "none",
		});
	});

	it("stores browserToolsEnabled: false and learnToolsEnabled: false on /web off", () => {
		const pi = mockPi();
		persistState(pi, {
			browserToolsEnabled: false,
			learnToolsEnabled: false,
			defaultProfile: "none",
		});
		expect(pi.appendEntry).toHaveBeenCalledWith("browser-toggle-state", {
			browserToolsEnabled: false,
			learnToolsEnabled: false,
			defaultProfile: "none",
		});
	});

	it("stores browserToolsEnabled: true and learnToolsEnabled: true on /web learn", () => {
		const pi = mockPi();
		persistState(pi, {
			browserToolsEnabled: true,
			learnToolsEnabled: true,
			defaultProfile: "none",
		});
		expect(pi.appendEntry).toHaveBeenCalledWith("browser-toggle-state", {
			browserToolsEnabled: true,
			learnToolsEnabled: true,
			defaultProfile: "none",
		});
	});
});

// ==================================================================
//  getToggleState
// ==================================================================
describe("getToggleState", () => {
	beforeEach(() => {
		_resetToggleStateForTest();
	});

	it("returns true by default (browser tools start enabled)", () => {
		expect(getToggleState()).toBe(true);
	});

	it("returns false after disabling via applyBrowserState", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, false);
		expect(getToggleState()).toBe(false);
	});

	it("returns true after re-enabling via applyBrowserState", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, true);
		expect(getToggleState()).toBe(true);
	});

	it("is not affected by persistState", () => {
		persistState(mockPi(), {
			browserToolsEnabled: true,
			learnToolsEnabled: false,
			defaultProfile: "none",
		});
		// persistState doesn't call applyBrowserState, so state is unchanged
		expect(getToggleState()).toBe(true);
	});

	it("returns true when browserToolsEnabled is true (regardless of learn state)", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		// getToggleState returns browserToolsEnabled only (status bar compat)
		applyBrowserState(pi, true);
		applyLearnState(pi, true);
		expect(getToggleState()).toBe(true);
	});

	it("reflects the most recent call to applyBrowserState", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		applyBrowserState(pi, false);
		expect(getToggleState()).toBe(false);
		applyBrowserState(pi, true);
		expect(getToggleState()).toBe(true);
		applyBrowserState(pi, false);
		expect(getToggleState()).toBe(false);
	});
});

// ==================================================================
//  restoreFromBranch
// ==================================================================
describe("restoreFromBranch", () => {
	it("does nothing when the branch has no saved state", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		const ctx = mockContext([
			{ type: "message", data: { role: "user" } },
			{ type: "message", data: { role: "assistant" } },
		]);
		vi.spyOn(pi, "setActiveTools");
		restoreFromBranch(pi, ctx);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("applies saved browserToolsEnabled=true learnToolsEnabled=false state ", () => {
		const allNames = ALL_BROWSER_TOOLS.map((t) => t.name);
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name), // browsers off
		});
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: {
					browserToolsEnabled: true,
					learnToolsEnabled: false,
					defaultProfile: "none",
				} satisfies BrowserToggleState,
			},
		]);
		restoreFromBranch(pi, ctx);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		expect(setActive).toHaveBeenCalledWith(expect.arrayContaining(allNames));
	});

	it("applies saved browserToolsEnabled=false learnToolsEnabled=false state", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				...ALL_BROWSER_TOOLS.map((t) => t.name),
			],
		});
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: {
					browserToolsEnabled: false,
					learnToolsEnabled: false,
					defaultProfile: "none",
				} satisfies BrowserToggleState,
			},
		]);
		restoreFromBranch(pi, ctx);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		for (const tool of ALL_BROWSER_TOOLS.map((t) => t.name)) {
			expect(calledWith).not.toContain(tool);
		}
	});

	it("picks the last saved state when multiple toggles exist in branch", () => {
		const allNames = ALL_BROWSER_TOOLS.map((t) => t.name);
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { browserToolsEnabled: true, learnToolsEnabled: false },
			},
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { browserToolsEnabled: false, learnToolsEnabled: false },
			},
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { browserToolsEnabled: true, learnToolsEnabled: true },
			},
		]);
		restoreFromBranch(pi, ctx);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		expect(setActive).toHaveBeenCalledWith(expect.arrayContaining(allNames));
	});

	it("does nothing when no browser tools are registered", () => {
		const pi = mockPi({ tools: NON_BROWSER_TOOLS });
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { enabled: false },
			},
		]);
		vi.spyOn(pi, "setActiveTools");
		restoreFromBranch(pi, ctx);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("gracefully handles stale state (tool no longer registered)", () => {
		const pi = mockPi({
			tools: NON_BROWSER_TOOLS, // only web-fetch removed from all tools
			activeTools: [...NON_BROWSER_TOOLS.map((t) => t.name), "web-fetch"],
		});
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: {
					browserToolsEnabled: false,
					learnToolsEnabled: false,
					defaultProfile: "none",
				} satisfies BrowserToggleState,
			},
		]);
		// Should not throw — with no browser tools currently registered,
		// restoreFromBranch returns early (no-op).
		expect(() => restoreFromBranch(pi, ctx)).not.toThrow();
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ==================================================================
//  Default export — factory & command handler
// ==================================================================
describe("default export (extension factory)", () => {
	it("registers the '/web' command", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		browserToggle(pi);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"web",
			expect.objectContaining({
				description: expect.stringContaining("browser"),
			}),
		);
	});

	it("registers session_start handler", () => {
		const pi = mockPi();
		browserToggle(pi);
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
	});

	it("registers session_tree handler", () => {
		const pi = mockPi();
		browserToggle(pi);
		expect(pi.on).toHaveBeenCalledWith("session_tree", expect.any(Function));
	});
});

describe("command handler dispatch (via factory closure)", () => {
	it("handles 'on' when browsers are off — updates state", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name), // browsers off
		});
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("on", {
				ui: { notify: vi.fn(), setStatus: vi.fn() },
			} as any);
		}) as any;
		pi.setActiveTools = vi.fn();

		browserToggle(pi);
		expect(pi.setActiveTools).toHaveBeenCalled();
	});

	it("handles 'on' — does not short-circuit (no early return)", () => {
		// In the new three-state version, 'on' always calls applyBrowserState/applyLearnState
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				...ALL_BROWSER_TOOLS.map((t) => t.name),
			],
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("on", {
				ui: { notify: vi.fn(), setStatus: vi.fn() },
			} as any);
		}) as any;

		browserToggle(pi);
		// In the new three-state version, /web on always applies (no short-circuit)
		expect(pi.setActiveTools).toHaveBeenCalled();
	});

	it("handles 'off' when browsers are on — updates state", () => {
		const nonBrowserNames = NON_BROWSER_TOOLS.map((t) => t.name);
		const allNames = ALL_BROWSER_TOOLS.map((t) => t.name);
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [...nonBrowserNames, ...allNames],
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("off", {
				ui: { notify: vi.fn(), setStatus: vi.fn() },
			} as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).toHaveBeenCalled();
	});

	it("handles 'off' when already disabled — still updates state", () => {
		// In the new three-state version, 'off' always applies (no early return)
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("off", {
				ui: { notify: vi.fn(), setStatus: vi.fn() },
			} as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).toHaveBeenCalled();
	});

	it("handles 'learn' — enables both browser and learn tools", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("learn", {
				ui: { notify: vi.fn(), setStatus: vi.fn() },
			} as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).toHaveBeenCalled();
	});

	it("handles unknown arg (e.g. 'xyz') — shows status, no state change", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("xyz", {
				ui: { notify: vi.fn(), setStatus: vi.fn() },
			} as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("handles missing pi-browser — does not throw", () => {
		const pi = mockPi({ tools: NON_BROWSER_TOOLS });
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("on", {
				ui: { notify: vi.fn(), setStatus: vi.fn() },
			} as any);
		}) as any;
		// Should not throw even though no browser tools exist
		expect(() => browserToggle(pi)).not.toThrow();
	});

	it("handles empty args string — shows status, no state change", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("", { ui: { notify: vi.fn(), setStatus: vi.fn() } } as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ==================================================================
//  getRegisteredLearnTools / isLearnEnabled / applyLearnState
// ==================================================================
describe("getRegisteredLearnTools", () => {
	it("returns empty array when no learn tools registered", () => {
		const pi = mockPi({ tools: ALL_BROWSER_TOOLS });
		expect(getRegisteredLearnTools(pi)).toEqual([]);
	});

	it("returns web-learn when it's in the tool list", () => {
		const tools = [
			...ALL_BROWSER_TOOLS,
			{ name: "web-learn", description: "learn" },
		];
		const pi = mockPi({ tools });
		expect(getRegisteredLearnTools(pi)).toEqual(["web-learn"]);
	});

	it("is case-sensitive (tool names are always lowercase)", () => {
		const tools = [
			...ALL_BROWSER_TOOLS,
			{ name: "Web-Learn" },
			{ name: "web-learn" },
		];
		const pi = mockPi({ tools });
		expect(getRegisteredLearnTools(pi)).toEqual(["web-learn"]);
	});
});

describe("isLearnEnabled", () => {
	it("returns true when web-learn is active", () => {
		const tools = [
			...ALL_BROWSER_TOOLS,
			{ name: "web-learn", description: "learn" },
		];
		const pi = mockPi({
			tools,
			activeTools: [...ALL_BROWSER_TOOLS.map((t) => t.name), "web-learn"],
		});
		expect(isLearnEnabled(pi)).toBe(true);
	});

	it("returns false when web-learn is not active", () => {
		const tools = [
			...ALL_BROWSER_TOOLS,
			{ name: "web-learn", description: "learn" },
		];
		const pi = mockPi({
			tools,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		expect(isLearnEnabled(pi)).toBe(false);
	});

	it("returns true when no learn tools exist (vacuously enabled)", () => {
		const pi = mockPi({ tools: ALL_BROWSER_TOOLS });
		expect(isLearnEnabled(pi)).toBe(true);
	});
});

describe("applyLearnState", () => {
	it("enable adds web-learn to active set", () => {
		const tools = [
			...ALL_BROWSER_TOOLS,
			{ name: "web-learn", description: "learn" },
		];
		const pi = mockPi({
			tools,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		applyLearnState(pi, true);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		expect(calledWith).toContain("web-learn");
	});

	it("disable removes web-learn from active set", () => {
		const tools = [
			...ALL_BROWSER_TOOLS,
			{ name: "web-learn", description: "learn" },
		];
		const allNames = [...ALL_BROWSER_TOOLS.map((t) => t.name), "web-learn"];
		const pi = mockPi({
			tools,
			activeTools: allNames,
		});
		applyLearnState(pi, false);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		expect(calledWith).not.toContain("web-learn");
	});

	it("is a no-op when no learn tools are registered", () => {
		const pi = mockPi({ tools: ALL_BROWSER_TOOLS });
		applyLearnState(pi, true);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ==================================================================
//  applyConfigDefault — learn state
// ==================================================================
describe("applyConfigDefault (learn state)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("learn state starts disabled", () => {
		// applyConfigDefault should set learnToolsEnabled to false
		const tools = [
			...ALL_BROWSER_TOOLS,
			{ name: "web-learn", description: "learn" },
		];
		const pi = mockPi({
			tools,
			activeTools: [...ALL_BROWSER_TOOLS.map((t) => t.name), "web-learn"],
		});
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ browserToggle: { defaultEnabled: true } }),
		);
		applyConfigDefault(pi);

		// applyConfigDefault calls setActiveTools twice:
		// 1. applyBrowserState(true) — adds browser tools
		// 2. applyLearnState(false) — removes web-learn
		// Check the *last* call's result (not the first)
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const lastCall = setActive.mock.calls[setActive.mock.calls.length - 1]!;
		const calledWith: string[] = lastCall[0] as string[];
		expect(calledWith).not.toContain("web-learn");
	});

	it("persists learnToolsEnabled: false", () => {
		const pi = mockPi({ tools: ALL_BROWSER_TOOLS });
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ browserToggle: { defaultEnabled: true } }),
		);
		applyConfigDefault(pi);

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"browser-toggle-state",
			expect.objectContaining({ learnToolsEnabled: false }),
		);
	});
});

// ==================================================================
//  readBrowserToggleConfig
// ==================================================================
describe("readBrowserToggleConfig", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when neither settings file exists (default)", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		expect(readBrowserToggleConfig()).toBe(true);
	});

	it("returns true when settings files exist but have no browserToggle key", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ theme: "dark" }));
		expect(readBrowserToggleConfig()).toBe(true);
	});

	it("returns false when browserToggle.defaultEnabled is false (global)", () => {
		vi.mocked(existsSync).mockImplementation(
			(path) => typeof path === "string" && path.includes("settings.json"),
		);
		vi.mocked(readFileSync).mockImplementation((path: unknown) =>
			typeof path === "string" && path.includes(".pi/agent/settings")
				? JSON.stringify({ browserToggle: { defaultEnabled: false } })
				: JSON.stringify({ theme: "light" }),
		);
		expect(readBrowserToggleConfig()).toBe(false);
	});

	it("returns true when browserToggle.defaultEnabled is true (global)", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((path: unknown) =>
			typeof path === "string" && path.includes(".pi/agent/settings")
				? JSON.stringify({ browserToggle: { defaultEnabled: true } })
				: JSON.stringify({}),
		);
		expect(readBrowserToggleConfig()).toBe(true);
	});

	it("project settings override global settings", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((path: unknown) =>
			typeof path === "string" && path.includes(".pi/agent/settings")
				? JSON.stringify({ browserToggle: { defaultEnabled: true } })
				: JSON.stringify({ browserToggle: { defaultEnabled: false } }),
		);
		expect(readBrowserToggleConfig()).toBe(false);
	});

	it("returns true on malformed JSON", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue("not valid json");
		expect(readBrowserToggleConfig()).toBe(true);
	});

	it("returns true when browserToggle.defaultEnabled is not a boolean", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((path: unknown) =>
			typeof path === "string" && path.includes(".pi/agent/settings")
				? JSON.stringify({ browserToggle: { defaultEnabled: "yes" } })
				: JSON.stringify({}),
		);
		expect(readBrowserToggleConfig()).toBe(true);
	});

	it("returns true when browserToggle is not an object", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((path: unknown) =>
			typeof path === "string" && path.includes(".pi/agent/settings")
				? JSON.stringify({ browserToggle: "on" })
				: JSON.stringify({}),
		);
		expect(readBrowserToggleConfig()).toBe(true);
	});

	it("returns true when settings file content is not an object", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue("[]");
		expect(readBrowserToggleConfig()).toBe(true);
	});
});

// ==================================================================
//  applyConfigDefault
// ==================================================================
describe("applyConfigDefault", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls applyBrowserState with the config value (true)", () => {
		// Config says enabled
		vi.mocked(existsSync).mockImplementation(
			(path) => typeof path === "string" && path.includes("settings.json"),
		);
		vi.mocked(readFileSync).mockImplementation((path: unknown) =>
			typeof path === "string" && path.includes(".pi/agent/settings")
				? JSON.stringify({ browserToggle: { defaultEnabled: true } })
				: JSON.stringify({}),
		);

		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name), // browsers off
		});
		vi.spyOn(pi, "setActiveTools");

		applyConfigDefault(pi);

		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.arrayContaining(ALL_BROWSER_TOOLS.map((t) => t.name)),
		);
	});

	it("calls applyBrowserState with the config value (false)", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((path: unknown) =>
			typeof path === "string" && path.includes(".pi/agent/settings")
				? JSON.stringify({ browserToggle: { defaultEnabled: false } })
				: JSON.stringify({}),
		);

		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				...ALL_BROWSER_TOOLS.map((t) => t.name),
			],
		});
		vi.spyOn(pi, "setActiveTools");

		applyConfigDefault(pi);

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as string[];
		expect(calledWith).not.toContain("web-fetch");
		expect(calledWith).not.toContain("browser-navigate");
	});

	it("persists the applied state", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ browserToggle: { defaultEnabled: true } }),
		);

		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});

		applyConfigDefault(pi);

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"browser-toggle-state",
			expect.objectContaining({
				browserToolsEnabled: true,
				learnToolsEnabled: false,
			}),
		);
	});

	it("is a no-op when no browser tools are registered", () => {
		const pi = mockPi({
			tools: NON_BROWSER_TOOLS,
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		vi.spyOn(pi, "setActiveTools");

		applyConfigDefault(pi);

		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ==================================================================
//  restoreFromBranch — updated return value
// ==================================================================
describe("restoreFromBranch (return value)", () => {
	it("returns true when saved state was found and applied", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: {
					browserToolsEnabled: true,
					learnToolsEnabled: false,
					defaultProfile: "none",
				} satisfies BrowserToggleState,
			},
		]);
		expect(restoreFromBranch(pi, ctx)).toBe(true);
	});

	it("returns false when no saved state in branch", () => {
		const pi = mockPi({
			tools: ALL_BROWSER_TOOLS,
			activeTools: ALL_BROWSER_TOOLS.map((t) => t.name),
		});
		const ctx = mockContext([
			{ type: "message", data: { role: "user" } },
			{ type: "message", data: { role: "assistant" } },
		]);
		expect(restoreFromBranch(pi, ctx)).toBe(false);
	});

	it("returns false when no browser tools are registered", () => {
		const pi = mockPi({ tools: NON_BROWSER_TOOLS });
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { browserToolsEnabled: false, learnToolsEnabled: false },
			},
		]);
		expect(restoreFromBranch(pi, ctx)).toBe(false);
	});

	// ── Legacy compat ──────────────────────────────────────────────

	it("migrateLegacyState converts {enabled: true} to new schema", () => {
		const result = migrateLegacyState({ enabled: true });
		expect(result).toEqual({
			browserToolsEnabled: true,
			learnToolsEnabled: true,
			defaultProfile: "none",
		});
	});

	it("migrateLegacyState converts {enabled: false} to new schema", () => {
		const result = migrateLegacyState({ enabled: false });
		expect(result).toEqual({
			browserToolsEnabled: false,
			learnToolsEnabled: false,
			defaultProfile: "none",
		});
	});

	it("migrateLegacyState returns null for non-legacy objects", () => {
		expect(migrateLegacyState({ foo: "bar" })).toBeNull();
	});

	it("restoreFromBranch handles legacy {enabled: true} entry", () => {
		const allNames = ALL_BROWSER_TOOLS.map((t) => t.name);
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { enabled: true },
			},
		]);
		restoreFromBranch(pi, ctx);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		expect(setActive).toHaveBeenCalledWith(expect.arrayContaining(allNames));
	});

	it("restoreFromBranch handles legacy {enabled: false} entry", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				...ALL_BROWSER_TOOLS.map((t) => t.name),
			],
		});
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { enabled: false },
			},
		]);
		restoreFromBranch(pi, ctx);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		const calledWith: string[] = setActive.mock.calls[0]![0] as string[];
		for (const tool of ALL_BROWSER_TOOLS.map((t) => t.name)) {
			expect(calledWith).not.toContain(tool);
		}
	});
});
