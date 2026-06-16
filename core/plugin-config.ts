/**
 * Plugin Config Loader — reads browser.plugins from settings.json,
 * validates entries, detects plugin type, and provides typed PluginConfig[].
 *
 * Config is read once at startup. Hot-reload is future work.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginConfig, PluginDetection } from "./plugin-api.js";
import {
	sanitizeProfileName,
	DEFAULT_MAX_STORAGE_STATE_SIZE,
} from "./shared/storage-state.js";
import {
	readSettingsFile,
	GLOBAL_SETTINGS_PATH,
	PROJECT_SETTINGS_PATH,
} from "./shared/settings-reader.js";

// ─── Types ────────────────────────────────────────────────────────

/** Configuration for a single browser profile. */
export interface BrowserProfileConfig {
	persist: boolean;
}

/**
 * Parsed browser configuration from settings.json.
 * Provides defaults for all fields — every field is always present.
 */
export interface BrowserConfig {
	/**
	 * Default profile mode or named profile when `browser-navigate` omits the `profile` parameter.
	 * - "none": clean slate, no persistence
	 * - "session": persist for this conversation
	 * - A named profile string (e.g. "shopping", "work")
	 */
	defaultProfile: "none" | "session" | string;
	/** Fallback profile name when `profile="session"` cannot derive a piSessionId-based name. Default: "default". */
	legacyDefaultProfile: string;
	/**
	 * Size threshold in bytes for storage state warnings.
	 * When a saved state exceeds this, a warning is logged but the save proceeds.
	 */
	maxStorageStateSize: number;
	/**
	 * Named profiles configuration.
	 * Profiles listed here are validated at startup; unlisted profiles
	 * can still be used at runtime but won't appear in listings.
	 */
	profiles: Record<string, BrowserProfileConfig>;
}

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

/**
 * Read the merged browser config object from settings.json.
 *
 * Looks in:
 *   1. `~/.pi/agent/settings.json` (global)
 *   2. `.pi/settings.json` (project-local, overrides global)
 *
 * Returns the browser config object, or undefined if not present or invalid.
 */
function readBrowserConfigRaw(): Record<string, unknown> | undefined {
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

	return browserConfig as Record<string, unknown>;
}

/**
 * Read the browser.plugins array from settings.json.
 *
 * Returns the merged plugins array, or undefined if not configured.
 */
function readPluginsFromSettings(): unknown[] | undefined {
	const browserConfig = readBrowserConfigRaw();
	if (!browserConfig) return undefined;

	const plugins = browserConfig["plugins"];
	if (!Array.isArray(plugins)) return undefined;

	return plugins;
}

/**
 * Load and validate the browser configuration from settings.json.
 *
 * Reads the `browser` section and extracts:
 * - `defaultProfile` (string, default "none")
 * - `maxStorageStateSize` (number in bytes, default 10 MB)
 * - `profiles` (record of profile configs, default {})
 *
 * All profile names are validated via `sanitizeProfileName()`.
 * Validation errors are collected but non-fatal — invalid entries
 * fall back to sensible defaults.
 */
export function loadBrowserConfig(): BrowserConfig {
	const raw = readBrowserConfigRaw();
	const errors: string[] = [];

	// Defaults
	const config: BrowserConfig = {
		defaultProfile: "none",
		legacyDefaultProfile: "default",
		maxStorageStateSize: DEFAULT_MAX_STORAGE_STATE_SIZE,
		profiles: {},
	};

	if (!raw) return config;

	// ── defaultProfile ───────────────────────────────────────────
	if (raw.defaultProfile !== undefined) {
		if (typeof raw.defaultProfile === "string" && raw.defaultProfile.trim()) {
			const v = raw.defaultProfile.trim();
			// Validate: "none", "session", or a named profile
			if (v === "none" || v === "session") {
				config.defaultProfile = v;
			} else {
				try {
					config.defaultProfile = sanitizeProfileName(v);
				} catch (err) {
					errors.push(
						`browser.defaultProfile: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		} else {
			errors.push(
				`browser.defaultProfile: expected a non-empty string, got ${typeof raw.defaultProfile}`,
			);
		}
	}

	// ── legacyDefaultProfile (was old defaultProfile) ────────
	if (raw.legacyDefaultProfile !== undefined) {
		if (
			typeof raw.legacyDefaultProfile === "string" &&
			raw.legacyDefaultProfile.trim()
		) {
			try {
				config.legacyDefaultProfile = sanitizeProfileName(
					raw.legacyDefaultProfile.trim(),
				);
			} catch (err) {
				errors.push(
					`browser.legacyDefaultProfile: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			errors.push(
				`browser.legacyDefaultProfile: expected a non-empty string, got ${typeof raw.legacyDefaultProfile}`,
			);
		}
	}

	// ── maxStorageStateSize ───────────────────────────────────
	if (raw.maxStorageStateSize !== undefined) {
		if (
			typeof raw.maxStorageStateSize === "number" &&
			raw.maxStorageStateSize > 0 &&
			Number.isFinite(raw.maxStorageStateSize)
		) {
			config.maxStorageStateSize = raw.maxStorageStateSize;
		} else {
			errors.push(
				`browser.maxStorageStateSize: expected a positive number, got ${JSON.stringify(raw.maxStorageStateSize)}`,
			);
		}
	}

	// ── profiles ──────────────────────────────────────────────
	if (raw.profiles !== undefined) {
		if (
			typeof raw.profiles !== "object" ||
			Array.isArray(raw.profiles) ||
			raw.profiles === null
		) {
			errors.push(
				`browser.profiles: expected an object, got ${typeof raw.profiles}`,
			);
		} else {
			const profilesRaw = raw.profiles as Record<string, unknown>;
			for (const [name, entry] of Object.entries(profilesRaw)) {
				try {
					sanitizeProfileName(name);
				} catch (err) {
					errors.push(
						`browser.profiles['${name}']: ${err instanceof Error ? err.message : String(err)}`,
					);
					continue;
				}

				if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
					errors.push(
						`browser.profiles['${name}']: expected an object, got ${typeof entry}`,
					);
					continue;
				}

				const profileEntry = entry as Record<string, unknown>;
				const persist =
					typeof profileEntry.persist === "boolean"
						? profileEntry.persist
						: true;

				config.profiles[name] = { persist };
			}
		}
	}

	// Log validation errors (non-fatal, but surfaced in return)
	for (const err of errors) {
		console.warn(`[pi-browser] Config warning: ${err}`);
	}

	return config;
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
