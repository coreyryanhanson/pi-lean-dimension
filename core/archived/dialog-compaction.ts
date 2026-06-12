/**
 * Dialog-aware truncation — archived utility.
 *
 * Previously part of `core/router.ts`, this module provides functions to
 * detect and re-attach `dialog`/`alertdialog` blocks that fall beyond the
 * truncation cut point in compacted snapshots.
 *
 * Archived because the same effect is achieved via skills (e.g. "use
 * full=true on sites with consent dialogs"). Kept for reference and
 * potential re-integration if a skill/plugin hook for custom compaction
 * is developed.
 *
 * External callers that previously relied on these functions via
 * compactSnapshot should now either be satisfied with plain truncation
 * or use skills to guide the agent toward full snapshots.
 */

// ─── Types ──────────────────────────────────────────────────────────

interface DialogBlock {
	/** Full block text (header + children). */
	text: string;
	/** Character position where this block starts in the full snapshot. */
	startChar: number;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Max chars for a dialog block appended after truncation. */
const DIALOG_BLOCK_MAX = 500;

// ─── Functions ──────────────────────────────────────────────────────

/**
 * Extract dialog/alertdialog blocks from a snapshot text.
 *
 * Walks the lines and collects each dialog header followed by its
 * indented children (elements at greater indent than the header).
 * Returns blocks that were *entirely* beyond the character `cutPoint`
 * and thus hidden from the top portion of a compacted snapshot.
 */
export function extractDialogBlocks(
	snapshot: string,
	cutPoint: number,
): string[] {
	const lines = snapshot.split("\n");
	const blocks: DialogBlock[] = [];
	let currentLines: string[] | null = null;
	let headerIndent = -1;
	let charPos = 0;
	let startChar = 0;

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		const lineLen = rawLine.length + 1; // +1 for the newline
		const isDialogHeader =
			trimmed.includes("💬 dialog") ||
			trimmed.includes("⚠ alertdialog") ||
			// Also detect raw YAML format (beyond maxElements cap)
			/^-\s+(alert)?dialog\b/.test(trimmed);

		if (isDialogHeader) {
			// Close any previous dialog
			if (currentLines) {
				const blockText = currentLines.join("\n");
				if (startChar + blockText.length > cutPoint)
					blocks.push({ text: blockText, startChar });
			}
			currentLines = [rawLine];
			startChar = charPos;
			headerIndent = rawLine.search(/\S/);
			if (headerIndent === -1) headerIndent = 0;
		} else if (currentLines) {
			// Check if this line is at the same or lower indent than the header
			const lineIndent = rawLine.search(/\S/);
			const effectiveIndent = lineIndent === -1 ? 0 : lineIndent;

			if (effectiveIndent > headerIndent || trimmed === "") {
				// Child of the dialog or blank line within
				currentLines.push(rawLine);
			} else {
				// Dialog ended — close and finalise
				const blockText = currentLines.join("\n");
				if (startChar + blockText.length > cutPoint)
					blocks.push({ text: blockText, startChar });
				currentLines = null;
			}
		}

		charPos += lineLen;
	}

	// Close any dangling dialog at end of file
	if (currentLines) {
		const blockText = currentLines.join("\n");
		if (startChar + blockText.length > cutPoint)
			blocks.push({ text: blockText, startChar });
	}

	// Cap each block
	return blocks.map((b) =>
		b.text.length > DIALOG_BLOCK_MAX
			? truncateDialogBlock(b.text, DIALOG_BLOCK_MAX)
			: b.text,
	);
}

/**
 * Truncate a dialog block to at most `maxChars` while keeping the
 * header line visible.
 */
export function truncateDialogBlock(block: string, maxChars: number): string {
	if (block.length <= maxChars) return block;
	const lines = block.split("\n");
	const header = lines[0]!;
	let result = header;
	for (let i = 1; i < lines.length; i++) {
		if (result.length + lines[i]!.length + 1 > maxChars - 60) {
			const remainingCount = lines.length - i;
			result += `\n… ${remainingCount} more dialog element${remainingCount === 1 ? "" : "s"} (use full=true for complete tree)`;
			break;
		}
		result += "\n" + lines[i]!;
	}
	return result;
}
