/**
 * browser-back tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId } from "../core/shared/task-id.js";
import { updateFooterStatus } from "./utils.js";

export const browserBackTool = defineTool({
	name: "browser-back",
	label: "Go Back",
	description: "Navigate back in browser history.",
	parameters: Type.Object({}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { taskId: tid } = params as { taskId?: string };
		const result = await router.goBack(tid ?? taskId(ctx));
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Go back failed: ${result.error ?? "unknown"}`,
					},
				],
				details: { error: true },
			};
		}

		let content = `Went back to: ${result.newUrl || "?"}`;
		if (result.snapshot) {
			content += `\n\n${result.snapshot}`;
		}
		if (result.elementCount !== undefined) {
			content += `\n\nInteractive elements: ${result.elementCount}`;
		}

		return {
			content: [{ type: "text", text: content }],
			details: {
				newUrl: result.newUrl,
				newTitle: result.newTitle,
				elementCount: result.elementCount,
			},
		};
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
