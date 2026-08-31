/**
 * Interactive guide picker for the /api verify, /api delete, and /api oauth
 * commands.
 *
 * When a domain claims N guides and no `guide` selector is supplied, the
 * commands show a two-column picker (shared `pickWithDescription` helper) —
 * shortName in the primary column, guide description in the second. The user
 * picks with ↑↓/enter instead of retyping the command with a shortName.
 * `value` is the dirName (unique, unlike shortName, which can be ambiguous
 * across sibling guides).
 *
 * Terminal-only: `ctx.mode === "tui"` (custom components don't exist in
 * RPC/print). In headless/RPC/print `pickGuide` returns undefined and the
 * caller keeps today's text menu + retype fallback. A stale guide
 * (`schemaVersion < current`) gets a `⚠` on its label so stale-guide
 * detection survives the interactive path.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { GUIDE_SCHEMA_VERSION, type ApiGuide } from "./api-guide-types.js";
import {
	formatGuideListings,
	isStaleSchema,
	selectGuideByShortName,
	shortNameErrorText,
} from "./parse-api-guide.js";
import { pickWithDescription } from "./select-picker.js";

/**
 * Build the picker rows: `value` = dirName (unique), `label` = shortName (with
 * a `⚠` when stale), `description` = the guide description, falling back to an
 * op-count summary when absent. Pure — tests exercise it without a TUI.
 */
export function buildGuidePickerItems(
	matches: { guide: ApiGuide; dirName: string }[],
	current: number = GUIDE_SCHEMA_VERSION,
): SelectItem[] {
	return matches.map(({ guide, dirName }) => {
		const desc =
			guide.description ??
			(guide.operations.length > 0
				? `${guide.operations.length} op${guide.operations.length === 1 ? "" : "s"}`
				: undefined);
		const item: SelectItem = {
			value: dirName,
			label:
				guide.shortName +
				(isStaleSchema(guide.schemaVersion ?? 0, current) ? " ⚠" : ""),
		};
		if (desc !== undefined) item.description = desc;
		return item;
	});
}

/**
 * Let the user pick one of a domain's guides interactively (TUI gets the
 * two-column SelectList; other modes return undefined so the caller renders
 * its own text menu fallback). Returns the selected `{ guide, dirName }`, or
 * undefined when the picker is unavailable or the user cancelled.
 */
export async function pickGuide(
	ctx: ExtensionCommandContext,
	matches: { guide: ApiGuide; dirName: string }[],
): Promise<{ guide: ApiGuide; dirName: string } | undefined> {
	if (ctx.mode !== "tui") return undefined;

	const picked = await pickWithDescription(
		ctx,
		"Select API guide",
		buildGuidePickerItems(matches),
	);

	if (picked === undefined) return undefined;
	return matches.find((m) => m.dirName === picked);
}

/**
 * Shared notify-based guide selection for commands: 1 match → it wins; a
 * selector → resolve by shortName (error + stop on no match); otherwise the
 * interactive picker with the text-menu fallback. Returns undefined when the
 * caller should stop (fallback menu shown or selection error notified).
 * Callers keep their own 0-match branch — those messages genuinely differ.
 * `ctx.ui.notify`-based only (the tool-channel sites — api-guide, api-learn,
 * api-scaffold — keep their own skeletons).
 */
export async function pickGuideForCommand(
	ctx: ExtensionCommandContext,
	domain: string,
	selector: string | undefined,
	matches: { guide: ApiGuide; dirName: string }[],
	command: string,
	label = "API guides",
): Promise<{ guide: ApiGuide; dirName: string } | undefined> {
	if (matches.length === 1) return matches[0];
	if (selector) {
		const sel = selectGuideByShortName(matches, selector);
		if (!sel.ok) {
			ctx.ui.notify(
				shortNameErrorText(
					sel,
					domain,
					selector,
					`Call ${command} ${domain} to see the menu.`,
				),
				"warning",
			);
			return undefined;
		}
		return sel;
	}
	// N guides, no selector → interactive pick (TUI) or the menu fallback
	// (headless/RPC/print or cancelled), nothing run yet.
	const picked = await pickGuide(ctx, matches);
	if (picked) return picked;
	ctx.ui.notify(
		[
			`${matches.length} ${label} for '${domain}':`,
			formatGuideListings(matches),
			`Call ${command} ${domain} <shortName> to pick one.`,
		].join("\n"),
		"info",
	);
	return undefined;
}
