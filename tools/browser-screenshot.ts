/**
 * browser-screenshot tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId } from "./utils.js";

export const browserScreenshotTool = defineTool({
	name: "browser-screenshot",
	label: "Take Screenshot",
	description:
		"Take a screenshot of the current page for visual analysis. " +
		"Returns a JPEG data URI (80% quality, max 1024px wide) that vision-capable models can examine.",
	parameters: Type.Object({
		question: Type.Optional(
			Type.String({
				description:
					"Optional — if provided and the model has vision, it will answer questions about the screenshot",
			}),
		),
		fullPage: Type.Optional(
			Type.Boolean({
				description:
					"If true, capture full-page screenshot (default: viewport only)",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const p = params as {
			question?: string;
			fullPage?: boolean;
			taskId?: string;
		};
		const tid = p?.taskId ?? taskId(ctx);
		const fullPage = p?.fullPage ?? false;
		const result = await router.screenshot(tid, fullPage);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Screenshot failed: ${result.error ?? "unknown"}`,
					},
				],
				details: { error: true },
			};
		}

		const textContent = p?.question
			? `Screenshot captured. Question: ${p.question}`
			: "Screenshot captured:";

		const mediaType = result.dataUri.startsWith("data:image/jpeg")
			? "image/jpeg"
			: "image/png";
		const base64Data = result.dataUri.replace(/^data:image\/\w+;base64,/, "");

		return {
			content: [
				{ type: "text", text: textContent },
				{ type: "image", data: base64Data, mimeType: mediaType },
			],
			details: { screenshot: true, question: p?.question },
		};
	},

	renderCall(args, theme, _context) {
		if (args.question) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("browser-screenshot"))} ${theme.fg("dim", `"${args.question.slice(0, 60)}"`)}`,
				0,
				0,
			);
		}
		return new Text(
			theme.fg("toolTitle", theme.bold("browser-screenshot")),
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.question) {
			return new Text(
				`${theme.fg("accent", "📸 Screenshot")} ${theme.fg("dim", `"${(d.question as string).slice(0, 60)}"`)}`,
				0,
				0,
			);
		}
		return new Text(theme.fg("accent", "📸 Screenshot captured"), 0, 0);
	},
});
