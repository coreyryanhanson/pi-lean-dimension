/**
 * browser-navigate tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "../core/router.js";
import { resolveGuidePresence } from "../core/guides.js";
import { getConversationDefaultProfile } from "../browser-toggle.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { removeSnapshotFiles } from "../core/shared/snapshot-cache.js";
import { taskId, updateFooterStatus, profileLine } from "./utils.js";

export const browserNavigateTool = defineTool({
	name: "browser-navigate",
	label: "Browse Web",
	description:
		"Navigate a browser to a URL and return the page as an accessibility tree with @e1, @e2 element references. " +
		"Uses the configured browser plugin (default: Chromium). For stateless HTTP fetches without interactive elements, use web-fetch instead.",
	promptSnippet: "Fetch and read web pages in text form",
	promptGuidelines: [
		"Use browser-navigate when you need to interact with a web page using @e1/@e2 element references (click, type, scroll, etc.).",
		"If you just need the page content as Markdown without interactive elements, use web-fetch instead.",
		"Use @e1, @e2 references from the accessibility tree with browser-click and browser-type to interact with page elements.",
		"If snapshot or interaction returns 'No active session', the previous navigation was in a different context. Use browser-navigate first to establish a session.",
		"After auto-launch, @e refs may have changed — a fresh accessibility tree is returned automatically. Use the new refs for interaction.",
		"If the snapshot is truncated, use browser-inspect role=... name=... to find specific elements, or read the cached snapshot file. Avoid browser-snapshot full=true unless you need the entire tree.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The URL to navigate to" }),
		strategy: Type.Optional(
			Type.String({
				description:
					'Backend strategy: "auto" (default) uses the first available plugin; ' +
					'specify a registered plugin name (e.g. "chromium", "chromium-py") to use that backend. ' +
					"For stateless HTTP fetches, use web-fetch instead.",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description: "Timeout in seconds (default: 30, max: 120)",
				minimum: 1,
				maximum: 120,
			}),
		),
		profile: Type.Optional(
			Type.Union(
				[Type.Literal("none"), Type.Literal("session"), Type.String()],
				{
					description:
						"Profile mode: 'none' (clean slate, default), 'session' (persist for this " +
						"conversation), or a named profile (e.g. 'shopping', 'work'). " +
						"Named profiles share cookies across subagents like browser tabs.",
				},
			),
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const {
			url,
			strategy = "auto",
			timeout = 30,
			profile,
		} = params as {
			url: string;
			strategy?: string;
			timeout?: number;
			profile?: string;
		};
		const tid = taskId(ctx);
		const piSessionId = ctx?.sessionManager?.getSessionId?.();

		signal?.addEventListener(
			"abort",
			() => {
				sessionManager.removeSession(tid);
				removeSnapshotFiles(tid);
				updateFooterStatus(ctx);
			},
			{ once: true },
		);

		const navOptions: router.NavigateOptions = {
			strategy,
			timeout,
			taskId: tid,
		};
		if (piSessionId) navOptions.piSessionId = piSessionId;
		if (signal) navOptions.signal = signal;
		// Profile resolution: explicit param > conversation default > config file default
		if (profile) {
			// Explicit user parameter
			navOptions.profile = profile as "none" | "session" | string;
		} else {
			// Conversation-scoped default (set via /web profile <name>)
			const convDefault = getConversationDefaultProfile();
			if (convDefault) {
				navOptions.profile = convDefault as "none" | "session" | string;
			}
			// else: router falls back to browserConfig.defaultProfile
		}

		const result = await router.navigate(url, navOptions);

		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to load page: ${result.error ?? "unknown error"}`,
					},
				],
				details: {
					error: true,
					backendUsed: result.backendUsed,
					url: result.url,
				},
			};
		}

		// Safety net: prevent extreme context flooding (fires below the router's
		// very-large-page strategy, which kicks in at 8000 chars; this is a
		// secondary cap at 4000 chars for rare edge cases). The snapshot cache
		// preserves the full original — use `read` on the cache file path to
		// access all elements.
		let contentText = result.snapshot;
		if (result.elementCount !== undefined && contentText.length > 8000) {
			let cut = contentText.lastIndexOf("\n", 4000);
			if (cut < 2000) cut = 4000;
			contentText =
				contentText.slice(0, cut) +
				`\n… ${contentText.length - cut} more chars (auto-truncated). ` +
				`Read cached snapshot for full content.`;
		}

		// Capture a screenshot to a temp file so the LLM can opt into visual
		// inspection via `read` only when needed.
		const screenshotPath = await router.screenshotToTemp(tid);

		const lines = [
			`Title: ${result.title || "(no title)"}`,
			`URL: ${result.url}`,
			`Backend: ${result.backendUsed}`,
			result.elementCount !== undefined
				? `Interactive elements: ${result.elementCount}`
				: "",
			result.profileMode !== undefined ? profileLine(result) : "",
			result.botDetectionWarning
				? "⚠ BOT DETECTION WARNING: This page appears to be protected by " +
					"anti-automation. The content below may be incomplete or show " +
					"a challenge page instead of the actual content."
				: "",
			screenshotPath
				? `📷 Screenshot: ${screenshotPath} (use the read tool for visual inspection)`
				: "",
			"",
			contentText,
		];

		// ---- Web Guide presence ----
		const presence = resolveGuidePresence(
			tid,
			result.url,
			result.snapshot,
			result.botDetectionWarning ?? false,
		);
		if (presence) {
			if (presence.type === "inject") {
				lines.push(
					"",
					presence.text,
					"",
					`_Call web-guide guide="${presence.guideName}" to see this guide again._`,
				);
			} else {
				lines.push("", presence.text);
			}
		}

		return {
			content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
			details: {
				title: result.title,
				url: result.url,
				backendUsed: result.backendUsed,
				elementCount: result.elementCount,
				profileMode: result.profileMode,
				profileName: result.profileName,
				botDetectionWarning: result.botDetectionWarning,
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [
			theme.fg("toolTitle", theme.bold("browser-navigate ")),
		];
		parts.push(theme.fg("accent", `"${args.url}"`));
		if (args.strategy && args.strategy !== "auto")
			parts.push(theme.fg("dim", `via ${args.strategy}`));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Navigating…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(
				theme.fg(
					"error",
					`Failed: ${(result.content?.[0] as any)?.text ?? "?"}`,
				),
				0,
				0,
			);

		const title = (d?.title as string) || "(no title)";
		const backend = (d?.backendUsed as string) || "?";
		const url = (d?.url as string) || "";
		const ec = d?.elementCount as number | undefined;
		const pm = d?.profileMode as string | undefined;
		const pn = d?.profileName as string | undefined;
		const botWarn = d?.botDetectionWarning as boolean | undefined;

		let text = theme.fg("accent", theme.bold(`🌐 ${title}`));
		text += `\n${theme.fg("dim", url)}`;
		text += `\n${theme.fg("muted", `via ${backend}`)}`;
		if (ec !== undefined) text += ` · ${ec} elements`;
		if (pn) {
			const modeTag = pm === "session" ? "📋" : "👤";
			text += ` ${theme.fg("dim", `${modeTag} ${pn}`)}`;
		} else if (pm === "restored") {
			text += ` ${theme.fg("accent", "↻ restored")}`;
		}
		if (botWarn) text += ` ${theme.fg("warning", "⚠ bot detection")}`;

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
