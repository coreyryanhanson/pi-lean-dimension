/**
 * web-fetch tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { webFetch } from "../core/fetch-backend.js";
import { taskId } from "../core/shared/task-id.js";

export const webFetchTool = defineTool({
	name: "web-fetch",
	label: "Web Fetch",
	description:
		"Perform a stateless HTTP fetch of a URL and return its content as Markdown. " +
		"Auto-detects JS-only shells and bot challenge pages. " +
		"For interactive browsing with @e1/@e2 element references, use browser-navigate instead.",
	promptSnippet: "Fetch a URL via stateless HTTP and get Markdown content",
	promptGuidelines: [
		"Use web-fetch for quick, stateless page retrieval when you don't need JavaScript or interactive elements.",
		"The tool returns page content as Markdown, truncated to ~4K chars inline.",
		"If the result mentions a temp file with full content, use the read tool with offset/limit to access specific sections.",
		"If the result indicates the page needs JavaScript, switch to browser-navigate with strategy='chromium'.",
		"If bot detection is triggered, the page may be blocked — try browser-navigate instead.",
		"This tool does NOT create a browser session — it's a simple HTTP fetch.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The URL to fetch" }),
		timeout: Type.Optional(
			Type.Number({
				description: "Timeout in seconds (default: 30, max: 120)",
				minimum: 1,
				maximum: 120,
			}),
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const { url, timeout = 30 } = params as {
			url: string;
			timeout?: number;
		};
		const tid = taskId(ctx);

		const fetchOptions: {
			url: string;
			timeout: number;
			signal?: AbortSignal;
			taskId?: string;
		} = {
			url,
			timeout,
			taskId: tid,
		};
		if (signal) fetchOptions.signal = signal;

		const result = await webFetch(fetchOptions);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Fetch failed: ${result.error ?? "unknown error"}`,
					},
				],
				details: {
					error: true,
					url: result.url,
					statusCode: result.statusCode,
				},
			};
		}

		const lines = [
			result.title ? `Title: ${result.title}` : "",
			`URL: ${result.url}`,
			`Backend: ${result.backendUsed}`,
			result.statusCode ? `HTTP ${result.statusCode}` : "",
			result.needsJavaScript
				? "⚠ This page appears to need JavaScript for full rendering."
				: "",
			result.botDetected
				? "⚠ Bot detection triggered — may need stealth backend."
				: "",
			"",
			result.content,
		];

		return {
			content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
			details: {
				title: result.title,
				url: result.url,
				backendUsed: result.backendUsed,
				statusCode: result.statusCode,
				needsJavaScript: result.needsJavaScript,
				botDetected: result.botDetected,
				...(result.filePath ? { filePath: result.filePath } : {}),
				...(result.totalChars ? { totalChars: result.totalChars } : {}),
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("web-fetch "))];
		parts.push(theme.fg("accent", `"${args.url}"`));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(
				theme.fg(
					"error",
					`Fetch failed: ${(result.content?.[0] as any)?.text ?? "?"}`,
				),
				0,
				0,
			);

		const title = (d?.title as string) || "(no title)";
		const url = (d?.url as string) || "";
		const statusCode = d?.statusCode as number | undefined;
		const needsJS = d?.needsJavaScript as boolean | undefined;
		const botDetected = d?.botDetected as boolean | undefined;

		let text = theme.fg("accent", theme.bold(`📡 ${title}`));
		text += `\n${theme.fg("dim", url)}`;
		if (statusCode) text += ` · HTTP ${statusCode}`;
		if (needsJS) text += ` ${theme.fg("warning", "⚠ needs JS")}`;
		if (botDetected) text += ` ${theme.fg("warning", "⚠ bot detected")}`;

		const content = (result.content?.[0] as any)?.text ?? "";
		if (expanded) {
			const preview = content.replace(/\n{3,}/g, "\n\n").slice(0, 500);
			text += `\n\n${theme.fg("dim", preview)}`;
			if (content.length > 500)
				text += `\n${theme.fg("muted", `… ${content.length - 500} more chars`)}`;
		} else {
			text += `\n${theme.fg("muted", `${content.length} chars (expand)`)}`;
		}
		return new Text(text, 0, 0);
	},
});
