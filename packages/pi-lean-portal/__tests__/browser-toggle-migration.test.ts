/**
 * Migration-warning test for the legacy `browserToggle.defaultEnabled`
 * settings key. Isolated from the main browser-toggle suite so the
 * settings-reader mock doesn't touch the other tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Hoisted mock: the SUT reads `readMergedSettings` at init time.
vi.mock("../core/shared/settings-reader.js", () => ({
	readMergedSettings: vi.fn(() => ({})),
}));

import browserToggle, { _resetToggleStateForTest } from "../browser-toggle.js";
import { readMergedSettings } from "../core/shared/settings-reader.js";

beforeEach(() => {
	_resetToggleStateForTest();
	vi.mocked(readMergedSettings).mockReturnValue({});
	const REGISTRY_KEY = "__piToolMaskingRegistry";
	const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";
	const MODULE_STATE_KEY = "__piToolMaskingModuleState";
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[RESTORE_EVENT_KEY];
	delete (globalThis as any)[MODULE_STATE_KEY];
});

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
	{ name: "read", description: "read" },
	{ name: "bash", description: "shell" },
];

function mockPi(): {
	pi: ExtensionAPI;
	handlers: Map<string, Array<(...args: any[]) => void>>;
} {
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const pi = {
		getAllTools: vi.fn(() => ALL_TOOLS as any),
		getActiveTools: vi.fn(() => ALL_TOOLS.map((t) => t.name)),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(<T>(event: string, handler: (event: T, ctx: any) => void) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler as any);
		}),
		get events() {
			return {
				emit: () => {},
				on: () => () => {},
			};
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function mockCtx(): any {
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
	};
}

describe("legacy browserToggle.defaultEnabled migration warning", () => {
	it("warns on session_start when the legacy key is pinned", async () => {
		vi.mocked(readMergedSettings).mockReturnValue({
			browserToggle: { defaultEnabled: false },
		});
		const { pi, handlers } = mockPi();
		browserToggle(pi);

		const ctx = mockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, ctx);
		}

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("toolsetDefaults"),
			"warning",
		);
		const msg = (ctx.ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("toolset-state:pi-lean-dimension.web");
		expect(msg).toContain("toolset-state:pi-lean-dimension.web-learn");
		// The warning must make clear the legacy key still works today and the
		// new block is not read yet — otherwise users drop the working key.
		expect(msg).toContain("KEEP");
		expect(msg).toContain("not read yet");
		expect(msg).toContain("browserToggle");
	});

	it("stays silent when no legacy key is present", async () => {
		vi.mocked(readMergedSettings).mockReturnValue({});
		const { pi, handlers } = mockPi();
		browserToggle(pi);

		const ctx = mockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, ctx);
		}

		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("suppresses the warning once the web default is migrated to toolsetDefaults", async () => {
		vi.mocked(readMergedSettings).mockReturnValue({
			browserToggle: { defaultEnabled: false },
			toolsetDefaults: {
				"toolset-state:pi-lean-dimension.web": { enabled: false },
			},
		});
		const { pi, handlers } = mockPi();
		browserToggle(pi);

		const ctx = mockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, ctx);
		}

		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
