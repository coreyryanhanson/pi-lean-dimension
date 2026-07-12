/**
 * Load and validate plugin configuration from a specific settings file path.
 *
 * Moved out of core/plugin-config.ts so the function doesn't ship in the
 * npm tarball (core/ is in the package `files` allowlist).
 */

import {
	parsePluginConfig,
	type PluginConfigLoadResult,
	DEFAULT_BACKEND_ROOTS,
} from "../../core/plugin-config.js";
import { readSettingsFile } from "../../core/shared/settings-reader.js";

/**
 * Same parsing/validation as {@link import("../../core/plugin-config.js").loadPluginConfig},
 * but reads from a specific file path instead of the merged global + project
 * settings. One-shot read — no caching.
 *
 * The file must have the same top-level shape as `settings.json`:
 * ```json
 * { "browser": { "plugins": [...] } }
 * ```
 *
 * When the file is absent or has no `browser` section, falls back to the
 * default plugin list (same as `loadPluginConfig()` with no settings).
 *
 * @param path  Absolute or relative path to a settings.json file.
 * @param roots  Optional ordered list of backend roots to resolve
 *               plugin `dir` values against.  Defaults to
 *               `DEFAULT_BACKEND_ROOTS`.
 */
export function loadPluginConfigFromFile(
	path: string,
	roots?: readonly string[],
): PluginConfigLoadResult {
	const raw = readSettingsFile(path);
	const browserConfig = raw["browser"];
	const effectiveRoots = roots ?? DEFAULT_BACKEND_ROOTS;

	if (
		!browserConfig ||
		typeof browserConfig !== "object" ||
		Array.isArray(browserConfig)
	) {
		return parsePluginConfig(undefined, effectiveRoots);
	}

	return parsePluginConfig(
		browserConfig as Record<string, unknown>,
		effectiveRoots,
	);
}
