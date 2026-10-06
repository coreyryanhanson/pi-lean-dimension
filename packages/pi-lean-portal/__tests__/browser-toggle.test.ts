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

import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
} from "vitest";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOLSET_EVENTS, defineToolset } from "pi-tool-masking";
import { mockCtx, captureWebHandler } from "./helpers/mock-pi.js";
import browserToggle, {
	getToggleState,
	getLearnState,
	getConversationDefaultProfile,
	resetToggleModuleState,
} from "../browser-toggle.js";

// Clean globalThis registry between test files
const REGISTRY_KEY = "__piToolMaskingRegistry";
const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";

beforeEach(() => {
	resetToggleModuleState();
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[RESTORE_EVENT_KEY];
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

function mockPi(
	initialTools?: string[],
	extraTools: { name: string; description?: string }[] = [],
): MockPi {
	let active = initialTools ?? ALL_TOOLS.map((t) => t.name);
	const eventEmitter = new EventEmitter();
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const entryCalls: Array<{ customType: string; data: unknown }> = [];

	const pi = {
		getAllTools: vi.fn(() => [...ALL_TOOLS, ...extraTools] as any),
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
				emit: (channel: string, data: unknown) => eventEmitter.emit(channel, data),
				on: (channel: string, handler: (data: unknown) => void) => {
					eventEmitter.on(channel, handler);
					return () => eventEmitter.off(channel, handler);
				},
			};
		},
	} as unknown as ExtensionAPI;

	return { pi, events: eventEmitter, handlers, entryCalls };
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

	// pi re-invokes the factory per load pass; a second invocation must
	// drain the previous glyph-sync listeners instead of stacking them.
	it("does not stack glyph-sync listeners across factory re-invocations", () => {
		const { pi, events } = mockPi();
		browserToggle(pi);
		browserToggle(pi);
		expect(events.listenerCount(TOOLSET_EVENTS.changed)).toBe(1);
		expect(events.listenerCount(TOOLSET_EVENTS.restored)).toBe(1);
	});
});

// ==================================================================
//  /web command dispatch
// ==================================================================
describe("/web command dispatch", () => {
	it("handles unknown or empty args — shows status, no state change", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		for (const args of ["xyz", ""]) {
			(pi.setActiveTools as any).mockClear();
			await captureWebHandler(pi)(args, mockCtx());

			expect(pi.setActiveTools).not.toHaveBeenCalled();
		}
	});
});

// ==================================================================
//  /web co-activation batches (search installed)
// ==================================================================
describe("/web co-activation batches", () => {
	// Hermetic settings tier: masking merges toolsetDefaults from the real
	// ~/.pi/agent/settings.json, which varies per machine and would skew the
	// delta gate's `before` basis (e.g. a local pin on web off would make a
	// drift-free /web on emit a web delta). Point the agent dir at a missing
	// path — masking's never-throw read contributes {} — so seeded branch
	// entries and packaged spec defaults are the only inputs.
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = "/nonexistent-test-agent-dir";
	});
	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	// The harness deletes the shared toolset registry key in beforeEach, so
	// the stub must be registered per test, not once. masking's loadout adds
	// filter through getAllTools, so the mock also needs web-search (passed
	// via extraTools — appending it to ALL_TOOLS would break BROWSER_TOOL_NAMES
	// and the portal-only /web off expectations).
	const SEARCH_STUB_SPEC = {
		id: "pi-lean-dimension.search",
		names: new Set(["web-search"]),
		persistKey: "toolset-state:pi-lean-dimension.search",
		defaultEnabled: true,
	};

	const searchOffEntry = {
		type: "custom",
		customType: "toolset-state:pi-lean-dimension.search",
		data: { enabled: false },
	};
	const webOffEntry = {
		type: "custom",
		customType: "toolset-state:pi-lean-dimension.web",
		data: { enabled: false },
	};

	function searchInstalledCtx(branch: unknown[] = []) {
		return mockCtx({ sessionManager: { getBranch: () => branch } });
	}

	function captureChanged(
		events: ReturnType<typeof mockPi>["events"],
	): Array<{ id: string; enabled: boolean }> {
		const seen: Array<{ id: string; enabled: boolean }> = [];
		events.on(TOOLSET_EVENTS.changed, (d: any) =>
			seen.push({ id: d.id, enabled: d.enabled }),
		);
		return seen;
	}

	it("on — one batch turns web and search on, learn off", async () => {
		const { pi, events } = mockPi([], [
			{ name: "web-search", description: "search" },
		]);
		browserToggle(pi);
		defineToolset(pi, SEARCH_STUB_SPEC);
		const seen = captureChanged(events);

		await captureWebHandler(pi)(
			"on",
			searchInstalledCtx([webOffEntry, searchOffEntry]),
		);

		// setActiveTools reflects the union.
		expect(pi.getActiveTools()).toEqual(
			expect.arrayContaining([...BROWSER_TOOL_NAMES, "web-search"]),
		);
		expect(pi.getActiveTools()).not.toContain("web-learn");
		// One emit pass: exactly the deltas (learn was already off).
		expect(seen).toEqual([
			{ id: "pi-lean-dimension.web", enabled: true },
			{ id: "pi-lean-dimension.search", enabled: true },
		]);
	});

	it("on — co-activates search even when web is already on (drift-free)", async () => {
		// All tools active: web already enabled. The delta-gated mirror never
		// fired here; the batch must turn search on unconditionally.
		const { pi, events } = mockPi(
			ALL_TOOLS.map((t) => t.name).filter((n) => n !== "web-learn"),
			[{ name: "web-search", description: "search" }],
		);
		browserToggle(pi);
		defineToolset(pi, SEARCH_STUB_SPEC);
		const seen = captureChanged(events);

		await captureWebHandler(pi)("on", searchInstalledCtx([searchOffEntry]));

		expect(pi.getActiveTools()).toContain("web-search");
		// Web had no drift → no web emit; search is the only delta.
		expect(seen).toEqual([{ id: "pi-lean-dimension.search", enabled: true }]);
	});

	it("off — web off, learn cascaded off, search off", async () => {
		const { pi, events } = mockPi([], [{ name: "web-search", description: "search" }]);
		browserToggle(pi);
		defineToolset(pi, SEARCH_STUB_SPEC);
		const handler = captureWebHandler(pi);
		const seen = captureChanged(events);

		// Seed learn on by running /web learn first.
		await handler("learn", searchInstalledCtx());
		await handler("off", searchInstalledCtx());

		const finalActive = pi.getActiveTools();
		for (const name of [
			...BROWSER_TOOL_NAMES,
			"web-learn",
			"web-search",
		]) {
			expect(finalActive).not.toContain(name);
		}
		// The search off delta is the event search's glyph re-render rides on.
		expect(seen).toContainEqual({
			id: "pi-lean-dimension.search",
			enabled: false,
		});
	});

	it("learn — turns learn and search on without requiring web drift", async () => {
		const { pi, events } = mockPi(
			ALL_TOOLS.map((t) => t.name).filter((n) => n !== "web-learn"),
			[{ name: "web-search", description: "search" }],
		);
		browserToggle(pi);
		defineToolset(pi, SEARCH_STUB_SPEC);
		const seen = captureChanged(events);

		await captureWebHandler(pi)("learn", searchInstalledCtx([searchOffEntry]));

		expect(getLearnState()).toBe(true);
		expect(pi.getActiveTools()).toContain("web-search");
		// No web emit — web stayed on with no drift; only the real deltas fire.
		expect(seen).toEqual([
			{ id: "pi-lean-dimension.web-learn", enabled: true },
			{ id: "pi-lean-dimension.search", enabled: true },
		]);
	});

	// Also the only positive /web learn active-set assertion left after the
	// batch tests: the learn batch test asserts deltas, not the active set.
	it("on/learn/off — search op filtered on a portal-only install, no throw", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);
		const handler = captureWebHandler(pi);
		const ctx = mockCtx();

		await expect(handler("on", ctx)).resolves.toBeUndefined();
		expect(pi.getActiveTools()).toEqual(
			expect.arrayContaining([...BROWSER_TOOL_NAMES]),
		);
		expect(pi.getActiveTools()).not.toContain("web-learn");

		await expect(handler("learn", ctx)).resolves.toBeUndefined();
		expect(pi.getActiveTools()).toEqual(
			expect.arrayContaining([...BROWSER_TOOL_NAMES, "web-learn"]),
		);

		await expect(handler("off", ctx)).resolves.toBeUndefined();
		expect(pi.getActiveTools()).toEqual(
			expect.not.arrayContaining([...BROWSER_TOOL_NAMES, "web-learn"]),
		);

		// No search delta on a portal-only install — the base notify must
		// still fire, with no search suffix appended.
		const notify = ctx.ui.notify as any;
		expect(notify).toHaveBeenCalledTimes(3);
		for (const [msg] of notify.mock.calls) {
			expect(msg).not.toContain("Search");
		}
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

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("browser", expect.any(String));
	});
});

// ==================================================================
//  conversation-default-profile
// ==================================================================
describe("getConversationDefaultProfile", () => {
	it("returns undefined initially", () => {
		expect(getConversationDefaultProfile()).toBeUndefined();
	});

	it("restores the newest portal-conversation-state entry on session_start (last wins)", async () => {
		const { pi, handlers } = mockPi();
		browserToggle(pi);

		const entry = (profile: string) => ({
			type: "custom" as const,
			customType: "portal-conversation-state",
			data: { defaultProfile: profile },
		});
		// getBranch() walks chronologically root→leaf, oldest first.
		const ctx = mockCtx({
			sessionManager: {
				getBranch: () => [entry("work"), entry("shopping")] as any[],
			},
		} as any);

		for (const h of handlers.get("session_start")!) {
			await h({}, ctx);
		}

		expect(getConversationDefaultProfile()).toBe("shopping");
	});
});

// ==================================================================
//  Focus-mode guard — /web on/off/learn refuse during allowlist focus
// ==================================================================
describe("/web focus-mode guard", () => {
	// Under 2.0.0 the branch's mode entry is the authority — an allowlist
	// governance entry makes every toggle throw AllowlistModeError, which the
	// command handler catches and renders as the friendly refusal.
	function focusAllowlistForTest(ctx: any): any {
		const baseBranch = ctx.sessionManager.getBranch();
		return {
			...ctx,
			sessionManager: {
				getBranch: () => [
					...baseBranch,
					{
						type: "custom",
						customType: "toolset-resolution-mode",
						data: { mode: "allowlist", allowlist: [] },
					},
				],
			},
		};
	}

	it("refuses /web on/off/learn while allowlist focus is active", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		for (const sub of ["on", "off", "learn"]) {
			(pi.setActiveTools as any).mockClear();
			const ctx = focusAllowlistForTest(mockCtx());
			await captureWebHandler(pi)(sub, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Focus mode (allowlist) is active"),
				"warning",
			);
			// Refusal must not be followed by the subcommand's success notify.
			expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
			expect(pi.setActiveTools).not.toHaveBeenCalled();
		}
	});

	it("read-only subcommands unaffected by allowlist focus", async () => {
		const { pi } = mockPi([]);
		browserToggle(pi);

		for (const sub of ["status", "profile", "cookies", "install", ""]) {
			const ctx = focusAllowlistForTest(mockCtx());
			await captureWebHandler(pi)(sub, ctx);

			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringContaining("Focus mode (allowlist) is active"),
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
			expect.stringContaining("Focus mode (allowlist) is active"),
			"warning",
		);
		const finalActive = pi.getActiveTools();
		for (const name of BROWSER_TOOL_NAMES) {
			expect(finalActive).toContain(name);
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
