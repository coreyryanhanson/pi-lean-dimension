import type {
	AgentToolResult,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	formatGuideListings,
	selectGuideByShortName,
	shortNameErrorText,
} from "../core/guide-catalog.js";
import type { ApiGuide } from "../core/api-guide-types.js";

/**
 * Extract the text of the first text content block of a tool result.
 * Returns the fallback (default "") when there is none.
 */
export function contentText(
	result: AgentToolResult<unknown>,
	fallback = "",
): string {
	const c = result.content?.[0];
	return c && c.type === "text" ? c.text : fallback;
}

/**
 * Tool-channel error result for a failed `selectGuideByShortName` — the
 * shared envelope (error text + structured details) behind api-guide,
 * api-learn, and api-scaffold's `{domain, guide}` resolution. The trailing
 * "how to see the menu" hint differs per tool, so callers pass it.
 */
export function shortNameErrorResult(
	sel: Extract<ReturnType<typeof selectGuideByShortName>, { ok: false }>,
	domain: string,
	selector: string,
	callToAction: string,
): AgentToolResult<unknown> {
	return {
		content: [
			{
				type: "text",
				text: shortNameErrorText(sel, domain, selector, callToAction),
			},
		],
		details:
			sel.reason === "no_match"
				? { error: "no_guide_by_shortname", domain, guide: selector }
				: {
						error: "ambiguous_shortname",
						domain,
						guide: selector,
						directories: sel.directories,
					},
	};
}

/**
 * Tool-channel disambiguation menu for a domain claimed by N guides:
 * count header (+ shared `organization:` when all matches share one),
 * per-guide listings, and a per-tool call-to-action footer built from
 * the first match's shortName.
 */
export function disambiguationMenuResult(
	domain: string,
	matches: { guide: ApiGuide }[],
	callToAction: (shortName: string) => string,
): AgentToolResult<unknown> {
	const orgs = new Set(
		matches.map((m) => m.guide.organization).filter((o): o is string => !!o),
	);
	const orgName = [...orgs][0];
	const orgPart =
		orgs.size === 1 && orgName ? ` (organization: ${orgName})` : "";
	return {
		content: [
			{
				type: "text",
				text: [
					`${matches.length} API guides for '${domain}'${orgPart}:`,
					formatGuideListings(matches),
					callToAction(matches[0]!.guide.shortName),
				].join("\n"),
			},
		],
		details: { mode: "menu", domain, disambiguation: matches.length },
	};
}

/**
 * Append a dim-styled content preview to an in-progress result string,
 * with a "more chars" suffix when the content exceeds the given limit.
 */
function renderExpandedText(
	text: string,
	theme: { fg: (c: ThemeColor, t: string) => string },
	content: string,
	limit: number,
): string {
	const preview = content.replace(/\n{3,}/g, "\n\n").slice(0, limit);
	if (!preview) return text;
	text += `\n${theme.fg("dim", preview)}`;
	if (content.length > limit)
		text += `\n${theme.fg("muted", `… ${content.length - limit} more chars`)}`;
	return text;
}

/**
 * Append the shared collapsed/expanded body footer to a render string:
 * expanded shows the content preview; collapsed shows a "chars (expand)" hint.
 */
export function appendFooter(
	text: string,
	expanded: boolean,
	result: AgentToolResult<unknown>,
	theme: { fg: (c: ThemeColor, t: string) => string },
	limit: number,
): string {
	const content = contentText(result);
	if (expanded) {
		text += "\n";
		text = renderExpandedText(text, theme, content, limit);
	} else {
		text += `\n${theme.fg("muted", `${content.length} chars (expand)`)}`;
	}
	return text;
}
