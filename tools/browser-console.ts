/**
 * browser-console tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId } from "./utils.js";

export const browserConsoleTool = defineTool({
	name: "browser-console",
	label: "Browser Console",
	description:
		"Execute JavaScript in the current page context and see the result, " +
		"or read captured console output (log, warn, error, info). " +
		"Useful for inspecting page state, reading hidden content, or debugging.",
	parameters: Type.Object({
		expression: Type.Optional(
			Type.String({
				description:
					"JavaScript expression to evaluate in the page context. If omitted, returns captured console messages.",
			}),
		),
		clear: Type.Optional(
			Type.Boolean({
				description:
					"If true, clear the captured console log (no other action)",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const p = params as {
			expression?: string;
			clear?: boolean;
			taskId?: string;
		};
		const tid = p?.taskId ?? taskId(ctx);

		if (p?.clear) {
			await router.clearConsole(tid);
			return {
				content: [{ type: "text", text: "Console log cleared." }],
				details: { cleared: true },
			};
		}

		if (p?.expression) {
			const result = await router.evaluate(tid, p.expression);

			if (!result.success) {
				return {
					content: [
						{
							type: "text",
							text: `Evaluation failed: ${result.error ?? "unknown"}`,
						},
					],
					details: { error: true },
				};
			}

			let formatted: string;
			if (typeof result.result === "string") {
				formatted = result.result;
			} else if (result.result === undefined || result.result === null) {
				formatted = String(result.result);
			} else {
				try {
					formatted = JSON.stringify(result.result, null, 2);
				} catch {
					formatted = String(result.result);
				}
			}
			const TRUNCATE_LIMIT = 10_000;
			if (formatted.length > TRUNCATE_LIMIT) {
				formatted =
					formatted.slice(0, TRUNCATE_LIMIT) +
					`\n… (truncated, ${formatted.length - TRUNCATE_LIMIT} more chars)`;
			}
			return {
				content: [{ type: "text", text: formatted || "undefined" }],
				details: { result: result.result },
			};
		}

		// No expression, no clear — read console messages
		const consoleResult = await router.getConsoleMessages(tid);
		if (!consoleResult.success) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to read console: ${consoleResult.error}`,
					},
				],
				details: { error: true },
			};
		}

		if (consoleResult.messages.length === 0) {
			return {
				content: [{ type: "text", text: "No console messages captured." }],
				details: { count: 0 },
			};
		}

		const formatted = consoleResult.messages
			.map((m) => `[${m.type}] ${m.text}`)
			.join("\n");
		return {
			content: [{ type: "text", text: formatted }],
			details: {
				count: consoleResult.messages.length,
				messages: consoleResult.messages,
			},
		};
	},

	renderCall(args, theme, _context) {
		if (args.clear)
			return new Text(
				theme.fg("toolTitle", theme.bold("browser-console clear")),
				0,
				0,
			);
		if (args.expression) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("browser-console"))} ${theme.fg("dim", args.expression.slice(0, 60))}`,
				0,
				0,
			);
		}
		return new Text(
			theme.fg("toolTitle", theme.bold("browser-console read")),
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(theme.fg("error", "Console operation failed"), 0, 0);
		if (d?.cleared) return new Text(theme.fg("dim", "Console cleared"), 0, 0);
		if (d?.result !== undefined)
			return new Text(
				theme.fg(
					"dim",
					`JS → ${JSON.stringify(d.result)?.slice(0, 80) || "ok"}`,
				),
				0,
				0,
			);
		if (d?.count !== undefined)
			return new Text(theme.fg("dim", `📋 ${d.count} console messages`), 0, 0);
		return new Text(theme.fg("dim", "Console ok"), 0, 0);
	},
});
