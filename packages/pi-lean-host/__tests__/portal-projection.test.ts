/**
 * Portal co-install integration tests.
 *
 * Covers runtime feature-detect, provider registration, self-gating on
 * toggle state, recipe-field stripping, and host-only install safety.
 * Uses a mock global to simulate portal presence — no static portal import.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	registerPortalProjection,
	_resetPortalProjectionForTest,
} from "../core/portal-projection.js";
import {
	_resetToggleStateForTest,
	_setToggleStateForTest,
} from "../core/api-toggle.js";
import {
	setUserGuidesDir,
	_resetLoadWarningsForTest,
} from "../core/guide-store.js";

// ═══════════════════════════════════════════════════════════════════
// Fixture helpers
// ═══════════════════════════════════════════════════════════════════

/** Create a temp dir with one valid API guide and point the guide store at it. */
function withFixtureGuide(fn: () => void): void {
	const tmpDir = mkdtempSync(join(tmpdir(), "host-projection-test-"));
	const guidesDir = join(tmpDir, "api-guides");
	mkdirSync(guidesDir, { recursive: true });
	mkdirSync(join(guidesDir, "boe-test"), { recursive: true });
	writeFileSync(
		join(guidesDir, "boe-test", "guide.md"),
		[
			"---",
			"shortName: BOE Test",
			"domains:",
			"  - boe.es",
			"icon: 📡",
			"apiHost: https://apidatos.boe.es/v1",
			"operations:",
			"  - name: searchDiary",
			"    via: restGet",
			"    path: /diario",
			"---",
			"## BOE Test guide",
			"",
			"Test guide for portal-projection tests.",
		].join("\n"),
	);
	setUserGuidesDir(guidesDir);
	try {
		fn();
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════

let capturedProvider: (() => Record<string, unknown>) | null = null;

beforeEach(() => {
	capturedProvider = null;
	_resetToggleStateForTest();
	_resetPortalProjectionForTest();
	_resetLoadWarningsForTest();

	// Simulate portal's global registry.
	(globalThis as Record<string, unknown>)[
		"__piLeanPortalRegisterGuideProvider"
	] = (fn: () => Record<string, unknown>) => {
		capturedProvider = fn;
	};
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>)[
		"__piLeanPortalRegisterGuideProvider"
	];
	_resetPortalProjectionForTest();
	_resetToggleStateForTest();
});

// ═══════════════════════════════════════════════════════════════════
// Runtime feature-detect
// ═══════════════════════════════════════════════════════════════════

describe("registerPortalProjection — global probe", () => {
	it("registers a provider when portal global is present", () => {
		registerPortalProjection();
		expect(capturedProvider).not.toBeNull();
		expect(typeof capturedProvider).toBe("function");
	});

	it("does NOT register when portal global is absent", () => {
		delete (globalThis as Record<string, unknown>)[
			"__piLeanPortalRegisterGuideProvider"
		];

		registerPortalProjection();
		expect(capturedProvider).toBeNull();
	});

	it("session_start retry registers when portal loads after host", () => {
		// Host loads first — portal global not set yet.
		delete (globalThis as Record<string, unknown>)[
			"__piLeanPortalRegisterGuideProvider"
		];
		registerPortalProjection();
		expect(capturedProvider).toBeNull();

		// Portal loads, sets its global; session_start retries.
		(globalThis as Record<string, unknown>)[
			"__piLeanPortalRegisterGuideProvider"
		] = (fn: () => Record<string, unknown>) => {
			capturedProvider = fn;
		};
		registerPortalProjection();
		expect(capturedProvider).not.toBeNull();
	});

	it("is idempotent — second call does not re-register", () => {
		registerPortalProjection();
		const first = capturedProvider;

		registerPortalProjection();
		expect(capturedProvider).toBe(first);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Self-gating on /api toggle
// ═══════════════════════════════════════════════════════════════════

describe("buildProjection — toggle self-gate", () => {
	it("returns {} when /api toggle is off (default)", () => {
		registerPortalProjection();
		const result = capturedProvider!();
		expect(result).toEqual({});
	});

	it("returns projections when /api toggle is on", () =>
		withFixtureGuide(() => {
			_setToggleStateForTest(true, false);

			registerPortalProjection();
			const result = capturedProvider!() as Record<
				string,
				Record<string, unknown>
			>;
			expect(Object.keys(result).length).toBeGreaterThan(0);
		}));
});

// ═══════════════════════════════════════════════════════════════════
// Projection shape — no recipe fields
// ═══════════════════════════════════════════════════════════════════

describe("projection shape", () => {
	it("projected guides omit recipe fields (apiHost, operations, auth, pagination, responseShape)", () =>
		withFixtureGuide(() => {
			_setToggleStateForTest(true, false);

			registerPortalProjection();
			const result = capturedProvider!() as Record<
				string,
				Record<string, unknown>
			>;

			expect(Object.keys(result).length).toBeGreaterThan(0);

			for (const [, guide] of Object.entries(result)) {
				// Presentation fields present
				expect(guide).toHaveProperty("content");
				expect(guide).toHaveProperty("updated");
				expect(guide).toHaveProperty("category");
				expect(guide).toHaveProperty("source");
				expect(guide).toHaveProperty("icon");
				expect(guide).toHaveProperty("shortName");

				// Recipe fields absent
				expect(guide).not.toHaveProperty("apiHost");
				expect(guide).not.toHaveProperty("operations");
				expect(guide).not.toHaveProperty("auth");
				expect(guide).not.toHaveProperty("pagination");
				expect(guide).not.toHaveProperty("responseShape");
				expect(guide).not.toHaveProperty("schemaVersion");
				expect(guide).not.toHaveProperty("verified");
				expect(guide).not.toHaveProperty("docs");
				expect(guide).not.toHaveProperty("organization");
				expect(guide).not.toHaveProperty("description");
				expect(guide).not.toHaveProperty("gatherAllMax");

				// kind set to "api"
				expect(guide.kind).toBe("api");
			}
		}));
});

// ═══════════════════════════════════════════════════════════════════
// Host-only install safety
// ═══════════════════════════════════════════════════════════════════

describe("host-only install (no portal)", () => {
	beforeEach(() => {
		delete (globalThis as Record<string, unknown>)[
			"__piLeanPortalRegisterGuideProvider"
		];
	});

	it("registerPortalProjection does not throw", () => {
		expect(() => registerPortalProjection()).not.toThrow();
	});

	it("registerPortalProjection on session_start does not throw", () => {
		// Simulate what index.ts does — call at entrypoint and on session_start
		registerPortalProjection();
		expect(() => registerPortalProjection()).not.toThrow();
	});
});
