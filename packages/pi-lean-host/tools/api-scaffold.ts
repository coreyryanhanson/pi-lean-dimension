/**
 * api-scaffold tool definition.
 *
 * Learn-gated bootstrap tool for a guide's sibling artifacts. Reads the
 * saved guide from the guides dir and writes starter `helper.ts` and/or
 * `verify.json` into `/tmp/pi-lean-host/<slug(shortName)>/` staging — never
 * the guides dir. The agent saves via `api-learn({domain, dir})`.
 *
 *  - `{domain, helper: true}` → commented-out helper stub (default +
 *    `transform` exports) with doc comments. Self-documenting.
 *  - `{domain, verify: true}` → `verify.json` with `"__FILL_ME__"` sentinels
 *    for every unsatisfiable param (path `{token}`, required-no-default
 *    query, each `requiresAnyOf` member). Existing guides-dir `verify.json`
 *    real values are additive-merged; new sentinels added for newly-
 *    unsatisfiable params.
 *  - `{domain, verify: true, helper: true}` → both files, same staged dir.
 *
 * Refuses to overwrite an existing staged sibling (delete from /tmp +
 * re-call for a fresh scaffold). At least one of `verify`/`helper` must be
 * true. `dirName` is always derived (slug(shortName)) and surfaced.
 *
 * Guide resolution mirrors api-learn's fetch-recipe exactly
 * (`findGuidesByDomain` + `selectGuideByShortName`, disambiguation menu for
 * N-guide domains with no selector).
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { appendFooter, contentText } from "./utils.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatGuideListings,
	selectGuideByShortName,
	shortNameErrorText,
} from "../core/parse-api-guide.js";
import type { ApiGuide } from "../core/api-guide-types.js";
import { findGuidesByDomain, getUserGuidesDir } from "../core/guide-store.js";
import { assertSafeDomain, slug } from "../core/path-template.js";
import {
	unsatisfiable,
	renderForSentinels,
	loadVerifyJson,
} from "../core/verify-command.js";

// ═══════════════════════════════════════════════════════════════════
// Staged working copy (/tmp) — same root api-learn writes to
// ═══════════════════════════════════════════════════════════════════

let _stagingRoot = join(tmpdir(), "pi-lean-host");

/** Test override — keeps scaffolds out of the real /tmp root (mirrors
 * api-learn's `setStagingRoot`). */
export function setStagingRoot(dir: string): void {
	_stagingRoot = dir;
}

// ═══════════════════════════════════════════════════════════════════
// Authoring manual + templates
// ═══════════════════════════════════════════════════════════════════

/** Compact authoring manual, prepended to every scaffold result. */
const AUTHORING_MANUAL = [
	"# verify.json authoring manual",
	"",
	'1. "__FILL_ME__" means "replace with a real value." The sentinel is treated as unsupplied; the op skips until you replace it.',
	"2. For requiresAnyOf groups, fill any ONE member — not all. The op runs when any member is supplied; the remaining sentinels are correctly ignored.",
	"3. Source the values. Don't invent them — use api-fetch or api-probe to discover a real {token} value, or read the guide's param descriptions for format hints.",
	"",
	"Save the guide FIRST, then scaffold: api-scaffold reads the SAVED guide, so the staged sibling matches what the loader will see. Re-scaffold = delete the staged file from /tmp + re-call (no merge).",
].join("\n");

/** Starter helper.ts — both exports commented out, self-documenting. */
function helperStub(domain: string): string {
	return `/**
 * Helper for ${domain}.
 * One helper per domain is the v1 contract.
 *
 * Uncomment the export(s) you need and fill in the logic.
 */

// Pre-call param transform — receives agent-supplied params, returns the
// params the executor uses for URL templating / query assembly.
// export default function(
//   params: Record<string, unknown>,
//   _ctx: { operation: string; domain: string },
// ): Record<string, unknown> {
//   return params;
// }

// Post-response transform — reshapes the parsed response body.
// export function transform(
//   data: unknown,
//   _ctx: { operation: string; domain: string },
// ): unknown {
//   return data;
// }
`;
}

// ═══════════════════════════════════════════════════════════════════
// verify.json sentinel computation
// ═══════════════════════════════════════════════════════════════════

/**
 * Additive-merge the sentinel scaffold into an existing guides-dir
 * verify.json: real values preserved, `"__FILL_ME__"` added only for
 * unsatisfiable params not yet present. Purely additive — no pruning.
 */
function mergeVerifySentinels(
	guide: ApiGuide,
	existing: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
	const merged: Record<string, Record<string, unknown>> = {};
	for (const [opName, params] of Object.entries(existing)) {
		merged[opName] = { ...params };
	}
	for (const op of guide.operations) {
		const sentinels = renderForSentinels(unsatisfiable(op, {}));
		if (sentinels.length === 0) continue; // runnable op → no entry
		const entry = merged[op.name] ?? {};
		for (const p of sentinels) {
			if (entry[p] === undefined) entry[p] = "__FILL_ME__";
		}
		merged[op.name] = entry;
	}
	return merged;
}

// ═══════════════════════════════════════════════════════════════════
// Tool definition
// ═══════════════════════════════════════════════════════════════════

export const apiScaffoldTool = defineTool({
	name: "api-scaffold",
	label: "API Scaffold",
	description:
		"Bootstrap sibling artifacts (helper.ts / verify.json) for an API guide, staged to /tmp — never the guides dir. " +
		"Call with {domain, verify: true} and/or {domain, helper: true}. " +
		"Then save via api-learn({domain, dir: '<staged dir>'}).",

	parameters: Type.Object({
		domain: Type.String({
			description:
				"Routing domain (e.g. 'example.com'). Resolves the guide exactly like api-learn fetch-recipe.",
		}),
		guide: Type.Optional(
			Type.String({
				description:
					"When a domain claims multiple guides, select one by shortName (shown in the disambiguation menu).",
			}),
		),
		verify: Type.Optional(
			Type.Boolean({
				description:
					'true → scaffold a starter verify.json with "__FILL_ME__" sentinels for every unsatisfiable param.',
			}),
		),
		helper: Type.Optional(
			Type.Boolean({
				description:
					"true → scaffold a commented-out helper.ts stub (default + transform exports).",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const {
			domain,
			guide: guideSelector,
			verify,
			helper,
		} = params as {
			domain: string;
			guide?: string;
			verify?: boolean;
			helper?: boolean;
		};

		// ── At least one artifact requested ────────────────────
		if (!verify && !helper) {
			return {
				content: [
					{
						type: "text",
						text:
							`⚠ Nothing to scaffold — at least one of verify: true or helper: true is required.\n` +
							`  verify: true → starter verify.json (sentinels for unsatisfiable params)\n` +
							`  helper: true → commented-out helper.ts stub`,
					},
				],
				details: { error: "nothing_to_scaffold", domain },
			};
		}

		// ── Validate domain (path-traversal guard) ─────────────
		try {
			assertSafeDomain(domain);
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: err instanceof Error ? err.message : `Invalid domain '${domain}'.`,
					},
				],
				details: { error: "invalid_domain", domain },
			};
		}

		// ── Guide resolution (mirrors api-learn fetch-recipe) ──
		const matches = findGuidesByDomain(domain);
		if (matches.length === 0) {
			// State-aware guidance: if a staged template already exists for this
			// domain (api-learn {domain, new:true} stages by domain), the user is
			// mid-authoring — tell them to save it first. Otherwise keep the
			// browse + author-one-first guidance.
			const stagedDraftDir = join(_stagingRoot, domain);
			const hasStagedDraft = existsSync(join(stagedDraftDir, "guide.md"));
			return {
				content: [
					{
						type: "text",
						text: hasStagedDraft
							? `No SAVED API guide for '${domain}' — scaffold reads the saved guide, not a staged draft.\n` +
								`  You have a staged template at ${stagedDraftDir}/guide.md — save it first via\n` +
								`  api-learn({domain: "${domain}", dir: "${stagedDraftDir}"}), then re-call api-scaffold.`
							: `No API guide for '${domain}'. ` +
								`Call api-guide({}) to list available guides, or author one first via api-learn({domain: "${domain}", new: true}) — ` +
								`scaffold reads the SAVED guide.`,
					},
				],
				details: { error: "no_guide", domain, stagedDraft: hasStagedDraft },
			};
		}

		let selected: { guide: ApiGuide; dirName: string };
		if (matches.length === 1) {
			selected = matches[0]!;
		} else if (guideSelector) {
			const sel = selectGuideByShortName(matches, guideSelector);
			if (!sel.ok) {
				return {
					content: [
						{
							type: "text",
							text: shortNameErrorText(
								sel,
								domain,
								guideSelector,
								`Call api-scaffold({domain: "${domain}", verify: true}) to see the menu.`,
							),
						},
					],
					details:
						sel.reason === "no_match"
							? { error: "no_guide_by_shortname", domain, guide: guideSelector }
							: {
									error: "ambiguous_shortname",
									domain,
									guide: guideSelector,
									directories: sel.directories,
								},
				};
			}
			selected = sel;
		} else {
			// N guides, no selector → disambiguation menu (mirrors api-learn).
			return {
				content: [
					{
						type: "text",
						text: [
							`${matches.length} API guides for '${domain}':`,
							formatGuideListings(matches),
							`Call api-scaffold({domain: "${domain}", guide: "${matches[0]!.guide.shortName}", verify: true}) to scaffold one.`,
						].join("\n"),
					},
				],
				details: { mode: "menu", domain, disambiguation: matches.length },
			};
		}

		const { guide, dirName } = selected;
		const stagedDir = join(_stagingRoot, slug(guide.shortName));

		// ── Refuse-to-overwrite (before any write) ────────────
		if (helper && existsSync(join(stagedDir, "helper.ts"))) {
			return {
				content: [
					{
						type: "text",
						text:
							`⚠ Refusing to scaffold — ${join(stagedDir, "helper.ts")} already exists.\n` +
							`  api-scaffold never overwrites a staged sibling. Delete the file from /tmp first, then re-call for a fresh scaffold.`,
					},
				],
				details: { error: "refuse_overwrite", domain, dirName, file: "helper.ts" },
			};
		}
		if (verify && existsSync(join(stagedDir, "verify.json"))) {
			return {
				content: [
					{
						type: "text",
						text:
							`⚠ Refusing to scaffold — ${join(stagedDir, "verify.json")} already exists.\n` +
							`  api-scaffold never overwrites a staged sibling. Delete the file from /tmp first, then re-call for a fresh scaffold.`,
					},
				],
				details: {
					error: "refuse_overwrite",
					domain,
					dirName,
					file: "verify.json",
				},
			};
		}

		// ── verify: load existing guides-dir sidecar for the merge ──
		let existingVerify: Record<string, Record<string, unknown>> = {};
		if (verify) {
			const sidecar = loadVerifyJson(dirName);
			if (sidecar && "error" in sidecar) {
				return {
					content: [
						{
							type: "text",
							text:
								`⚠ verify.json for '${dirName}' is malformed — cannot merge (${sidecar.error}).\n` +
								`  Fix or delete ${join(getUserGuidesDir(), dirName, "verify.json")}, then re-call. Guides dir untouched.`,
						},
					],
					details: { error: "malformed_verify_json", domain, dirName },
				};
			}
			if (sidecar && "data" in sidecar) existingVerify = sidecar.data;
		}

		mkdirSync(stagedDir, { recursive: true });

		const written: string[] = [];
		let helperPath: string | undefined;
		let verifyPath: string | undefined;

		if (helper) {
			helperPath = join(stagedDir, "helper.ts");
			writeFileSync(helperPath, helperStub(domain), "utf-8");
			written.push(helperPath);
		}
		if (verify) {
			verifyPath = join(stagedDir, "verify.json");
			const merged = mergeVerifySentinels(guide, existingVerify);
			writeFileSync(verifyPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
			written.push(verifyPath);
		}

		let mode: string;
		if (helper && verify) mode = "both";
		else if (helper) mode = "helper";
		else mode = "verify";

		return {
			content: [
				{
					type: "text",
					text:
						AUTHORING_MANUAL +
						"\n\n" +
						`🛠 Scaffolded '${guide.shortName}' (${dirName}) into ${stagedDir}\n` +
						written.map((p) => `  ${p}`).join("\n") +
						`\n  Then save via api-learn({domain: "${domain}", dir: "${stagedDir}"}).`,
				},
			],
			details: {
				mode,
				domain,
				dirName,
				guide: guide.shortName,
				stagedDir,
				...(helperPath === undefined ? {} : { helperPath }),
				...(verifyPath === undefined ? {} : { verifyPath }),
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("api-scaffold "))];
		parts.push(theme.fg("accent", `"${args.domain}"`));
		if (args.verify && args.helper) parts.push(theme.fg("dim", "🛠"));
		else if (args.verify) parts.push(theme.fg("dim", "🔑"));
		else if (args.helper) parts.push(theme.fg("dim", "🧩"));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Scaffolding…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) {
			return new Text(theme.fg("error", `⚠ ${contentText(result, "?")}`), 0, 0);
		}
		const mode = d?.mode as string | undefined;
		const domain = d?.domain as string | undefined;
		const dirName = d?.dirName as string | undefined;
		const stagedDir = d?.stagedDir as string | undefined;
		const disambig = d?.disambiguation as number | undefined;

		let text: string;
		if (mode === "menu" && domain) {
			text = theme.fg("dim", theme.bold("📖 menu"));
			text += ` — ${disambig ?? "?"} guides for ${domain}`;
		} else {
			text = theme.fg("accent", theme.bold(`🛠 ${dirName ?? "?"}`));
			text += ` — ${mode ?? "scaffold"} → ${stagedDir ?? "?"}`;
		}
		return new Text(appendFooter(text, expanded, result, theme, 600), 0, 0);
	},
});
