/**
 * browser-get-images tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId } from "./utils.js";

export const browserGetImagesTool = defineTool({
	name: "browser-get-images",
	label: "Get Page Images",
	description:
		"Extract all <img> tags from the current page with src, alt, dimensions. " +
		"Useful for understanding visual content structure without taking a full screenshot. " +
		"Excludes data URIs.",
	parameters: Type.Object({}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { taskId: tid } = params as { taskId?: string };
		const result = await router.getImages(tid ?? taskId(ctx));

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to get images: ${result.error ?? "unknown"}`,
					},
				],
				details: { error: true },
			};
		}

		if (result.images.length === 0) {
			return {
				content: [{ type: "text", text: "No images found on this page." }],
				details: { count: 0 },
			};
		}

		const lines = [`Found ${result.images.length} image(s):`, ""];
		for (const img of result.images) {
			lines.push(
				`- ${img.alt ? `"${img.alt}" ` : ""}${img.src} (${img.width}x${img.height})`,
			);
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { count: result.images.length, images: result.images },
		};
	},

	renderCall(_args, theme, _context) {
		return new Text(
			theme.fg("toolTitle", theme.bold("browser-get-images")),
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(theme.fg("error", "Failed to get images"), 0, 0);
		const count = (d?.count as number) ?? 0;
		if (count === 0) return new Text(theme.fg("dim", "No images"), 0, 0);
		return new Text(theme.fg("accent", `🖼 ${count} image(s)`), 0, 0);
	},
});
