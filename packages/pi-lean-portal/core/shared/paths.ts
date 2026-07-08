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

/**
 * User-installed Python backend root, sibling to `web-guides/` and
 * `browser-state/`.  Houses user-contributed stealth backends
 * (e.g. `camoufox-py/`) and any future user Python
 * backend, each as a `<name>-py/` directory containing a `bridge.py`.
 *
 * Lives outside the npm-managed `node_modules/` tree so it survives
 * `npm install` / `npm update` and is user-writable.  The plugin loader
 * (Phase 0b) resolves a plugin `dir` against this root as a fallback
 * after the package's shipped `backends/` root, and an absolute `dir`
 * short-circuits both.  See `core/plugin-config.ts` `detectPluginType`.
 *
 * Contents are **trusted user code** — the user authored or audited the
 * `bridge.py` placed here; this is not a plugin marketplace and the
 * extension never downloads backends into it automatically.
 */
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
