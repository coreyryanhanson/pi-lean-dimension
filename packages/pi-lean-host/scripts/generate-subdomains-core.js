/**
 * Shared core for generating `generated/subdomains.ts` from the MiniWoB++ html directory.
 *
 * Used by:
 * - `scripts/generate-subdomains.ts` — vitest globalSetup
 * - `scripts/setup-miniwob.mjs`     — standalone CLI setup
 *
 * Both callers produce identical output. This module prevents drift between the
 * two invocation paths.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Default MiniWoB++ HTML root (matches helpers and suite defaults). */
const DEFAULT_HTML_ROOT = "/tmp/miniwob-plusplus/miniwob/html";

/**
 * Generate `generated/subdomains.ts` from the MiniWoB++ task HTML files.
 *
 * When the task directory is not found (e.g. fresh clone before setup),
 * writes a placeholder stub with an empty array so the static import in
 * `register-suite.ts` always resolves at module-load time rather than
 * crashing with MODULE_NOT_FOUND.
 *
 * @param {string} [htmlRoot]  Path to the MiniWoB++ html root. Defaults to the
 *                  `MINIWOB_HTML_ROOT` env var, then the hardcoded default.
 * @returns {number} Number of subdomains written (0 means a placeholder stub).
 */
export function generateSubdomainsFile(htmlRoot) {
	const root = htmlRoot ?? process.env.MINIWOB_HTML_ROOT ?? DEFAULT_HTML_ROOT;
	const taskDir = join(root, "miniwob");
	const contentAvailable = existsSync(taskDir);

	// Output: packages/pi-lean-host/generated/subdomains.ts
	// (this script lives in packages/pi-lean-host/scripts/)
	const generatedDir = resolve(import.meta.dirname, "..", "generated");
	mkdirSync(generatedDir, { recursive: true });

	const sorted = contentAvailable
		? readdirSync(taskDir)
				.filter((f) => f.endsWith(".html"))
				.map((f) => f.replace(/\.html$/, ""))
				.sort()
		: [];

	const placeholder = !contentAvailable;

	const lines = [
		"/**",
		" * Auto-generated MiniWoB++ subdomain list.",
		placeholder
			? " * Placeholder — MiniWoB++ content not available at setup time."
			: ` * Generated from \`miniwob-plusplus@7fd85d71a4b60325c6585396ec4f48377d049838\`.`,
		placeholder
			? " * Run `npm run setup:miniwob` to populate the task directory and regenerate."
			: " * Regenerate via: npm run setup:miniwob",
		" * Do not edit by hand.",
		" */",
		"export const MINIWOB_SUBDOMAINS = [",
		...sorted.map((s) => `\t"${s}",`),
		"] as const;",
		"",
	].join("\n");

	const outPath = join(generatedDir, "subdomains.ts");
	writeFileSync(outPath, lines, "utf-8");

	return sorted.length;
}
