/**
 * Shared function to generate `generated/subdomains.ts` from the
 * MiniWoB++ html directory.
 *
 * Used by:
 * - vitest globalSetup (generates before test runs so the static
 *   import in register-suite.ts always resolves)
 * - setup-miniwob.mjs (inline copy for standalone CLI use)
 *
 * When MiniWoB++ content is not available on disk, writes a stub
 * with an empty array so test suites can skip gracefully instead
 * of crashing at module load.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Default MiniWoB++ HTML root (matches miniwob-suite-helper.ts). */
const DEFAULT_HTML_ROOT = "/tmp/miniwob-plusplus/miniwob/html";

/**
 * Generate `generated/subdomains.ts` from `htmlRoot/miniwob/*.html`.
 *
 * Returns the number of subdomains written (0 means a placeholder
 * stub was written because the task directory was not found).
 */
export function generateSubdomainsFile(htmlRoot?: string): number {
	const root = htmlRoot ?? process.env.MINIWOB_HTML_ROOT ?? DEFAULT_HTML_ROOT;
	const taskDir = join(root, "miniwob");
	const contentAvailable = existsSync(taskDir);

	const generatedDir = resolve(import.meta.dirname, "..", "generated");
	mkdirSync(generatedDir, { recursive: true });

	// Collect subdomain names from file stems, then sort deterministically.
	const sorted: string[] = contentAvailable
		? readdirSync(taskDir)
				.filter((f) => f.endsWith(".html"))
				.map((f) => f.replace(/\.html$/, ""))
				.sort()
		: [];

	const content = [
		"/**",
		" * Auto-generated MiniWoB++ subdomain list.",
		` * ${
			contentAvailable ? "Generated from" : "Placeholder —"
		} \`miniwob-plusplus@7fd85d71a4b60325c6585396ec4f48377d049838\`.`,
		` * ${
			contentAvailable
				? "Regenerate via: npm run setup:miniwob"
				: "Run `npm run setup:miniwob` to populate."
		}`,
		" * Do not edit by hand.",
		" */",
		"export const MINIWOB_SUBDOMAINS = [",
		...sorted.map((s) => `\t"${s}",`),
		"] as const;",
		"",
	].join("\n");

	const outPath = join(generatedDir, "subdomains.ts");
	writeFileSync(outPath, content, "utf-8");

	return sorted.length;
}
