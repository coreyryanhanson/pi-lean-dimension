/**
 * browser-click tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId } from "../core/shared/task-id.js";
import { updateFooterStatus } from "./utils.js";

export const browserClickTool = defineTool({
	name: "browser-click",
	label: "Click Element",
	description:
		"Click an element on the page by its @e reference ID (e.g., @e5). " +
		"Use element references from browser-navigate or browser-snapshot output.",
	parameters: Type.Object({
		ref: Type.String({
			description: "Element reference like @e5 (from the accessibility tree)",
		}),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { ref, taskId: tid } = params as { ref: string; taskId?: string };
		const result = await router.click(tid ?? taskId(ctx), ref);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{ type: "text", text: `Click failed: ${result.error ?? "unknown"}` },
				],
				details: { error: true },
			};
		}

		const lines = [
			`Clicked ${ref}`,
			result.newUrl ? `URL: ${result.newUrl}` : "",
			result.newTitle ? `Title: ${result.newTitle}` : "",
		].filter(Boolean);

		let content = lines.join("\n");
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

	renderCall(args, theme, _context) {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-click"))} ${theme.fg("accent", args.ref)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(theme.fg("error", `Click failed: ${d.error}`), 0, 0);
		const newUrl = d?.newUrl as string | undefined;
		const ec = d?.elementCount as number | undefined;
		if (newUrl) {
			let text = theme.fg("success", `✅ → ${newUrl}`);
			if (ec !== undefined) text += ` · ${ec} elements`;
			return new Text(text, 0, 0);
		}
		return new Text(
			theme.fg(
				"success",
				`✅ clicked${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
	},
});
