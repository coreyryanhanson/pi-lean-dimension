/**
 * browser-back tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { executeInteractionTool } from "./utils.js";

export const browserBackTool = defineTool({
	name: "browser-back",
	label: "Go Back",
	description: "Navigate back in browser history.",
	parameters: Type.Object({}),

	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		return executeInteractionTool(
			ctx,
			"Go back",
			(tid) => router.goBack(tid),
			(result) => ({
				message: `Went back to: ${result.newUrl || "?"}`,
				details: {
					newUrl: result.newUrl,
					newTitle: result.newTitle,
					elementCount: result.elementCount,
				},
			}),
		);
	},

	renderCall(_args, theme, _context) {
		return new Text(theme.fg("toolTitle", theme.bold("browser-back")), 0, 0);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) return new Text(theme.fg("error", "Go back failed"), 0, 0);
		const ec = d?.elementCount as number | undefined;
		return new Text(
			theme.fg(
				"dim",
				`← ${(d?.newUrl as string) || ""}${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
	},
});
