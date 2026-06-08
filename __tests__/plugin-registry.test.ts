/**
 * Tests for plugin-registry.ts — registration, validation, resolution, and ordering.
 *
 * Uses a MockPlugin that implements all 13 operations + lifecycle hooks
 * with configurable behaviour for each method.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry, validatePlugin } from "../core/plugin-registry";
import type {
	BrowserPlugin,
	PluginCapabilities,
	PluginConfig,
	NavigateResult,
	SnapshotResult,
	InteractionResult,
	ScreenshotResult,
	GetImagesResult,
	ConsoleMessagesResult,
	EvaluateResult,
} from "../core/plugin-api";
import { DEFAULT_CAPABILITIES } from "../core/plugin-api";

// ─── MockPlugin ──────────────────────────────────────────────────

/**
 * Fully-configurable mock plugin for testing.
 * Every operation returns a success result by default; individual
 * methods can be overridden or configured to return errors.
 */
class MockPlugin implements BrowserPlugin {
	readonly name: string;
	readonly capabilities: PluginCapabilities;

	/** Track which methods were called and with what args */
	readonly calls: Map<string, unknown[]> = new Map();

	/** Per-operation configurable return values */
	navResult: Partial<NavigateResult> = {};
	snapResult: Partial<SnapshotResult> = {};
	interactResult: Partial<InteractionResult> = {};
	screenshotResult: Partial<ScreenshotResult> = {};
	imagesResult: Partial<GetImagesResult> = {};
	consoleResult: Partial<ConsoleMessagesResult> = {};
	evalResult: Partial<EvaluateResult> = {};

	/** If set, this operation throws instead of returning */
	shouldThrow: Set<string> = new Set();

	constructor(name = "mock", capabilities: Partial<PluginCapabilities> = {}) {
		this.name = name;
		this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
	}

	private record(op: string, args: unknown[]): void {
		const existing = this.calls.get(op) ?? [];
		existing.push(args);
		this.calls.set(op, existing);
	}

	async init(config?: Record<string, unknown>): Promise<void> {
		this.record("init", [config]);
		if (this.shouldThrow.has("init")) throw new Error("init failed");
	}

	async cleanupAll(): Promise<void> {
		this.record("cleanupAll", []);
		if (this.shouldThrow.has("cleanupAll"))
			throw new Error("cleanupAll failed");
	}

	async navigate(
		url: string,
		taskId: string,
		timeoutMs: number,
		options?: { signal?: AbortSignal },
	): Promise<NavigateResult> {
		this.record("navigate", [url, taskId, timeoutMs, options]);
		if (this.shouldThrow.has("navigate")) throw new Error("navigate failed");
		return {
			success: true,
			url,
			title: "Mock Page",
			snapshot: "- tree [url] mock content",
			elementCount: 5,
			...this.navResult,
		};
	}

	async snapshot(taskId: string): Promise<SnapshotResult> {
		this.record("snapshot", [taskId]);
		if (this.shouldThrow.has("snapshot")) throw new Error("snapshot failed");
		return {
			success: true,
			snapshot: "- tree [mock] snapshot",
			elementCount: 3,
			...this.snapResult,
		};
	}

	async click(taskId: string, ref: string): Promise<InteractionResult> {
		this.record("click", [taskId, ref]);
		if (this.shouldThrow.has("click")) throw new Error("click failed");
		return {
			success: true,
			snapshot: "- tree [clicked]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async type(
		taskId: string,
		ref: string,
		text: string,
	): Promise<InteractionResult> {
		this.record("type", [taskId, ref, text]);
		if (this.shouldThrow.has("type")) throw new Error("type failed");
		return {
			success: true,
			snapshot: "- tree [typed]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async scroll(
		taskId: string,
		direction: "up" | "down",
	): Promise<InteractionResult> {
		this.record("scroll", [taskId, direction]);
		if (this.shouldThrow.has("scroll")) throw new Error("scroll failed");
		return {
			success: true,
			snapshot: "- tree [scrolled]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async goBack(taskId: string): Promise<InteractionResult> {
		this.record("goBack", [taskId]);
		if (this.shouldThrow.has("goBack")) throw new Error("goBack failed");
		return {
			success: true,
			newUrl: "https://example.com/prev",
			snapshot: "- tree [back]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async press(taskId: string, key: string): Promise<InteractionResult> {
		this.record("press", [taskId, key]);
		if (this.shouldThrow.has("press")) throw new Error("press failed");
		return {
			success: true,
			snapshot: "- tree [pressed]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async screenshot(
		taskId: string,
		options?: { fullPage?: boolean },
	): Promise<ScreenshotResult> {
		this.record("screenshot", [taskId, options]);
		if (this.shouldThrow.has("screenshot"))
			throw new Error("screenshot failed");
		return {
			success: true,
			dataUri: "data:image/jpeg;base64,mockdata",
			...this.screenshotResult,
		};
	}

	async getImages(taskId: string): Promise<GetImagesResult> {
		this.record("getImages", [taskId]);
		if (this.shouldThrow.has("getImages")) throw new Error("getImages failed");
		return {
			success: true,
			images: [
				{
					src: "https://example.com/img.png",
					alt: "test",
					width: 100,
					height: 50,
				},
			],
			...this.imagesResult,
		};
	}

	async getConsoleMessages(taskId: string): Promise<ConsoleMessagesResult> {
		this.record("getConsoleMessages", [taskId]);
		if (this.shouldThrow.has("getConsoleMessages"))
			throw new Error("getConsoleMessages failed");
		return {
			success: true,
			messages: [{ type: "log", text: "hello" }],
			...this.consoleResult,
		};
	}

	async clearConsole(taskId: string): Promise<void> {
		this.record("clearConsole", [taskId]);
		if (this.shouldThrow.has("clearConsole"))
			throw new Error("clearConsole failed");
	}

	async evaluate(taskId: string, expression: string): Promise<EvaluateResult> {
		this.record("evaluate", [taskId, expression]);
		if (this.shouldThrow.has("evaluate")) throw new Error("evaluate failed");
		return {
			success: true,
			result: 42,
			...this.evalResult,
		};
	}

	async cleanup(taskId: string): Promise<void> {
		this.record("cleanup", [taskId]);
		if (this.shouldThrow.has("cleanup")) throw new Error("cleanup failed");
	}
}

/** Helper: build a default PluginConfig for testing */
function makeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
	return {
		name: "mock",
		dir: "mock",
		enabled: true,
		config: {},
		...overrides,
	};
}

// ─── validatePlugin ──────────────────────────────────────────────

describe("validatePlugin", () => {
	it("returns empty array for a plugin with all 13 operations", () => {
		const plugin = new MockPlugin();
		const missing = validatePlugin(plugin);
		expect(missing).toEqual([]);
	});

	it("detects missing operations", () => {
		const plugin = new MockPlugin();
		// Override a required method to be non-function
		Object.defineProperty(plugin, "navigate", {
			value: undefined,
			configurable: true,
		});
		const missing = validatePlugin(plugin);
		expect(missing).toContain("navigate");
	});

	it("detects multiple missing operations", () => {
		const plugin = new MockPlugin();
		// Override required methods to be non-functions
		for (const op of ["click", "type", "scroll"]) {
			Object.defineProperty(plugin, op, {
				value: undefined,
				configurable: true,
			});
		}
		const missing = validatePlugin(plugin);
		expect(missing).toContain("click");
		expect(missing).toContain("type");
		expect(missing).toContain("scroll");
		expect(missing).not.toContain("navigate");
	});

	it("ignores lifecycle hooks that are missing", () => {
		const plugin = new MockPlugin();
		// init is optional, not in REQUIRED_OPERATIONS
		delete (plugin as any).init;
		const missing = validatePlugin(plugin);
		expect(missing).toEqual([]);
	});

	it("detects when operation is not a function", () => {
		const plugin = new MockPlugin();
		(plugin as any).snapshot = "not a function";
		const missing = validatePlugin(plugin);
		expect(missing).toContain("snapshot");
	});
});

// ─── PluginRegistry.register ─────────────────────────────────────

describe("PluginRegistry.register", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("registers a valid plugin", () => {
		const plugin = new MockPlugin("chromium");
		registry.register(plugin, makeConfig({ name: "chromium" }));
		expect(registry.size).toBe(1);
	});

	it("throws on duplicate name", () => {
		const p1 = new MockPlugin("chromium");
		const p2 = new MockPlugin("chromium");
		registry.register(p1, makeConfig({ name: "chromium" }));
		expect(() =>
			registry.register(p2, makeConfig({ name: "chromium" })),
		).toThrow(/already registered/);
	});

	it("throws on plugin missing required operations", () => {
		const plugin = new MockPlugin("broken");
		Object.defineProperty(plugin, "navigate", {
			value: undefined,
			configurable: true,
		});
		expect(() =>
			registry.register(plugin, makeConfig({ name: "broken" })),
		).toThrow(/missing required operations.*navigate/);
	});

	it("allows registering multiple plugins with different names", () => {
		const p1 = new MockPlugin("chromium");
		const p2 = new MockPlugin("firefox");
		registry.register(p1, makeConfig({ name: "chromium" }));
		registry.register(p2, makeConfig({ name: "firefox" }));
		expect(registry.size).toBe(2);
	});
});

// ─── PluginRegistry.get ──────────────────────────────────────────

describe("PluginRegistry.get", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("returns an enabled plugin", () => {
		const plugin = new MockPlugin("chromium");
		registry.register(plugin, makeConfig({ name: "chromium", enabled: true }));
		expect(registry.get("chromium")).toBe(plugin);
	});

	it("returns undefined for disabled plugin", () => {
		const plugin = new MockPlugin("chromium");
		registry.register(plugin, makeConfig({ name: "chromium", enabled: false }));
		expect(registry.get("chromium")).toBeUndefined();
	});

	it("returns undefined for unknown plugin", () => {
		expect(registry.get("nonexistent")).toBeUndefined();
	});
});

// ─── PluginRegistry.getAny ───────────────────────────────────────

describe("PluginRegistry.getAny", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("returns entry for disabled plugin", () => {
		const plugin = new MockPlugin("chromium");
		registry.register(plugin, makeConfig({ name: "chromium", enabled: false }));
		const entry = registry.getAny("chromium");
		expect(entry).toBeDefined();
		expect(entry!.enabled).toBe(false);
		expect(entry!.plugin).toBe(plugin);
	});

	it("returns entry for enabled plugin", () => {
		const plugin = new MockPlugin("chromium");
		registry.register(plugin, makeConfig({ name: "chromium", enabled: true }));
		const entry = registry.getAny("chromium");
		expect(entry).toBeDefined();
		expect(entry!.enabled).toBe(true);
	});

	it("returns undefined for unknown plugin", () => {
		expect(registry.getAny("nonexistent")).toBeUndefined();
	});
});

// ─── PluginRegistry.getDefault ───────────────────────────────────

describe("PluginRegistry.getDefault", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("returns the first enabled plugin", () => {
		const p1 = new MockPlugin("alpha");
		const p2 = new MockPlugin("beta");
		registry.register(p1, makeConfig({ name: "alpha" }));
		registry.register(p2, makeConfig({ name: "beta" }));
		expect(registry.getDefault()).toBe(p1);
	});

	it("skips disabled plugins", () => {
		const p1 = new MockPlugin("alpha");
		const p2 = new MockPlugin("beta");
		registry.register(p1, makeConfig({ name: "alpha", enabled: false }));
		registry.register(p2, makeConfig({ name: "beta" }));
		expect(registry.getDefault()).toBe(p2);
	});

	it("returns undefined when all plugins are disabled", () => {
		const p1 = new MockPlugin("alpha");
		registry.register(p1, makeConfig({ name: "alpha", enabled: false }));
		expect(registry.getDefault()).toBeUndefined();
	});

	it("returns undefined when no plugins are registered", () => {
		expect(registry.getDefault()).toBeUndefined();
	});
});

// ─── PluginRegistry.getOrdered ───────────────────────────────────

describe("PluginRegistry.getOrdered", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("returns enabled plugins in registration order", () => {
		const p1 = new MockPlugin("alpha");
		const p2 = new MockPlugin("beta");
		const p3 = new MockPlugin("gamma");
		registry.register(p1, makeConfig({ name: "alpha" }));
		registry.register(p2, makeConfig({ name: "beta" }));
		registry.register(p3, makeConfig({ name: "gamma" }));
		const ordered = registry.getOrdered();
		expect(ordered.map((e) => e.plugin.name)).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
	});

	it("excludes disabled plugins", () => {
		const p1 = new MockPlugin("alpha");
		const p2 = new MockPlugin("beta");
		const p3 = new MockPlugin("gamma");
		registry.register(p1, makeConfig({ name: "alpha" }));
		registry.register(p2, makeConfig({ name: "beta", enabled: false }));
		registry.register(p3, makeConfig({ name: "gamma" }));
		const ordered = registry.getOrdered();
		expect(ordered.map((e) => e.plugin.name)).toEqual(["alpha", "gamma"]);
	});

	it("assigns correct stealth levels", () => {
		const p1 = new MockPlugin("alpha");
		const p2 = new MockPlugin("beta");
		registry.register(p1, makeConfig({ name: "alpha" }));
		registry.register(p2, makeConfig({ name: "beta" }));
		const ordered = registry.getOrdered();
		expect(ordered[0]!.level).toBe(0);
		expect(ordered[1]!.level).toBe(1);
	});

	it("returns empty array when no plugins are enabled", () => {
		expect(registry.getOrdered()).toEqual([]);
	});
});

// ─── PluginRegistry.available ────────────────────────────────────

describe("PluginRegistry.available", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("lists enabled plugin names", () => {
		const p1 = new MockPlugin("chromium");
		const p2 = new MockPlugin("firefox");
		registry.register(p1, makeConfig({ name: "chromium" }));
		registry.register(p2, makeConfig({ name: "firefox", enabled: false }));
		expect(registry.available()).toEqual(["chromium"]);
	});

	it("returns empty array when no plugins are enabled", () => {
		expect(registry.available()).toEqual([]);
	});
});

// ─── PluginRegistry.availableAll ─────────────────────────────────

describe("PluginRegistry.availableAll", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("lists all plugins including disabled", () => {
		const p1 = new MockPlugin("chromium");
		const p2 = new MockPlugin("firefox");
		registry.register(p1, makeConfig({ name: "chromium" }));
		registry.register(p2, makeConfig({ name: "firefox", enabled: false }));
		expect(registry.availableAll()).toEqual([
			{ name: "chromium", enabled: true },
			{ name: "firefox", enabled: false },
		]);
	});
});

// ─── PluginRegistry.getHigherStealth ──────────────────────────────

describe("PluginRegistry.getHigherStealth", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("returns plugins at higher stealth levels", () => {
		const p1 = new MockPlugin("chromium");
		const p2 = new MockPlugin("stealth");
		registry.register(p1, makeConfig({ name: "chromium" }));
		registry.register(p2, makeConfig({ name: "stealth" }));
		const higher = registry.getHigherStealth(0);
		expect(higher.map((e) => e.plugin.name)).toEqual(["stealth"]);
	});

	it("returns empty array when no higher-level plugins exist", () => {
		const p1 = new MockPlugin("chromium");
		registry.register(p1, makeConfig({ name: "chromium" }));
		expect(registry.getHigherStealth(0)).toEqual([]);
	});

	it("excludes disabled plugins from higher stealth", () => {
		const p1 = new MockPlugin("chromium");
		const p2 = new MockPlugin("stealth");
		registry.register(p1, makeConfig({ name: "chromium" }));
		registry.register(p2, makeConfig({ name: "stealth", enabled: false }));
		expect(registry.getHigherStealth(0)).toEqual([]);
	});
});

// ─── PluginRegistry.resolveStrategy ──────────────────────────────

describe("PluginRegistry.resolveStrategy", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("resolves 'auto' to the first enabled plugin", () => {
		const p1 = new MockPlugin("chromium");
		registry.register(p1, makeConfig({ name: "chromium" }));
		const result = registry.resolveStrategy("auto");
		expect(result.plugin).toBe(p1);
		expect(result.error).toBeUndefined();
	});

	it("resolves a named strategy to the correct plugin", () => {
		const p1 = new MockPlugin("chromium");
		registry.register(p1, makeConfig({ name: "chromium" }));
		const result = registry.resolveStrategy("chromium");
		expect(result.plugin).toBe(p1);
		expect(result.error).toBeUndefined();
	});

	it("returns error for unknown strategy", () => {
		const p1 = new MockPlugin("chromium");
		registry.register(p1, makeConfig({ name: "chromium" }));
		const result = registry.resolveStrategy("nonexistent");
		expect(result.plugin).toBeUndefined();
		expect(result.error).toContain("not registered");
	});

	it("returns error for disabled plugin strategy", () => {
		const p1 = new MockPlugin("chromium");
		registry.register(p1, makeConfig({ name: "chromium", enabled: false }));
		const result = registry.resolveStrategy("chromium");
		expect(result.plugin).toBeUndefined();
		expect(result.error).toContain("disabled");
	});

	it("returns error when no plugins are registered for 'auto'", () => {
		const result = registry.resolveStrategy("auto");
		expect(result.plugin).toBeUndefined();
		expect(result.error).toContain("No browser plugins");
	});

	it("lists available plugins in error message", () => {
		const p1 = new MockPlugin("chromium");
		registry.register(p1, makeConfig({ name: "chromium" }));
		const result = registry.resolveStrategy("nonexistent");
		expect(result.error).toContain("chromium");
	});
});

// ─── PluginRegistry.clear ────────────────────────────────────────

describe("PluginRegistry.clear", () => {
	it("removes all registered plugins", () => {
		const registry = new PluginRegistry();
		const p1 = new MockPlugin("chromium");
		const p2 = new MockPlugin("firefox");
		registry.register(p1, makeConfig({ name: "chromium" }));
		registry.register(p2, makeConfig({ name: "firefox" }));
		expect(registry.size).toBe(2);
		registry.clear();
		expect(registry.size).toBe(0);
		expect(registry.available()).toEqual([]);
	});
});

// ─── PluginRegistry.getLevel ─────────────────────────────────────

describe("PluginRegistry.getLevel", () => {
	it("returns the stealth level of a registered plugin", () => {
		const registry = new PluginRegistry();
		const p1 = new MockPlugin("chromium");
		const p2 = new MockPlugin("stealth");
		registry.register(p1, makeConfig({ name: "chromium" }));
		registry.register(p2, makeConfig({ name: "stealth" }));
		expect(registry.getLevel("chromium")).toBe(0);
		expect(registry.getLevel("stealth")).toBe(1);
	});

	it("returns undefined for unknown plugin", () => {
		const registry = new PluginRegistry();
		expect(registry.getLevel("nonexistent")).toBeUndefined();
	});
});

// ─── MockPlugin call tracking ────────────────────────────────────

describe("MockPlugin call tracking", () => {
	it("records navigate calls with correct args", async () => {
		const plugin = new MockPlugin();
		await plugin.navigate("https://example.com", "task-1", 30000);
		await plugin.navigate("https://other.com", "task-2", 5000);
		const calls = plugin.calls.get("navigate")!;
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual([
			"https://example.com",
			"task-1",
			30000,
			undefined,
		]);
		expect(calls[1]).toEqual(["https://other.com", "task-2", 5000, undefined]);
	});

	it("records click calls", async () => {
		const plugin = new MockPlugin();
		await plugin.click("task-1", "@e5");
		expect(plugin.calls.get("click")).toEqual([["task-1", "@e5"]]);
	});

	it("records type calls", async () => {
		const plugin = new MockPlugin();
		await plugin.type("task-1", "@e3", "hello");
		expect(plugin.calls.get("type")).toEqual([["task-1", "@e3", "hello"]]);
	});

	it("records cleanup calls", async () => {
		const plugin = new MockPlugin();
		await plugin.cleanup("task-1");
		expect(plugin.calls.get("cleanup")).toEqual([["task-1"]]);
	});

	it("throws when shouldThrow is set", async () => {
		const plugin = new MockPlugin();
		plugin.shouldThrow.add("navigate");
		await expect(
			plugin.navigate("https://example.com", "task-1", 30000),
		).rejects.toThrow("navigate failed");
	});
});

// ─── MockPlugin configurable returns ─────────────────────────────

describe("MockPlugin configurable returns", () => {
	it("returns custom navigate result", async () => {
		const plugin = new MockPlugin();
		plugin.navResult = {
			success: false,
			error: "page not found",
			url: "https://example.com/404",
			title: "",
			snapshot: "",
			elementCount: 0,
		};
		const result = await plugin.navigate(
			"https://example.com/404",
			"task-1",
			30000,
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe("page not found");
	});

	it("returns bot detection signal", async () => {
		const plugin = new MockPlugin();
		plugin.navResult = { botDetected: true };
		const result = await plugin.navigate(
			"https://protected.com",
			"task-1",
			30000,
		);
		expect(result.botDetected).toBe(true);
	});

	it("returns custom evaluate result", async () => {
		const plugin = new MockPlugin();
		plugin.evalResult = { result: { key: "value" } };
		const result = await plugin.evaluate("task-1", "document.title");
		expect(result.result).toEqual({ key: "value" });
	});

	it("returns custom screenshot data URI", async () => {
		const plugin = new MockPlugin();
		plugin.screenshotResult = {
			dataUri: "data:image/png;base64,customdata",
		};
		const result = await plugin.screenshot("task-1");
		expect(result.dataUri).toBe("data:image/png;base64,customdata");
	});
});
