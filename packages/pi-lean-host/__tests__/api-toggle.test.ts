/**
 * API toggle tests — command dispatch, cascade, peer composition, config
 * default, focus-mode guard, and glyph states.
 *
 * Invariant tests (peer composition, persist shape, restore) live in the
 * pi-tool-masking library. These tests cover host-specific wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TOOLSET_EVENTS, setDefaultResolutionMode } from "pi-tool-masking";
import initApiToggle, {
	getApiToggleState,
	_getApiLearnStateForTest,
	_resetToggleStateForTest,
} from "../core/api-toggle.js";

// The verify subcommand is a peer of secrets/status — mock it so the dispatch
// tests assert routing without running live HTTP.
vi.mock("../core/verify-command.js", () => ({
	handleVerifySubcommand: vi.fn(),
}));

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
	{ name: "api-guide", description: "API guide" },
	{ name: "api-fetch", description: "API fetch" },
	{ name: "api-learn", description: "API learn" },
	{ name: "read", description: "read files" },
	{ name: "bash", description: "shell" },
	{ name: "edit", description: "edit files" },
	{ name: "write", description: "write files" },
];

const API_TOOL_NAMES = new Set(["api-guide", "api-fetch"]);

// ─── Mock builder ────────────────────────────────────────────────

interface MockPi {
	pi: ExtensionAPI;
	events: EventEmitter;
	handlers: Map<string, Array<(...args: any[]) => void>>;
}

function mockPi(initialTools?: string[]): MockPi {
	let active = initialTools ?? ALL_TOOLS.map((t) => t.name);
	const eventEmitter = new EventEmitter();
	const handlers = new Map<string, Array<(...args: any[]) => void>>();

	const pi = {
		getAllTools: vi.fn(() => ALL_TOOLS as any),
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

/** Capture the /api command handler from registerCommand. */
function captureApiHandler(
	pi: ExtensionAPI,
): (args: string, ctx: any) => Promise<void> {
	return (pi.registerCommand as any).mock.calls[0][1].handler;
}

// ==================================================================
//  Default export
// ==================================================================
describe("initApiToggle", () => {
	it("registers the /api command", () => {
		const { pi } = mockPi();
		initApiToggle(pi);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"api",
			expect.objectContaining({
				description: expect.stringContaining("API tools"),
			}),
		);
	});

	it("registers session_start and session_tree handlers", () => {
		const { pi, handlers } = mockPi();
		initApiToggle(pi);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_tree")).toBe(true);
	});
});

// ==================================================================
//  /api command dispatch
// ==================================================================
describe("/api command dispatch", () => {
	it("on — enables API tools, disables learn tools", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		await captureApiHandler(pi)("on", mockCtx());

		const finalActive = pi.getActiveTools();
		for (const name of API_TOOL_NAMES) {
			expect(finalActive).toContain(name);
		}
		expect(finalActive).not.toContain("api-learn");
	});

	it("off — disables API tools (learn cascades off via requires)", async () => {
		const { pi } = mockPi();
		initApiToggle(pi);

		await captureApiHandler(pi)("off", mockCtx());

		const finalActive = pi.getActiveTools();
		for (const name of API_TOOL_NAMES) {
			expect(finalActive).not.toContain(name);
		}
		expect(finalActive).not.toContain("api-learn");
	});

	it("learn — enables both API and learn tools", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		await captureApiHandler(pi)("learn", mockCtx());

		const finalActive = pi.getActiveTools();
		for (const name of API_TOOL_NAMES) {
			expect(finalActive).toContain(name);
		}
		expect(finalActive).toContain("api-learn");
	});

	it("status — does not change state", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		(pi.setActiveTools as any).mockClear();
		await captureApiHandler(pi)("status", mockCtx());

		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("handles unknown arg — shows status, no state change", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		(pi.setActiveTools as any).mockClear();
		await captureApiHandler(pi)("xyz", mockCtx());

		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("handles empty args — shows status, no state change", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		(pi.setActiveTools as any).mockClear();
		await captureApiHandler(pi)("", mockCtx());

		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ==================================================================
//  getApiToggleState / learn-state getter
// ==================================================================
describe("getApiToggleState / learn-state getter", () => {
	it("cached state starts false/false before session_start sync", () => {
		expect(getApiToggleState()).toBe(false);
		expect(_getApiLearnStateForTest()).toBe(false);
	});

	it("update after /api on and /api off", async () => {
		const { pi } = mockPi();
		initApiToggle(pi);

		const handler = captureApiHandler(pi);
		await handler("on", mockCtx());
		expect(getApiToggleState()).toBe(true);

		await handler("off", mockCtx());
		expect(getApiToggleState()).toBe(false);
	});

	it("learn state true after /api learn", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		await captureApiHandler(pi)("learn", mockCtx());

		expect(getApiToggleState()).toBe(true);
		expect(_getApiLearnStateForTest()).toBe(true);
	});
});

// ==================================================================
//  appendEntry persist keys
// ==================================================================
describe("persistence key split", () => {
	it("appends toolset-state:pi-lean-dimension.api on enable", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		await captureApiHandler(pi)("on", mockCtx());

		const apiCalls = (pi.appendEntry as any).mock.calls.filter(
			(c: any) => c[0] === "toolset-state:pi-lean-dimension.api",
		);
		expect(apiCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("appends toolset-state:pi-lean-dimension.api-learn on learn", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		await captureApiHandler(pi)("learn", mockCtx());

		const learnCalls = (pi.appendEntry as any).mock.calls.filter(
			(c: any) => c[0] === "toolset-state:pi-lean-dimension.api-learn",
		);
		expect(learnCalls.length).toBeGreaterThanOrEqual(1);
	});
});

// ==================================================================
//  session_start — renders glyph
// ==================================================================
describe("session_start integration", () => {
	it("renders api glyph on session_start", async () => {
		const { pi, handlers } = mockPi();
		initApiToggle(pi);

		const startHandlers = handlers.get("session_start")!;
		const ctx = mockCtx();

		for (const h of startHandlers) {
			await h({}, ctx);
		}

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("api", expect.any(String));
	});
});

// ==================================================================
//  Focus-mode guard — /api on/off/learn refuse during inclusion
// ==================================================================
describe("/api verify dispatch", () => {
	it("recognizes verify and routes to handleVerifySubcommand", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);
		const ctx = mockCtx();
		await captureApiHandler(pi)("verify verify.test", ctx);
		const { handleVerifySubcommand } = await import("../core/verify-command.js");
		expect(handleVerifySubcommand).toHaveBeenCalledWith("verify.test", ctx);
	});

	it("verify is not refused by the focus-mode guard (writes no toolset state)", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);
		setDefaultResolutionMode(pi, "inclusion");
		const ctx = mockCtx();
		await captureApiHandler(pi)("verify verify.test", ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("Another plugin has active inclusion mode"),
			"warning",
		);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("verify routes regardless of tool masking (no toolset actuation)", async () => {
		// No tools active — verify is a command that calls the executor/
		// auth/transport directly, so masking api-fetch/api-guide is irrelevant.
		const { pi } = mockPi([]);
		initApiToggle(pi);
		const ctx = mockCtx();
		await captureApiHandler(pi)("verify verify.test", ctx);

		const { handleVerifySubcommand } = await import("../core/verify-command.js");
		expect(handleVerifySubcommand).toHaveBeenCalled();
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("/api focus-mode guard", () => {
	it("refuses /api on/off/learn while inclusion focus is active", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);
		setDefaultResolutionMode(pi, "inclusion");

		for (const sub of ["on", "off", "learn"]) {
			(pi.setActiveTools as any).mockClear();
			const ctx = mockCtx();
			await captureApiHandler(pi)(sub, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Another plugin has active inclusion mode"),
				"warning",
			);
			expect(pi.setActiveTools).not.toHaveBeenCalled();
		}
	});

	it("refuses /api on/off/learn while allowlist focus is active", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);
		setDefaultResolutionMode(pi, "allowlist", ["pi-lean-dimension.api"]);

		for (const sub of ["on", "off", "learn"]) {
			(pi.setActiveTools as any).mockClear();
			const ctx = mockCtx();
			await captureApiHandler(pi)(sub, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Focus mode (allowlist) is active"),
				"warning",
			);
			expect(pi.setActiveTools).not.toHaveBeenCalled();
		}
	});

	it("read-only subcommands unaffected by inclusion focus", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);
		setDefaultResolutionMode(pi, "inclusion");

		for (const sub of ["status", "helpers", ""]) {
			const ctx = mockCtx();
			await captureApiHandler(pi)(sub, ctx);

			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringContaining("Another plugin has active inclusion mode"),
				"warning",
			);
		}
	});

	it("actuating subcommands work when focus is off (exclusion)", async () => {
		const { pi } = mockPi([]);
		initApiToggle(pi);

		const ctx = mockCtx();
		await captureApiHandler(pi)("on", ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("Another plugin has active inclusion mode"),
			"warning",
		);
		const finalActive = pi.getActiveTools();
		for (const name of API_TOOL_NAMES) {
			expect(finalActive).toContain(name);
		}
	});
});

// ==================================================================
//  Glyph sync on external-plugin changed events
// ==================================================================
describe("external-plugin glyph sync", () => {
	it("re-renders api glyph when external plugin fires pi-lean-dimension.api disabled", async () => {
		const { pi, handlers, events } = mockPi();
		initApiToggle(pi);

		// Fire session_start once to establish _lastCtx
		const startCtx = mockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, startCtx);
		}

		vi.clearAllMocks();

		// Simulate an external plugin disabling pi-lean-dimension.api
		const nonApi = ALL_TOOLS.map((t) => t.name).filter(
			(n) => !API_TOOL_NAMES.has(n) && n !== "api-learn",
		);
		(pi.getActiveTools as any).mockReturnValue(nonApi);

		events.emit(TOOLSET_EVENTS.changed, {
			id: "pi-lean-dimension.api",
			enabled: false,
		});

		expect(startCtx.ui.setStatus).toHaveBeenCalledWith("api", "○ api");
	});
});
