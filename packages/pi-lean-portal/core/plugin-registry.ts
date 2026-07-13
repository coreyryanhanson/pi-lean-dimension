/**
 * Plugin Registry — typed registration, validation, and lookup for BrowserPlugins.
 *
 * The registry holds all registered plugins and provides:
 * - `register(name, plugin)` — with validation that all required operations exist
 * - `get(name)` → BrowserPlugin | undefined
 * - `getDefault()` → first enabled plugin from the configured `plugins` array
 * - `getOrdered()` → all enabled plugins in array order (lower index = higher priority)
 * - `available()` → list of registered plugin names
 */

import type { BrowserPlugin } from "./plugin-api.js";
import type { PluginConfig } from "./plugin-config.js";

// ─── Validation ───────────────────────────────────────────────────

/** The required operation method names (tool-mapped only; lifecycle, cookie, storage excluded) */
const REQUIRED_OPERATIONS: ReadonlyArray<keyof BrowserPlugin> = [
	"navigate",
	"snapshot",
	"click",
	"type",
	"scroll",
	"goBack",
	"press",
	"screenshot",
	"getConsoleMessages",
	"clearConsole",
	"evaluate",
	"cleanup",
];

/**
 * Validate that a BrowserPlugin implements all required operations.
 * Returns an array of missing method names (empty if valid).
 */
export function validatePlugin(plugin: BrowserPlugin): string[] {
	const missing: string[] = [];
	for (const op of REQUIRED_OPERATIONS) {
		if (typeof (plugin as any)[op] !== "function") {
			missing.push(op);
		}
	}
	return missing;
}

// ─── Registry Entry ───────────────────────────────────────────────

/** Internal tracking for a registered plugin */
interface RegistryEntry {
	plugin: BrowserPlugin;
	/** Whether this plugin is enabled */
	enabled: boolean;
}

// ─── PluginRegistry ───────────────────────────────────────────────

export class PluginRegistry {
	/** Map of plugin name → registry entry */
	private entries = new Map<string, RegistryEntry>();

	/** Ordered list of plugin names from config (lower index = higher priority / recommended first) */
	private orderedNames: string[] = [];

	/**
	 * Pre-populate the ordered plugin name list.
	 *
	 * Call this BEFORE any `register()` calls to ensure the config array order
	 * is preserved even when plugins are registered asynchronously (e.g. Node
	 * plugins loaded via dynamic `import()` vs Python plugins registered
	 * synchronously).
	 *
	 * If `register()` finds its name already in the seeded order, it keeps
	 * that position instead of appending.
	 *
	 * @param names - Plugin names in the desired priority order (typically
	 *                 the order from the user's `browser.plugins` config array).
	 */
	seedOrder(names: string[]): void {
		this.orderedNames = [...names];
	}

	/**
	 * Register a plugin with its config.
	 *
	 * If the plugin name was pre-seeded via `seedOrder()`, it keeps that
	 * position in the ordered list. Otherwise it is appended at the end.
	 *
	 * @throws if a plugin with the same name is already registered
	 * @throws if the plugin is missing required operations
	 */
	register(plugin: BrowserPlugin, config: PluginConfig): void {
		if (this.entries.has(plugin.name)) {
			throw new Error(
				`Plugin '${plugin.name}' is already registered. Remove the duplicate entry.`,
			);
		}

		// Validate all required operations
		const missing = validatePlugin(plugin);
		if (missing.length > 0) {
			throw new Error(
				`Plugin '${plugin.name}' is missing required operations: ${missing.join(", ")}`,
			);
		}

		// Preserve pre-seeded order (from seedOrder); otherwise append.
		if (!this.orderedNames.includes(plugin.name)) {
			this.orderedNames.push(plugin.name);
		}

		this.entries.set(plugin.name, {
			plugin,
			enabled: config.enabled,
		});
	}

	/**
	 * Get a plugin by name. Returns undefined if not registered or disabled.
	 */
	get(name: string): BrowserPlugin | undefined {
		const entry = this.entries.get(name);
		if (!entry || !entry.enabled) return undefined;
		return entry.plugin;
	}

	/**
	 * Get a plugin by name, even if disabled.
	 * Useful for error messages ("Plugin 'X' is disabled, not missing").
	 */
	private getAny(name: string): RegistryEntry | undefined {
		return this.entries.get(name);
	}

	/**
	 * Get the default plugin — the first enabled plugin in the config order.
	 * Returns undefined if no plugins are registered or enabled.
	 */
	getDefault(): BrowserPlugin | undefined {
		for (const name of this.orderedNames) {
			const entry = this.entries.get(name);
			if (entry?.enabled) return entry.plugin;
		}
		return undefined;
	}

	/**
	 * Get all enabled plugins in config order (priority order).
	 */
	getOrdered(): BrowserPlugin[] {
		const result: BrowserPlugin[] = [];
		for (const name of this.orderedNames) {
			const entry = this.entries.get(name);
			if (entry?.enabled) {
				result.push(entry.plugin);
			}
		}
		return result;
	}

	/**
	 * List all registered plugin names (enabled only).
	 */
	available(): string[] {
		return this.getOrdered().map((p) => p.name);
	}

	/**
	 * List all registered plugin names (including disabled).
	 */
	availableAll(): Array<{ name: string; enabled: boolean }> {
		return this.orderedNames.map((name) => {
			const entry = this.entries.get(name)!;
			return { name, enabled: entry.enabled };
		});
	}

	/**
	 * Resolve a strategy value to a plugin.
	 *
	 * - "auto" → first enabled plugin (getDefault)
	 * - "<name>" → named plugin
	 *
	 * Returns { plugin, error? } — error is set if the plugin is not found.
	 */
	resolveStrategy(strategy: string): {
		plugin?: BrowserPlugin;
		error?: string;
	} {
		if (strategy === "auto") {
			const plugin = this.getDefault();
			if (!plugin) {
				return { error: "No browser plugins are registered and enabled." };
			}
			return { plugin };
		}

		// Check if the plugin exists at all (even disabled)
		const anyEntry = this.getAny(strategy);
		if (!anyEntry) {
			const available = this.available();
			return {
				error: `Plugin '${strategy}' is not registered. Available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
			};
		}

		if (!anyEntry.enabled) {
			const available = this.available();
			return {
				error: `Plugin '${strategy}' is disabled. Available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
			};
		}

		return { plugin: anyEntry.plugin };
	}

	/**
	 * Clear all registered plugins. Used for testing.
	 */
	clear(): void {
		this.entries.clear();
		this.orderedNames = [];
	}
}

// ─── Singleton ────────────────────────────────────────────────────

/** Global plugin registry instance */
export const pluginRegistry = new PluginRegistry();
