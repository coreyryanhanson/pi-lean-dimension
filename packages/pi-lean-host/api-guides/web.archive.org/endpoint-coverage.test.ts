/**
 * web.archive.org (Wayback CDX Server + Memento TimeMap) recipe validity
 * tests — endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every operation against the live
 * `https://web.archive.org`, and asserts the response has the expected shape
 * (CDX `output=json` zipped row objects via the `transform: true` on
 * `queryCdx`; TimeMap link-format text).
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

const DOMAIN = "web.archive.org";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper) ──

const fetchOp = createFetchOp(DOMAIN);

const CDX_FIELDS = [
	"urlkey",
	"timestamp",
	"original",
	"mimetype",
	"statuscode",
	"digest",
	"length",
];

// ═══════════════════════════════════════════════════════════════════
// Parsing baseline
// ═══════════════════════════════════════════════════════════════════

describe("Wayback CDX live integration smoke", () => {
	itWhen(
		"parses and loads the web.archive.org recipe from a temp user dir",
		withTempDirs("web.archive.org")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("web.archive.org");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["web.archive.org"]!;
			expect(guide.apiHost).toBe("https://web.archive.org");
			expect(guide.auth.kind).toBe("none");
			expect(guide.organization).toBe("archive.org");
			expect(guide.operations.length).toBe(2);
			const names = guide.operations.map((o) => o.name);
			expect(names).toEqual(["queryCdx", "getTimemap"]);
		}),
	);
});

// ═══════════════════════════════════════════════════════════════════
// queryCdx — CDX index queries
// ═══════════════════════════════════════════════════════════════════

describe("Wayback CDX Server Group A — queryCdx (post-transform objects)", () => {
	itWhen(
		"queryCdx returns row objects zipped against the CDX field header",
		withTempDirs("web.archive.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "queryCdx", {
				url: "example.com",
				limit: 2,
			})) as { data: Record<string, unknown>[] };
			expect(Array.isArray(result.data)).toBe(true);
			const rows = result.data;
			expect(rows.length).toBeGreaterThanOrEqual(1);
			expect(Object.keys(rows[0]!)).toEqual(CDX_FIELDS);
		}),
		20_000,
	);

	itWhen(
		"queryCdx limit=-1 returns a single most-recent capture",
		withTempDirs("web.archive.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "queryCdx", {
				url: "example.com",
				limit: -1,
			})) as { data: Record<string, unknown>[] };
			const rows = result.data;
			// limit=-1 → exactly 1 capture object.
			expect(rows.length).toBe(1);
			expect(Object.keys(rows[0]!)).toEqual(CDX_FIELDS);
		}),
		20_000,
	);

	itWhen(
		"queryCdx filter and fl narrow the result set",
		withTempDirs("web.archive.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "queryCdx", {
				url: "example.com",
				limit: 5,
				filter: "!statuscode:200",
				fl: "timestamp,statuscode",
			})) as { data: Record<string, unknown>[] };
			const rows = result.data;
			expect(Object.keys(rows[0]!)).toEqual(["timestamp", "statuscode"]);
			const non200 = rows.filter((r) => r.statuscode === "200");
			expect(non200).toHaveLength(0); // filter excluded 200s
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// getTimemap — Memento TimeMap (link-format text)
// ═══════════════════════════════════════════════════════════════════

describe("Wayback Memento Group B — getTimemap", () => {
	itWhen(
		"getTimemap returns link-format text with memento rels",
		withTempDirs("web.archive.org")(async ({ guidesDir }) => {
			// archive.org/developers/metadata.html has a compact TimeMap
			// (19 mementos, ~3KB); example.com's is tens of MB and exceeds
			// the transport body cap.
			const result = (await fetchOp(guidesDir, "getTimemap", {
				url: "https://archive.org/developers/metadata.html",
			})) as { data: string };
			expect(typeof result.data).toBe("string");
			expect(result.data).toContain('rel="memento"');
			expect(result.data).toContain('rel="original"');
		}),
		20_000,
	);
});
