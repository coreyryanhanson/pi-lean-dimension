/**
 * Pure unit tests for formatProfileRefusal — cap, ordering, remedy, and
 * fallback-line placement. The router-level contract (refused navigate,
 * errorKind, no lazy-create) is covered in router-session.test.ts.
 */

import { describe, expect, it } from "vitest";
import { formatProfileRefusal } from "../core/profile-resolution.js";

describe("formatProfileRefusal", () => {
	it("lists existing profiles for near-miss self-correction, in the given order", () => {
		const msg = formatProfileRefusal("shoppng", ["work", "shopping"]);
		expect(msg).toContain("Existing profiles: work, shopping");
		expect(msg).not.toContain("No named profiles");
	});

	it("caps the list at 10 with an and-N-more suffix", () => {
		const names = Array.from(
			{ length: 13 },
			(_, i) => `prof-${String(i).padStart(2, "0")}`,
		);
		const msg = formatProfileRefusal("typo", names);
		expect(msg).toContain(names.slice(0, 10).join(", "));
		expect(msg).toMatch(/…and 3 more/);
	});

	it("handles the no-profiles case", () => {
		const msg = formatProfileRefusal("typo", []);
		expect(msg).toContain("No named profiles exist yet.");
	});

	it("names the user remedy, then the labelled fallback last", () => {
		const msg = formatProfileRefusal("typo", ["work"]);
		expect(msg.indexOf("/web profile create typo")).toBeLessThan(
			msg.indexOf('profile="session"'),
		);
		expect(msg).toContain("cookies will NOT be saved to 'typo'");
	});
});
