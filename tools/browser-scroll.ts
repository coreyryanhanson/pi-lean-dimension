/**
 * browser-scroll tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId, updateFooterStatus } from "./utils.js";

export const browserScrollTool = defineTool({
	name: "browser-scroll",
	label: "Scroll Page",
	description:
		"Scroll the page up or down by approximately one viewport height.",
	parameters: Type.Object({
		direction: StringEnum(["up", "down"] as const, {
			description: "Scroll direction",
		}),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { direction, taskId: tid } = params as {
			direction: "up" | "down";
			taskId?: string;
		};
		const result = await router.scroll(tid ?? taskId(ctx), direction);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{ type: "text", text: `Scroll failed: ${result.error ?? "unknown"}` },
				],
				details: { error: true },
			};
		}

		let content = `Scrolled ${direction}`;
		if (result.snapshot) {
			content += `\n\n${result.snapshot}`;
		}
		if (result.elementCount !== undefined) {
			content += `\n\nInteractive elements: ${result.elementCount}`;
		}

		return {
			content: [{ type: "text", text: content }],
			details: { direction, elementCount: result.elementCount },
		};
	},

	renderCall(args, theme, _context) {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-scroll"))} ${theme.fg("dim", args.direction)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) return new Text(theme.fg("error", "Scroll failed"), 0, 0);
		const ec = d?.elementCount as number | undefined;
		return new Text(
			theme.fg(
				"dim",
				`↕ ${d?.direction || "?"}${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
	},
});
