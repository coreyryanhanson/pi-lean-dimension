/**
 * Interactive guide picker for the /api verify and /api delete commands.
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
import { isStaleSchema } from "./parse-api-guide.js";
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
