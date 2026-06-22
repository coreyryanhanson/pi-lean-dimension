/**
 * browser-press tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { executeInteractionTool } from "./utils.js";

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
		const { key } = params as { key: string };
		return executeInteractionTool(
			ctx,
			"Press",
			(tid) => router.press(tid, key),
			(result) => ({
				message: [
					`Pressed "${key}"`,
					result.newUrl ? `URL: ${result.newUrl}` : "",
					result.newTitle ? `Title: ${result.newTitle}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				details: {
					key,
					newUrl: result.newUrl,
					newTitle: result.newTitle,
					elementCount: result.elementCount,
				},
			}),
		);
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
		const nu = d?.newUrl as string | undefined;
		if (nu) {
			return new Text(
				theme.fg(
					"success",
					`✅ → ${nu}${ec !== undefined ? ` · ${ec} elements` : ""}`,
				),
				0,
				0,
			);
		}
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
