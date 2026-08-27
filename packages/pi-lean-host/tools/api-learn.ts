/**
 * api-learn tool definition.
 *
 * Authoring entry points:
 *  - `{domain, new: true}` → fresh template with `domains: [<domain>]`
 *    pre-filled (regardless of existing guides).
 *  - `{domain}` (no dir) → fetch the current raw recipe of an existing
 *    guide (0 guides → template; 1 guide → raw recipe + dirName surfaced;
 *    N guides → disambiguation menu by shortName), staged to
 *    `/tmp/pi-lean-host/<slug(shortName)>/` (guide.md + present siblings).
 *  - `{domain, dir}` → reads the staged directory (guide.md required,
 *    helper.ts / verify.json siblings mirrored), validates via
 *    `parseApiGuide()`, writes to
 *    `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/` —
 *    the write target is a function of the guide's own `shortName`, never
 *    the `domain` arg (the arg is cosmetic on the save branch).
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
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
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
import { assertSafeDomain, slug } from "../core/path-template.js";

// ═══════════════════════════════════════════════════════════════════
// Staged working copy (/tmp) — the draft the agent edits between saves
// ═══════════════════════════════════════════════════════════════════

let _stagingRoot = join(tmpdir(), "pi-lean-host");

/** Test override — mirrors `setUserGuidesDir` so tests keep drafts out of
 * the real /tmp root. */
export function setStagingRoot(dir: string): void {
	_stagingRoot = dir;
}

/** Deterministic staged dir: `<root>/<key>/`. The key is the requested
 * `domain` for templates (placeholder shortName) and `slug(shortName)` for
 * fetched recipes (which is the on-disk dirName). */
function stagingDirFor(key: string): string {
	return join(_stagingRoot, key);
}

/** True when `p` is a staged dir under the staging root (the root itself
 * excluded — save must never try to rename the whole root). */
function isUnderStagingRoot(p: string): boolean {
	return p !== _stagingRoot && p.startsWith(`${_stagingRoot}${sep}`);
}

/** Write the working copy (template or fetched raw recipe) to the staged
 * dir. Returns the staged *dir* path (multi-file — siblings write to the
 * same dir). */
function writeStagedDraft(key: string, raw: string): string {
	const dir = stagingDirFor(key);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), raw, "utf-8");
	return dir;
}

/** Sibling artifact names mirrored between the staged dir and the guides
 * dir on save (guide.md is always written). The helper extension set mirrors
 * core/local-helpers.ts's `findHelperFile` resolution (.ts → .mjs → .js). */
const SIBLING_NAMES = [
	"helper.ts",
	"helper.mjs",
	"helper.js",
	"verify.json",
] as const;

// ═══════════════════════════════════════════════════════════════════
// Placeholder skeleton (retired worked example)
// ═══════════════════════════════════════════════════════════════════

/** Max length for `description:` enforced on the write path (strict-on-write,
 * lenient-on-read — the loader accepts any length). One-liner, not prose. */
const DESCRIPTION_MAX = 200;

/** Commented static-key auth block — the issue-#5 auth-wiring teaching,
 * API-agnostic, kept after the worked example retired. Nested SecretRef
 * shape (v1): each ref is self-contained (secret + optional prefix/optional). */
const STATIC_KEY_BLOCK = `  # Keyed API? Use kind: static-key — values live in the secrets store (/api secrets), never in the recipe:
  #   kind: static-key
  #   secretRefs:
  #     Authorization:                # header name
  #       secret: <secret-name>       # store name (must match /api secrets)
  #       prefix: "Bearer "           # optional — prepended at fetch time
  #       optional: false             # optional refs don't fail closed when absent`;

/** Placeholder starter template — only `domains:` is real (the requested
 * domain). Every other field is a placeholder the agent fills (op blocks
 * sourced from api-probe({apiHost, path})). Fails closed: an unsaved,
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
# api-probe({apiHost, path}) (it drafts real ops with real values):
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
 * `static-key · Authorization ← secret apiKey (Bearer )` or
 * `oauth2 · grant client_credentials · clientId ← secret client_id`. */
function authSummary(auth: AuthConfig): string {
	const parts: string[] = [];
	switch (auth.kind) {
		case "static-key":
			for (const [header, ref] of Object.entries(auth.secretRefs ?? {})) {
				parts.push(
					`${header} ← secret ${ref.secret}${ref.prefix ? ` (${ref.prefix})` : ""}`,
				);
			}
			for (const [param, ref] of Object.entries(auth.secretQueryRefs ?? {})) {
				parts.push(`?${param} ← secret ${ref.secret}`);
			}
			break;
		case "oauth2":
			parts.push(
				`grant ${auth.grant} · clientId ← secret ${auth.clientId.secret}` +
					(auth.clientSecret
						? ` · clientSecret ← secret ${auth.clientSecret.secret}`
						: ""),
			);
			for (const [header, ref] of Object.entries(auth.secretRefs ?? {})) {
				parts.push(
					`${header} ← secret ${ref.secret}${ref.prefix ? ` (${ref.prefix})` : ""}`,
				);
			}
			break;
		case "none":
			break;
		default: {
			const _exhaustive: never = auth;
			throw new Error(`Unhandled auth kind: ${_exhaustive}`);
		}
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
	"   api-probe({apiHost, path}) — it drafts a YAML operation block ",
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
	`  \`requiresAnyOf\` — [param, ...] — at least one of these params must be supplied (one group per op). Use it when the API identifies a resource by exactly one of several interchangeable params and rejects them together (id XOR symbol XOR slug — the "exclusive peers" 400). Members may not be \`required: true\` NOR carry a \`default\` (both parser-enforced) — a default would always fire alongside a caller-supplied sibling and cause the conflict. Use \`required: true\` for a single-param constraint; \`requiresAnyOf\` is for two or more interchangeable params`,
	`  \`passthrough\` — true → forward undeclared caller params onto the query string`,
	`  \`parse\`       — op-level responseShape override (format/charset) for this operation`,
	"",
	"## Auth",
	`  \`kind: static-key\` — keyed-header auth mode (values live in the secrets store, never in the recipe):`,
	`  \`kind: oauth2\` — OAuth2 (client_credentials / authorization_code); token minting via /api oauth <domain>. ALL oauth2 credentials are store names, never literals — a shippable guide must not bake in one app's registration:`,
	`    \`clientId\`        — { secret: <store name> } — the client id's secrets-store name (e.g. clientId: { secret: client_id })`,
	`    \`clientSecret\`    — { secret: <store name> } — parser-required for client_credentials; absent for authorization_code (PKCE public clients)`,
	`    \`secretRefs\`      — { <request header>: { secret: <store name>, prefix?, optional? } } — headers merged alongside the Bearer token (e.g. Twitch's Client-Id)`,
	"  static-key (keyed APIs):",
	`    \`secretRefs\`      — { <header name>: { secret: <store name>, prefix?, optional? } }  ← self-contained ref`,
	`    \`secretQueryRefs\` — { <query param>: { secret: <store name>, optional? } }  ← query-param injection`,
	`    \`optional: true\` on a ref → proceeds unauthenticated if absent; default (required) → fail-closed. Values live in the secrets store; the store name must match /api secrets exactly.`,
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
	"## Saving (mirror-save)",
	"  Save reads every staged file (guide.md + helper.ts + verify.json when present) and",
	"  mirrors it into the guides dir. A sibling present in the guides dir but absent from",
	"  the staged /tmp dir would be DELETED — save refuses and names it; re-call with",
	"  confirmDeletions: true to proceed (that flag is discovered only via the refusal message,",
	"  never the tool description). A guide declaring helper: true / transform: true must",
	"  have a loadable staged helper.ts.",
	"",
	"Call api-learn({domain: '<domain>', dir: '<staged dir>'}) to save the guide, then test each op via api-fetch({domain, operation, params: <your verify.json values>}) — pass the values yourself; verify.json feeds /api verify (the user's batch stamp), not api-fetch.",
].join("\n");

/** Template path — write the placeholder skeleton to the staging dir and
 * surface the guide.md path + staged dir (the agent edits the file, not an
 * inline copy).
 * Fail-closed: the as-is template cannot save (placeholder `apiHost`
 * is rejected by requireHttpUrl). */
function stageTemplate(domain: string): string {
	const dir = writeStagedDraft(domain, placeholderSkeleton(domain));
	return (
		AUTHORING_MANUAL +
		"\n\n" +
		`📝 Template for '${domain}' written to ${join(dir, "guide.md")}\n` +
		`  Edit the file (or append ops via bash), then call ` +
		`api-learn({domain: "${domain}", dir: "${dir}"}) to validate and save.\n` +
		`  Re-fetching or re-templating this domain replaces the staged draft — save first to keep edits.`
	);
}

/** Fetch-recipe response — the saved guide's raw recipe (and present
 * siblings) staged to the staging dir, with the dir path + resolved dirName
 * surfaced. Staging keys on `slug(shortName)` (the on-disk dirName in steady
 * state), and the re-save self-keys off the draft's own shortName — no
 * "pass the directory name as domain" guidance (that arg is cosmetic on
 * save). The inline YAML block is dropped: the staged files are the source
 * of truth the agent edits. */
function stageFetchedRecipe(
	domain: string,
	guide: ApiGuide,
	dirName: string,
): AgentToolResult<unknown> {
	const sourceDir = join(getUserGuidesDir(), dirName);
	const stagedKey = slug(guide.shortName);
	const stagedDir = stagingDirFor(stagedKey);
	mkdirSync(stagedDir, { recursive: true });
	// guide.md always; helper.ts / verify.json when present.
	writeFileSync(
		join(stagedDir, "guide.md"),
		readFileSync(join(sourceDir, "guide.md"), "utf-8"),
		"utf-8",
	);
	const stagedSiblings: string[] = [];
	for (const name of SIBLING_NAMES) {
		const src = join(sourceDir, name);
		if (existsSync(src)) {
			writeFileSync(join(stagedDir, name), readFileSync(src, "utf-8"), "utf-8");
			stagedSiblings.push(name);
		}
	}
	return {
		content: [
			{
				type: "text",
				text:
					AUTHORING_MANUAL +
					"\n\n" +
					`📖 Current recipe for '${domain}' — guide '${guide.shortName}'\n` +
					`  Directory: ${dirName}\n` +
					`  Staged dir: ${stagedDir}\n` +
					(stagedSiblings.length > 0
						? `  Siblings staged: ${stagedSiblings.join(", ")}\n`
						: "") +
					`  To edit: edit the staged files with the edit tool or bash, then call ` +
					`api-learn({domain: "${domain}", dir: "${stagedDir}"}) — the guide ` +
					`saves to its own \`${stagedKey}\` folder (self-keyed by shortName).\n` +
					`  Re-fetching or re-templating this domain replaces the staged draft — save first to keep edits.`,
			},
		],
		details: {
			mode: "fetch",
			domain,
			dirName,
			guide: guide.shortName,
			stagedDir,
		},
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
		"Call with {domain} and no dir to fetch an existing guide's current raw recipe (and its sibling files). " +
		"Call with {domain, dir} to validate and save.\n\n" +
		"Authoring order (follow this to avoid the common mis-ordering):\n" +
		"1. (optional) api-probe({apiHost, path, params}) — discover a not-yet-guided endpoint's shape and draft an op block from the docs/example.\n" +
		"2. api-learn({domain, new: true}) — get a fresh template, fill the recipe, then api-learn({domain, dir}) to save it.\n" +
		"3. ONLY after the guide is saved: api-scaffold({domain, verify: true | helper: true}) — scaffold reads the SAVED guide, so scaffold-before-save fails. Fill the staged verify.json / helper.ts, then api-learn({domain, dir}) to save the siblings.\n" +
		"4. Test each op: api-fetch({domain, operation, params: <your verify.json values>}) — verify.json feeds /api verify, not api-fetch, so pass the values yourself. Fix via api-learn({domain}) → edit staged → api-learn({domain, dir}). /api verify is the user's batch attestation stamp (runs every op + stamps verified:).\n" +
		"Staged drafts live in /tmp/pi-lean-host/<slug(shortName)>/; the save target is self-keyed by the guide's shortName, never the domain arg.",

	parameters: Type.Object({
		domain: Type.String({
			description:
				"Domain (e.g. 'example.com'). With no dir it's the routing domain " +
				"for fetch-recipe lookup; with `dir` it's display/error context only — " +
				"the guide saves to its own slug(shortName) folder.",
		}),
		dir: Type.Optional(
			Type.String({
				description:
					"Path to the staged directory (written by a prior api-learn fetch/template or api-scaffold call to /tmp/pi-lean-host/<slug(shortName)>/). " +
					"guide.md is read, validated, and saved; present helper.ts / verify.json siblings are mirrored. " +
					"Omit to fetch the current raw recipe of an existing guide (or get a template when none exists).",
			}),
		),
		guide: Type.Optional(
			Type.String({
				description:
					"When a domain claims multiple guides, select one by shortName (shown in the disambiguation menu). " +
					"Only used with the fetch-recipe path (no dir).",
			}),
		),
		new: Type.Optional(
			Type.Boolean({
				description:
					"true → return a fresh domain-specific template (domains pre-filled) regardless of existing guides. " +
					"Does not touch any existing guide.",
			}),
		),
		// Undescribed by design — the only discovery path is the deletion-safety
		// gate's refusal message.
		confirmDeletions: Type.Optional(Type.Boolean()),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const {
			domain,
			dir,
			guide: guideSelector,
			new: isNew,
			confirmDeletions,
		} = params as {
			domain: string;
			dir?: string;
			guide?: string;
			new?: boolean;
			confirmDeletions?: boolean;
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

		// ── No dir → fetch-recipe ──────────────────────────────
		// 0 guides → template staged; 1 guide → raw recipe + siblings staged +
		// dirName surfaced; N guides → disambiguation menu (guide selector
		// resolves it).
		if (!dir || !dir.trim()) {
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

		// ── Save from a staged directory ────────────────────────
		// Read guide.md (required) from the staged dir, then run the identical
		// validate → stamp → write path. A missing/unreadable dir is a clear
		// error; guides dir untouched.
		let recipe: string;
		try {
			recipe = readFileSync(join(dir, "guide.md"), "utf-8");
		} catch {
			return {
				content: [
					{
						type: "text",
						text:
							`⚠ Could not read staged guide from '${join(dir, "guide.md")}' — guide was NOT saved.\n` +
							`  Fetch the current recipe first via api-learn({domain: "${domain}"}) ` +
							`(or a template with {domain, new: true}), then edit the staged files and save with dir.`,
					},
				],
				details: { error: "staged_dir_unreadable", domain, dir },
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

		// Save target — a function of the guide's own `shortName`, never the
		// `domain` arg. Two guides with different shortNames physically cannot
		// share a directory. An empty/all-symbol shortName throws here (the
		// slug flattens to empty) — refuse with a prescriptive error before
		// any write.
		let slugged: string;
		try {
			slugged = slug(parsed.guide.shortName);
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text:
							`⚠ Invalid shortName — guide was NOT saved.\n` +
							`  ${err instanceof Error ? err.message : `shortName '${parsed.guide.shortName}' does not slug to a directory name.`}\n` +
							`  Set a valid shortName (lowercase letters, digits, and '-') in the recipe and save again.`,
					},
				],
				details: { error: "invalid_shortname", domain },
			};
		}

		// ── Staged-dir collision guard (drift guard, part 1) ──
		// The template stages by `domain` (shortName is still a placeholder at
		// that point), but every later stage (fetch-recipe, scaffold) keys by
		// `slug(shortName)`. When the draft's staged dir basename doesn't match
		// its slug, the save re-stages it to the canonical slug dir (part 2).
		// Before that, refuse if the canonical dir already holds a guide.md
		// with a DIFFERENT shortName — a divergent save would clobber another
		// guide's staged recipe (e.g. a shortName copied from another guide).
		// Same shortName = legitimate update of this guide's own draft; no
		// guide.md = only scaffold siblings, safe to re-stage beside them.
		const canonicalStaged = stagingDirFor(slugged);
		const divergent = basename(dir) !== slugged && isUnderStagingRoot(dir);
		if (divergent && existsSync(join(canonicalStaged, "guide.md"))) {
			const existing = parseApiGuide(
				readFileSync(join(canonicalStaged, "guide.md"), "utf-8"),
				{ filename: slugged },
			);
			const existingShort = existing.ok ? existing.guide.shortName : undefined;
			if (existingShort !== parsed.guide.shortName) {
				return {
					content: [
						{
							type: "text",
							text:
								`⚠ Save refused — '${canonicalStaged}/guide.md' already holds ${existing.ok ? `a different guide ('${existing.guide.shortName}')` : "an unparseable guide"} — not the incoming '${parsed.guide.shortName}'.\n` +
								`  Your draft is staged at '${dir}', but its shortName slugs to '${canonicalStaged}', which already holds staged files${existing.ok ? " for another guide" : ""}.\n` +
								`  Resolve the collision, then save again:\n` +
								`    - If this is a new guide, change \`shortName\` so it slugs to a distinct directory.\n` +
								`    - If you're re-authoring this guide, delete the staged files in '${canonicalStaged}' (or move your draft there), then save.\n` +
								`  Guides dir untouched.`,
						},
					],
					details: {
						error: "staged_dir_collision",
						domain,
						dir,
						canonicalStaged,
						existing: existingShort ?? null,
						incoming: parsed.guide.shortName,
					},
				};
			}
		}

		// Collision detection — another guide (different directory) already
		// claims one of this guide's `domains:` keys. Valid (that's the whole
		// point of multi-recipe), but warn so the author knows they're in
		// disambiguation territory. Updating the same directory (same slug) is
		// NOT a collision. Names both the directory and the colliding `domains:`
		// key so the routing-vs-identity distinction is explicit.
		const warnings: string[] = [];
		const collidingDomains: string[] = [];
		const collidingDirs: string[] = [];
		for (const d of parsed.guide.domains ?? []) {
			const existing = findGuidesByDomain(d);
			for (const m of existing) {
				if (m.dirName !== slugged && !collidingDirs.includes(m.dirName)) {
					collidingDirs.push(m.dirName);
				}
			}
			if (existing.some((m) => m.dirName !== slugged)) {
				collidingDomains.push(d);
			}
		}
		if (collidingDomains.length > 0) {
			const keys = collidingDomains.join(", ");
			warnings.push(
				`⚠ Multi-recipe: writing to directory \`${slugged}\`, but \`domains:\` declares [${keys}] which another guide already claims — disambiguation menu applies. Give each guide a distinct \`shortName\`.`,
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
		// identity anchor. Since the write target is slug(shortName), a
		// pre-existing guide.md there with a DIFFERENT shortName is reachable
		// only via a slug collision — refuse and teach the rename-shortName
		// convention. Same shortName = legitimate update, proceeds.
		const guidesDir = getUserGuidesDir();
		const domainDir = join(guidesDir, slugged);
		const filepath = join(domainDir, "guide.md");
		if (existsSync(filepath)) {
			const existing = parseApiGuide(readFileSync(filepath, "utf-8"), {
				filename: slugged,
			});
			const existingShort = existing.ok ? existing.guide.shortName : undefined;
			if (existingShort !== parsed.guide.shortName) {
				return {
					content: [
						{
							type: "text",
							text:
								`⚠ Refusing to overwrite — guide was NOT saved.\n` +
								`  Directory '${slugged}' already holds guide '${existingShort ?? "?"}' (guide.md); ` +
								`the incoming guide is '${parsed.guide.shortName}'.` +
								(existing.ok
									? `\n  Both shortNames slug to the same directory ('${slugged}') — a slug collision. Rename the incoming guide's \`shortName\` so it slugs to a distinct directory.`
									: `\n  The existing guide.md is malformed (won't parse). If you intend to replace it, ask the user to run /api delete ${slugged} first.`),
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
		// ── Deletion-safety gate ────────────────────────────────
		// Mirror-save can wipe a sibling silently (accidental /tmp cleanup, or
		// the same-shortName new:true case). Compute the deletion set — siblings
		// in the guides dir absent from the staged dir — and refuse unless the
		// agent confirms. `confirmDeletions` is undescribed by design; the
		// refusal message is its only discovery path.
		const stagedSiblingNames = SIBLING_NAMES.filter((n) =>
			existsSync(join(dir, n)),
		);
		const doomed = SIBLING_NAMES.filter(
			(n) => existsSync(join(domainDir, n)) && !stagedSiblingNames.includes(n),
		);
		if (doomed.length > 0 && !confirmDeletions) {
			return {
				content: [
					{
						type: "text",
						text:
							`⚠ Save refused — these sibling files exist in the guides dir but are absent from your staged /tmp dir and would be deleted: ${doomed.join(", ")}.\n` +
							`  Re-call with confirmDeletions: true to delete them, or restore them in /tmp first.`,
					},
				],
				details: { error: "deletion_refused", domain, doomed },
			};
		}

		// ── Guide↔helper validation at save time ───────────────
		// A guide that declares helper/transform usage must have a loadable
		// staged helper with the declared exports. Self-contained — does not
		// touch core/local-helpers.ts (no loadHelper/loadTransform, no
		// disabledHelpers side effects).
		const ops = parsed.guide.operations;
		const needsHelper = ops.some(
			(o) => o.helper === true || o.transform === true,
		);
		if (needsHelper) {
			const stagedHelper = SIBLING_NAMES.find(
				(n) => n.startsWith("helper.") && existsSync(join(dir, n)),
			);
			if (!stagedHelper) {
				return {
					content: [
						{
							type: "text",
							text:
								`⚠ Save refused — the guide declares helper usage (helper: true / transform: true) but no helper.ts is in the staged dir.\n` +
								`  Scaffold one via api-scaffold({domain: "${domain}", helper: true}), or remove the helper: true / transform: true declarations from the guide.`,
						},
					],
					details: { error: "helper_declared_missing_staged", domain },
				};
			}
			try {
				const mod = await import(pathToFileURL(join(dir, stagedHelper)).href);
				if (
					ops.some((o) => o.helper === true) &&
					typeof mod.default !== "function"
				) {
					return {
						content: [
							{
								type: "text",
								text:
									`⚠ Save refused — staged ${stagedHelper} has no default export, but an op declares helper: true.\n` +
									`  Uncomment the default export in the staged helper, or drop the helper: true declarations.`,
							},
						],
						details: { error: "helper_missing_default_export", domain },
					};
				}
				if (
					ops.some((o) => o.transform === true) &&
					typeof mod.transform !== "function"
				) {
					return {
						content: [
							{
								type: "text",
								text:
									`⚠ Save refused — staged ${stagedHelper} has no transform export, but an op declares transform: true.\n` +
									`  Uncomment the transform export in the staged helper, or drop the transform: true declarations.`,
							},
						],
						details: { error: "helper_missing_transform_export", domain },
					};
				}
			} catch {
				return {
					content: [
						{
							type: "text",
							text:
								`⚠ Save refused — staged ${stagedHelper} failed to load (syntax error, broken import, or top-level throw).\n` +
								`  Fix the staged helper, or remove the helper: true / transform: true declarations from the guide.`,
						},
					],
					details: { error: "helper_load_failed", domain },
				};
			}
		}

		// ── Self-correct the staged root (drift guard, part 2) ──
		// Move the draft to the canonical slug dir and read from there for the
		// rest of save. Runs after all gates pass, so a refused save never
		// mutates /tmp. When the canonical dir already exists it holds the
		// same guide's draft (or only scaffold siblings) — the collision guard
		// above refused a different guide — so merge per-file; otherwise do an
		// atomic whole-dir rename.
		let reStagedNote: string | undefined;
		// `writeDir` is the staged dir the write reads from — reassigned to the
		// canonical slug dir when the passed dir diverges (see above). `dir`
		// stays const so its earlier narrowing survives the closure captures.
		let writeDir = dir;
		if (divergent) {
			const oldName = basename(writeDir);
			try {
				if (existsSync(canonicalStaged)) {
					for (const name of readdirSync(writeDir)) {
						renameSync(join(writeDir, name), join(canonicalStaged, name));
					}
					rmSync(writeDir, { recursive: true, force: true });
				} else {
					renameSync(writeDir, canonicalStaged);
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text:
								`⚠ Could not re-stage the draft from '${writeDir}' to '${canonicalStaged}' — guide was NOT saved.\n` +
								`  ${err instanceof Error ? err.message : String(err)}\n` +
								`  Move the staged files manually (or re-fetch via api-learn({domain: "${domain}"})), then save again.`,
						},
					],
					details: { error: "restage_failed", domain, dir, canonicalStaged },
				};
			}
			writeDir = canonicalStaged;
			reStagedNote =
				`Re-staged /${oldName} → ${writeDir} (slug of shortName) — ` +
				`the staged draft moved here; edit these files from now on.`;
		}

		mkdirSync(domainDir, { recursive: true });

		// ── Write guide + mirror siblings ───────────────────────

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

		// Mirror the staged dir: present siblings overwrite the guides-dir
		// counterpart; confirmed-absent siblings are removed.
		const writtenSiblings: string[] = [];
		for (const name of stagedSiblingNames) {
			writeFileSync(
				join(domainDir, name),
				readFileSync(join(writeDir, name), "utf-8"),
				"utf-8",
			);
			writtenSiblings.push(name);
		}
		const deletedSiblings: string[] = [];
		if (confirmDeletions) {
			for (const name of doomed) {
				rmSync(join(domainDir, name), { force: true });
				deletedSiblings.push(name);
			}
		}
		invalidateCache(); // next api-fetch / api-guide read picks it up

		const opCount = parsed.guide.operations.length;
		const opNames = parsed.guide.operations.map((o) => o.name).join(", ");

		const warningBlock = warnings.length > 0 ? warnings.join("\n") + "\n\n" : "";

		return {
			content: [
				{
					type: "text",
					text:
						`📖 Guide saved to ~/.pi/agent/pi-lean-host/api-guides/${slugged}/guide.md\n` +
						`  Directory: ${slugged}\n` +
						`  Operations: ${opCount} — ${opNames}\n` +
						`  ${authSummary(parsed.guide.auth)}\n` +
						`  Verified: ${parsed.guide.verified}\n` +
						`  Schema version: ${GUIDE_SCHEMA_VERSION}\n` +
						(writtenSiblings.length > 0
							? `  Written: ${writtenSiblings.join(", ")}\n`
							: "") +
						(deletedSiblings.length > 0
							? `  Deleted: ${deletedSiblings.join(", ")}\n`
							: "") +
						(reStagedNote ? `  ${reStagedNote}\n` : "") +
						`\n` +
						warningBlock +
						`Test each op via api-fetch({domain: "${domain}", operation: "${parsed.guide.operations[0]!.name}", params: <your verify.json values>}) — pass the values yourself (verify.json feeds /api verify, not api-fetch). /api verify is the user's batch stamp.` +
						`\n⚠ Edit the staged /tmp files, not the saved guide.md — direct edits to guide.md are overwritten on save and invisible to api-fetch until then.`,
				},
			],
			details: {
				mode: "saved",
				filePath: filepath,
				domain,
				operations: opCount,
				verified: parsed.guide.verified,
				...(reStagedNote ? { reStaged: true } : {}),
				...(writtenSiblings.length > 0 ? { written: writtenSiblings } : {}),
				...(deletedSiblings.length > 0 ? { deleted: deletedSiblings } : {}),
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("api-learn "))];
		parts.push(theme.fg("accent", `"${args.domain}"`));
		if (args.new) parts.push(theme.fg("dim", "✨new"));
		else if (args.dir) parts.push(theme.fg("dim", "📝"));
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
