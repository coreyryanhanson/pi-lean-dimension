/**
 * api-guide tool definition.
 *
 * Mirrors portal's `web-guide`:
 *  - No params → catalog of all guides (collapsed by `organization:`, healthy + ⚠ malformed).
 *  - `{domain}` → one match: detailed guide; multiple matches: disambiguation menu.
 *  - `{domain, guide}` → detailed guide selected by shortName (exact, case-insensitive).
 */

import {
	defineTool,
	type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { appendFooter, contentText } from "./utils.js";
import {
	loadAllGuides,
	findGuidesByDomain,
	getCatalogText,
} from "../core/guide-store.js";
import { formatGuideListings, TODAY } from "../core/parse-api-guide.js";
import { authStatusLine, canonicalStoreDomain } from "../core/auth.js";
import type { ApiGuide } from "../core/api-guide-types.js";

export const apiGuideTool = defineTool({
	name: "api-guide",
	label: "API Guide",
	description:
		"Get navigation guidance for a REST API. " +
		"Call with a domain (e.g. 'boe.es') for a guide's detailed operation list, " +
		"or with no parameter to list all available API guides.",

	parameters: Type.Object({
		domain: Type.Optional(
			Type.String({
				description:
					"Domain to look up (e.g. 'boe.es'). Omit to list all API guides.",
			}),
		),
		guide: Type.Optional(
			Type.String({
				description:
					"When multiple guides exist for a domain, select one by shortName " +
					"(shown in the disambiguation menu). Omit to list all matches.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { domain, guide: guideSelector } = params as {
			domain?: string;
			guide?: string;
		};

		if (!domain) {
			const guideCount = Object.keys(loadAllGuides().guides).length;
			return {
				content: [{ type: "text", text: getCatalogText() }],
				details: { guideCount },
			};
		}

		const matches = findGuidesByDomain(domain);
		if (matches.length === 0) {
			const known = Object.keys(loadAllGuides().guides);
			return {
				content: [
					{
						type: "text",
						text:
							`No API guide for '${domain}'.` +
							(known.length > 0 ? ` Known guides: ${known.join(", ")}.` : "") +
							"\n\nCall api-guide with no params to list all guides, or api-learn({domain, recipe}) to author one.",
					},
				],
				details: {},
			};
		}

		// `guide` selector: resolve by shortName exact, case-insensitive.
		// No substring fallback — exact match is sufficient for v1 and avoids
		// the unambiguous-or-error branch the substring path forces.
		if (guideSelector) {
			const lc = guideSelector.toLowerCase();
			const selected = matches.filter(
				(m) => m.guide.shortName.toLowerCase() === lc,
			);
			if (selected.length === 0) {
				const valid = matches.map((m) => m.guide.shortName).join(", ");
				return {
					content: [
						{
							type: "text",
							text:
								`No guide named '${guideSelector}' for '${domain}'. ` +
								`Available guides: ${valid}. ` +
								`Call api-guide({domain: "${domain}"}) to see the menu.`,
						},
					],
					details: {
						error: "no_guide_by_shortname",
						domain,
						guide: guideSelector,
					},
				};
			}
			if (selected.length > 1) {
				const dirs = selected.map((s) => s.dirName).join(", ");
				return {
					content: [
						{
							type: "text",
							text:
								`Ambiguous guide '${guideSelector}' for '${domain}' — ` +
								`${selected.length} guides share shortName '${guideSelector}' ` +
								`(directories: ${dirs}). Rename one guide's shortName to ` +
								`disambiguate. Call api-guide({domain: "${domain}"}) to see the menu.`,
						},
					],
					details: {
						error: "ambiguous_shortname",
						domain,
						guide: guideSelector,
						directories: selected.map((s) => s.dirName),
					},
				};
			}
			return renderGuideDetail(selected[0]!.guide, domain);
		}

		if (matches.length === 1) {
			return renderGuideDetail(matches[0]!.guide, domain);
		}

		// Multiple guides for one domain → disambiguation menu.
		return renderDisambiguationMenu(domain, matches);
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("api-guide "))];
		if (args.domain) {
			parts.push(theme.fg("accent", `"${args.domain}"`));
			if (args.guide) parts.push(theme.fg("dim", `› ${args.guide}`));
		} else {
			parts.push(theme.fg("dim", "(catalog)"));
		}
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Loading…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;

		const guideName = d?.guide as string | undefined;
		const opCount = d?.operations as number | undefined;
		const guideCount = d?.guideCount as number | undefined;
		const disambig = d?.disambiguation as number | undefined;

		let text: string;
		if (disambig !== undefined) {
			text = theme.fg("dim", theme.bold("📖 menu"));
			text += ` — ${disambig} guides for ${d?.domain ?? "?"}`;
		} else if (guideName && opCount !== undefined) {
			text = theme.fg("accent", theme.bold(`📖 ${guideName}`));
			text += ` — ${opCount} operations`;
		} else if (guideCount === undefined) {
			text = theme.fg("dim", "📖 No guide");
		} else {
			text = theme.fg("dim", theme.bold("📖 catalog"));
			text += ` — ${guideCount} guides`;
		}

		return new Text(appendFooter(text, expanded, result, theme, 800), 0, 0);
	},
});

// ════════════════════════════════════════════════════════════════════
// Detail + disambiguation renderers
// ════════════════════════════════════════════════════════════════════

/** Detailed operation list for a single resolved guide (today's render). */
function renderGuideDetail(
	guide: ApiGuide,
	domain: string,
): AgentToolResult<unknown> {
	const lines: string[] = [];
	lines.push(`${guide.icon} ${guide.shortName} — API guide`);
	lines.push(`  Domains: ${guide.domains?.join(", ") ?? "—"}`);
	lines.push(`  Host: ${guide.apiHost}`);
	lines.push(`  Verified: ${guide.verified} · Updated: ${guide.updated}`);
	if (guide.docs) lines.push(`  Docs: ${guide.docs}`);
	lines.push(`  Auth: ${guide.auth.kind}`);
	// Auth status footer — shared with api-fetch. Metadata only (names,
	// never values); nudges provisioning when a required secret is absent.
	// Keyed on the canonical store domain, not the routing `domain`.
	const authStatus = authStatusLine(guide.auth, canonicalStoreDomain(guide));
	if (authStatus) lines.push(`  ${authStatus}`);
	lines.push(
		`  Response: ${guide.responseShape.format} (${guide.responseShape.charset})`,
	);
	if (guide.pagination) {
		lines.push(`  Pagination: ${guide.pagination.style}`);
		lines.push(`    Items path: ${guide.pagination.itemsPath}`);
	}
	lines.push("");
	lines.push("Operations:");
	for (const op of guide.operations) {
		lines.push(`  ${op.name}`);
		lines.push(`    via: ${op.via}`);
		lines.push(`    path: ${op.path}`);
		// Path-param docs — `{token}` semantics (format, example values).
		// Declared as `params.<token>.description`; shown next to the path
		// line since the token lives in the path, not the query string.
		if (op.pathParamDocs && Object.keys(op.pathParamDocs).length > 0) {
			for (const [token, desc] of Object.entries(op.pathParamDocs)) {
				lines.push(`      {${token}}: ${desc.replace(/\s+/g, " ").trim()}`);
			}
		}
		const pathParamSet = new Set(op.pathParams);
		const qParams = Object.entries(op.params).filter(
			([k]) => !pathParamSet.has(k),
		);
		if (qParams.length > 0) {
			const rendered = qParams.map(([k, spec]) => {
				const parts = [k];
				if (spec.required) parts.push("required");
				if (spec.default !== undefined)
					parts.push(`default ${JSON.stringify(spec.default)}`);
				return parts.join(" ");
			});
			lines.push(`    params: ${rendered.join(", ")}`);
			// Per-param hints (format, semantics) — these are the model's
			// primary guidance for shaping values, so they get their own lines.
			for (const [k, spec] of qParams) {
				if (spec.description) {
					lines.push(`      ${k}: ${spec.description.replace(/\s+/g, " ").trim()}`);
				}
			}
		}
		if (op.via === "paginate") {
			const pagCfg = op.pagination ?? guide.pagination;
			if (pagCfg) {
				const bits: string[] = [pagCfg.style];
				if (pagCfg.pageParam) bits.push(pagCfg.pageParam);
				if (pagCfg.pageSizeParam)
					bits.push(`${pagCfg.pageSizeParam}=${pagCfg.pageSize ?? 50}`);
				if (pagCfg.base !== undefined) bits.push(`base=${pagCfg.base}`);
				lines.push(`    pagination: ${bits.join(" ")}`);
			}
		}
	}
	lines.push("");
	lines.push(
		`Call api-fetch({domain: "${domain}", operation: "<name>", params: {...}}) to execute.`,
	);

	// Surface the guide's prose (date formats, query semantics, field
	// lists, etc.) — this is the author's documentation and otherwise
	// never reaches the model via api-guide. Capped at the same inline
	// budget api-fetch uses (INLINE_LIMIT) so a typical guide fits whole;
	// longer prose spills with a pointer rather than flooding context.
	if (guide.content) {
		const PROSE_LIMIT = 4000;
		const prose = guide.content.trim();
		lines.push("");
		lines.push("— Guide notes —");
		if (prose.length <= PROSE_LIMIT) {
			lines.push(prose);
		} else {
			lines.push(prose.slice(0, PROSE_LIMIT));
			lines.push(`… (${prose.length - PROSE_LIMIT} more chars omitted)`);
		}
	}

	const currentDate = TODAY();
	lines.push(
		`\n_Guide updated: ${guide.updated} · Current date: ${currentDate} · Source: ${guide.source}_`,
	);

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			guide: guide.shortName,
			domains: guide.domains,
			apiHost: guide.apiHost,
			operations: guide.operations.length,
		},
	};
}

/**
 * Disambiguation menu for a domain claimed by more than one guide. Lists
 * each guide's shortName (+ description when present) and a truncated op-name
 * summary; the org header shows only when all matches share one organization.
 */
function renderDisambiguationMenu(
	domain: string,
	matches: { guide: ApiGuide; dirName: string }[],
): AgentToolResult<unknown> {
	const orgs = new Set(
		matches.map((m) => m.guide.organization).filter((o): o is string => !!o),
	);
	const orgName = [...orgs][0];
	const orgPart =
		orgs.size === 1 && orgName ? ` (organization: ${orgName})` : "";
	const lines: string[] = [];
	lines.push(`${matches.length} API guides for '${domain}'${orgPart}:`);
	lines.push(formatGuideListings(matches));
	const example = matches[0]!.guide.shortName;
	lines.push(
		`Call api-guide({domain: "${domain}", guide: "${example}"}) for details.`,
	);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { domain, disambiguation: matches.length },
	};
}
