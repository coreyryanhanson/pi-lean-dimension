/**
 * browser-press tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId, updateFooterStatus } from "./utils.js";

export const browserPressTool = defineTool({
	name: "browser-press",
	label: "Press Key",
	description:
		'Press a keyboard key (e.g., "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"). ' +
		"Useful for submitting forms, dismissing dialogs, or navigating dropdowns.",
	parameters: Type.Object({
		key: Type.String({
			description:
				"Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp')",
		}),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { key, taskId: tid } = params as { key: string; taskId?: string };
		const result = await router.press(tid ?? taskId(ctx), key);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{ type: "text", text: `Press failed: ${result.error ?? "unknown"}` },
				],
				details: { error: true },
			};
		}

		let content = `Pressed "${key}"`;
		if (result.snapshot) {
			content += `\n\n${result.snapshot}`;
		}
		if (result.elementCount !== undefined) {
			content += `\n\nInteractive elements: ${result.elementCount}`;
		}

		return {
			content: [{ type: "text", text: content }],
			details: { key, elementCount: result.elementCount },
		};
	},

	renderCall(args, theme, _context) {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-press"))} ${theme.fg("accent", args.key)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) return new Text(theme.fg("error", "Press failed"), 0, 0);
		const ec = d?.elementCount as number | undefined;
		return new Text(
			theme.fg(
				"dim",
				`⌨ ${d?.key || ""}${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
	},
});
