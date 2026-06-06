/**
 * Tests for browser-toggle.ts — the companion extension that provides
 * /web on | off | status commands for toggling browser automation tools.
 *
 * Tests cover:
 * - Filtering logic (getRegisteredBrowserTools)
 * - State queries (isBrowserEnabled)
 * - State mutations (applyBrowserState, persistState)
 * - Branch-aware restoration (restoreFromBranch)
 * - Command registration and handler dispatch
 */

import { describe, it, expect, vi } from "vitest";
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
	type BrowserToggleState,
} from "../browser-toggle";

// ─── Fixtures ────────────────────────────────────────────────────

const ALL_BROWSER_TOOLS = [
	{ name: "web-fetch", description: "fetch" },
	{ name: "browser-navigate", description: "navigate" },
	{ name: "browser-snapshot", description: "snapshot" },
	{ name: "browser-click", description: "click" },
	{ name: "browser-type", description: "type" },
	{ name: "browser-scroll", description: "scroll" },
	{ name: "browser-screenshot", description: "screenshot" },
	{ name: "browser-get-images", description: "get images" },
	{ name: "browser-back", description: "back" },
	{ name: "browser-press", description: "press" },
	{ name: "browser-console", description: "console" },
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

	it("returns all 11 browser tools when fully loaded", () => {
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
		persistState(pi, true);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"browser-toggle-state",
			expect.any(Object),
		);
	});

	it("stores enabled: true when toggling on", () => {
		const pi = mockPi();
		persistState(pi, true);
		expect(pi.appendEntry).toHaveBeenCalledWith("browser-toggle-state", {
			enabled: true,
		});
	});

	it("stores enabled: false when toggling off", () => {
		const pi = mockPi();
		persistState(pi, false);
		expect(pi.appendEntry).toHaveBeenCalledWith("browser-toggle-state", {
			enabled: false,
		});
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

	it("applies saved enabled=true state", () => {
		const allNames = ALL_BROWSER_TOOLS.map((t) => t.name);
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name), // browsers off
		});
		const ctx = mockContext([
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { enabled: true } satisfies BrowserToggleState,
			},
		]);
		restoreFromBranch(pi, ctx);
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>;
		expect(setActive).toHaveBeenCalledWith(expect.arrayContaining(allNames));
	});

	it("applies saved enabled=false state", () => {
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
				data: { enabled: false } satisfies BrowserToggleState,
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
				data: { enabled: true },
			},
			{
				type: "custom",
				customType: "browser-toggle-state",
				data: { enabled: false },
			},
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
				data: { enabled: false } satisfies BrowserToggleState,
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
			opts.handler("on", { ui: { notify: vi.fn() } } as any);
		}) as any;
		pi.setActiveTools = vi.fn();

		browserToggle(pi);
		expect(pi.setActiveTools).toHaveBeenCalled();
	});

	it("handles 'on' when already enabled — no state change", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: [
				...NON_BROWSER_TOOLS.map((t) => t.name),
				...ALL_BROWSER_TOOLS.map((t) => t.name),
			],
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("on", { ui: { notify: vi.fn() } } as any);
		}) as any;

		browserToggle(pi);
		// Should short-circuit before calling setActiveTools
		expect(pi.setActiveTools).not.toHaveBeenCalled();
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
			opts.handler("off", { ui: { notify: vi.fn() } } as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).toHaveBeenCalled();
	});

	it("handles 'off' when already disabled — no state change", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("off", { ui: { notify: vi.fn() } } as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("handles unknown arg (e.g. 'xyz') — shows status, no state change", () => {
		const pi = mockPi({
			tools: [...ALL_BROWSER_TOOLS, ...NON_BROWSER_TOOLS],
			activeTools: NON_BROWSER_TOOLS.map((t) => t.name),
		});
		pi.setActiveTools = vi.fn();
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("xyz", { ui: { notify: vi.fn() } } as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("handles missing pi-browser — does not throw", () => {
		const pi = mockPi({ tools: NON_BROWSER_TOOLS });
		pi.registerCommand = vi.fn((_name, opts) => {
			opts.handler("on", { ui: { notify: vi.fn() } } as any);
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
			opts.handler("", { ui: { notify: vi.fn() } } as any);
		}) as any;

		browserToggle(pi);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});
