/**
 * browser-snapshot tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId } from "../core/shared/task-id.js";
import { updateFooterStatus, renderExpandedText } from "./utils.js";

export const browserSnapshotTool = defineTool({
	name: "browser-snapshot",
	label: "Page Snapshot",
	description:
		"Get the current page's accessibility tree with @e1, @e2 element references. " +
		"Also captures a screenshot to a temp file (see output for path). " +
		"Use after browser-navigate to refresh the element list, or after page changes (click, scroll) to see the updated state.",
	parameters: Type.Object({
		full: Type.Optional(
			Type.Boolean({
				description:
					"If true, return complete tree instead of compact view (default: false)",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const p = params as { full?: boolean; taskId?: string };
		const tid = p?.taskId ?? taskId(ctx);
		const full = p?.full ?? false;
		const result = await router.snapshot(tid, full);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Snapshot failed: ${result.error ?? "unknown"}`,
					},
				],
				details: { error: true },
			};
		}

		const screenshotLine = await router.captureScreenshotLine(tid);

		const parts = [screenshotLine, result.snapshot || "(empty page)"];

		return {
			content: [{ type: "text", text: parts.filter(Boolean).join("\n\n") }],
			details: { elementCount: result.elementCount, full },
		};
	},

	renderCall(args, theme, _context) {
		const label = args.full ? "full" : "compact";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-snapshot"))} ${theme.fg("dim", label)}`,
			0,
			0,
		);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial)
			return new Text(theme.fg("warning", "Taking snapshot…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) return new Text(theme.fg("error", "Snapshot failed"), 0, 0);
		const ec = (d?.elementCount as number) ?? 0;
		const content = (result.content?.[0] as any)?.text ?? "";
		const isFull = !!(d?.full as boolean);
		if (expanded) {
			let text = theme.fg("accent", `📋 ${ec} elements`);
			text += isFull ? "" : theme.fg("dim", " (compact)");
			text = renderExpandedText(text, theme, content, 400);
			return new Text(text, 0, 0);
		}
		const label = isFull ? " (full)" : " (compact)";
		return new Text(
			theme.fg("accent", `📋 ${ec} elements${label} (expand)`),
			0,
			0,
		);
	},
});
