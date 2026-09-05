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

			// Auth: the corpus ships `none`, `static-key`, and `oauth2` guides.
			expect(["none", "static-key", "oauth2"]).toContain(result.guide.auth.kind);
			const auth = result.guide.auth;
			if (auth.kind === "static-key") {
				// A keyed guide must declare a non-empty reference shape: header
				// (secretRefs), query param (secretQueryRefs), or URL path
				// (secretPathRefs) — or any combination. Every ref carries its
				// own secret name (nested SecretRef — self-contained).
				const headerRefs = auth.secretRefs ?? {};
				const queryRefs = auth.secretQueryRefs ?? {};
				const pathRefs = auth.secretPathRefs ?? {};
				expect(
					Object.keys(headerRefs).length +
						Object.keys(queryRefs).length +
						Object.keys(pathRefs).length,
				).toBeGreaterThan(0);
				for (const ref of [
					...Object.values(headerRefs),
					...Object.values(queryRefs),
					...Object.values(pathRefs),
				]) {
					expect(ref.secret.length).toBeGreaterThan(0);
				}
			}

			// Every operation declares a supported via
			for (const op of result.guide.operations) {
				expect(["restGet", "paginate"]).toContain(op.via);
				expect(op.path).toMatch(/^\//); // must start with /
			}
		});
	}
});
