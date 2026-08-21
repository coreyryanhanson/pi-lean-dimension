/**
 * Interactive guide picker for the /api verify and /api delete commands.
 *
 * When a domain claims N guides and no `guide` selector is supplied, the
 * commands show a `SelectList` (from @earendil-works/pi-tui, already a peer
 * dep) with the shortName in the primary column and the guide description in
 * a second column — the user picks with ↑↓/enter instead of retyping the
 * command with a shortName. `value` is the dirName (unique, unlike shortName,
 * which can be ambiguous across sibling guides).
 *
 * Terminal-only: `ctx.mode === "tui"` (custom components don't exist in
 * RPC/print). In headless/RPC/print `pickGuide` returns undefined and the
 * caller keeps today's text menu + retype fallback. A stale guide
 * (`schemaVersion < current`) gets a `⚠` on its label so stale-guide
 * detection survives the interactive path.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import { GUIDE_SCHEMA_VERSION, type ApiGuide } from "./api-guide-types.js";
import { isStaleSchema } from "./parse-api-guide.js";

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
 * Let the user pick one of a domain's guides interactively (TUI only).
 * Returns the selected `{ guide, dirName }`, or undefined when the picker is
 * unavailable (not TUI mode) or the user cancelled — the caller then renders
 * its own text menu fallback.
 */
export async function pickGuide(
	ctx: ExtensionCommandContext,
	matches: { guide: ApiGuide; dirName: string }[],
): Promise<{ guide: ApiGuide; dirName: string } | undefined> {
	if (ctx.mode !== "tui") return undefined;

	const items = buildGuidePickerItems(matches);

	const picked = await ctx.ui.custom<string | undefined>(
		(tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Select API guide"))),
			);
			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			container.addChild(list);
			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")),
			);
			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);

	if (picked === undefined) return undefined;
	return matches.find((m) => m.dirName === picked);
}
