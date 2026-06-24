/**
 * web-guide tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Guide } from "../core/guides.js";
import { formatGuideList, getGuideContent } from "../core/guides.js";

export const webGuideTool = defineTool({
	name: "web-guide",
	label: "Web Navigation Guide",
	description:
		"Get navigation guidance for a site or pattern. " +
		"Call with a guide name (e.g. 'reddit', 'cookie-consent', 'bot-detection') " +
		"for guidance, or with no parameter to list all available guides.",
	parameters: Type.Object({
		guide: Type.Optional(
			Type.String({
				description:
					"Guide name (e.g. 'reddit', 'cookie-consent', 'bot-detection'). Omit to list all guides.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { guide } = params as { guide?: string };
		if (!guide) {
			return {
				content: [{ type: "text", text: formatGuideList() }],
				details: {},
			};
		}
		const entry: Guide | undefined = getGuideContent()[guide];
		if (!entry) {
			return {
				content: [
					{
						type: "text",
						text: `No guide for '${guide}'. Available: ${Object.keys(getGuideContent()).join(", ")}`,
					},
				],
				details: {},
			};
		}
		const currentDate = new Date().toISOString().slice(0, 10);
		const text =
			entry.content +
			`\n\n_Guide updated: ${entry.updated} · Current date: ${currentDate} · Source: ${entry.source}_`;
		return {
			content: [{ type: "text", text }],
			details: {},
		};
	},
});
