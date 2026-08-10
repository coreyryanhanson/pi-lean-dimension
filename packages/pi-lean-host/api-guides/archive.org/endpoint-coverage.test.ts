/**
 * Internet Archive recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Tests the live Internet Archive API: parses the recipe, executes every
 * defined operation against the live endpoint, and asserts the response has
 * the expected shape.
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1.
 * Co-located with the guide it tests.
 */

import { describe, expect } from "vitest";
import {
	withTempDirs,
	createFetchOp,
	itWhen,
} from "../_shared/test-harness.js";

const DOMAIN = "archive.org";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper) ──

const fetchOp = createFetchOp(DOMAIN);

// ═══════════════════════════════════════════════════════════════════
// Parsing baseline
// ═══════════════════════════════════════════════════════════════════

describe("Internet Archive live integration smoke", () => {
	itWhen(
		"parses and loads the Internet Archive recipe from a temp user dir",
		withTempDirs("archive.org")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("archive.org");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["archive.org"]!;
			expect(guide.apiHost).toBe("https://archive.org");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(4);
			const names = guide.operations.map((o) => o.name);
			expect(names).toEqual([
				"getItemMetadata",
				"getItemField",
				"getItemFilesSlice",
				"searchItems",
			]);
		}),
	);

	itWhen(
		"getItemMetadata fetches the full item record",
		withTempDirs("archive.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getItemMetadata", {
				identifier: "nasa",
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
			expect(Array.isArray(result.data["files"])).toBe(true);
			expect(result.data["metadata"]).toBeTruthy();
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Metadata partial reads
// ═══════════════════════════════════════════════════════════════════

describe("Internet Archive Group A — metadata partial reads", () => {
	itWhen(
		"getItemField reads a single top-level metadata field",
		withTempDirs("archive.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getItemField", {
				identifier: "xfetch",
				field: "server",
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["result"]).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getItemFilesSlice returns a non-empty files array slice",
		withTempDirs("archive.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getItemFilesSlice", {
				identifier: "nasa",
				start: 0,
				count: 2,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data["result"])).toBe(true);
			const files = result.data["result"] as unknown[];
			expect(files.length).toBeGreaterThan(0);
			expect(files.length).toBeLessThanOrEqual(2);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Search API
// ═══════════════════════════════════════════════════════════════════

describe("Internet Archive Group B — Search API", () => {
	itWhen(
		"searchItems returns a non-empty docs array via the page paginator",
		withTempDirs("archive.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchItems", {
				q: "test",
				fl: "identifier",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"searchItems sort param works as a plain key=value (no helper needed)",
		withTempDirs("archive.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchItems", {
				q: "test",
				fl: "identifier,downloads",
				sort: "downloads desc",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});
