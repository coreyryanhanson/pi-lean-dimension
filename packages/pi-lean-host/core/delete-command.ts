/**
 * `/api delete <domain> [guide]` — remove a guide directory and invalidate
 * the per-session guide-store cache (closing the ghost-guide cache bug that
 * `bash rm` leaves behind).
 *
 * - `delete <domain>`         — whole-domain delete (interactive confirm).
 * - `delete <domain> <guide>` — delete one guide by shortName (no confirm).
 * - `delete --help`           — usage.
 *
 * Whole-domain delete mirrors `/api secrets --delete` (interactive confirm);
 * single-guide delete mirrors `/api secrets --delete <domain> <name>` (no
 * confirm). After the `rm -rf` of the directory, `invalidateCache()` so the
 * next api-guide / api-fetch doesn't see a ghost guide — the load-bearing
 * reason this beats `bash rm`.
 *
 * Always-available (runs in **on** mode), not learn-gated, and not refused by
 * the focus-mode guard — it writes no toolset state (peer of secrets/verify).
 *
 * The agent has NO delete surface: api-learn's collision/malformed errors
 * tell it to ask the human to run this command.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	findGuidesByDomain,
	invalidateCache,
	getUserGuidesDir,
} from "./guide-store.js";
import {
	formatGuideListings,
	selectGuideByShortName,
	shortNameErrorText,
} from "./parse-api-guide.js";
import { pickGuide } from "./guide-picker.js";
import { assertSafeDomain } from "./path-template.js";

/** Usage, surfaced by `--help`. */
function helpText(): string {
	return [
		"Usage: /api delete <domain> [guide]",
		"  /api delete <domain>            delete the whole guide directory (interactive confirm)",
		"  /api delete <domain> <guide>    delete one guide by shortName (no confirm)",
		"  /api delete --help              this help",
		"",
		"  Removes the directory and invalidates the per-session guide cache, so the",
		"  next api-guide / api-fetch no longer lists it (bash rm leaves a ghost).",
		"  The agent has no delete tool — this is a human-typed recovery gesture.",
	].join("\n");
}

/**
 * Handle the `delete` subcommand of `/api`.
 *
 * @param args  The text after "delete" ("" / "<domain>" / "<domain> <guide>").
 * @param ctx   The extension command context
 */
export async function handleDeleteSubcommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);

	if (parts.includes("--help") || parts.includes("help")) {
		ctx.ui.notify(helpText(), "info");
		return;
	}

	const domain = parts[0];
	const guideSelector = parts[1];

	if (!domain) {
		ctx.ui.notify(
			"Usage: /api delete <domain> [guide] — see /api delete --help.",
			"warning",
		);
		return;
	}

	// Path-traversal guard before any filesystem access — the literal-dir
	// fallback below joins the domain into the guides dir.
	try {
		assertSafeDomain(domain);
	} catch (err) {
		ctx.ui.notify(
			err instanceof Error ? err.message : `Invalid domain '${domain}'.`,
			"warning",
		);
		return;
	}

	const matches = findGuidesByDomain(domain);

	if (matches.length === 0) {
		// Literal-dir fallback: a malformed guide's `domains:` block is
		// unreadable, so findGuidesByDomain can't address it — but the
		// malformed catalog line shows its dirName. `/api delete <dirName>`
		// recovers it. Whole-domain delete (confirm) since the guide can't be
		// enumerated from it.
		if (existsSync(join(getUserGuidesDir(), domain))) {
			await deleteDir(ctx, domain, true);
			return;
		}
		ctx.ui.notify(
			`No API guide for '${domain}'. ` +
				`Call api-guide({}) to list available guides, or api-learn({domain: "${domain}"}) to author one.`,
			"warning",
		);
		return;
	}

	// guide selector present → resolve by shortName (1 or N guides), no confirm.
	if (guideSelector) {
		const sel = selectGuideByShortName(matches, guideSelector);
		if (!sel.ok) {
			ctx.ui.notify(
				shortNameErrorText(
					sel,
					domain,
					guideSelector,
					`Call /api delete ${domain} to see the menu.`,
				),
				"warning",
			);
			return;
		}
		await deleteDir(ctx, sel.dirName, false);
		return;
	}

	if (matches.length === 1) {
		// Whole-domain delete — interactive confirm.
		await deleteDir(ctx, matches[0]!.dirName, true);
		return;
	}

	// N guides, no selector → interactive pick (TUI) or the menu
	// fallback (headless/RPC/print or cancelled), nothing removed.
	const picked = await pickGuide(ctx, matches);
	if (!picked) {
		ctx.ui.notify(
			[
				`${matches.length} API guides for '${domain}':`,
				formatGuideListings(matches),
				`Call /api delete ${domain} <shortName> to delete one guide (no confirm).`,
			].join("\n"),
			"info",
		);
		return;
	}
	await deleteDir(ctx, picked.dirName, false);
}

/**
 * Remove one guide directory and invalidate the cache. `confirm` is true for
 * whole-domain deletes (interactive confirm, headless skips it — mirroring
 * `/api secrets --delete`) and false for single-guide deletes.
 */
async function deleteDir(
	ctx: ExtensionCommandContext,
	dirName: string,
	confirm: boolean,
): Promise<void> {
	const dir = join(getUserGuidesDir(), dirName);
	if (!existsSync(dir)) {
		ctx.ui.notify(
			`No guide directory '${dirName}' — nothing to delete.`,
			"warning",
		);
		return;
	}
	if (confirm && ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			`Delete the API guide directory '${dirName}'?`,
			`This removes ${dir} and its contents (guide.md, helper.ts, verify.json).`,
		);
		if (!ok) {
			ctx.ui.notify("Cancelled — nothing deleted.", "info");
			return;
		}
	}
	rmSync(dir, { recursive: true, force: true });
	invalidateCache();
	ctx.ui.notify(
		`🗑 Deleted API guide '${dirName}'. ` +
			`Cache invalidated — the next api-guide catalog will no longer list it.`,
		"info",
	);
}
