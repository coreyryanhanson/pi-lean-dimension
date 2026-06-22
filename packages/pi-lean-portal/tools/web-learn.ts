/**
 * web-learn tool definition.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDES_DIR, invalidateGuideContent } from "../core/guides.js";

export const webLearnTool = defineTool({
	name: "web-learn",
	label: "Learn Navigation Patterns",
	description:
		"Save or update a navigation guide for a site. " +
		"Creates a new guide file for the given domain, or updates an existing one with new content and date. " +
		"The guide becomes available immediately via web-guide and appears in the guide footer on future navigations. " +
		"Requires /web learn to be active.",
	parameters: Type.Object({
		domain: Type.String({
			description: "Primary domain (e.g. 'reddit.com'). Used as the filename.",
		}),
		content: Type.String({
			description:
				"Markdown guidance content describing the site's navigation patterns, page structure, consent dialogs, and known quirks.",
		}),
		domains: Type.Optional(
			Type.String({
				description:
					"Comma-separated additional domains (e.g. 'www.reddit.com, old.reddit.com'). Omit if only the primary domain applies.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { domain, content, domains } = params as {
			domain: string;
			content: string;
			domains?: string;
		};

		// ── Validation ────────────────────────────────────────────
		if (!domain.includes(".")) {
			return {
				content: [
					{
						type: "text",
						text: `'${domain}' doesn't look like a domain. Use the full domain (e.g. 'reddit.com').`,
					},
				],
				details: {},
			};
		}

		if (!content || content.trim().length < 20) {
			return {
				content: [
					{
						type: "text",
						text: "Content too short. Provide at least a few sentences of guidance.",
					},
				],
				details: {},
			};
		}

		// ── File path ─────────────────────────────────────────────
		mkdirSync(GUIDES_DIR, { recursive: true });
		const filename = `${domain}.md`;
		const filepath = join(GUIDES_DIR, filename);

		// ── Build frontmatter ─────────────────────────────────────
		const today = new Date().toISOString().slice(0, 10);
		const allDomains = [domain];
		if (domains) {
			for (const d of domains
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)) {
				if (!allDomains.includes(d)) allDomains.push(d);
			}
		}

		const frontmatter = [
			"---",
			"category: site",
			`domains: ${allDomains.join(", ")}`,
			`updated: ${today}`,
			"---",
		].join("\n");

		const fileContent = frontmatter + "\n\n" + content.trim() + "\n";

		// ── Detect whether this is a create or update ──────────────
		const isUpdate = existsSync(filepath);
		writeFileSync(filepath, fileContent, "utf-8");

		// ── Invalidate cache ────────────────────────────────────
		invalidateGuideContent();

		const verb = isUpdate ? "Updated" : "Created";
		return {
			content: [
				{
					type: "text",
					text:
						`📖 ${verb} guide at guides/${filename}\n` +
						`  Domains: ${allDomains.join(", ")}\n` +
						`  Call web-guide guide="${domain}" to view it.\n` +
						`  A guide badge and footer will appear when navigating to ${allDomains[0]}.`,
				},
			],
			details: {
				filePath: filepath,
				domains: allDomains,
				guideName: domain,
				isUpdate,
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("web-learn "))];
		parts.push(theme.fg("accent", `"${args.domain}"`));
		return new Text(parts.join(" "), 0, 0);
	},
});
