/**
 * Tests for plugin-registry.ts — registration, validation, resolution, and ordering.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry, validatePlugin } from "../core/plugin-registry.js";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin.js";

// ─── validatePlugin ──────────────────────────────────────────────

describe("validatePlugin", () => {
	it("returns empty array for a plugin with all required operations", () => {
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
		expect(ordered.map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("excludes disabled plugins", () => {
		const p1 = new MockPlugin("alpha");
		const p2 = new MockPlugin("beta");
		const p3 = new MockPlugin("gamma");
		registry.register(p1, makeConfig({ name: "alpha" }));
		registry.register(p2, makeConfig({ name: "beta", enabled: false }));
		registry.register(p3, makeConfig({ name: "gamma" }));
		const ordered = registry.getOrdered();
		expect(ordered.map((p) => p.name)).toEqual(["alpha", "gamma"]);
	});

	it("preserves registration order across enabled plugins", () => {
		const p1 = new MockPlugin("alpha");
		const p2 = new MockPlugin("beta");
		registry.register(p1, makeConfig({ name: "alpha" }));
		registry.register(p2, makeConfig({ name: "beta" }));
		const ordered = registry.getOrdered();
		expect(ordered.map((p) => p.name)).toEqual(["alpha", "beta"]);
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
		expect(result.error).not.toContain("not registered");
	});

	it("returns error when no plugins are registered for 'auto'", () => {
		const result = registry.resolveStrategy("auto");
		expect(result.plugin).toBeUndefined();
		expect(result.error).toContain("No browser plugins");
	});

	it("returns error for unknown strategy when no plugins exist", () => {
		const result = registry.resolveStrategy("nonexistent");
		expect(result.plugin).toBeUndefined();
		expect(result.error).toContain("not registered");
	});

	it("lists available plugins in disabled error", () => {
		const p1 = new MockPlugin("alpha");
		const p2 = new MockPlugin("chromium");
		registry.register(p1, makeConfig({ name: "alpha" }));
		registry.register(p2, makeConfig({ name: "chromium", enabled: false }));
		const result = registry.resolveStrategy("chromium");
		expect(result.error).toContain("disabled");
		expect(result.error).toContain("alpha");
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
		registry.clear();
		expect(registry.available()).toEqual([]);
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
