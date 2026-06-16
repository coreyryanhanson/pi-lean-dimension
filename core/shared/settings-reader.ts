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
