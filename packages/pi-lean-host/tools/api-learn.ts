/**
 * api-learn tool definition.
 *
 * Validates and writes an API guide recipe.
 *  - `{domain, recipe}` → validates via `parseApiGuide()`, writes to
 *    `~/.pi/agent/pi-lean-host/api-guides/<domain>/guide.md`.
 *  - No `domain` → returns the worked-example recipe for authoring.
 *
 * No half-write on validation error (validate first, write only on success).
 * Defaults are filled by the validator before writing.
 *
 * Mirrors portal's `web-learn`.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { appendFooter, contentText } from "./utils.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseApiGuide } from "../core/parse-api-guide.js";
import {
	invalidateCache,
	getUserGuidesDir,
	assertSafeDomain,
	findGuidesByDomain,
} from "../core/guide-store.js";

// ═══════════════════════════════════════════════════════════════════
// Worked example
// ═══════════════════════════════════════════════════════════════════

/** Max length for `description:` enforced on the write path (strict-on-write,
 * lenient-on-read — the loader accepts any length). One-liner, not prose. */
const DESCRIPTION_MAX = 200;

const WORKED_EXAMPLE = `---
kind: api
domains: [boe.es, www.boe.es]
organization: boe.es          # optional — org identity across guides (registrable domain)
description: Spanish official gazette legislation API.  # optional — one-line summary; aids disambiguation
icon: ⚖️
shortName: BOE
updated: 2026-07-15
apiHost: https://apidatos.boe.es/v1
verified: 2026-07-15
docs: https://www.boe.es/datosabiertos/api/api.php
gatherAllMax: 500

auth:
  kind: none

pagination:
  style: offset-limit
  pageParam: page
  pageSizeParam: limit
  pageSize: 50
  itemsPath: data

responseShape:
  format: json
  charset: utf-8

operations:
  - name: searchDiary
    via: restGet
    path: /diario/{date}
    accept: json
    dateParams:    # normalize a date QUERY param before sending (path tokens aren't reached by dateParams)
      since: yyyy-mm-dd
    params:
      date:        # docs-only — describes the {date} path token; never a query param
        description: Diary date in yyyy-mm-dd form (e.g. 2026-07-15).
      since:
        description: Lower-bound publication date; ISO YYYY-MM-DD auto-converted to yyyy-mm-dd.
      limit:
        default: 50
    parse:
      format: xml
      charset: iso-8859-1

  - name: listConsolidada
    via: paginate
    path: /legislacion-consolidada
    accept: json
    pagination:
      style: cursor
      cursorParam: cursor
      cursorPath: pagination.nextCursor
      itemsPath: results
---
`;

// ═══════════════════════════════════════════════════════════════════
// Tool definition
// ═══════════════════════════════════════════════════════════════════

export const apiLearnTool = defineTool({
	name: "api-learn",
	label: "API Learn",
	description:
		"Save or update an API guide for a domain. " +
		"The recipe is written in YAML frontmatter format. " +
		"Call with no params to see the worked example recipe and field reference.",

	parameters: Type.Object({
		domain: Type.Optional(
			Type.String({
				description:
					"Primary domain (e.g. 'boe.es'). Used as the filename. Omit to see the worked example.",
			}),
		),
		recipe: Type.Optional(
			Type.String({
				description:
					"Full recipe string including YAML frontmatter (---\\n...\\n---) and optional prose body. Required when domain is provided.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { domain, recipe } = params as {
			domain?: string;
			recipe?: string;
		};

		// ── No domain → return worked example ────────────────────
		if (!domain) {
			const text = [
				"# Example recipe — copy, edit, and call api-learn({domain: '...', recipe: '...'})",
				"",
				"💡 For a not-yet-guided API, discover its shape first with api-probe({apiHost, path, params}) ",
				"   — it drafts a YAML operation block to paste straight into the recipe below.",
				"",
				"```yaml",
				WORKED_EXAMPLE,
				"```",
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
				`  \`apiHost\`      — base URL. \`path\` is always resolved relative to it — \`joinUrl\` strips a leading \`/\`, so \`/items\` + \`apiHost: https://host/v3\` → \`https://host/v3/items\`. Keep the version in \`apiHost\` (worked-example style) or leave it bare with the version in each \`path\` — pick one per guide; both at once doubles the segment (\`/v3/v3/items\` → 404)`,
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
				`  \`passthrough\` — true → forward undeclared caller params onto the query string`,
				`  \`parse\`       — op-level responseShape override (format/charset) for this operation`,
				"",
				"## Executor semantics",
				"  Pagination:",
				`    \`pagination.base\` seeds the page param for offset-limit/page styles (caller value wins, then \`base\`, then the param \`default\`); use \`base: 1\` for 1-based offset APIs`,
				`    The page-size param is a real knob: caller value → op param \`default\` → \`pagination.pageSize\` → 50`,
				"  Auth:",
				`    \`requires\` = fail-closed if unprovisioned; \`optional\` = proceeds unauthenticated if absent. Both are names only — values live in the secrets store.`,
				"",
				"Call api-learn({domain: '...', recipe: '...'}) to save the guide, then api-fetch({domain, operation: '...'}) to verify.",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {},
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

		// ── Validate recipe ──────────────────────────────────────
		if (!recipe || !recipe.trim()) {
			return {
				content: [
					{
						type: "text",
						text: `Recipe is required when domain is provided. Call api-learn() with no params to see the worked example.`,
					},
				],
				details: { error: "missing_recipe" },
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
			lines.push("");
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
		for (const d of parsed.guide.domains ?? []) {
			const existing = findGuidesByDomain(d);
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
		}

		// ── Write guide ──────────────────────────────────────────
		const guidesDir = getUserGuidesDir();
		const domainDir = join(guidesDir, domain);
		mkdirSync(domainDir, { recursive: true });
		const filepath = join(domainDir, "guide.md");

		writeFileSync(filepath, recipe, "utf-8");
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
						`\n` +
						warningBlock +
						`Call api-fetch({domain: "${domain}", operation: "${parsed.guide.operations[0]!.name}"}) to verify.` +
						`\n⚠ Direct edits to guide.md are ignored until the next api-learn save (per-session cache). Re-run api-learn to apply changes.`,
				},
			],
			details: {
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
			parts.push(theme.fg("dim", "📝"));
		} else {
			parts.push(theme.fg("dim", "(example)"));
		}
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Saving…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) {
			return new Text(theme.fg("error", `⚠ ${contentText(result, "?")}`), 0, 0);
		}

		const domain = d?.domain as string | undefined;
		const opCount = d?.operations as number | undefined;

		let text: string;
		if (domain && opCount !== undefined) {
			text = theme.fg("accent", theme.bold(`📝 Saved guide for ${domain}`));
			text += ` — ${opCount} ops`;
		} else {
			text = theme.fg("dim", "📝 Worked example");
		}

		return new Text(appendFooter(text, expanded, result, theme, 600), 0, 0);
	},
});
