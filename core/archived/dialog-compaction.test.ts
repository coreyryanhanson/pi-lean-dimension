/**
 * Archived tests for dialog-aware truncation utilities.
 *
 * These tests previously lived in __tests__/router-dispatch.test.ts and
 * exercised extractDialogBlocks indirectly through compactSnapshot().
 * They now test the extracted pure functions directly in their archived
 * location, serving as reference documentation for the dialog detection
 * and re-attachment logic.
 */

import { describe, it, expect } from "vitest";
import {
	extractDialogBlocks,
	truncateDialogBlock,
} from "./dialog-compaction.js";

// ─── Shared test fixtures ──────────────────────────────────────

const DIALOG_LINES = [
	'💬 dialog "Let us know your cookie preferences"',
	'  @e742 🔘 button "Accept all cookies"',
	'  @e743 🔘 button "Reject all"',
	'  @e744 🔘 button "Customize settings"',
];
const DIALOG_BLOCK = DIALOG_LINES.join("\n");

describe("extractDialogBlocks (archived)", () => {
	it("finds a dialog block entirely beyond the cut point", () => {
		const content = "line content here padding\n".repeat(60); // ~2100 chars before
		const snap = content + "\n" + DIALOG_BLOCK;
		const blocks = extractDialogBlocks(snap, content.length);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("Let us know your cookie preferences");
		expect(blocks[0]).toContain("Accept all cookies");
		expect(blocks[0]).toContain("Reject all");
		expect(blocks[0]).toContain("Customize settings");
	});

	it("does NOT extract a dialog block that is entirely before the cut point", () => {
		// Dialog is before the cut point — should not appear in extracted blocks
		const footer = "footer\n".repeat(100); // ~600 chars
		const snap = DIALOG_BLOCK + "\n" + footer;
		const blocks = extractDialogBlocks(snap, snap.length - footer.length);
		expect(blocks).toHaveLength(0);
	});

	it("handles multiple dialog blocks", () => {
		const dialog2 = ['💬 dialog "Second dialog"', '  @e800 🔘 button "OK"'];
		const content = "line content\n".repeat(150); // ~2250 chars
		const snap = content + "\n" + DIALOG_BLOCK + "\n" + dialog2.join("\n");
		const blocks = extractDialogBlocks(snap, content.length);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("Let us know your cookie preferences");
		expect(blocks[1]).toContain("Second dialog");
		expect(blocks[1]).toContain("OK");
	});

	it("handles alertdialog headers", () => {
		const alertDialog = [
			'⚠ alertdialog "Important alert"',
			'  @e50 🔘 button "Acknowledge"',
		];
		const content = "line content\n".repeat(150); // ~2250 chars
		const snap = content + "\n" + alertDialog.join("\n");
		const blocks = extractDialogBlocks(snap, content.length);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("Important alert");
		expect(blocks[0]).toContain("Acknowledge");
	});

	it("caps very large dialog blocks via truncateDialogBlock", () => {
		const largeDialogHeader = '💬 dialog "Large dialog"';
		const largeDialogLines = [largeDialogHeader];
		for (let i = 0; i < 100; i++) {
			largeDialogLines.push(`  @e${i + 100} 🔘 button "Option ${i}"`);
		}
		const largeDialogBlock = largeDialogLines.join("\n");

		const content = "line content\n".repeat(150); // ~2250 chars
		const snap = content + "\n" + largeDialogBlock;
		const blocks = extractDialogBlocks(snap, content.length);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("Large dialog");
		expect(blocks[0]).toContain("Option 0");
		expect(blocks[0]).toMatch(/more dialog elements/);
	});

	it("returns empty array when no dialogs in snapshot", () => {
		const content = "line content with longer text here\n".repeat(200);
		const blocks = extractDialogBlocks(content, content.length / 2);
		expect(blocks).toHaveLength(0);
	});

	it("detects nested (indented) dialog headers", () => {
		const nestedDialogLines = [
			"  " + DIALOG_LINES[0]!,
			"    " + DIALOG_LINES[1]!.trim(),
			"    " + DIALOG_LINES[2]!.trim(),
		];
		const nestedBlock = nestedDialogLines.join("\n");
		const content = "line content\n".repeat(150); // ~2250 chars
		const snap = content + "\n" + nestedBlock;
		const blocks = extractDialogBlocks(snap, content.length);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("Let us know your cookie preferences");
		expect(blocks[0]).toContain("Accept all cookies");
		expect(blocks[0]).toContain("Reject all");
	});

	it("handles empty snapshot gracefully", () => {
		const blocks = extractDialogBlocks("", 0);
		expect(blocks).toHaveLength(0);
	});

	it("handles snapshots with only dialog content", () => {
		const blocks = extractDialogBlocks(DIALOG_BLOCK, 0);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("Accept all cookies");
	});
});

describe("truncateDialogBlock (archived)", () => {
	it("returns short blocks unchanged", () => {
		const result = truncateDialogBlock(DIALOG_BLOCK, 500);
		expect(result).toBe(DIALOG_BLOCK);
	});

	it("truncates long blocks but keeps header", () => {
		const lines = ['💬 dialog "Big"'];
		for (let i = 0; i < 50; i++) {
			lines.push(`  @e${i} 🔘 button "Option ${i}"`);
		}
		const block = lines.join("\n");
		const result = truncateDialogBlock(block, 200);
		expect(result).toContain('💬 dialog "Big"');
		expect(result).toContain("Option 0");
		expect(result).toMatch(/more dialog elements/);
		expect(result.length).toBeLessThan(block.length);
	});

	it("shows singular 'element' for exactly one remaining item", () => {
		const block = [
			'💬 dialog "Tiny"',
			'  @e1 🔘 button "OK"',
			'  @e2 🔘 button "More"',
		].join("\n");
		// With maxChars very small, only the header fits
		const result = truncateDialogBlock(block, 50);
		expect(result).toContain('💬 dialog "Tiny"');
		expect(result).toMatch(/more dialog element/);
	});
});
