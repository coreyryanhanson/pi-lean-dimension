/**
 * archive.org-wayback (Wayback Availability) recipe validity tests —
 * endpoint coverage + live fetch sanity, exercising the multi-recipe path.
 *
 * The Availability guide shares `domains: [archive.org]` with the Item
 * Metadata guide in `archive.org/`, so fetchOp routes through
 * `DOMAIN = "archive.org"` and relies on op-name resolution across the two
 * matching guides — `getClosestSnapshot` must land in THIS guide, not the
 * metadata one. That is the multi-recipe acceptance path for a colliding
 * domain key.
 *
 * Both sibling dirs are copied into the temp user dir so the shared-domain
 * resolution is exercised for real.
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

const DOMAIN = "archive.org"; // shared with the Item Metadata guide!

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper) ──

const fetchOp = createFetchOp(DOMAIN);

// ═══════════════════════════════════════════════════════════════════
// Parsing baseline
// ═══════════════════════════════════════════════════════════════════

describe("Wayback Availability live integration smoke", () => {
	itWhen(
		"loads as a second guide for archive.org alongside Item Metadata",
		withTempDirs(
			"archive.org",
			"archive.org-wayback",
		)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(loaded.malformed).toHaveLength(0);

			// Both guides are present and claim the shared domain.
			const wayback = loaded.guides["archive.org-wayback"]!;
			expect(wayback.apiHost).toBe("https://archive.org");
			expect(wayback.organization).toBe("archive.org");
			expect(wayback.auth.kind).toBe("none");
			expect(wayback.operations.length).toBe(1);
			expect(wayback.operations[0]!.name).toBe("getClosestSnapshot");

			// findGuidesByDomain resolves both for the shared domain.
			// (fetchOp sets the user-guides dir itself; this direct lookup
			// needs it too, so set it once before the loader call.)
			const { findGuidesByDomain, setUserGuidesDir } = await import(
				"../../core/guide-store.js"
			);
			setUserGuidesDir(guidesDir);
			const matches = findGuidesByDomain("archive.org");
			expect(matches.length).toBe(2);
			const names = matches.map((m) => m.guide.shortName).sort();
			expect(names).toEqual(["Internet Archive", "Wayback Availability"]);
		}),
	);
});

// ═══════════════════════════════════════════════════════════════════
// getClosestSnapshot — op-name resolution across the shared domain
// ═══════════════════════════════════════════════════════════════════

describe("Wayback Availability Group A — getClosestSnapshot", () => {
	itWhen(
		"getClosestSnapshot resolves to the Availability guide over the shared domain",
		withTempDirs(
			"archive.org",
			"archive.org-wayback",
		)(async ({ guidesDir }) => {
			// The op's name is unique to the wayback guide — resolution must
			// land here even though Item Metadata also claims archive.org.
			// (fetchOp sets the user-guides dir itself, so no manual setup.)
			const result = (await fetchOp(guidesDir, "getClosestSnapshot", {
				url: "example.com",
			})) as { data: Record<string, unknown> };
			const snapshots = result.data["archived_snapshots"] as
				| Record<string, unknown>
				| undefined;
			expect(snapshots).toBeTruthy();
			const closest = snapshots?.["closest"] as
				| Record<string, unknown>
				| undefined;
			expect(closest).toBeTruthy();
			expect(closest!["available"]).toBe(true);
			expect(typeof closest!["url"]).toBe("string");
			expect(typeof closest!["timestamp"]).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"getClosestSnapshot respects a timestamp via a plain key=value param",
		withTempDirs(
			"archive.org",
			"archive.org-wayback",
		)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getClosestSnapshot", {
				url: "example.com",
				timestamp: "2006",
			})) as { data: Record<string, unknown> };
			// The API echoes the requested timestamp at top level — proves the
			// param reached the wire. (The closest snapshot can fall before or
			// after the target; asserting on it would be flaky.)
			expect(result.data["timestamp"]).toBe("2006");
		}),
		20_000,
	);
});
