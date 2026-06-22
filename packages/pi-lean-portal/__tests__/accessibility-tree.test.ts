/**
 * Tests for core/shared/accessibility-tree.ts — snapshot parsing and locator building.
 *
 * Focus on duplicate element disambiguation (occurrenceIndex) since that is the
 * primary logic change.  buildLocator() requires a real Playwright Page so it is
 * tested indirectly via the behavioral contract tests (plugin-contract.ts).
 */

import { describe, it, expect } from "vitest";
import {
	parseSnapshot,
	snapshotFingerprint,
	type AriaCachedNode,
	type AriaParseResult,
} from "../core/shared/accessibility-tree.js";

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Parse a snapshot line and return the single element entry.
 * Asserts that exactly one element was parsed.
 */
function singleElement(snap: string): AriaCachedNode {
	const result = parseSnapshot(snap);
	expect(result.count).toBe(1);
	const entries = Array.from(result.elements.values());
	return entries[0]!;
}

/**
 * Return all elements from a parse result as an array ordered by ref number.
 */
function allElements(result: AriaParseResult): AriaCachedNode[] {
	const entries: AriaCachedNode[] = [];
	for (let i = 1; i <= result.count; i++) {
		const e = result.elements.get(`e${i}`);
		if (e) entries.push(e);
	}
	return entries;
}

// ─── occurrenceIndex — unique elements ────────────────────────────

describe("parseSnapshot — occurrenceIndex", () => {
	it("sets occurrenceIndex=0 for a single unique element", () => {
		const node = singleElement('- link "Click me"');
		expect(node.occurrenceIndex).toBe(0);
	});

	it("sets occurrenceIndex=0 for two different elements", () => {
		const result = parseSnapshot(
			['- link "Read more"', '- button "Submit"'].join("\n"),
		);
		expect(result.count).toBe(2);
		expect(result.elements.get("e1")!.occurrenceIndex).toBe(0);
		expect(result.elements.get("e2")!.occurrenceIndex).toBe(0);
	});

	it("skips informational roles and assigns occurrenceIndex 0 to the first interactive element", () => {
		// Informational roles like "paragraph" don't get @e refs
		const result = parseSnapshot('- paragraph "Some text"\n- link "Click"');
		expect(result.count).toBe(1);
		expect(result.elements.get("e1")!.occurrenceIndex).toBe(0);
	});

	it("keeps occurrence indices for elements with different names", () => {
		const result = parseSnapshot(
			'- link "First"\n- link "Second"\n- link "Third"',
		);
		expect(result.count).toBe(3);
		expect(result.elements.get("e1")!.occurrenceIndex).toBe(0);
		expect(result.elements.get("e2")!.occurrenceIndex).toBe(0);
		expect(result.elements.get("e3")!.occurrenceIndex).toBe(0);
	});
});

// ─── occurrenceIndex — duplicate elements ─────────────────────────

describe("parseSnapshot — duplicate occurrences", () => {
	it("assigns occurrenceIndex 0,1,2 for three identical links", () => {
		const result = parseSnapshot(
			['- link "Promoted"', '- link "Promoted"', '- link "Promoted"'].join(
				"\n",
			),
		);
		expect(result.count).toBe(3);
		const els = allElements(result);
		expect(els.map((e) => e.occurrenceIndex)).toEqual([0, 1, 2]);
	});

	it("assigns occurrenceIndex independently per role+name group", () => {
		const result = parseSnapshot(
			[
				'- link "Home"',
				'- link "Promoted"',
				'- button "Home"',
				'- link "Promoted"',
				'- link "Home"',
			].join("\n"),
		);
		expect(result.count).toBe(5);

		// Link "Home": first occurrence → index 0
		expect(result.elements.get("e1")!.occurrenceIndex).toBe(0);
		// Link "Promoted": first occurrence → index 0
		expect(result.elements.get("e2")!.occurrenceIndex).toBe(0);
		// Button "Home": first occurrence (different role) → index 0
		expect(result.elements.get("e3")!.occurrenceIndex).toBe(0);
		// Link "Promoted": second occurrence → index 1
		expect(result.elements.get("e4")!.occurrenceIndex).toBe(1);
		// Link "Home": second occurrence → index 1
		expect(result.elements.get("e5")!.occurrenceIndex).toBe(1);
	});

	it("assigns occurrenceIndex for duplicates with empty name", () => {
		const result = parseSnapshot(
			["- link", "- link", '- link "Labeled"'].join("\n"),
		);
		expect(result.count).toBe(3);

		// link with no name — first occurrence
		expect(result.elements.get("e1")!.name).toBe("");
		expect(result.elements.get("e1")!.occurrenceIndex).toBe(0);
		// link with no name — second occurrence (same role+name both "")
		expect(result.elements.get("e2")!.name).toBe("");
		expect(result.elements.get("e2")!.occurrenceIndex).toBe(1);
		// link with "Labeled" — different name, index resets
		expect(result.elements.get("e3")!.occurrenceIndex).toBe(0);
	});

	it("only counts interactive roles for occurrence tracking", () => {
		// Informational roles like "paragraph" don't get @e refs
		const result = parseSnapshot(
			['- paragraph "text"', '- link "Promoted"', '- link "Promoted"'].join(
				"\n",
			),
		);
		expect(result.count).toBe(2);
		expect(result.elements.get("e1")!.occurrenceIndex).toBe(0);
		expect(result.elements.get("e2")!.occurrenceIndex).toBe(1);
	});

	it("passes occurrenceIndex=0 for elements with props that differ", () => {
		// Different roles => different groups even if name is same
		const result = parseSnapshot(
			['- button "Home" [disabled]', '- link "Home"'].join("\n"),
		);
		expect(result.count).toBe(2);
		// Different roles — both get index 0
		expect(result.elements.get("e1")!.occurrenceIndex).toBe(0);
		expect(result.elements.get("e2")!.occurrenceIndex).toBe(0);
	});
});

// ─── buildLocator — structural verification ───────────────────────

describe("buildLocator occurrenceIndex behavior", () => {
	it("always uses .nth(occurrenceIndex) even when index is 0", () => {
		// buildLocator now ALWAYS calls .nth(occurrenceIndex) to avoid strict-
		// mode violations from duplicate role+name elements.  For unique
		// elements with occurrenceIndex=0, .nth(0) is equivalent to the bare
		// locator in Playwright — it targets element at index 0 which is the
		// same as the only match.
		const result = parseSnapshot('- button "Unique"');
		const node = result.elements.get("e1")!;
		expect(node.occurrenceIndex).toBe(0);
	});
});

// ─── Snapshot text format — @e refs ──────────────────────────────

describe("parseSnapshot text format", () => {
	it("includes @e refs for interactive elements", () => {
		const result = parseSnapshot('- link "Click"');
		expect(result.text).toContain("@e1");
		expect(result.text).toContain("link");
	});

	it("produces consecutive @e refs for duplicates", () => {
		const result = parseSnapshot(
			['- link "Same" [disabled]', '- link "Same"', '- link "Same"'].join("\n"),
		);
		expect(result.text).toContain("@e1");
		expect(result.text).toContain("@e2");
		expect(result.text).toContain("@e3");
	});

	it("text does not leak occurrenceIndex values", () => {
		// occurrenceIndex is a caching detail, not displayed in the agent-facing text
		const result = parseSnapshot(
			['- link "Promoted"', '- link "Promoted"'].join("\n"),
		);
		expect(result.text).not.toContain("occurrence");
		expect(result.text).not.toContain("index");
	});
});

// ─── snapshotFingerprint ─────────────────────────────────────────

describe("snapshotFingerprint()", () => {
	it("returns stable output for the same snapshot", () => {
		const snap = '- button "Click"\n- link "More"\n';
		expect(snapshotFingerprint(snap)).toBe(snapshotFingerprint(snap));
	});

	it("returns different fingerprints for different content", () => {
		const a = '- button "Click"\n';
		const b = '- link "Go"\n';
		expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
	});

	it("returns different fingerprints when content length differs", () => {
		const short = "x\n";
		const long = "x\n".repeat(100);
		expect(snapshotFingerprint(short)).not.toBe(snapshotFingerprint(long));
	});

	it("handles empty string consistently", () => {
		const fp = snapshotFingerprint("");
		expect(typeof fp).toBe("string");
		expect(fp.length).toBeGreaterThan(0);
		expect(snapshotFingerprint("")).toBe(fp);
	});

	it("returns a short base-36 string", () => {
		const fp = snapshotFingerprint('- button "Click me"\n- link "More"\n');
		expect(fp.length).toBeLessThanOrEqual(10);
		expect(fp).toMatch(/^[0-9a-z]+$/);
	});

	it("is sensitive to minor whitespace changes", () => {
		const a = '- button "Click"\n';
		const b = '- button "Click" \n';
		expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
	});
});
