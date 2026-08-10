/**
 * Verify every bundled guide in api-guides/ passes parseApiGuide().
 *
 * This is a structural test (no live endpoints) — it just checks that
 * every guide.md in the repo parses cleanly with the current schema.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApiGuide } from "../core/parse-api-guide.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, "..", "api-guides");

function discoverGuides(): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(GUIDES_DIR)) {
		const guidePath = join(GUIDES_DIR, entry, "guide.md");
		try {
			if (statSync(guidePath).isFile()) out.push(entry);
		} catch {
			// not a directory or no guide.md — skip
		}
	}
	return out.sort();
}

const guideDomains = discoverGuides();

describe("all bundled guides parse correctly", () => {
	it(`discovers ${guideDomains.length} guides in api-guides/`, () => {
		expect(guideDomains.length).toBeGreaterThanOrEqual(4);
	});

	for (const domain of guideDomains) {
		it(`${domain} parses cleanly`, () => {
			const guidePath = join(GUIDES_DIR, domain, "guide.md");
			const raw = readFileSync(guidePath, "utf-8");
			const result = parseApiGuide(raw, { file: guidePath, filename: domain });

			if (!result.ok) {
				throw new Error(
					`${domain}: ${result.error.field} — expected ${result.error.expected}, found ${result.error.found}` +
						(result.error.fix ? `\n  Fix: ${result.error.fix}` : ""),
				);
			}

			// Sanity checks on the parsed guide
			expect(result.guide.apiHost).toBeTruthy();
			expect(result.guide.operations.length).toBeGreaterThan(0);
			expect(result.guide.auth.kind).toBe("none");

			// Every operation declares a supported via
			for (const op of result.guide.operations) {
				expect(["restGet", "paginate"]).toContain(op.via);
				expect(op.path).toMatch(/^\//); // must start with /
			}
		});
	}
});
