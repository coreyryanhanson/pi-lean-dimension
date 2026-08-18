// Host-only boundary test.
//
// Walks all host source .ts files under packages/pi-lean-host/ (excluding
// __tests__/ directories) and fails on any import specifier reaching
// into pi-lean-portal or pi-lean-search.
//
// The boundary guards *source* imports; test files are excluded so
// cross-package *test-helper* imports (test helpers rely on this) do not
// trip it.
//
// Manually inserting an import from "../../pi-lean-portal/core/..."
// into a source file and re-running this test must produce a failure.
// The same import in a __tests__/ file must not.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, it, expect } from "vitest";

const HOST_DIR = resolve(import.meta.dirname, "..");

/**
 * Match relative import specifiers that reach into pi-lean-portal or pi-lean-search.
 */
const FORBIDDEN_RELATIVE = /^(?:\.\.\/)+pi-lean-(?:portal|search)(?:\/|$)/;

/**
 * Match bare specifier imports of pi-lean-portal or pi-lean-search.
 */
const FORBIDDEN_BARE = /^pi-lean-(?:portal|search)(?:\/|$)/;

/**
 * Recursively walk a directory collecting .ts files, skipping __tests__/.
 */
function findSourceFiles(dir: string, rootDir: string): string[] {
	const results: string[] = [];

	function walk(current: string) {
		const rel = relative(rootDir, current);
		if (rel.split(sep).includes("__tests__")) return;

		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".ts")) {
				results.push(full);
			}
		}
	}

	walk(dir);
	return results;
}

describe("host-only boundary", () => {
	it("no host source file imports pi-lean-portal or pi-lean-search", () => {
		const sourceFiles = findSourceFiles(HOST_DIR, HOST_DIR);
		expect(sourceFiles.length).toBeGreaterThan(0);

		const violations: { file: string; line: number; specifier: string }[] = [];

		for (const file of sourceFiles) {
			const content = readFileSync(file, "utf-8");
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;

				// Static import/export with string specifier
				const staticMatch = line.match(
					/(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/,
				);
				if (staticMatch?.[1]) {
					const specifier = staticMatch[1];
					if (
						FORBIDDEN_RELATIVE.test(specifier) ||
						FORBIDDEN_BARE.test(specifier)
					) {
						violations.push({
							file: relative(HOST_DIR, file),
							line: i + 1,
							specifier,
						});
					}
				}

				// Dynamic import
				const dynamicMatch = line.match(/import\s*\(\s*["']([^"']+)["']\s*\)/);
				if (dynamicMatch?.[1]) {
					const specifier = dynamicMatch[1];
					if (
						FORBIDDEN_RELATIVE.test(specifier) ||
						FORBIDDEN_BARE.test(specifier)
					) {
						violations.push({
							file: relative(HOST_DIR, file),
							line: i + 1,
							specifier,
						});
					}
				}
			}
		}

		expect(violations).toEqual([]);
	});

	it("test files are excluded from the source walk", () => {
		const sourceFiles = findSourceFiles(HOST_DIR, HOST_DIR);
		// No source file should live under __tests__/
		for (const file of sourceFiles) {
			const rel = relative(HOST_DIR, file);
			expect(rel.split(sep)).not.toContain("__tests__");
		}
	});

	it("documents forbidden vs allowed specifier patterns", () => {
		const bad = [
			"../../pi-lean-portal/core/plugin-api",
			"pi-lean-portal",
			"pi-lean-portal/core/guides",
			"pi-lean-search",
		];
		for (const spec of bad) {
			expect(FORBIDDEN_RELATIVE.test(spec) || FORBIDDEN_BARE.test(spec)).toBe(
				true,
			);
		}

		const good = [
			"node:fs",
			"node:path",
			"@earendil-works/pi-coding-agent",
			"undici",
			"yaml",
			"../../core/ssrf-guard",
		];
		for (const spec of good) {
			expect(FORBIDDEN_RELATIVE.test(spec) || FORBIDDEN_BARE.test(spec)).toBe(
				false,
			);
		}
	});
});
