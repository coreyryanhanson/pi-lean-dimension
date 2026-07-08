/**
 * Shared core for generating `generated/subdomains.ts` from the MiniWoB++ html directory.
 *
 * Used by:
 * - `scripts/generate-subdomains.ts` — vitest globalSetup
 * - `scripts/setup-miniwob.mjs`     — standalone CLI setup
 *
 * @module
 */

/**
 * Generate `generated/subdomains.ts` from the MiniWoB++ task HTML files.
 *
 * When the task directory is not found writes a placeholder stub with an
 * empty array so the static import in `register-suite.ts` always resolves.
 *
 * @param htmlRoot  Path to the MiniWoB++ html root. Defaults to the
 *                  `MINIWOB_HTML_ROOT` env var, then the hardcoded default.
 * @returns Number of subdomains written (0 means a placeholder stub).
 */
export function generateSubdomainsFile(htmlRoot?: string): number;
