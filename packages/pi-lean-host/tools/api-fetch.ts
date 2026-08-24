/**
 * api-fetch tool definition.
 *
 * Executes an API operation from a registered guide:
 *  1. Resolves all guides claiming `domain` and finds the one whose
 *     operation matches `operation` (op-name resolution across guides).
 *  2. Calls the declared helper (`restGet` / `paginate`) via the matched
 *     guide's directory name (the helper-routing key).
 *  3. Returns parsed items with a continuation handle if paginated.
 *
 * Self-correcting execute-fail: no guide for `domain` fails informingly,
 * pointing at `api-guide({})` and `/api learn`.
 *
 * No ad-hoc bare-fetch mode — every request must follow a guide.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
	HelperError,
	type RestGetResult,
	type PaginateResult,
} from "../core/helpers.js";
import { findGuidesByDomain } from "../core/guide-store.js";
import {
	resolveOpForExecution,
	type ResolveOpOptions,
	type ResolveOpResult,
} from "../core/resolve-op.js";
import { canonicalStoreDomain, containsSecret } from "../core/auth.js";
import { provisionedDomainsSuffix } from "../core/secrets-store.js";
import {
	formatGuideListings,
	staleSchemaLine,
} from "../core/parse-api-guide.js";
import { spillResponse, formatSpillNotice } from "../core/response-spill.js";
import { appendFooter, contentText } from "./utils.js";
import type { Operation, ApiGuide } from "../core/api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Test hook — bypasses the nextLink SSRF guard in `paginate`
// (127.0.0.1 / localhost are blocked in production). No-op for
// `restGet`, which no longer guards agent-supplied URLs.
// ═══════════════════════════════════════════════════════════════════

let _bypassUrlSafety = false;
export function __test__setBypassUrlSafety(v: boolean): void {
	// Inert outside the test suite so the SSRF guard can't be flipped
	// off in a production tarball.
	if (process.env.NODE_ENV !== "test") return;
	_bypassUrlSafety = v;
}

// ═══════════════════════════════════════════════════════════════════
// Tool definition
// ═══════════════════════════════════════════════════════════════════

export const apiFetchTool = defineTool({
	name: "api-fetch",
	label: "API Fetch",
	description:
		"Fetch structured data from a REST API using a recipe-based guide. " +
		"Requires an API guide for the target domain. " +
		"Call api-guide({domain}) to see available operations, or api-learn({domain, recipeFile}) to author a new guide.",

	parameters: Type.Object({
		domain: Type.String({
			description:
				"Domain registered in an API guide (e.g. 'boe.es'). Use api-guide to discover guides.",
		}),
		operation: Type.String({
			description:
				"Operation name from the guide (e.g. 'searchDiary'). Use api-guide({domain}) to list operations.",
		}),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "Path and query parameter values for the operation.",
			}),
		),
		gatherAll: Type.Optional(
			Type.Boolean({
				description:
					"When true, paginate to gather all items up to the guide's gatherAllMax ceiling.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const sessionKey = ctx?.sessionManager?.getSessionId?.() ?? "api-default";
		const { domain, operation } = params as {
			domain: string;
			operation: string;
			params?: Record<string, unknown>;
			gatherAll?: boolean;
		};

		// `gatherAll` may be passed at the tool's top level (the documented
		// position) or nested inside `params` (the natural place, since `params`
		// holds the operation arguments). Resolve both, preferring the top level,
		// and strip `gatherAll` out of the forwarded params so it can't leak onto
		// a `passthrough` query string or reach a domain helper. This must happen
		// before `executeParams` is built below.
		const rawParams = (params as Record<string, unknown>)["params"] as
			| Record<string, unknown>
			| undefined;
		const gatherAll =
			((params as Record<string, unknown>)["gatherAll"] as boolean | undefined) ??
			(rawParams?.gatherAll as boolean | undefined);
		const userParams = rawParams ? { ...rawParams } : undefined;
		if (userParams && "gatherAll" in userParams) {
			delete userParams.gatherAll;
		}

		// 1. Resolve guides by domain — a domain may be claimed by more than
		// one guide (one domain, multiple APIs). Search every match for the
		// named operation: exactly one hit executes (resolved via that guide's
		// dirName, the helper-routing key); zero lists ops from all matches; an
		// op name appearing in ≥2 guides is an ambiguous collision the authors
		// must fix (re-author via api-learn to rename). dirName diverges from
		// `domain` exactly in the multi-recipe case, so the helper is resolved
		// by dirName, not the routing param.
		const matches = findGuidesByDomain(domain);
		if (matches.length === 0) {
			return {
				content: [
					{
						type: "text",
						text:
							`No API guide for '${domain}'. ` +
							`Call api-guide({}) to list available guides, or api-learn({domain: "${domain}"}) to author a new one.`,
					},
				],
				details: { error: "no_guide", domain },
			};
		}

		const opMatches: { guide: ApiGuide; dirName: string; op: Operation }[] = [];
		for (const { guide, dirName } of matches) {
			const op = guide.operations.find((o) => o.name === operation);
			if (op) opMatches.push({ guide, dirName, op });
		}

		if (opMatches.length === 0) {
			const known = matches
				.flatMap(({ guide }) => guide.operations.map((o) => o.name))
				.join(", ");
			return {
				content: [
					{
						type: "text",
						text: `No operation '${operation}' in guide(s) for '${domain}'. Available: ${known}. Call api-guide({domain: "${domain}"}) for details.`,
					},
				],
				details: { error: "no_operation", domain, operation },
			};
		}

		if (opMatches.length > 1) {
			return {
				content: [
					{
						type: "text",
						text: formatAmbiguousOperation(domain, operation, opMatches),
					},
				],
				details: { error: "ambiguous_operation", domain, operation },
			};
		}

		const { guide, dirName: helperDirName, op } = opMatches[0]!;

		// The canonical secret-store key: `guide.domains[0]` (the plain
		// browsable domain), used for the fail-closed error below.
		const storeDomain = canonicalStoreDomain(guide);

		// Shared resolution + dispatch (callHelper + loadTransform + auth
		// resolution + executor) — see core/resolve-op.ts. api-fetch and
		// /api verify both route through it so the sequence can't drift.
		let outcome: ResolveOpResult;
		try {
			const execOpts: ResolveOpOptions = { skipSsrfGuard: _bypassUrlSafety };
			if (userParams) execOpts.userParams = userParams;
			if (gatherAll !== undefined) execOpts.gatherAll = gatherAll;
			outcome = await resolveOpForExecution(guide, op, helperDirName, execOpts);
		} catch (err) {
			if (err instanceof HelperError) {
				return {
					content: [
						{
							type: "text",
							text: formatHelperError(err, domain, operation),
						},
					],
					details: {
						error: "helper_error",
						field: err.field,
						message: err.message,
					},
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							`api-fetch failed for '${domain}' / '${operation}': ` +
							`${err instanceof Error ? err.message : String(err)}`,
					},
				],
				details: { error: "unexpected", message: String(err) },
			};
		}

		// Non-run outcomes: a session-disabled helper or a fail-closed missing
		// `requires` secret. Both return before any request is made.
		if (!outcome.ok) {
			if (outcome.reason === "helper_disabled") {
				return {
					content: [
						{
							type: "text",
							text: formatHelperDisabled(
								outcome.message,
								helperDirName,
								domain,
								operation,
							),
						},
					],
					details: {
						error: "helper_disabled",
						domain,
						operation,
					},
				};
			}
			const text =
				`🔑 ${guide.shortName} requires a secret not yet provisioned: ` +
				`${outcome.missing.join(", ")}.\n` +
				`Run /api secrets ${storeDomain} to provision it, then retry this call.` +
				provisionedDomainsSuffix(storeDomain);
			return {
				content: [{ type: "text", text }],
				details: {
					error: "auth_required_not_provisioned",
					domain,
					operation,
					missing: outcome.missing,
				},
			};
		}

		const { via, result, authFooter } = outcome;

		if (via === "restGet") {
			const r = result as RestGetResult;
			let text = formatResult(r.data, guide, op, sessionKey, r.url);
			if (r.transformWarning !== undefined) {
				text =
					`⚠ Transform failed: ${r.transformWarning}. Returning raw response.\n` +
					text;
			}
			if (gatherAll) {
				text += `\n⚠ gatherAll ignored — ${operation} is not paginated (via: restGet).`;
			}
			if (authFooter) text += `\n${authFooter}`;
			const staleNote = staleSchemaLine(guide);
			if (staleNote) text += `\n${staleNote}`;
			return {
				content: [{ type: "text", text }],
				details: {
					domain,
					operation,
					shortName: guide.shortName,
					via: "restGet",
					request: { method: "GET", url: r.url, params: r.params },
					// Output-channel audit: drop response headers that echo a known
					// secret value (an auth-bearing server must not leak the key).
					headers: scrubSecretHeaders(r.headers, outcome.authOpts.secretValues),
				},
			};
		}

		if (via === "paginate") {
			const r = result as PaginateResult;
			const firstUrl = r.urls[0] ?? "";
			const serverTotal = r.serverTotal;
			let text =
				r.items.length === 0 && !r.failedItems
					? [
							`📦 0 item(s) fetched`,
							formatRequestLine("GET", firstUrl),
							`  pages fetched: ${r.pages}${r.ceilingHit ? " · ceiling: reached" : ""}`,
							...formatServerTotalLines(serverTotal, 0),
						].join("\n")
					: formatPaginatedResult(
							r.items,
							r.totalFetched,
							r.ceilingHit,
							sessionKey,
							firstUrl,
							r.pages,
							serverTotal,
							r.failedItems,
						);
			if (authFooter) text += `\n${authFooter}`;
			const staleNote = staleSchemaLine(guide);
			if (staleNote) text += `\n${staleNote}`;
			return {
				content: [{ type: "text", text }],
				details: {
					domain,
					operation,
					shortName: guide.shortName,
					via: "paginate",
					request: {
						method: "GET",
						url: firstUrl,
						params: r.params,
						pages: r.pages,
						urls: r.urls,
					},
					totalFetched: r.totalFetched,
					...(serverTotal === undefined ? {} : { serverTotal }),
					ceilingHit: r.ceilingHit,
				},
			};
		}

		// TypeScript guard — all ExecutorVia values handled above.
		return {
			content: [{ type: "text", text: `Unhandled executor '${via as string}'.` }],
			details: { error: "unhandled_via", via },
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("api-fetch "))];
		parts.push(theme.fg("accent", `"${args.domain}"`));
		if (args.operation) {
			parts.push(theme.fg("dim", `› ${args.operation}`));
		}
		// Optional scalar param hint in collapsed view.
		const rawParams = args.params;
		if (rawParams && typeof rawParams === "object") {
			const keys = Object.keys(rawParams);
			if (keys.length > 0 && keys.length <= 3) {
				const summary = keys
					.filter((k) =>
						["string", "number", "boolean"].includes(typeof rawParams[k]),
					)
					.map((k) => `${k}: ${rawParams[k]}`)
					.join(", ");
				if (summary) parts.push(theme.fg("dim", `{${summary}}`));
			}
		}
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(
				theme.fg("error", `Fetch failed: ${contentText(result, "?")}`),
				0,
				0,
			);

		const shortName = (d?.shortName as string) || (d?.domain as string) || "?";
		const operation = (d?.operation as string) || "?";
		const reqUrl = ((d?.request as Record<string, unknown>)?.url as string) || "";
		const totalFetched = d?.totalFetched as number | undefined;

		let text = theme.fg("accent", theme.bold(`📡 ${shortName}`));
		text += ` — ${operation} · GET ${reqUrl}`;
		if (totalFetched !== undefined) {
			text += `\n📦 ${totalFetched} item(s) fetched`;
		}

		return new Text(appendFooter(text, expanded, result, theme, 1000), 0, 0);
	},
});

// ═══════════════════════════════════════════════════════════════════
// Formatting helpers
// ═══════════════════════════════════════════════════════════════════

const INLINE_LIMIT = 4000;

/**
 * Format a request URL line for result transparency.
 */
function formatRequestLine(method: string, url: string): string {
	return `🔗 ${method} ${url}`;
}

/**
 * Newline-aware cut position: break at the last newline before `limit`,
 * falling back to a hard cut at `limit` if no newline in the second half.
 */
function cutAtNewline(s: string, limit: number): number {
	const cut = s.lastIndexOf("\n", limit);
	return cut < limit / 2 ? limit : cut;
}

/**
 * Truncate a pretty-printed JSON to INLINE_LIMIT (newline-aware, ending on "…"),
 * and when truncation occurs spill the full body to disk and append the pointer.
 */
function formatJsonSnippet(json: string, sessionKey: string): string {
	const tooLarge = json.length > INLINE_LIMIT;
	const cut = tooLarge ? cutAtNewline(json, INLINE_LIMIT) : json.length;
	const snippet = tooLarge ? json.slice(0, cut) + "\n…" : json;
	if (!tooLarge) return snippet;
	const spill = spillResponse(json, sessionKey);
	return snippet + "\n" + formatSpillNotice(spill, json.length);
}

function formatResult(
	data: unknown,
	guide: ApiGuide,
	op: Operation,
	sessionKey: string,
	url?: string,
): string {
	const lines: string[] = [];
	lines.push(`📡 ${guide.shortName} — ${op.name}`);
	lines.push(`  ${op.path}`);
	if (url) lines.push(formatRequestLine("GET", url));
	lines.push("");
	lines.push(formatJsonSnippet(JSON.stringify(data, null, 2), sessionKey));
	return lines.join("\n");
}

/**
 * Footer for paginate results. When the guide declares `totalCountPath` and the
 * server reported a total, stacks lines like `server total: N` / `remaining: …`.
 * Returns [] when the server total is unknown (guides without a count path).
 */
function formatServerTotalLines(
	serverTotal: number | undefined,
	totalFetched: number,
): string[] {
	if (serverTotal === undefined) return [];
	const lines = [`  server total: ${serverTotal}`];
	if (serverTotal > totalFetched) {
		lines.push(`  remaining: ${serverTotal - totalFetched}`);
	}
	return lines;
}

function formatPaginatedResult(
	items: unknown[],
	totalFetched: number,
	ceilingHit: boolean,
	sessionKey: string,
	firstUrl?: string,
	pages?: number,
	serverTotal?: number,
	failedItems?: unknown[],
): string {
	const lines: string[] = [];
	lines.push(`📦 ${totalFetched} item(s) fetched`);
	if (firstUrl) lines.push(formatRequestLine("GET", firstUrl));
	if (pages !== undefined && pages > 0) {
		lines.push(
			`  pages fetched: ${pages}${ceilingHit ? " · ceiling: reached" : ""}`,
		);
	}
	lines.push(...formatServerTotalLines(serverTotal, totalFetched));
	if (ceilingHit) {
		lines.push(`  ⚠ Ceiling reached — not all items were gathered.`);
	} else if (totalFetched > 0) {
		lines.push(
			`  💡 Pass gatherAll: true to fetch all pages (up to the guide's ceiling).`,
		);
	}
	lines.push("");
	lines.push(formatJsonSnippet(JSON.stringify(items, null, 2), sessionKey));
	if (failedItems && failedItems.length > 0) {
		lines.push("");
		lines.push(
			`⠂ ${failedItems.length} item(s) failed transform (raw, untransformed):`,
		);
		lines.push(
			formatJsonSnippet(JSON.stringify(failedItems, null, 2), sessionKey),
		);
	}
	return lines.join("\n");
}

/**
 * Ambiguous-operation error: the op name appears in ≥2 guides for one
 * domain. Shows the disambiguation listing, then points the agent at
 * api-guide to read each recipe and api-learn to re-author with the op
 * renamed. api-learn rewrites a whole recipe, not a single op — the
 * message sets that expectation. No `guide:` selector is referenced on
 * api-fetch (that param is deferred as YAGNI), so the message must not
 * point at one.
 */
function formatAmbiguousOperation(
	domain: string,
	operation: string,
	opMatches: { guide: ApiGuide; dirName: string; op: Operation }[],
): string {
	const lines: string[] = [];
	lines.push(
		`Ambiguous operation '${operation}' for '${domain}' — found in ${opMatches.length} guides:`,
	);
	lines.push(formatGuideListings(opMatches));
	const first = opMatches[0]!;
	lines.push("");
	lines.push(
		`The operation '${operation}' appears in multiple guides for '${domain}'.`,
	);
	lines.push(
		`Call api-guide({domain: "${domain}", guide: "${first.guide.shortName}"}) to read each guide's full recipe,`,
	);
	lines.push(
		`then re-author one guide via api-learn({recipeFile: …}) with the colliding operation renamed so the names no longer clash.`,
	);
	lines.push(`Note: api-learn rewrites a whole recipe, not a single operation.`);
	return lines.join("\n");
}

function formatHelperDisabled(
	message: string,
	helperDirName: string,
	domain: string,
	operation: string,
): string {
	// dirName (not routing `domain`) is where the helper file lives —
	// they diverge in the multi-recipe case; naming `domain` sends the
	// user to the wrong file.
	const lines: string[] = [
		`⚠ api-fetch error for '${domain}' / '${operation}':`,
		`  ${message}`,
		`  Helper directory: ${helperDirName}`,
		"",
		"Call api-guide({domain: …}) to review the guide, or fix the helper file and restart the session.",
	];
	return lines.join("\n");
}

/**
 * Output-channel audit — response-header echo: drop any response header
 * whose value contains a known store-injected secret. An auth-bearing
 * server must not echo the key back into `details.headers`. Returns the
 * original map unchanged when no secrets are in play.
 */
function scrubSecretHeaders(
	headers: Record<string, string>,
	secretValues?: string[],
): Record<string, string> {
	if (!secretValues || secretValues.length === 0) return headers;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (containsSecret(v, secretValues)) continue;
		out[k] = v;
	}
	return out;
}

function formatHelperError(
	err: HelperError,
	domain: string,
	operation: string,
): string {
	const lines: string[] = [
		`⚠ api-fetch error for '${domain}' / '${operation}':`,
		`  ${err.message}`,
		`  Field: ${err.field}`,
	];
	if (err.expected) lines.push(`  Expected: ${err.expected}`);
	if (err.found) lines.push(`  Found: ${err.found}`);
	if (err.fix) lines.push(`  Fix: ${err.fix}`);
	if (err.url) lines.push(formatRequestLine("GET", err.url));
	lines.push("");
	lines.push(
		`Call api-guide({domain: "${domain}"}) to review the guide, or api-learn({domain: "${domain}", recipeFile: …}) to fix it.`,
	);
	return lines.join("\n");
}
