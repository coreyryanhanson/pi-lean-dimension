/**
 * Shared settings.json reader — used by multiple modules that need to
 * read pi's settings.json files (global and project-local).
 *
 * Provides a unified `readSettingsFile()` function and canonical path
 * constants to prevent drift across the codebase.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Config paths ─────────────────────────────────────────────────

/** Global pi settings path. */
export const GLOBAL_SETTINGS_PATH = join(
	homedir(),
	".pi",
	"agent",
	"settings.json",
);

/** Project pi settings path (relative to cwd). */
export const PROJECT_SETTINGS_PATH = ".pi/settings.json";

// ─── Reader ────────────────────────────────────────────────────────

/**
 * Read and parse a JSON settings file. Returns {} on any failure.
 */
export function readSettingsFile(path: string): Record<string, unknown> {
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
 * Read global + project settings and merge them (project overrides global).
 *
 * Convenience wrapper so consumers don't duplicate the merge pattern.
 *
 * @param globalPath - Path to the global settings file (defaults to GLOBAL_SETTINGS_PATH)
 * @param projectPath - Path to the project settings file (defaults to PROJECT_SETTINGS_PATH)
 * @returns Merged settings object with project values taking precedence
 */
export function readMergedSettings(
	globalPath: string = GLOBAL_SETTINGS_PATH,
	projectPath: string = PROJECT_SETTINGS_PATH,
): Record<string, unknown> {
	const global = readSettingsFile(globalPath);
	const project = readSettingsFile(projectPath);
	return { ...global, ...project };
}
