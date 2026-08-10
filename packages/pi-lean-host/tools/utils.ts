import type {
	AgentToolResult,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";

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
 * Append a dim-styled content preview to an in-progress result string,
 * with a "more chars" suffix when the content exceeds the given limit.
 */
export function renderExpandedText(
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
