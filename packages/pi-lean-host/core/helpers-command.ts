/**
 * `/api helpers [domain]` — list and read local user helpers.
 *
 * Visibility-only read command. Authoring is via `api-learn` in learn mode
 * (or hand-editing the helper file).
 *
 * Mirrors `/web cookies list` / `/web profile` in portal.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	getAllHelpers,
	readHelperSource,
	getDisabledHelperDomains,
} from "./local-helpers.js";

/**
 * Handle the `helpers` subcommand of `/api`.
 *
 * @param args  The text after "helpers" (e.g. "" for list, "boe.es" for detail)
 * @param ctx   The extension command context
 */
export async function handleHelpersSubcommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const domain = args.trim();

	if (!domain) {
		// ── List all helpers ────────────────────────────────────
		const all = getAllHelpers();
		const disabled = getDisabledHelperDomains();
		const disabledSet = new Set(disabled);

		if (all.length === 0) {
			ctx.ui.notify(
				"No local helpers found. Helpers live alongside their guide: " +
					`api-guides/<domain>/helper.ts.\n\n` +
					"Author a helper via api-learn in learn mode, or hand-edit a <domain>/helper.ts file.",
				"info",
			);
			return;
		}

		const lines: string[] = [`Found ${all.length} helper(s):`, ""];

		for (const name of all) {
			if (disabledSet.has(name)) {
				lines.push(`  ⚠ ${name}  (disabled — errored this session)`);
			} else {
				lines.push(`  · ${name}`);
			}
		}

		lines.push(
			"",
			"Call /api helpers <domain> to view a helper's source.",
			"Call api-learn({domain, dir}) to author or update a guide (and its helper).",
		);

		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// ── Show single helper source ───────────────────────────────
	// readHelperSource → findHelperFile → assertSafeDomain throws on
	// path-traversal domains (e.g. `/api helpers ../../foo`).
	let source: string | null;
	try {
		source = readHelperSource(domain);
	} catch (err) {
		ctx.ui.notify(
			err instanceof Error ? err.message : `Invalid domain '${domain}'.`,
			"warning",
		);
		return;
	}
	if (source === null) {
		const all = getAllHelpers();
		const known =
			all.length > 0 ? ` Known helpers: ${all.join(", ")}.` : " No helpers found.";
		ctx.ui.notify(
			`No helper for '${domain}'.${known}\n\n` +
				`Helpers live alongside guides at api-guides/${domain}/helper.ts.\n` +
				"Author via api-learn in learn mode.",
			"warning",
		);
		return;
	}

	const lines: string[] = [
		`📋 Helper: ${domain}.ts`,
		"",
		"```typescript",
		source,
		"```",
		"",
		"Helper contract:",
		"  (params: Record<string, unknown>, ctx: { operation: string; domain: string })",
		"    => Record<string, unknown> | Promise<Record<string, unknown>>",
		"",
		"The helper is a synchronous-pure or fully-awaited pre-call transform.",
		"No background work — setTimeout/setInterval/process.on callbacks",
		"escape as uncaughtException and cannot be caught.",
	];

	ctx.ui.notify(lines.join("\n"), "info");
}
