/**
 * browser-type tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { executeInteractionTool } from "./utils.js";

export const browserTypeTool = defineTool({
	name: "browser-type",
	label: "Type Text",
	description:
		"Type text into an input element identified by its @e reference ID. " +
		"Clears existing content before typing. Use after browser-navigate or browser-snapshot.",
	parameters: Type.Object({
		ref: Type.String({
			description:
				"Element reference like @e5 (must be a textbox, searchbox, or combobox)",
		}),
		text: Type.String({ description: "Text to type into the element" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { ref, text } = params as { ref: string; text: string };
		return executeInteractionTool(
			ctx,
			"Type",
			(tid) => router.type(tid, ref, text),
			(result) => ({
				message: `Typed "${text}" into ${ref}`,
				details: { typed: true, ref, text, elementCount: result.elementCount },
			}),
		);
	},

	renderCall(args, theme, _context) {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-type"))} ${theme.fg("accent", args.ref)} "${args.text}"`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(theme.fg("error", `Type failed: ${d.error}`), 0, 0);
		const ec = d?.elementCount as number | undefined;
		return new Text(
			theme.fg(
				"success",
				`📝 typed "${d?.text || "?"}"${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
	},
});
