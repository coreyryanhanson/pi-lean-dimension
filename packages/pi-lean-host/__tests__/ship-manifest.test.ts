/**
 * Ship-manifest verification for pi-lean-host.
 *
 * Asserts that every production `.ts` file is covered by `package.json`
 * `files`, and that no stale entries exist. Also includes a negative
 * assertion: `api-guides/` is NOT in the tarball.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyShipManifest } from "../core/verify-ship-manifest.js";

// Point verifyShipManifest at the package root, not __tests__/
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("publish manifest", () => {
	it("`package.json` `files` array covers every production .ts module", () => {
		// api-guides/ contains GitHub-only reference recipes, not in tarball
		const result = verifyShipManifest(PACKAGE_ROOT, {
			skipDirs: ["api-guides"],
		});
		expect(result.missing).toEqual([]);
	});

	it("every `files` entry points at something on disk", () => {
		const result = verifyShipManifest(PACKAGE_ROOT);
		expect(result.stale).toEqual([]);
	});

	it("api-guides/ directory is NOT in the published files array (GitHub-only recipes)", () => {
		let pkg: { files?: string[] };
		try {
			const raw = readFileSync(
				new URL("../package.json", import.meta.url),
				"utf-8",
			);
			pkg = JSON.parse(raw) as { files?: string[] };
		} catch {
			pkg = {};
		}
		const files: string[] = pkg.files ?? [];
		for (const entry of files) {
			expect(entry).not.toMatch(/^api-guides/);
			expect(entry).not.toMatch(/^helpers\//);
		}
	});
	it("axis guides ship their transform helper.ts alongside guide.md", () => {
		// api-guides/ is GitHub-only (excluded from the npm tarball — see the
		// negative assertions above), so the helper only needs to exist in the
		// repo tree, not in the published `files` array. The synthetic axis
		// guides carry helper.ts where their axis needs one (transform /
		// local-helper).
		expect(
			existsSync(
				resolve(PACKAGE_ROOT, "api-guides/earthquake.usgs.gov/helper.ts"),
			),
		).toBe(true);
	});
});
