/**
 * api-learn tool definition.
 *
 * Authoring entry points:
 *  - No params → authoring manual (field reference + defaults + semantics)
 *    with a pointer to `{domain, new: true}` for a domain-specific starter.
 *  - `{domain, new: true}` → fresh template with `domains: [<domain>]`
 *    pre-filled (regardless of existing guides).
 *  - `{domain}` (no recipe) → fetch the current raw recipe of an existing
 *    guide (0 guides → template; 1 guide → raw recipe + dirName surfaced;
 *    N guides → disambiguation menu by shortName).
 *  - `{domain, recipe}` → validates via `parseApiGuide()`, writes to
 *    `~/.pi/agent/pi-lean-host/api-guides/<domain>/guide.md`.
 *
 * No half-write on validation error (validate first, write only on success).
 * Defaults are filled by the validator before writing.
 *
 * Mirrors portal's `web-learn`.
 */

import {
	defineTool,
	type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { appendFooter, contentText } from "./utils.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	parseApiGuide,
	stampFrontmatterField,
	formatGuideListings,
	selectGuideByShortName,
} from "../core/parse-api-guide.js";
import {
	GUIDE_SCHEMA_VERSION,
	type ApiGuide,
} from "../core/api-guide-types.js";
import {
	invalidateCache,
	getUserGuidesDir,
	findGuidesByDomain,
} from "../core/guide-store.js";
import { assertSafeDomain } from "../core/path-template.js";

// ═══════════════════════════════════════════════════════════════════
// Placeholder skeleton (retired worked example)
// ═══════════════════════════════════════════════════════════════════

/** Max length for `description:` enforced on the write path (strict-on-write,
 * lenient-on-read — the loader accepts any length). One-liner, not prose. */
const DESCRIPTION_MAX = 200;

/** Commented static-key auth block — the issue-#5 auth-wiring teaching,
 * API-agnostic, kept after the worked example retired. */
const STATIC_KEY_BLOCK = `  # Keyed API? Use kind: static-key — values live in the secrets store (/api secrets), never in the recipe:
  #   kind: static-key
  #   requires: [apiKey]
  #   secretRefs:
  #     Authorization: apiKey        # header name → secret name
  #   headerPrefixes:
  #     Authorization: "Bearer "`;

/** Placeholder starter template — only `domains:` is real (the requested
 * domain). Every other field is a placeholder the agent fills (op blocks
 * sourced from api-probe({scaffold: true})). Fails closed: an unsaved,
 * as-is template is rejected by the parser because `apiHost: <base url>`
 * is not a valid URL — no wrong-API guide can be saved silently. */
function placeholderSkeleton(domain: string): string {
	return `---
kind: api
domains: [${domain}]
organization: <org>          # optional — org identity across guides (registrable domain)
description: <one-line summary>  # optional — one-line summary; aids disambiguation
icon: <emoji>
shortName: <short>
# updated / verified are stamped by the tool when omitted (defaults to today)
apiHost: <base url>          # REQUIRED — base URL including version prefix
# docs: <api docs url>       # optional — API documentation URL
gatherAllMax: 1000           # omitted → 1000

auth:
  kind: none
${STATIC_KEY_BLOCK}

pagination:
  style: offset-limit
  pageParam: page
  pageSizeParam: limit
  pageSize: 50
  itemsPath: results

responseShape:
  format: json
  charset: utf-8

# Add one operation per endpoint here — source the block from
# api-probe({apiHost, path, scaffold: true}) (it drafts real ops with real
# values):
# operations:
#   - name: <op>
#     via: restGet
#     path: /<path>
#     accept: json
---

# Optional agent-instruction prose goes AFTER the closing --- and is surfaced
# to the reading agent (as "Guide notes" via api-guide): date formats, auth
# caveats, field semantics, endpoint quirks. Delete this note before saving.
`;
}

// ═══════════════════════════════════════════════════════════════════
// Authoring manual + templates
// ═══════════════════════════════════════════════════════════════════

/** Bare `api-learn()` output — the field reference + defaults + semantics
 * manual. No recipe body (superseded by `{domain, new: true}`); points at
 * the template entry point. */
const AUTHORING_MANUAL = [
	"# API guide authoring manual",
	"",
	"💡 Start a new guide: call api-learn({domain: '<domain>', new: true}) — it returns a ",
	"   template with `domains` pre-filled. Discover the API's shape first with ",
	"   api-probe({apiHost, path, scaffold: true}) — it drafts a YAML operation block ",
	"   to paste into the template.",
	"",
	"## Required fields",
	`  \`domains\`       — list of domain names this guide applies to`,
	`  \`apiHost\`       — base URL including version prefix`,
	`  \`operations\`    — at least one operation mapping`,
	`  \`operations[].name\`   — unique operation name`,
	`  \`operations[].via\`    — "restGet" or "paginate"`,
	`  \`operations[].path\`   — path starting with /`,
	"",
	"## Key defaults",
	`  \`apiHost\`      — base URL. \`path\` is always resolved relative to it — \`joinUrl\` strips a leading \`/\`, so \`/items\` + \`apiHost: https://host/v3\` → \`https://host/v3/items\`. Keep the version in \`apiHost\` (e.g. \`https://api.example.com/v3\`) or leave it bare with the version in each \`path\` — pick one per guide; both at once doubles the segment (\`/v3/v3/items\` → 404)`,
	`  \`auth\`           — omitted → kind: none`,
	`  \`verified\`       — omitted → today's date`,
	`  \`docs\`           — optional API documentation URL (http/https); omitted → no docs line`,
	`  \`gatherAllMax\`   — omitted → 1000`,
	`  \`responseShape\`  — omitted → json/utf-8`,
	`  \`operation.accept\` — omitted → json`,
	"",
	"## Optional fields (multi-recipe disambiguation)",
	`  \`organization\`  — org identity across guides (use the org's registrable domain, e.g. archive.org)`,
	`  \`description\`    — one-line API summary (≤${DESCRIPTION_MAX} chars); the primary signal when several guides share a domain`,
	"",
	"## Optional fields (operation-level)",
	`  \`dateParams\`  — normalize date QUERY params before sending: map name → iso8601 | yyyymmdd | yyyy-mm-dd (path tokens are documented via params.<token>.description; core dateParams does not reach path tokens)`,
	`  \`helper\`      — true → call this domain's local helper.ts for this op`,
	`  \`transform\`   — true → run the helper.ts \`transform\` export on the parsed response`,
	`  \`params.<token>.description\` — docs-only description for a {token} path param (format, e.g. 'yyyy-mm-dd'); never sent as a query param, shown in api-guide`,
	`  \`params.<name>.required\` — true → query param must be supplied (verify skips the op if missing; api-fetch errors before the request)`,
	`  \`params.<name>.default\`  — value (any YAML scalar: string, number, boolean) used when the caller omits the param (verify runs the op with it; a \`required\`+\`default\` op is always verifiable without a verify.json sidecar)`,
	`  \`passthrough\` — true → forward undeclared caller params onto the query string`,
	`  \`parse\`       — op-level responseShape override (format/charset) for this operation`,
	"",
	"## Auth",
	`  \`requires\` = fail-closed if unprovisioned; \`optional\` = proceeds unauthenticated if absent. Both are names only — values live in the secrets store.`,
	"  static-key (keyed APIs):",
	`    \`secretRefs\`      — { <header name>: <secret name> }  ← header → secret direction`,
	`    \`headerPrefixes\`  — { <header>: "Bearer " }  ← scheme prefix; store holds the raw token`,
	`    \`requires\`        — [apiKey]  ← fail-closed if unprovisioned`,
	"",
	"## Executor semantics",
	"  Pagination:",
	`    \`pagination.base\` seeds the page param for offset-limit/page styles (caller value wins, then \`base\`, then the param \`default\`); use \`base: 1\` for 1-based offset APIs`,
	`    The page-size param is a real knob: caller value → op param \`default\` → \`pagination.pageSize\` → 50`,
	"",
	"## Guide prose (agent instructions)",
	"  After the closing `---`, optional plaintext guidance for the reading agent —",
	"  date formats, auth caveats, field semantics, endpoint quirks. Surfaced by",
	"  api-guide as 'Guide notes'.",
	"",
	"Call api-learn({domain: '...', recipe: '...'}) to save the guide, then api-fetch({domain, operation: '...'}) to verify.",
].join("\n");

/** Manual section that governs a failing parser field — the validation-error
 * closing line routes the author to the manual (gap 2). Ordered rules, first
 * match wins; undefined → generic manual pointer. Names must match the
 * `##` headings in AUTHORING_MANUAL above. */
const MANUAL_SECTION_RULES: ReadonlyArray<[RegExp, string]> = [
	[/^auth(\.|$)/, "Auth"],
	[/^operations(\[\d+\])?\.params(\.|$)/, "Optional fields (operation-level)"],
	[/^operations(\[\d+\])?\.(via|name|path)$/, "Required fields"],
	[
		/^operations(\[\d+\])?\.(dateParams|helper|transform|passthrough|parse)(\.|$)/,
		"Optional fields (operation-level)",
	],
	[/^operations(\[\d+\])?\.pagination(\.|$)/, "Executor semantics"],
	[/^pagination(\.|$)/, "Executor semantics"],
	[/^operations(\[\d+\])?\.(accept|gatherAllMax)(\.|$)/, "Key defaults"],
	[/^responseShape(\.|$)/, "Key defaults"],
	[
		/^(organization|description)$/,
		"Optional fields (multi-recipe disambiguation)",
	],
	[/^(domains|apiHost|kind|operations)$/, "Required fields"],
	[/^(verified|docs|gatherAllMax)$/, "Key defaults"],
];

function manualSectionFor(field: string): string | undefined {
	for (const [re, section] of MANUAL_SECTION_RULES) {
		if (re.test(field)) return section;
	}
	return undefined;
}

/** Domain-specific starter template — a placeholder skeleton with `domains:`
 * pre-filled for the requested domain. Other fields are placeholders the
 * agent fills (op block sourced from api-probe({scaffold: true})).
 * Fail-closed: the as-is template cannot save (placeholder `apiHost`
 * is rejected by requireHttpUrl). */
function renderTemplate(domain: string): string {
	return `\`\`\`yaml\n${placeholderSkeleton(domain)}\n\`\`\``;
}

/** Fetch-recipe response — the raw recipe wrapped for the agent, with the
 * resolved dirName surfaced so re-save keys on the directory, not the
 * routing domain (sibling-clobber mitigation). */
function renderFetchedRecipe(
	domain: string,
	guide: ApiGuide,
	dirName: string,
	raw: string,
): string {
	const body = raw.endsWith("\n") ? raw : raw + "\n";
	return (
		`📖 Current recipe for '${domain}' — guide '${guide.shortName}'\n` +
		`  Directory: ${dirName}\n` +
		`  To edit: copy the recipe below, modify it, and call ` +
		`api-learn({domain: "${dirName}", recipe: "..."}) — pass the directory name ` +
		`as \`domain\` on re-save so a sibling guide is not clobbered.\n\n` +
		"```yaml\n" +
		body +
		"```"
	);
}

/** D12 disambiguation menu for the N-guide fetch-recipe case (mirrors
 * api-guide's menu). */
function renderFetchMenu(
	domain: string,
	matches: { guide: ApiGuide; dirName: string }[],
): AgentToolResult<unknown> {
	const lines: string[] = [];
	lines.push(`${matches.length} API guides for '${domain}':`);
	lines.push(formatGuideListings(matches));
	const example = matches[0]!.guide.shortName;
	lines.push(
		`Call api-learn({domain: "${domain}", guide: "${example}"}) to fetch one guide's recipe.`,
	);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { mode: "menu", domain, disambiguation: matches.length },
	};
}

/** Read a guide's raw recipe from disk and build the fetch-recipe result
 * (dirName surfaced so re-save keys on the directory, not the routing
 * domain). Shared by the 1-guide and N-guide-with-selector branches. */
function fetchGuideRecipe(
	domain: string,
	guide: ApiGuide,
	dirName: string,
): AgentToolResult<unknown> {
	const raw = readFileSync(
		join(getUserGuidesDir(), dirName, "guide.md"),
		"utf-8",
	);
	return {
		content: [
			{ type: "text", text: renderFetchedRecipe(domain, guide, dirName, raw) },
		],
		details: { mode: "fetch", domain, dirName, guide: guide.shortName },
	};
}

// ═══════════════════════════════════════════════════════════════════
// Tool definition
// ═══════════════════════════════════════════════════════════════════

export const apiLearnTool = defineTool({
	name: "api-learn",
	label: "API Learn",
	description:
		"Author an API guide for a domain. " +
		"Call with no params for the authoring manual (field reference + defaults + semantics). " +
		"Call with {domain, new: true} for a fresh domain-specific template. " +
		"Call with {domain} and no recipe to fetch an existing guide's current raw recipe. " +
		"Call with {domain, recipe} to validate and save.",

	parameters: Type.Object({
		domain: Type.Optional(
			Type.String({
				description:
					"Domain (e.g. 'example.com'). With `recipe` it's the save directory; " +
					"with no recipe it's the routing domain for fetch-recipe lookup.",
			}),
		),
		recipe: Type.Optional(
			Type.String({
				description:
					"Full recipe string including YAML frontmatter (---\\n...\\n---) and optional prose body. " +
					"Omit to fetch the current raw recipe of an existing guide (or get a template when none exists).",
			}),
		),
		guide: Type.Optional(
			Type.String({
				description:
					"When a domain claims multiple guides, select one by shortName (shown in the disambiguation menu). " +
					"Only used with the fetch-recipe path (no recipe).",
			}),
		),
		new: Type.Optional(
			Type.Boolean({
				description:
					"true → return a fresh domain-specific template (domains pre-filled) regardless of existing guides. " +
					"Does not touch any existing guide.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const {
			domain,
			recipe,
			guide: guideSelector,
			new: isNew,
		} = params as {
			domain?: string;
			recipe?: string;
			guide?: string;
			new?: boolean;
		};

		// ── No domain → authoring manual ─────────────────────────
		if (!domain) {
			return {
				content: [{ type: "text", text: AUTHORING_MANUAL }],
				details: { mode: "manual" },
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

		// ── new: true → fresh template regardless of existing guides ──
		if (isNew) {
			return {
				content: [{ type: "text", text: renderTemplate(domain) }],
				details: { mode: "template", domain },
			};
		}

		// ── No recipe → fetch-recipe (D9) ────────────────────────
		// 0 guides → template; 1 guide → raw recipe + dirName surfaced;
		// N guides → D12 disambiguation menu (guide selector resolves it).
		if (!recipe || !recipe.trim()) {
			const matches = findGuidesByDomain(domain);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: renderTemplate(domain) }],
					details: { mode: "template", domain },
				};
			}
			if (matches.length === 1) {
				const { guide, dirName } = matches[0]!;
				return fetchGuideRecipe(domain, guide, dirName);
			}
			// N guides → disambiguation by shortName (mirrors api-guide).
			if (!guideSelector) {
				return renderFetchMenu(domain, matches);
			}
			const sel = selectGuideByShortName(matches, guideSelector);
			if (!sel.ok) {
				if (sel.reason === "no_match") {
					return {
						content: [
							{
								type: "text",
								text:
									`No guide named '${guideSelector}' for '${domain}'. ` +
									`Available guides: ${sel.valid.join(", ")}. ` +
									`Call api-learn({domain: "${domain}"}) to see the menu.`,
							},
						],
						details: {
							error: "no_guide_by_shortname",
							domain,
							guide: guideSelector,
						},
					};
				}
				return {
					content: [
						{
							type: "text",
							text:
								`Ambiguous guide '${guideSelector}' for '${domain}' — ` +
								`${sel.directories.length} guides share shortName '${guideSelector}' ` +
								`(directories: ${sel.directories.join(", ")}). Rename one guide's shortName to ` +
								`disambiguate. Call api-learn({domain: "${domain}"}) to see the menu.`,
						},
					],
					details: {
						error: "ambiguous_shortname",
						domain,
						guide: guideSelector,
						directories: sel.directories,
					},
				};
			}
			return fetchGuideRecipe(domain, sel.guide, sel.dirName);
		}

		const parsed = parseApiGuide(recipe, { filename: domain });
		if (!parsed.ok) {
			const err = parsed.error;
			const lines: string[] = [
				`⚠ Validation error — guide was NOT saved.`,
				`  Field: ${err.field}`,
				`  Expected: ${err.expected}`,
				`  Found: ${err.found}`,
			];
			if (err.fix) lines.push(`  Fix: ${err.fix}`);
			const section = manualSectionFor(err.field);
			lines.push("");
			lines.push(
				section
					? `See the \`${section}\` section of the authoring manual — call api-learn() with no params.`
					: `Call api-learn() with no params for the authoring manual.`,
			);
			lines.push("Fix the recipe and call api-learn again.");
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { error: "validation_error", field: err.field },
			};
		}

		// ── Post-parse authoring policy (strict-on-write) ───────
		// `description:` length cap. The parser validates structure only
		// (non-empty, single line); conciseness is an api-learn policy so the
		// one-parser invariant stays intact. Reject before writing.
		const desc = parsed.guide.description;
		if (desc !== undefined && desc.length > DESCRIPTION_MAX) {
			return {
				content: [
					{
						type: "text",
						text:
							`⚠ description: is too long — guide was NOT saved.\n` +
							`  Length: ${desc.length} chars (max ${DESCRIPTION_MAX}).\n` +
							`  Keep description to one line; put longer prose in the guide body (after ---).`,
					},
				],
				details: { error: "description_too_long", length: desc.length },
			};
		}

		// Collision detection — another guide (different directory) already
		// claims one of this guide's `domains:` keys. Valid (that's the whole
		// point of multi-recipe), but warn so the author knows they're in
		// disambiguation territory. Updating the same directory is NOT a
		// collision. Names both the directory and the colliding `domains:` key
		// so the routing-vs-identity distinction is explicit.
		const warnings: string[] = [];
		const collidingDomains: string[] = [];
		const collidingDirs: string[] = [];
		for (const d of parsed.guide.domains ?? []) {
			const existing = findGuidesByDomain(d);
			for (const m of existing) {
				if (m.dirName !== domain && !collidingDirs.includes(m.dirName)) {
					collidingDirs.push(m.dirName);
				}
			}
			if (existing.some((m) => m.dirName !== domain)) {
				collidingDomains.push(d);
			}
		}
		if (collidingDomains.length > 0) {
			const keys = collidingDomains.join(", ");
			warnings.push(
				`⚠ Multi-recipe: writing to directory \`${domain}\`, but \`domains:\` declares [${keys}] which another guide already claims — disambiguation menu applies. Give each guide a distinct \`shortName\`.`,
			);
			if (desc === undefined) {
				warnings.push(
					`  \`description:\` is absent — adding one is recommended when several guides share a domain (it's the primary disambiguation signal).`,
				);
			}
			warnings.push(
				`  If an existing guide is wrong, ask the user to run /api delete ${collidingDirs.join(" ")} to remove it (the agent has no delete tool).`,
			);
		}

		// ── Write guide ──────────────────────────────────────────
		const guidesDir = getUserGuidesDir();
		const domainDir = join(guidesDir, domain);
		mkdirSync(domainDir, { recursive: true });
		const filepath = join(domainDir, "guide.md");

		// Stamp schemaVersion on save — each guide records the schema vintage
		// it was authored against (the per-guide vintage that stale detection
		// compares against). Line-level frontmatter edit; comments + key order
		// preserved (no YAML round-trip).
		const stamped = stampFrontmatterField(
			recipe,
			"schemaVersion",
			String(GUIDE_SCHEMA_VERSION),
		);
		writeFileSync(filepath, stamped, "utf-8");
		invalidateCache(); // next api-fetch / api-guide read picks it up

		const opCount = parsed.guide.operations.length;
		const opNames = parsed.guide.operations.map((o) => o.name).join(", ");

		const warningBlock = warnings.length > 0 ? warnings.join("\n") + "\n\n" : "";

		return {
			content: [
				{
					type: "text",
					text:
						`📖 Guide saved to ~/.pi/agent/pi-lean-host/api-guides/${domain}/guide.md\n` +
						`  Domain: ${domain}\n` +
						`  Operations: ${opCount} — ${opNames}\n` +
						`  Auth: ${parsed.guide.auth.kind}\n` +
						`  Verified: ${parsed.guide.verified}\n` +
						`  Schema version: ${GUIDE_SCHEMA_VERSION}\n` +
						`\n` +
						warningBlock +
						`Call api-fetch({domain: "${domain}", operation: "${parsed.guide.operations[0]!.name}"}) to verify.` +
						`\n⚠ Direct edits to guide.md are ignored until the next api-learn save (per-session cache). Re-run api-learn to apply changes.`,
				},
			],
			details: {
				mode: "saved",
				filePath: filepath,
				domain,
				operations: opCount,
				verified: parsed.guide.verified,
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("api-learn "))];
		if (args.domain) {
			parts.push(theme.fg("accent", `"${args.domain}"`));
			if (args.new) parts.push(theme.fg("dim", "✨new"));
			else if (args.recipe) parts.push(theme.fg("dim", "📝"));
			else parts.push(theme.fg("dim", "📖"));
		} else {
			parts.push(theme.fg("dim", "(manual)"));
		}
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Saving…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) {
			return new Text(theme.fg("error", `⚠ ${contentText(result, "?")}`), 0, 0);
		}

		const mode = d?.mode as string | undefined;
		const domain = d?.domain as string | undefined;
		const opCount = d?.operations as number | undefined;
		const dirName = d?.dirName as string | undefined;
		const disambig = d?.disambiguation as number | undefined;

		let text: string;
		if (mode === "fetch" && dirName) {
			text = theme.fg("accent", theme.bold(`📖 ${dirName}`));
			text += " — fetched recipe";
		} else if (mode === "template" && domain) {
			text = theme.fg("accent", theme.bold(`📝 Template for ${domain}`));
		} else if (mode === "menu" && domain) {
			text = theme.fg("dim", theme.bold("📖 menu"));
			text += ` — ${disambig ?? "?"} guides for ${domain}`;
		} else if (domain && opCount !== undefined) {
			text = theme.fg("accent", theme.bold(`📝 Saved guide for ${domain}`));
			text += ` — ${opCount} ops`;
		} else {
			text = theme.fg("dim", "📝 Authoring manual");
		}

		return new Text(appendFooter(text, expanded, result, theme, 600), 0, 0);
	},
});
