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
	/** Position in the user's plugins config array (lower = higher priority, used for LLM escalation hints) */
	level: number;
	/** Whether this plugin is enabled */
	enabled: boolean;
}

// ─── PluginRegistry ───────────────────────────────────────────────

export class PluginRegistry {
	/** Map of plugin name → registry entry */
	private entries = new Map<string, RegistryEntry>();

	/** Ordered list of plugin names from config (defines escalation priority — lower index = recommended first) */
	private orderedNames: string[] = [];

	/**
	 * Pre-populate the ordered plugin name list.
	 *
	 * Call this BEFORE any `register()` calls to ensure the config array order
	 * is preserved even when plugins are registered asynchronously (e.g. Node
	 * plugins loaded via dynamic `import()` vs Python plugins registered
	 * synchronously).
	 *
	 * If `register()` finds its name already in the seeded order, it uses the
	 * existing position as the priority level instead of appending.
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
	 * If the plugin name was pre-seeded via `seedOrder()`, its priority level
	 * is taken from that pre-determined position. Otherwise it is appended at
	 * the end.
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

		// Determine the level from the pre-seeded orderedNames, or append
		let level = this.orderedNames.indexOf(plugin.name);
		if (level === -1) {
			level = this.orderedNames.length;
			this.orderedNames.push(plugin.name);
		}

		this.entries.set(plugin.name, {
			plugin,
			level,
			enabled: config.enabled,
		});
	}

	/**
	 * Get a plugin by name. Returns undefined if not registered or disabled.
	 * Use `getAny()` to include disabled plugins.
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
	getAny(name: string): RegistryEntry | undefined {
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
	 * Each entry includes the plugin and its priority level (lower = recommended first).
	 */
	getOrdered(): Array<{ plugin: BrowserPlugin; level: number }> {
		const result: Array<{ plugin: BrowserPlugin; level: number }> = [];
		for (const name of this.orderedNames) {
			const entry = this.entries.get(name);
			if (entry?.enabled) {
				result.push({ plugin: entry.plugin, level: entry.level });
			}
		}
		return result;
	}

	/**
	 * List all registered plugin names (enabled only).
	 */
	available(): string[] {
		return this.getOrdered().map((e) => e.plugin.name);
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
	 * Get the priority level for a plugin (lower = recommended first).
	 * Used by the LLM to decide whether to escalate to a different backend.
	 * Returns undefined if the plugin is not registered.
	 */
	getLevel(name: string): number | undefined {
		return this.entries.get(name)?.level;
	}

	/**
	 * Get plugins at higher priority levels (further in the backup chain) than the given level.
	 * Used to suggest alternative backends when bot detection fires.
	 */
	getHigherStealth(currentLevel: number): Array<{
		plugin: BrowserPlugin;
		level: number;
	}> {
		return this.getOrdered().filter((e) => e.level > currentLevel);
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

	/**
	 * Number of registered plugins (enabled and disabled).
	 */
	get size(): number {
		return this.entries.size;
	}
}

// ─── Singleton ────────────────────────────────────────────────────

/** Global plugin registry instance */
export const pluginRegistry = new PluginRegistry();
