/**
 * Generic picker with a muted description column (SelectList from
 * @earendil-works/pi-tui, already a peer dep) — the two-column layout used by
 * the guide picker and the oauth init wizard's grant / auth-method pickers.
 *
 * TUI-only for the custom component: `ctx.mode === "tui"` (custom components
 * don't exist in RPC/print). Everywhere else this falls back to plain
 * `ctx.ui.select` over the labels, returning the matching item's `value` —
 * descriptions are dropped, the flow is not.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

export interface PickerItem {
	value: string;
	label: string;
	description?: string;
}

export async function pickWithDescription(
	ctx: ExtensionCommandContext,
	title: string,
	items: PickerItem[],
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const picked = await ctx.ui.select(
			title,
			items.map((i) => i.label),
		);
		return picked === undefined
			? undefined
			: items.find((i) => i.label === picked)?.value;
	}

	const selectItems: SelectItem[] = items.map((i) => {
		const item: SelectItem = { value: i.value, label: i.label };
		if (i.description !== undefined) item.description = i.description;
		return item;
	});
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));
		const list = new SelectList(selectItems, Math.min(selectItems.length, 10), {
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
	});
}
