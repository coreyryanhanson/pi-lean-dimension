/**
 * api-learn tool definition.
 *
 * Authoring entry points:
 *  - `{domain, new: true}` → fresh template with `domains: [<domain>]`
 *    pre-filled (regardless of existing guides).
 *  - `{domain}` (no recipeFile) → fetch the current raw recipe of an existing
 *    guide (0 guides → template; 1 guide → raw recipe + dirName surfaced;
 *    N guides → disambiguation menu by shortName), staged to
 *    `/tmp/pi-lean-host/<domain>/guide.md`.
 *  - `{domain, recipeFile}` → reads the staged draft, validates via
 *    `parseApiGuide()`, writes to
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseApiGuide,
	stampFrontmatterField,
	formatGuideListings,
	selectGuideByShortName,
	shortNameErrorText,
} from "../core/parse-api-guide.js";
import {
	GUIDE_SCHEMA_VERSION,
	type ApiGuide,
	type AuthConfig,
} from "../core/api-guide-types.js";
import {
	invalidateCache,
	getUserGuidesDir,
	findGuidesByDomain,
} from "../core/guide-store.js";
import { assertSafeDomain } from "../core/path-template.js";

// ═══════════════════════════════════════════════════════════════════
// Staged working copy (/tmp) — the draft the agent edits between saves
// ═══════════════════════════════════════════════════════════════════

let _stagingRoot = join(tmpdir(), "pi-lean-host");

/** Test override — mirrors `setUserGuidesDir` so tests keep drafts out of
 * the real /tmp root. */
export function setStagingRoot(dir: string): void {
	_stagingRoot = dir;
}

/** Deterministic draft path: `<root>/<domain>/guide.md`. */
function stagingPathFor(domain: string): string {
	return join(_stagingRoot, domain, "guide.md");
}

/** Write the working copy (template or fetched raw recipe) to the staging
 * path. Returns the path. */
function writeStagedDraft(domain: string, raw: string): string {
	const path = stagingPathFor(domain);
	mkdirSync(join(_stagingRoot, domain), { recursive: true });
	writeFileSync(path, raw, "utf-8");
	return path;
}

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
  #   requires: [<secret-name>]
  #   secretRefs:
  #     Authorization: <secret-name>   # header name → secret name (must match the name provisioned via /api secrets)
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
apiHost: <base url>          # REQUIRED — base URL. Version in apiHost XOR in each path — never both (/v3/v3/items → 404)
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
#     # requiresAnyOf: [id, slug, code]  # at least one of these params must be supplied
#     params:
#       id:
#         description: <what id selects>
---

# Optional agent-instruction prose goes AFTER the closing --- and is surfaced
# to the reading agent (as "Guide notes" via api-guide): date formats, auth
# caveats, field semantics, endpoint quirks. Delete this note before saving.
`;
}

/** Save-summary auth line — names the header→secret mapping (names only,
 * never values: values live in the store). e.g.
 * `static-key · Authorization ← secret apiKey (Bearer )`. */
function authSummary(auth: AuthConfig): string {
	const parts: string[] = [];
	for (const [header, secretName] of Object.entries(auth.secretRefs ?? {})) {
		const prefix = auth.headerPrefixes?.[header];
		parts.push(
			`${header} ← secret ${secretName}${prefix === undefined ? "" : ` (${prefix})`}`,
		);
	}
	for (const [param, secretName] of Object.entries(auth.secretQueryRefs ?? {})) {
		parts.push(`?${param} ← secret ${secretName}`);
	}
	return parts.length === 0
		? `Auth: ${auth.kind}`
		: `Auth: ${auth.kind} · ${parts.join(", ")}`;
}

// ═══════════════════════════════════════════════════════════════════
// Authoring manual + templates
// ═══════════════════════════════════════════════════════════════════

/** The field reference + defaults + semantics manual. Travels with the
 * pull-to-/tmp action — prepended to every staged draft (template or
 * fetched recipe) so the author sees it at the moment of authoring. */
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
	`  \`apiHost\`       — base URL. Version in apiHost XOR in each path — never both (see Key defaults)`,
	`  \`operations\`    — a LIST of operation mappings — at least one entry`,
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
	`  \`requiresAnyOf\` — [param, ...] — at least one of these params must be supplied (one group per op). Members may not be \`required: true\` — a group member is a plain optional param (verify it via a verify.json sidecar value). Use \`required: true\` for a single-param constraint; \`requiresAnyOf\` is for two or more interchangeable params`,
	`  \`passthrough\` — true → forward undeclared caller params onto the query string`,
	`  \`parse\`       — op-level responseShape override (format/charset) for this operation`,
	"",
	"## Auth",
	`  \`kind: static-key\` — keyed-header auth mode (values live in the secrets store, never in the recipe):`,
	`  \`requires\` = fail-closed if unprovisioned; \`optional\` = proceeds unauthenticated if absent. Both are names only — values live in the secrets store, and each name must match exactly the one passed to /api secrets. Each \`requires\` / \`optional\` name must also appear as a secretRefs/secretQueryRefs value (parser-enforced).`,
	"  static-key (keyed APIs):",
	`    \`secretRefs\`      — { <header name>: <secret name> }  ← header → secret direction`,
	`    \`headerPrefixes\`  — { <header>: "Bearer " }  ← scheme prefix; store holds the raw token`,
	`    \`requires\`        — [<secret-name>]  ← fail-closed if unprovisioned (literal name, must match the store)`,
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
	"Call api-learn({domain: '<domain>', recipeFile: '<staged file path>'}) to save the guide, then api-fetch({domain, operation: '...'}) to verify.",
].join("\n");

/** Template path — write the placeholder skeleton to the staging path and
 * surface the file path (the agent edits the file, not an inline copy).
 * Fail-closed: the as-is template cannot save (placeholder `apiHost`
 * is rejected by requireHttpUrl). */
function stageTemplate(domain: string): string {
	const path = writeStagedDraft(domain, placeholderSkeleton(domain));
	return (
		AUTHORING_MANUAL +
		"\n\n" +
		`📝 Template for '${domain}' written to ${path}\n` +
		`  Edit the file (or append ops via bash), then call ` +
		`api-learn({domain: "${domain}", recipeFile: "${path}"}) to validate and save.\n` +
		`  Re-fetching or re-templating this domain replaces the staged draft — save first to keep edits.`
	);
}

/** Fetch-recipe response — the saved guide's raw recipe staged to the
 * staging path, with the file path + resolved dirName surfaced so re-save
 * keys on the directory, not the routing domain (sibling-clobber
 * mitigation). The inline YAML block is dropped: the staged file is the
 * source of truth the agent edits. */
function stageFetchedRecipe(
	domain: string,
	guide: ApiGuide,
	dirName: string,
): AgentToolResult<unknown> {
	const raw = readFileSync(
		join(getUserGuidesDir(), dirName, "guide.md"),
		"utf-8",
	);
	const path = writeStagedDraft(domain, raw);
	return {
		content: [
			{
				type: "text",
				text:
					AUTHORING_MANUAL +
					"\n\n" +
					`📖 Current recipe for '${domain}' — guide '${guide.shortName}'\n` +
					`  Directory: ${dirName}\n` +
					`  Staged draft: ${path}\n` +
					`  To edit: edit the staged file with the edit tool or bash, then call ` +
					`api-learn({domain: "${dirName}", recipeFile: "${path}"}) — pass the ` +
					`directory name as \`domain\` on re-save so a sibling guide is not clobbered.\n` +
					`  Re-fetching or re-templating this domain replaces the staged draft — save first to keep edits.`,
			},
		],
		details: { mode: "fetch", domain, dirName, guide: guide.shortName },
	};
}

/** Disambiguation menu for the N-guide fetch-recipe case (mirrors
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

// ═══════════════════════════════════════════════════════════════════
// Tool definition
// ═══════════════════════════════════════════════════════════════════

export const apiLearnTool = defineTool({
	name: "api-learn",
	label: "API Learn",
	description:
		"Author an API guide for a domain. " +
		"Call with {domain, new: true} for a fresh domain-specific template. " +
		"Call with {domain} and no recipeFile to fetch an existing guide's current raw recipe. " +
		"Call with {domain, recipeFile} to validate and save.",

	parameters: Type.Object({
		domain: Type.String({
			description:
				"Domain (e.g. 'example.com'). With `recipeFile` it's the save directory; " +
				"with no recipeFile it's the routing domain for fetch-recipe lookup.",
		}),
		recipeFile: Type.Optional(
			Type.String({
				description:
					"Path to the staged draft guide file (written by a prior api-learn fetch/template call to /tmp/pi-lean-host/<domain>/guide.md). " +
					"Read, validated, and saved. Omit to fetch the current raw recipe of an existing guide (or get a template when none exists).",
			}),
		),
		guide: Type.Optional(
			Type.String({
				description:
					"When a domain claims multiple guides, select one by shortName (shown in the disambiguation menu). " +
					"Only used with the fetch-recipe path (no recipeFile).",
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
			recipeFile,
			guide: guideSelector,
			new: isNew,
		} = params as {
			domain: string;
			recipeFile?: string;
			guide?: string;
			new?: boolean;
		};

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
				content: [{ type: "text", text: stageTemplate(domain) }],
				details: { mode: "template", domain },
			};
		}

		// ── No recipeFile → fetch-recipe ─────────────────────────
		// 0 guides → template staged; 1 guide → raw recipe staged + dirName
		// surfaced; N guides → disambiguation menu (guide selector resolves it).
		if (!recipeFile || !recipeFile.trim()) {
			const matches = findGuidesByDomain(domain);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: stageTemplate(domain) }],
					details: { mode: "template", domain },
				};
			}
			if (matches.length === 1) {
				const { guide, dirName } = matches[0]!;
				return stageFetchedRecipe(domain, guide, dirName);
			}
			// N guides → disambiguation by shortName (mirrors api-guide).
			if (!guideSelector) {
				return renderFetchMenu(domain, matches);
			}
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
								`Call api-learn({domain: "${domain}"}) to see the menu.`,
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
			return stageFetchedRecipe(domain, sel.guide, sel.dirName);
		}

		// ── Save from a staged file ─────────────────────────────
		// Read the draft, then run the identical validate → stamp → write
		// path. A missing/unreadable file is a clear error; guide.md untouched.
		let recipe: string;
		try {
			recipe = readFileSync(recipeFile, "utf-8");
		} catch {
			return {
				content: [
					{
						type: "text",
						text:
							`⚠ Could not read recipe file '${recipeFile}' — guide was NOT saved.\n` +
							`  Fetch the current recipe first via api-learn({domain: "${domain}"}) ` +
							`(or a template with {domain, new: true}), then edit the staged file and save with recipeFile.`,
					},
				],
				details: { error: "recipe_file_unreadable", domain, recipeFile },
			};
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

		// ── Fail-closed overwrite guard ─────────────────────────
		// A guide.md already in the target directory is that directory's
		// identity anchor. If its shortName differs from the incoming
		// guide's, this save would silently replace a sibling guide (the
		// multi-recipe clobber bug). Refuse and teach the directory
		// convention instead. Same shortName = legitimate update, proceeds.
		const guidesDir = getUserGuidesDir();
		const domainDir = join(guidesDir, domain);
		const filepath = join(domainDir, "guide.md");
		if (existsSync(filepath)) {
			const existing = parseApiGuide(readFileSync(filepath, "utf-8"), {
				filename: domain,
			});
			const existingShort = existing.ok ? existing.guide.shortName : undefined;
			if (existingShort !== parsed.guide.shortName) {
				return {
					content: [
						{
							type: "text",
							text:
								`⚠ Refusing to overwrite — guide was NOT saved.\n` +
								`  Directory '${domain}' already holds guide '${existingShort ?? "?"}' (guide.md); ` +
								`the incoming guide is '${parsed.guide.shortName}'.` +
								(existing.ok
									? `\n  To save a SECOND guide for the same routing domain, use a distinct directory:\n` +
										`    api-learn({domain: "${domain}-${parsed.guide.shortName}", recipeFile: "${recipeFile}"})\n` +
										`  Keep \`domains: [${parsed.guide.domains?.join(", ")}]\` in the recipe for routing.`
									: `\n  The existing guide.md is malformed (won't parse). If you intend to replace it, ask the user to run /api delete ${domain} first.`),
						},
					],
					details: {
						error: "overwrite_refused",
						domain,
						existing: existingShort ?? null,
						incoming: parsed.guide.shortName,
					},
				};
			}
		}
		mkdirSync(domainDir, { recursive: true });

		// ── Write guide ──────────────────────────────────────────

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
						`  ${authSummary(parsed.guide.auth)}\n` +
						`  Verified: ${parsed.guide.verified}\n` +
						`  Schema version: ${GUIDE_SCHEMA_VERSION}\n` +
						`\n` +
						warningBlock +
						`Call api-fetch({domain: "${domain}", operation: "${parsed.guide.operations[0]!.name}"}) to verify.` +
						`\n⚠ Edit the staged /tmp file, not the saved guide.md — direct edits to guide.md are overwritten on save and invisible to api-fetch until then.`,
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
		parts.push(theme.fg("accent", `"${args.domain}"`));
		if (args.new) parts.push(theme.fg("dim", "✨new"));
		else if (args.recipeFile) parts.push(theme.fg("dim", "📝"));
		else parts.push(theme.fg("dim", "📖"));
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
		} else {
			text = theme.fg("accent", theme.bold(`📝 Saved guide for ${domain}`));
			text += ` — ${opCount} ops`;
		}

		return new Text(appendFooter(text, expanded, result, theme, 600), 0, 0);
	},
});
