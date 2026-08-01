/**
 * Integration tests for browser-toggle.ts — portal-specific concerns.
 *
 * Invariant tests (peer composition, persist shape, restore) live in the
 * pi-tool-masking library. These tests cover portal-specific wiring:
 *   - /web command dispatch
 *   - defaultProfile persistence under portal-conversation-state
 *   - glyph render on session_start
 *   - cached state (getToggleState / getLearnState) reflects library state
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TOOLSET_EVENTS, setDefaultResolutionMode } from "pi-tool-masking";
import browserToggle, {
	getToggleState,
	getLearnState,
	getConversationDefaultProfile,
	_resetToggleStateForTest,
} from "../browser-toggle.js";

// Clean globalThis registry between test files
const REGISTRY_KEY = "__piToolMaskingRegistry";
const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";
const MODULE_STATE_KEY = "__piToolMaskingModuleState";

beforeEach(() => {
	_resetToggleStateForTest();
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[RESTORE_EVENT_KEY];
	delete (globalThis as any)[MODULE_STATE_KEY];
});

// ─── Fixtures ────────────────────────────────────────────────────

const ALL_TOOLS = [
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
	{ name: "web-learn", description: "learn" },
	{ name: "read", description: "read files" },
	{ name: "bash", description: "shell" },
	{ name: "edit", description: "edit files" },
	{ name: "write", description: "write files" },
];

const BROWSER_TOOL_NAMES = new Set(
	ALL_TOOLS.filter(
		(t) =>
			t.name !== "web-learn" &&
			t.name !== "read" &&
			t.name !== "bash" &&
			t.name !== "edit" &&
			t.name !== "write",
	).map((t) => t.name),
);

// ─── Mock builder ────────────────────────────────────────────────

interface MockPi {
	pi: ExtensionAPI;
	events: EventEmitter;
	handlers: Map<string, Array<(...args: any[]) => void>>;
	entryCalls: Array<{ customType: string; data: unknown }>;
}

function mockPi(initialTools?: string[]): MockPi {
	let active = initialTools ?? ALL_TOOLS.map((t) => t.name);
	const eventEmitter = new EventEmitter();
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const entryCalls: Array<{ customType: string; data: unknown }> = [];

	const pi = {
		getAllTools: vi.fn(() => ALL_TOOLS as any),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((names: string[]) => {
			active = [...names];
		}),
		appendEntry: vi.fn((customType: string, data?: unknown) => {
			entryCalls.push({ customType, data });
		}),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(<T>(event: string, handler: (event: T, ctx: any) => void) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler as any);
		}),
		get events() {
			return {
				emit: (channel: string, data: unknown) =>
					eventEmitter.emit(channel, data),
				on: (channel: string, handler: (data: unknown) => void) => {
					eventEmitter.on(channel, handler);
					return () => eventEmitter.off(channel, handler);
				},
			};
		},
	} as unknown as ExtensionAPI;

	return { pi, events: eventEmitter, handlers, entryCalls };
}

function mockCtx(overrides: Partial<ExtensionContext> = {}): any {
	return {
		sessionManager: { getBranch: () => [] },
		ui: {
			setStatus: vi.fn(),
			theme: { fg: (_c: string, t: string) => t },
			notify: vi.fn(),
		},
		mode: "tui",
		cwd: "/mock",
		hasUI: true,
		isIdle: () => true,
		modelRegistry: {} as any,
		...overrides,
	};
}

/** Capture the /web command handler from registerCommand. */
function captureWebHandler(
	pi: ExtensionAPI,
): (args: string, ctx: any) => Promise<void> {
	return (pi.registerCommand as any).mock.calls[0][1].handler;
}

// ==================================================================
//  Default export
// ==================================================================
describe("initBrowserToggle", () => {
	it("registers the /web command", () => {
		const { pi } = mockPi();
		browserToggle(pi);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"web",
			expect.objectContaining({
				description: expect.stringContaining("browser"),
			}),
		);
	});

	it("registers session_start and session_tree handlers", () => {
		const { pi, handlers } = mockPi();
		browserToggle(pi);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_tree")).toBe(true);
	});
});

// ==================================================================
//  /web command dispatch
// ==================================================================
describe("/web command dispatch", () => {
	it("on — enables web tools, disables learn tools", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		await captureWebHandler(pi)("on", mockCtx());

		const finalActive = pi.getActiveTools();
		for (const name of BROWSER_TOOL_NAMES) {
			expect(finalActive).toContain(name);
		}
		expect(finalActive).not.toContain("web-learn");
	});

	it("off — disables web tools (learn cascades off via requires)", async () => {
		const { pi } = mockPi();
		browserToggle(pi);

		await captureWebHandler(pi)("off", mockCtx());

		const finalActive = pi.getActiveTools();
		for (const name of BROWSER_TOOL_NAMES) {
			expect(finalActive).not.toContain(name);
		}
		expect(finalActive).not.toContain("web-learn");
	});

	it("learn — enables both web and learn tools", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		await captureWebHandler(pi)("learn", mockCtx());

		const finalActive = pi.getActiveTools();
		for (const name of BROWSER_TOOL_NAMES) {
			expect(finalActive).toContain(name);
		}
		expect(finalActive).toContain("web-learn");
	});

	it("handles unknown arg — shows status, no state change", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		(pi.setActiveTools as any).mockClear();
		await captureWebHandler(pi)("xyz", mockCtx());

		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("handles empty args — shows status, no state change", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		(pi.setActiveTools as any).mockClear();
		await captureWebHandler(pi)("", mockCtx());

		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ==================================================================
//  getToggleState / getLearnState
// ==================================================================
describe("getToggleState / getLearnState", () => {
	it("start true/false by default", () => {
		expect(getToggleState()).toBe(true);
		expect(getLearnState()).toBe(false);
	});

	it("update after /web on and /web off", async () => {
		const { pi } = mockPi();
		browserToggle(pi);

		const handler = captureWebHandler(pi);
		await handler("off", mockCtx());
		expect(getToggleState()).toBe(false);

		await handler("on", mockCtx());
		expect(getToggleState()).toBe(true);
	});

	it("getLearnState true after /web learn", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		await captureWebHandler(pi)("learn", mockCtx());

		expect(getToggleState()).toBe(true);
		expect(getLearnState()).toBe(true);
	});
});

// ==================================================================
//  appendEntry persist keys
// ==================================================================
describe("persistence key split", () => {
	it("appends toolset-state:pi-lean-dimension.web on enable", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		await captureWebHandler(pi)("on", mockCtx());

		const webCalls = (pi.appendEntry as any).mock.calls.filter(
			(c: any) => c[0] === "toolset-state:pi-lean-dimension.web",
		);
		expect(webCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("appends toolset-state:pi-lean-dimension.web-learn on learn", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		await captureWebHandler(pi)("learn", mockCtx());

		const learnCalls = (pi.appendEntry as any).mock.calls.filter(
			(c: any) => c[0] === "toolset-state:pi-lean-dimension.web-learn",
		);
		expect(learnCalls.length).toBeGreaterThanOrEqual(1);
	});
});

// ==================================================================
//  session_start — renders glyph
// ==================================================================
describe("session_start integration", () => {
	it("renders browser glyph on session_start", async () => {
		const { pi, handlers } = mockPi();
		browserToggle(pi);

		const startHandlers = handlers.get("session_start")!;
		const eventObj = {};
		const ctx = mockCtx();

		for (const h of startHandlers) {
			await h(eventObj, ctx);
		}

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"browser",
			expect.any(String),
		);
	});
});

// ==================================================================
//  conversation-default-profile
// ==================================================================
describe("getConversationDefaultProfile", () => {
	it("returns undefined initially", () => {
		expect(getConversationDefaultProfile()).toBeUndefined();
	});
});

// ==================================================================
//  Focus-mode guard (Fix 3) — /web on/off/learn refuse during inclusion
// ==================================================================
describe("/web focus-mode guard", () => {
	it("refuses /web on/off/learn while inclusion focus is active", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);
		setDefaultResolutionMode(pi, "inclusion");

		for (const sub of ["on", "off", "learn"]) {
			(pi.setActiveTools as any).mockClear();
			const ctx = mockCtx();
			await captureWebHandler(pi)(sub, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Another plugin has active inclusion mode"),
				"warning",
			);
			expect(pi.setActiveTools).not.toHaveBeenCalled();
		}
	});

	it("read-only subcommands unaffected by inclusion focus", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);
		setDefaultResolutionMode(pi, "inclusion");

		for (const sub of ["status", "profile", "cookies", ""]) {
			const ctx = mockCtx();
			await captureWebHandler(pi)(sub, ctx);

			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringContaining("Another plugin has active inclusion mode"),
				"warning",
			);
		}
	});

	it("actuating subcommands work when focus is off (exclusion)", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);
		// default mode is exclusion after beforeEach reset

		const ctx = mockCtx();
		await captureWebHandler(pi)("on", ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("Another plugin has active inclusion mode"),
			"warning",
		);
		const finalActive = pi.getActiveTools();
		for (const name of BROWSER_TOOL_NAMES) {
			expect(finalActive).toContain(name);
		}
	});

	// Allowlist focus (an upstream pi-tool-masking consumer) holds the line
	// the same way inclusion does. The published library type doesn't name
	// "allowlist", so we set the shared module state directly — mirroring what
	// an allowlist-capable consumer's restore writes into globalThis.
	it("refuses /web on/off/learn while allowlist focus is active", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);
		(globalThis as any)[MODULE_STATE_KEY] = {
			defaultResolutionMode: "allowlist",
		};

		for (const sub of ["on", "off", "learn"]) {
			(pi.setActiveTools as any).mockClear();
			const ctx = mockCtx();
			await captureWebHandler(pi)(sub, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Focus mode (allowlist) is active"),
				"warning",
			);
			expect(pi.setActiveTools).not.toHaveBeenCalled();
		}
	});
});

// ==================================================================
//  Glyph sync on external-plugin changed events
// ==================================================================
describe("external-plugin glyph sync", () => {
	it("re-renders browser glyph off when external plugin fires pi-lean-dimension.web disabled", async () => {
		const { pi, handlers, events } = mockPi();
		browserToggle(pi);

		// Fire session_start once to establish _lastCtx.
		// After this, the glyph is rendered correctly for default state.
		const startCtx = mockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, startCtx);
		}

		// Clear the initial render call so we only see the external-plugin re-render.
		vi.clearAllMocks();

		// Simulate an external plugin disabling pi-lean-dimension.web — it has
		// already removed browser tools from the active set.
		const nonBrowser = ALL_TOOLS.map((t) => t.name).filter(
			(n) => !BROWSER_TOOL_NAMES.has(n),
		);
		(pi.getActiveTools as any).mockReturnValue(nonBrowser);

		events.emit(TOOLSET_EVENTS.changed, {
			id: "pi-lean-dimension.web",
			enabled: false,
		});

		expect(startCtx.ui.setStatus).toHaveBeenCalledWith("browser", "○ web off");
	});
});
