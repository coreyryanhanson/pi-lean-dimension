/**
 * Config reader for pi-lean-seer.
 *
 * Reads `searxng.url` from Pi's merged settings.json files
 * (global ~/.pi/agent/settings.json + project-local .pi/settings.json).
 *
 * The expected shape in settings.json:
 * ```json
 * { "searxng": { "url": "http://localhost:8888" } }
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Config paths ─────────────────────────────────────────────────

/** Global pi settings path. */
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Project-local pi settings path (relative to cwd). */
const PROJECT_SETTINGS_PATH = ".pi/settings.json";

// ─── Reader ───────────────────────────────────────────────────────

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
 * Read the configured SearXNG URL from merged Pi settings.
 *
 * Looks up `searxng.url` in:
 *   1. `~/.pi/agent/settings.json` (global)
 *   2. `.pi/settings.json` (project-local, overrides global)
 *
 * Returns the URL string if configured, or `undefined` if absent
 * (caller should degrade gracefully — the tool returns a setup
 * message when no URL is configured).
 */
export function readSearxngUrl(): string | undefined {
	const global = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const project = readSettingsFile(PROJECT_SETTINGS_PATH);
	const merged = { ...global, ...project };

	const searxng = merged.searxng;
	if (searxng && typeof searxng === "object" && !Array.isArray(searxng)) {
		const url = (searxng as Record<string, unknown>).url;
		if (typeof url === "string" && url.length > 0) return url;
	}
	return undefined;
}
