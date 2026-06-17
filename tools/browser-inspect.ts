/**
 * browser-inspect tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { taskId } from "./utils.js";

export const browserInspectTool = defineTool({
	name: "browser-inspect",
	label: "Inspect Page",
	description:
		"Query the current page for specific elements or extract readable " +
		"text content. Use for targeted discovery instead of full snapshots.",
	promptSnippet:
		"Query the current page for elements or text content with @e ref annotations",
	promptGuidelines: [
		"Use browser-inspect role=... name=... to find a specific element without loading a full snapshot",
		"Use browser-inspect text=true to read page content (article, form, etc.) with correlated @e refs",
		"Use browser-inspect subtree=... to scope queries inside dialogs, menus, or navigation regions",
		"After clicking or scrolling, take a fresh browser-snapshot before trusting @e refs from browser-inspect",
		"Do NOT use browser-inspect as a replacement for browser-navigate — it requires an existing session",
		"When browser-inspect returns multiple @e refs for the same name, disambiguate by reading the cached full snapshot",
	],
	parameters: Type.Object({
		role: Type.Optional(
			Type.String({
				description:
					'Filter by ARIA role. Comma-separated for multiple. E.g. "link,button"',
			}),
		),
		name: Type.Optional(
			Type.String({
				description:
					"Filter by accessible name (case-insensitive substring match)",
			}),
		),
		ref: Type.Optional(
			Type.String({
				description:
					"Look up a specific @e ref (e.g. 'e5'). When combined with text=true, scopes DOM walker to that element's subtree.",
			}),
		),
		subtree: Type.Optional(
			Type.String({
				description:
					"Scope to elements inside a container role. E.g. 'dialog', 'navigation'",
			}),
		),
		text: Type.Optional(
			Type.Boolean({
				description:
					"Include text content from DOM walker with @e ref annotations. Default: false",
			}),
		),
		maxChars: Type.Optional(
			Type.Number({
				description:
					'Max output characters. 0 = no limit. Default: ~2500 when omitted. Truncated output shows "… X more chars (use maxChars=0 for full content)"',
				minimum: 0,
			}),
		),
		query: Type.Optional(
			Type.String({
				description:
					"Filter extracted text to only include content matching this case-insensitive keyword. " +
					"Useful for finding specific topics on large pages without retrieving all text. " +
					"Only active when text=true.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const p = params as Record<string, unknown>;
		const tid = (p?.taskId as string | undefined) ?? taskId(ctx);

		const result = await router.browserInspect(tid, {
			...(p?.role !== undefined ? { role: p.role as string } : {}),
			...(p?.name !== undefined ? { name: p.name as string } : {}),
			...(p?.ref !== undefined ? { ref: p.ref as string } : {}),
			...(p?.subtree !== undefined ? { subtree: p.subtree as string } : {}),
			...(p?.text !== undefined ? { text: Boolean(p.text) } : {}),
			...(p?.maxChars !== undefined ? { maxChars: p.maxChars as number } : {}),
			...(p?.query !== undefined ? { query: p.query as string } : {}),
		});

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: result.error ?? "browser-inspect failed",
					},
				],
				details: { error: true },
			};
		}

		return {
			content: [{ type: "text", text: result.content }],
			details: {
				stalenessWarning: result.staleCacheWarning,
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts = [theme.fg("toolTitle", theme.bold("browser-inspect"))];
		if (args.text) parts.push(theme.fg("accent", "📖 text"));
		if (args.role) parts.push(theme.fg("dim", `role=${args.role}`));
		if (args.name) parts.push(theme.fg("dim", `name="${args.name}"`));
		if (args.ref) parts.push(theme.fg("dim", `@${args.ref}`));
		if (args.subtree) parts.push(theme.fg("dim", `subtree=${args.subtree}`));
		if (args.query) parts.push(theme.fg("accent", `query="${args.query}"`));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) return new Text(theme.fg("error", "Inspect failed"), 0, 0);
		const content = (result.content?.[0] as any)?.text ?? "";
		const staleness = d?.stalenessWarning
			? ` ${theme.fg("warning", "(stale)")}`
			: "";
		const preview = content.replace(/\n{3,}/g, "\n\n").slice(0, 100);
		let text = theme.fg("accent", `🔍 ${content.length} chars`) + staleness;
		if (preview) {
			text += `\n${theme.fg("dim", preview)}`;
			if (content.length > 100)
				text += `\n${theme.fg("muted", `… ${content.length - 100} more chars`)}`;
		}
		return new Text(text, 0, 0);
	},
});
