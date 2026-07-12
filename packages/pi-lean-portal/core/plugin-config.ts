/**
 * Plugin Config Loader — reads browser.plugins from settings.json,
 * validates entries, detects plugin type, and provides typed PluginConfig[].
 *
 * Config is read once at startup. Hot-reload is future work.
 */

import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { USER_BACKENDS_DIR } from "./shared/paths.js";
// ─── Plugin Config types ──────────────────────────────────────────

/** A single plugin entry from the user's settings.json */
export interface PluginConfig {
	/** Stable identifier used in strategy param, session tracking, errors */
	name: string;
	/** Directory name (or absolute path) containing the plugin code.
	 * Resolved by `detectPluginType` against the configured roots: an
	 * absolute path short-circuits; otherwise the shipped `backends/`
	 * root is tried first, then the user `user-backends/` tree. */
	dir: string;
	/** Whether this plugin is active (default: true) */
	enabled: boolean;
	/** Plugin-specific overrides passed to init() */
	config: Record<string, unknown>;
}

/** Plugin type — determines how the plugin is loaded and run */
export type PluginType = "node" | "python";

/** Result of inspecting a plugin directory for type detection */
export interface PluginDetection {
	type: PluginType;
	/** Absolute or relative path to the entry point */
	entryPoint: string;
}
import { sanitizeProfileName } from "./shared/storage-state.js";
import { readMergedSettings } from "./shared/settings-reader.js";

// ─── Config types & loading ────────────────────────────────────────

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

/**
 * Unified full configuration result — includes both browser and plugin config.
 */
export interface FullConfig {
	browser: BrowserConfig;
	plugins: PluginConfigLoadResult;
}

/** Internal cache for loadFullConfig() — invalidated via invalidateConfigCache() */
let _fullConfigCache: FullConfig | null = null;

/**
 * Parse the browser config section from settings JSON.
 * Extracts and validates defaultProfile.
 */
function parseBrowserConfig(
	raw: Record<string, unknown> | undefined,
): BrowserConfig {
	const errors: string[] = [];

	// Defaults
	const config: BrowserConfig = {
		defaultProfile: "session",
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

	// Log validation errors (non-fatal, but surfaced in return)
	for (const err of errors) {
		console.warn(`[pi-lean-portal] Config warning: ${err}`);
	}

	return config;
}

/**
 * Parse and validate the plugin config section from settings JSON.
 *
 * Extracts and validates the `browser.plugins` array.
 * If no plugins are configured, returns a single default Chromium plugin.
 */
/** @internal */
export function parsePluginConfig(
	raw: Record<string, unknown> | undefined,
	roots: readonly string[],
): PluginConfigLoadResult {
	const errors: string[] = [];

	// Extract plugins from the raw browser config section
	const rawPlugins = raw?.["plugins"];

	// Default fallback: chromium + firefox enabled, python backends disabled
	if (!Array.isArray(rawPlugins)) {
		return {
			plugins: [
				{
					name: "chromium",
					dir: "chromium",
					enabled: true,
					config: {},
				},
				{
					name: "firefox",
					dir: "firefox",
					enabled: true,
					config: {},
				},
				{
					name: "chromium-py",
					dir: "chromium-py",
					enabled: false,
					config: {},
				},
				{
					name: "firefox-py",
					dir: "firefox-py",
					enabled: false,
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
				detectPluginType(validated.dir, roots);
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
	const merged = readMergedSettings();
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
 * Load and cache the full browser configuration from settings.json.
 *
 * Reads settings.json once on first call and caches the result for
 * subsequent calls. Both `loadBrowserConfig()` and `loadPluginConfig()`
 * delegate to this function.
 */
export function loadFullConfig(roots?: readonly string[]): FullConfig {
	if (_fullConfigCache) return _fullConfigCache;

	const raw = readBrowserConfigRaw();
	const effectiveRoots = roots ?? DEFAULT_BACKEND_ROOTS;

	_fullConfigCache = {
		browser: parseBrowserConfig(raw),
		plugins: parsePluginConfig(raw, effectiveRoots),
	};

	return _fullConfigCache;
}

/**
 * Invalidate the config cache — forces the next call to re-read from disk.
 * Used in tests to reset state between test cases.
 */
export function invalidateConfigCache(): void {
	_fullConfigCache = null;
}

/**
 * Convenience wrapper — returns the `defaultProfile` setting from the
 * cached browser configuration. Delegates to `loadFullConfig()` which
 * reads `settings.json` once and caches the result.
 *
 * The `browser.defaultProfile` field controls what happens when
 * `browser-navigate` is called without an explicit `profile` parameter.
 * See `BrowserConfig` for valid values.
 */
export function loadBrowserConfig(): BrowserConfig {
	return loadFullConfig().browser;
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
 * Resolution order for `dir`:
 *   1. **Absolute path** — if `dir` is absolute, it is used directly
 *      (skips all roots; useful for development / power users).
 *   2. **Each root in `roots`, in order** — `join(root, dir)`. The first
 *      root that contains an unambiguous entry point wins.
 *
 * Per-root ambiguity: if a single resolved dir contains *both*
 * `index.ts` and `bridge.py`, that is an error (the original behaviour).
 * If the first root has `index.ts` and a later root has `bridge.py`, the
 * first root wins — that is a legitimate multi-root layout, not ambiguity.
 *
 * If no resolved dir has any entry point, throws an error naming every
 * root searched so users can see where the loader looked.
 *
 * - `backends/<dir>/index.ts` exists → Node plugin
 * - `backends/<dir>/bridge.py` exists → Python plugin
 * - Both exist in the same resolved dir → error (ambiguous)
 * - Neither exists anywhere → error
 */
export function detectPluginType(
	dir: string,
	roots: readonly string[],
): PluginDetection {
	const candidatePaths: string[] = [];
	if (isAbsolute(dir)) {
		candidatePaths.push(dir);
	} else {
		for (const root of roots) {
			candidatePaths.push(join(root, dir));
		}
	}

	for (const dirPath of candidatePaths) {
		const indexPath = join(dirPath, "index.ts");
		const bridgePath = join(dirPath, "bridge.py");

		const hasIndex = existsSync(indexPath);
		const hasBridge = existsSync(bridgePath);

		if (hasIndex && hasBridge) {
			throw new Error(
				`Plugin dir '${dir}' is ambiguous: both index.ts and bridge.py found in ${dirPath}. Remove one.`,
			);
		}

		if (hasIndex) {
			return { type: "node", entryPoint: indexPath };
		}

		if (hasBridge) {
			return { type: "python", entryPoint: bridgePath };
		}
	}

	const searched = candidatePaths.length
		? candidatePaths.join(", ")
		: "(no roots provided)";
	throw new Error(
		`Plugin dir '${dir}' has no entry point. Expected index.ts (Node) or bridge.py (Python). ` +
			`Searched: ${searched}`,
	);
}

// ─── Main loader ───────────────────────────────────────────────────

/**
 * Default backends root — relative to this file.
 * core/plugin-config.ts → backends/ is ../../backends/
 */
export const DEFAULT_BACKENDS_ROOT = join(__dirname, "..", "backends");

/**
 * Default root search order for plugin discovery: the shipped package
 * `backends/` first, then the user-writable `user-backends/` tree under
 * `~/.pi/agent/pi-lean-portal/`.  Callers may pass a custom `roots`
 * array (e.g. tests with temp dirs); when omitted, this default is used.
 */
export const DEFAULT_BACKEND_ROOTS: readonly string[] = [
	DEFAULT_BACKENDS_ROOT,
	USER_BACKENDS_DIR,
];

/**
 * Load and validate the plugin configuration.
 *
 * If no `browser.plugins` config exists, returns the default fallback
 * (chromium + firefox enabled, chromium-py + firefox-py disabled).
 *
 * @param roots  Optional ordered list of backend roots to resolve
 *               plugin `dir` values against.  Defaults to
 *               `DEFAULT_BACKEND_ROOTS` (shipped backends, then
 *               `user-backends/`).
 */
export function loadPluginConfig(
	roots?: readonly string[],
): PluginConfigLoadResult {
	return loadFullConfig(roots).plugins;
}
