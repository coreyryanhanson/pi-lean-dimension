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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	ctx: ExtensionContext,
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

// Checklist multi-select (✓/○ toggle + Done row) — the one new UI
// component of the agent-driven OAuth2 bootstrap. Same ctx.ui.custom +
// SelectList scaffolding as above; Enter on a row toggles ✓/○, Enter on the
// Done row proceeds, Esc cancels.

const DONE_VALUE = "__done__";

/**
 * Multi-select checklist: Enter toggles ✓/○, Enter on the Done row resolves
 * the checked values, Esc returns undefined (whole tool call cancels).
 * All rows start unchecked — granting is the human's affirmative act.
 * Non-TUI fallback: comma-separated `ctx.ui.input` over the names.
 */
export async function pickChecklist(
	ctx: ExtensionContext,
	title: string,
	rows: PickerItem[],
): Promise<string[] | undefined> {
	if (ctx.mode !== "tui") {
		const raw = await ctx.ui.input(
			`${title} — comma-separated names to grant`,
			rows.map((r) => r.value).join(","),
		);
		if (raw === undefined) return undefined;
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter((v) => rows.some((r) => r.value === v));
	}

	const checked = new Set<string>();
	return ctx.ui.custom<string[] | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		let selectedIndex = 0;
		let list = buildList();

		function buildList(): SelectList {
			const selectItems: SelectItem[] = rows.map((r) => {
				const item: SelectItem = {
					value: r.value,
					label: `${checked.has(r.value) ? "✓" : "○"} ${r.label}`,
				};
				if (r.description !== undefined) item.description = r.description;
				return item;
			});
			selectItems.push({
				value: DONE_VALUE,
				label: "✔ Done — grant the checked scopes",
			});
			const fresh = new SelectList(selectItems, Math.min(selectItems.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			fresh.setSelectedIndex(Math.min(selectedIndex, selectItems.length - 1));
			fresh.onSelectionChange = (item) => {
				const at = selectItems.findIndex((s) => s.value === item.value);
				if (at >= 0) selectedIndex = at;
			};
			fresh.onSelect = (item) => {
				if (item.value === DONE_VALUE) {
					done([...checked]);
					return;
				}
				if (checked.has(item.value)) checked.delete(item.value);
				else checked.add(item.value);
				// Rebuild so the ✓/○ prefixes re-render; the highlight follows
				// the tracked index across the swap.
				container.removeChild(list);
				list = buildList();
				container.addChild(list);
			};
			fresh.onCancel = () => done(undefined);
			return fresh;
		}

		container.addChild(new Text(theme.fg("accent", theme.bold(title))));
		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ navigate • enter toggle • esc cancel all")),
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
