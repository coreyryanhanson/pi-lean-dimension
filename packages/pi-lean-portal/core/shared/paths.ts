/**
 * Shared Path & Filename Utilities — single source of truth for temp
 * file directories and task ID sanitization.
 *
 * Previously these constants and helpers were duplicated across
 * snapshot-cache.ts, fetch-backend.ts, and router.ts. Consolidating
 * them here prevents divergence and simplifies changes.
 *
 * @module paths
 */

import { tmpdir, homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Base temp directory for all pi-lean-portal ephemeral files. */
export const BROWSER_TEMP_DIR = `${tmpdir()}/pi-lean-portal`;

/**
 * Portal-owned data root under ~/.pi/agent/, namespaced by package name.
 * Houses user-authored guides, browser profiles, and any other runtime
 * user data that must survive package upgrades.
 * Siblings: sessions/ (pi-core owned — DO NOT move under this).
 */
export const PORTAL_DATA_DIR = join(
	homedir(),
	".pi",
	"agent",
	"pi-lean-portal",
);

/** User-installed Python backend root; sibling of web-guides/ and browser-state/. */
export const USER_BACKENDS_DIR = join(PORTAL_DATA_DIR, "user-backends");

/**
 * Sanitize a taskId (or any string) for use in filenames.
 * Replaces any character that is not alphanumeric or hyphen with `_`.
 *
 * Note: `taskId()` from `task-id.ts` always returns filename-safe values
 * (`browser-N` or `browser-default`), so callers can skip this on its
 * output. This function is useful for sanitizing arbitrary strings such
 * as raw pi session IDs.
 */
export function safeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9-]/g, "_");
}

/**
 * Ensure the browser temp directory exists (best-effort).
 * Creates the directory recursively. Silently ignores errors so that
 * callers don't need their own try-catch blocks.
 */
export function ensureBrowserTempDir(): void {
	try {
		mkdirSync(BROWSER_TEMP_DIR, { recursive: true });
	} catch {
		/* best-effort */
	}
}
