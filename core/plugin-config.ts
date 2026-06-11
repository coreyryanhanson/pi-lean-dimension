/**
 * Plugin Config Loader — reads browser.plugins from settings.json,
 * validates entries, detects plugin type, and provides typed PluginConfig[].
 *
 * Config is read once at startup. Hot-reload is future work.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginConfig, PluginDetection } from "./plugin-api.js";

// ─── Config paths ─────────────────────────────────────────────────

/** Global pi settings path */
const GLOBAL_SETTINGS_PATH = join(
	process.env.HOME || "/root",
	".pi",
	"agent",
	"settings.json",
);

/** Project pi settings path (relative to cwd) */
const PROJECT_SETTINGS_PATH = ".pi/settings.json";

// ─── Types ────────────────────────────────────────────────────────

/** Raw plugin entry from settings.json (before validation) */
interface RawPluginEntry {
	name?: unknown;
	dir?: unknown;
	enabled?: unknown;
	config?: unknown;
}

/** Result of loading and validating the plugin config */
export interface PluginConfigLoadResult {
	/** Validated plugin configs in order */
	plugins: PluginConfig[];
	/** Validation errors (non-fatal — logged but not thrown) */
	errors: string[];
}

// ─── Config reading ───────────────────────────────────────────────

/** Read and parse a JSON settings file. Returns {} on any failure. */
function readSettingsFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * Read the browser.plugins array from settings.json.
 *
 * Looks in:
 *   1. `~/.pi/agent/settings.json` (global)
 *   2. `.pi/settings.json` (project-local, overrides global)
 *
 * Returns the merged plugins array, or undefined if not configured.
 */
function readPluginsFromSettings(): unknown[] | undefined {
	const global = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const project = readSettingsFile(PROJECT_SETTINGS_PATH);

	// Project overrides global
	const merged = { ...global, ...project };
	const browserConfig = merged["browser"];

	if (
		!browserConfig ||
		typeof browserConfig !== "object" ||
		Array.isArray(browserConfig)
	) {
		return undefined;
	}

	const plugins = (browserConfig as Record<string, unknown>)["plugins"];
	if (!Array.isArray(plugins)) return undefined;

	return plugins;
}

// ─── Validation ───────────────────────────────────────────────────

/**
 * Validate a single raw plugin entry from settings.json.
 * Returns a PluginConfig if valid, or adds errors to the error list.
 */
function validateEntry(
	raw: unknown,
	index: number,
	errors: string[],
	seenNames: Set<string>,
): PluginConfig | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push(
			`plugins[${index}]: Entry must be an object, got ${typeof raw}`,
		);
		return null;
	}

	const entry = raw as RawPluginEntry;

	// name is required
	if (typeof entry.name !== "string" || !entry.name.trim()) {
		errors.push(
			`plugins[${index}]: 'name' is required and must be a non-empty string`,
		);
		return null;
	}

	const name = entry.name.trim();

	// Check for duplicate names
	if (seenNames.has(name)) {
		errors.push(`plugins[${index}]: Duplicate plugin name '${name}'`);
		return null;
	}
	seenNames.add(name);

	// dir is required
	if (typeof entry.dir !== "string" || !entry.dir.trim()) {
		errors.push(
			`plugins[${index}]: 'dir' is required and must be a non-empty string`,
		);
		return null;
	}

	const dir = entry.dir.trim();

	// enabled defaults to true
	const enabled = typeof entry.enabled === "boolean" ? entry.enabled : true;

	// config must be an object if provided
	let config: Record<string, unknown> = {};
	if (entry.config !== undefined) {
		if (
			typeof entry.config !== "object" ||
			Array.isArray(entry.config) ||
			entry.config === null
		) {
			errors.push(`plugins[${index}]: 'config' must be an object if provided`);
		} else {
			config = entry.config as Record<string, unknown>;
		}
	}

	return { name, dir, enabled, config };
}

// ─── Plugin type detection ────────────────────────────────────────

/**
 * Detect the plugin type from the directory contents.
 *
 * - `backends/<dir>/index.ts` exists → Node plugin
 * - `backends/<dir>/bridge.py` exists → Python plugin
 * - Both exist → error (ambiguous)
 * - Neither exists → error
 */
export function detectPluginType(
	dir: string,
	backendsRoot: string,
): PluginDetection {
	const dirPath = join(backendsRoot, dir);
	const indexPath = join(dirPath, "index.ts");
	const bridgePath = join(dirPath, "bridge.py");

	const hasIndex = existsSync(indexPath);
	const hasBridge = existsSync(bridgePath);

	if (hasIndex && hasBridge) {
		throw new Error(
			`Plugin dir '${dir}' is ambiguous: both index.ts and bridge.py found. Remove one.`,
		);
	}

	if (hasIndex) {
		return { type: "node", entryPoint: indexPath };
	}

	if (hasBridge) {
		return { type: "python", entryPoint: bridgePath };
	}

	throw new Error(
		`Plugin dir '${dir}' has no entry point. Expected index.ts (Node) or bridge.py (Python).`,
	);
}

// ─── Main loader ───────────────────────────────────────────────────

/**
 * Default backends root — relative to this file.
 * core/plugin-config.ts → backends/ is ../../backends/
 */
export const DEFAULT_BACKENDS_ROOT = join(__dirname, "..", "backends");

/**
 * Load and validate the plugin configuration.
 *
 * If no `browser.plugins` config exists, returns a single Chromium
 * plugin config (default fallback — identical to today's behavior).
 */
export function loadPluginConfig(
	backendsRoot: string = DEFAULT_BACKENDS_ROOT,
): PluginConfigLoadResult {
	const errors: string[] = [];

	// Read raw plugins array from settings
	const rawPlugins = readPluginsFromSettings();

	// Default fallback: single chromium plugin
	if (!rawPlugins) {
		return {
			plugins: [
				{
					name: "chromium",
					dir: "chromium",
					enabled: true,
					config: {},
				},
			],
			errors: [],
		};
	}

	// Validate each entry
	const seenNames = new Set<string>();
	const plugins: PluginConfig[] = [];

	for (let i = 0; i < rawPlugins.length; i++) {
		const validated = validateEntry(rawPlugins[i], i, errors, seenNames);
		if (validated) {
			// Also validate that the directory exists and is unambiguous
			try {
				detectPluginType(validated.dir, backendsRoot);
			} catch (err) {
				errors.push(
					`plugins[${i}] ('${validated.name}'): ${err instanceof Error ? err.message : String(err)}`,
				);
				continue; // Skip this plugin
			}
			plugins.push(validated);
		}
	}

	return { plugins, errors };
}
