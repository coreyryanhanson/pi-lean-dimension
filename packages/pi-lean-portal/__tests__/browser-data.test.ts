/**
 * Shared browser-data validation tests.
 *
 * Verifies that ``browser-data.json`` is well-formed and contains all
 * expected keys with the correct types.  Both the TypeScript loader
 * (browser-data.ts) and the Python bridge's JSON loader depend on this
 * file, so a break here means both sides are broken in the same way.
 *
 * These tests are browser-free — no Chromium/Firefox needed.
 */

import { describe, it, expect } from "vitest";
import {
	BOT_SIGNALS,
	ACCESSIBILITY,
	NAV_SETTLE,
} from "../core/shared/browser-data.js";

// ─── Bot signals ─────────────────────────────────────────────────────

describe("shared browser-data.json — bot signals", () => {
	it("has all four signal categories as arrays of strings", () => {
		expect(Array.isArray(BOT_SIGNALS.blockSignals)).toBe(true);
		expect(BOT_SIGNALS.blockSignals.length).toBeGreaterThanOrEqual(10);
		for (const s of BOT_SIGNALS.blockSignals) {
			expect(typeof s).toBe("string");
		}

		expect(Array.isArray(BOT_SIGNALS.bodyOnlySignals)).toBe(true);
		expect(BOT_SIGNALS.bodyOnlySignals.length).toBeGreaterThanOrEqual(1);
		for (const s of BOT_SIGNALS.bodyOnlySignals) {
			expect(typeof s).toBe("string");
		}

		expect(Array.isArray(BOT_SIGNALS.bodyOnlyPatterns)).toBe(true);
		expect(BOT_SIGNALS.bodyOnlyPatterns.length).toBeGreaterThanOrEqual(1);
		for (const s of BOT_SIGNALS.bodyOnlyPatterns) {
			expect(typeof s).toBe("string");
		}

		expect(Array.isArray(BOT_SIGNALS.htmlSignals)).toBe(true);
		expect(BOT_SIGNALS.htmlSignals.length).toBeGreaterThanOrEqual(4);
		for (const s of BOT_SIGNALS.htmlSignals) {
			expect(typeof s).toBe("string");
		}
	});

	it("includes known block signals", () => {
		expect(BOT_SIGNALS.blockSignals).toContain("please verify you are human");
		expect(BOT_SIGNALS.blockSignals).toContain("cf-challenge");
		expect(BOT_SIGNALS.blockSignals).toContain("cdn-cgi/challenge");
	});

	it("includes known body-only signals", () => {
		expect(BOT_SIGNALS.bodyOnlySignals).toContain("errors.edgesuite.net");
	});

	it("includes known html signals", () => {
		expect(BOT_SIGNALS.htmlSignals).toContain("recaptcha");
		expect(BOT_SIGNALS.htmlSignals).toContain("hcaptcha");
		expect(BOT_SIGNALS.htmlSignals).toContain("data-sitekey");
	});
});

// ─── Accessibility ───────────────────────────────────────────────────

describe("shared browser-data.json — accessibility", () => {
	it("has interactiveRoles as a non-empty array of strings", () => {
		expect(Array.isArray(ACCESSIBILITY.interactiveRoles)).toBe(true);
		expect(ACCESSIBILITY.interactiveRoles.length).toBeGreaterThanOrEqual(40);
		for (const r of ACCESSIBILITY.interactiveRoles) {
			expect(typeof r).toBe("string");
		}
	});

	it("has informationalRoles as a non-empty array of strings", () => {
		expect(Array.isArray(ACCESSIBILITY.informationalRoles)).toBe(true);
		expect(ACCESSIBILITY.informationalRoles.length).toBeGreaterThanOrEqual(15);
		for (const r of ACCESSIBILITY.informationalRoles) {
			expect(typeof r).toBe("string");
		}
	});

	it("has roleIcons as a map with known entries", () => {
		expect(typeof ACCESSIBILITY.roleIcons).toBe("object");
		expect(ACCESSIBILITY.roleIcons).not.toBeNull();
		expect(Object.keys(ACCESSIBILITY.roleIcons).length).toBeGreaterThanOrEqual(
			60,
		);
		expect(ACCESSIBILITY.roleIcons["button"]).toBe("🔘 ");
		expect(ACCESSIBILITY.roleIcons["link"]).toBe("🔗 ");
	});

	it("includes common interactive roles like button and link", () => {
		expect(ACCESSIBILITY.interactiveRoles).toContain("button");
		expect(ACCESSIBILITY.interactiveRoles).toContain("link");
		expect(ACCESSIBILITY.interactiveRoles).toContain("textbox");
		expect(ACCESSIBILITY.interactiveRoles).toContain("checkbox");
	});

	it("includes informational roles like paragraph and text", () => {
		expect(ACCESSIBILITY.informationalRoles).toContain("paragraph");
		expect(ACCESSIBILITY.informationalRoles).toContain("text");
		expect(ACCESSIBILITY.informationalRoles).toContain("group");
	});
});

// ─── Nav-settle ────────────────────────────────────────────────────

describe("shared browser-data.json — nav-settle", () => {
	it("has expected numeric timeout values", () => {
		expect(NAV_SETTLE.navTimeoutMs).toBe(5000);
		expect(NAV_SETTLE.settleTimeoutMs).toBe(400);
		expect(NAV_SETTLE.settleRaceMs).toBe(150);
	});

	it("has a non-empty domStabilizationJs string", () => {
		expect(typeof NAV_SETTLE.domStabilizationJs).toBe("string");
		expect(NAV_SETTLE.domStabilizationJs.length).toBeGreaterThan(50);
		expect(NAV_SETTLE.domStabilizationJs).toContain(
			"document.querySelectorAll",
		);
	});
});
