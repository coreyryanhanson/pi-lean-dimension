/**
 * `/api verify <domain> [guide] [--force]` — verify every runnable operation
 * of a guide against its live API, stamping `verified: today` only when all
 * runnable ops pass.
 *
 * - `verify <domain>`            — fetch every op; stamp on all-runnable-pass.
 * - `verify <domain> <guide>`    — pick a guide by shortName (N-guide domains).
 * - `verify <domain> --force`    — stamp today WITHOUT running any ops
 *                                 (human-typed "human-attested good" escape valve).
 * - `verify --help`              — usage + cost note.
 *
 * Strict threshold: any runnable-op failure (partial or all-fail) → no stamp.
 * Skipped ops are NOT failures and don't block the stamp, but are named in
 * the report. Two skip categories: unsatisfiable params (a path `{token}` or
 * required query param with no default, and no verify.json value) and a
 * session-disabled local helper. A post-response transform failure is
 * non-blocking (the HTTP op succeeded — the executor carries it as a
 * `transformWarning`).
 *
 * Opt-in params sidecar: a co-located
 * `~/.pi/agent/pi-lean-host/api-guides/<dirName>/verify.json`,
 * shape `{ "<opName>": { "<param>": "<value>" } }`, supplies the params map
 * verbatim to the executor (pre-helper inputs for `helper: true` ops). It is
 * the only way an op with unsatisfiable params can run.
 *
 * Always-available (runs in **on** mode, not just learn) and not refused by
 * the focus-mode guard — it writes no toolset state (peer of `secrets`).
 * Runs the executor/auth/transport directly, so it works even when the
 * api-fetch / api-guide tools are masked off.
 *
 * Not free: N live HTTP requests against the target API (GET only — no
 * mutation side-effects, but real quota/rate-limit cost). Reuses the
 * transport's existing 429 retry at the default maxRetries.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	stampFrontmatterField,
	TODAY,
} from "./parse-api-guide.js";
import { pickGuide } from "./guide-picker.js";
import {
	resolveSecretHeaders,
	resolveSecretQueryParams,
	canonicalStoreDomain,
	hasUsableTokenPath,
} from "./auth.js";
import { resolveOpForExecution, type ResolveOpResult } from "./resolve-op.js";
import {
	HelperError,
	type RestGetResult,
	type PaginateResult,
} from "./helpers.js";
import type { ApiGuide, Operation } from "./api-guide-types.js";

/** Usage + cost note, surfaced by `--help`. */
function helpText(): string {
	return [
		"Usage: /api verify <domain> [guide] [--force]",
		"  /api verify <domain>            fetch every runnable op; stamp verified: today on all-pass",
		"  /api verify <domain> <guide>    pick a guide by shortName when a domain claims several",
		"  /api verify <domain> --force    stamp verified: today WITHOUT running any ops (human-attested)",
		"  /api verify --help              this help",
		"",
		"  Ops with unsatisfiable params (a path {token} or required query param with no default)",
		"  are skipped, not failed. Scaffold a starter sidecar with api-scaffold({domain, verify: true})",
		'  (writes to /tmp, with "__FILL_ME__" sentinels for every blocking param), then save via',
		"  api-learn({domain, dir}) — the sidecar lives at:",
		`    ~/.pi/agent/pi-lean-host/api-guides/<dirName>/verify.json`,
		`    { "<opName>": { "<param>": "<value>" } }`,
		"",
		"  Not free: N live HTTP requests against the target API (GET only — no mutation).",
		"  Reuses the transport's 429 retry at the default maxRetries.",
	].join("\n");
}

/**
 * Handle the `verify` subcommand of `/api`.
 *
 * @param args  The text after "verify" ("" / "<domain>" / "<domain> <guide>").
 * @param ctx   The extension command context
 */
export async function handleVerifySubcommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);

	if (parts.includes("--help") || parts.includes("help")) {
		ctx.ui.notify(helpText(), "info");
		return;
	}

	const force = parts.includes("--force");
	const tokens = parts.filter((p) => p !== "--force");
	const domain = tokens[0];
	const guideSelector = tokens[1];

	if (!domain) {
		ctx.ui.notify(
			"Usage: /api verify <domain> [guide] [--force] — see /api verify --help.",
			"warning",
		);
		return;
	}

	// Resolve the guide by domain (disambiguation for N-guide domains).
	const matches = findGuidesByDomain(domain);
	if (matches.length === 0) {
		ctx.ui.notify(
			`No API guide for '${domain}'. ` +
				`Call api-guide({}) to list available guides, or api-learn({domain: "${domain}"}) to author one.`,
			"warning",
		);
		return;
	}

	let selected: { guide: ApiGuide; dirName: string };
	if (matches.length === 1) {
		selected = matches[0]!;
	} else if (guideSelector) {
		const sel = selectGuideByShortName(matches, guideSelector);
		if (!sel.ok) {
			ctx.ui.notify(
				shortNameErrorText(
					sel,
					domain,
					guideSelector,
					`Call /api verify ${domain} to see the menu.`,
				),
				"warning",
			);
			return;
		}
		selected = sel;
	} else {
		// N guides, no selector → interactive pick (TUI) or the menu
		// fallback (headless/RPC/print or cancelled), nothing run yet.
		const picked = await pickGuide(ctx, matches);
		if (!picked) {
			ctx.ui.notify(
				[
					`${matches.length} API guides for '${domain}':`,
					formatGuideListings(matches),
					`Call /api verify ${domain} <shortName> to pick one.`,
				].join("\n"),
				"info",
			);
			return;
		}
		selected = picked;
	}

	const { guide, dirName } = selected;
	const storeDomain = canonicalStoreDomain(guide);

	// --force: human-attested stamp, no HTTP at all.
	if (force) {
		stampVerified(dirName);
		ctx.ui.notify(
			`📡 Verify --force: ${guide.shortName} (${dirName})\n` +
				`  Stamped verified: ${TODAY()} without running any ops — human-attested good.\n` +
				`  Note: this reflects attestation, not a run confirmation.`,
			"info",
		);
		return;
	}

	// Auth precheck (fail-fast): resolve the same secrets/token api-fetch does.
	// If a required secret is unprovisioned or no OAuth2 token is mintable,
	// short-circuit with ONE message — do not run N ops that all fail
	// identically.
	switch (guide.auth.kind) {
		case "static-key": {
			const headerRes = resolveSecretHeaders(guide.auth, storeDomain);
			const queryRes = resolveSecretQueryParams(guide.auth, storeDomain);
			const missingRequired = [
				...headerRes.absentRequired,
				...queryRes.absentRequired,
			];
			if (missingRequired.length > 0) {
				ctx.ui.notify(
					`🔑 ${guide.shortName} requires a secret not yet provisioned: ` +
						`${missingRequired.join(", ")}.\n` +
						`Run /api secrets ${storeDomain} to provision it, then re-run /api verify.`,
					"warning",
				);
				return;
			}
			break;
		}
		case "oauth2": {
			if (!hasUsableTokenPath(guide.auth, storeDomain)) {
				const hint =
					guide.auth.grant === "authorization_code"
						? `Run /api oauth ${storeDomain} to start the interactive flow`
						: `Provision the client secret via /api secrets ${storeDomain}, then run /api oauth ${storeDomain}`;
				ctx.ui.notify(
					`🔑 ${guide.shortName} has no usable OAuth2 token for '${storeDomain}'.\n` +
						`${hint}, then re-run /api verify.`,
					"warning",
				);
				return;
			}
			break;
		}
		case "none":
			break;
		default: {
			const _exhaustive: never = guide.auth;
			throw new Error(`Unhandled auth kind: ${_exhaustive}`);
		}
	}

	// Best-effort verify.json sidecar: file-miss → no sidecar (today's skip
	// behavior); malformed → parse error caught at load, not a runtime crash.
	const sidecar = loadVerifyJson(dirName);
	if (sidecar && "error" in sidecar) {
		ctx.ui.notify(
			`⚠ verify.json for '${dirName}' is malformed — ignoring it (${sidecar.error}).`,
			"warning",
		);
	}
	const verifyJson = sidecar && "data" in sidecar ? sidecar.data : {};

	// ── Fetch loop ──────────────────────────────────────────────
	const ops = guide.operations;
	const report: string[] = [];
	let ran = 0;
	let failed = 0;
	let skipped = 0;

	for (const op of ops) {
		// Strip `"__FILL_ME__"` sentinels (from verify.json / api-scaffold) so
		// they never count as supplied params or serialize into the query string.
		const rawSupplied = verifyJson[op.name] ?? {};
		const supplied: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(rawSupplied)) {
			if (v !== "__FILL_ME__") supplied[k] = v;
		}
		const missing = renderForReport(unsatisfiable(op, supplied));
		if (missing.length > 0) {
			skipped++;
			report.push(
				`  ⏭ ${op.name} — skipped: requires agent-supplied params (${missing.join(", ")}) — scaffold via api-scaffold({domain, verify: true}), or verify manually via api-fetch`,
			);
			continue;
		}

		// Fan-out: a requiresAnyOf group with >1 supplied member is verified
		// once per member, isolating that member (non-group params carried on
		// every run). Mutually-exclusive peers (id ⊻ symbol) never ride the
		// same request; inclusive-OR filters get per-peer coverage. ≤1 supplied
		// member → today's single run. Sentinels are already stripped above, so
		// a partially-filled file still runs just the real values.
		const group = op.requiresAnyOf ?? [];
		const suppliedMembers = group.filter((m) => supplied[m] !== undefined);
		const runs =
			suppliedMembers.length > 1
				? suppliedMembers.map((m) => {
						const params = { ...supplied };
						for (const peer of group) {
							if (peer !== m) delete params[peer];
						}
						return { params, tag: m };
					})
				: [{ params: supplied, tag: undefined }];

		for (const run of runs) {
			let outcome: ResolveOpResult;
			try {
				outcome = await resolveOpForExecution(guide, op, dirName, {
					userParams: run.params,
				});
			} catch (err) {
				failed++;
				const msg =
					err instanceof HelperError
						? err.message
						: err instanceof Error
							? err.message
							: String(err);
				report.push(`  ✗ ${opTag(op.name, run.tag)} — ${msg}`);
				continue;
			}

			if (!outcome.ok) {
				if (outcome.reason === "helper_disabled") {
					// Session-persistent condition — unverifiable this session, not broken.
					skipped++;
					report.push(
						`  ⏭ ${opTag(op.name, run.tag)} — skipped: local helper disabled this session (${outcome.message})`,
					);
					// Disabled helpers are session-persistent and deterministic — the
					// remaining fan-out runs would skip identically, so stop here.
					break;
				}
				if (outcome.reason === "oauth_token_missing") {
					// Unmintable OAuth2 token — same nudge for every op, so fail once
					// (the auth precheck will fail-fast before the loop).
					failed++;
					report.push(`  ✗ ${opTag(op.name, run.tag)} — ${outcome.message}`);
					continue;
				}
				// auth_required_not_provisioned — unreachable after the precheck
				// (auth is per-guide constant); defensive.
				failed++;
				report.push(
					`  ✗ ${opTag(op.name, run.tag)} — requires secret not provisioned: ${outcome.missing.join(", ")}`,
				);
				continue;
			}

			ran++;
			report.push(opLine(outcome, op, run.tag));
		}
	}

	const header = `📡 Verify: ${guide.shortName} (${dirName})`;
	const summary = `  Ops: ${ops.length} · ran ${ran} · failed ${failed} · skipped ${skipped}`;

	if (failed > 0) {
		ctx.ui.notify(
			[
				header,
				summary,
				...report,
				"",
				`❌ NOT stamped — ${failed} op(s) failed. Fix and re-run /api verify.`,
			].join("\n"),
			"warning",
		);
		return;
	}
	if (ran === 0) {
		ctx.ui.notify(
			[
				header,
				summary,
				...report,
				"",
				`⚠ NOT stamped — all ops skipped. Scaffold a verify.json via api-scaffold({domain: "${domain}", verify: true}), or supply params via ${dirName}/verify.json, or verify manually via api-fetch.`,
			].join("\n"),
			"warning",
		);
		return;
	}

	stampVerified(dirName);
	ctx.ui.notify(
		[
			header,
			summary,
			...report,
			"",
			`✅ All runnable ops passed — stamped verified: ${TODAY()}`,
		].join("\n"),
		"info",
	);
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Why an op can't run yet: a path `{token}` (never defaultable — filled from
 * the params map), a `required: true` query param with no default, or an
 * unsatisfied `requiresAnyOf` group. Anything the executor would throw on
 * before making a request.
 *
 * A `requiresAnyOf` group contributes ONE group-level entry when no member is
 * supplied; group members are governed by the group, not per-param required
 * (the parser bans `required: true` on them), so they're skipped in the
 * per-param loop.
 */
export type Unsatisfiable =
	| { kind: "path"; param: string }
	| { kind: "group"; members: string[] }
	| { kind: "query"; param: string };

/** The params an op still needs to run, as structured entries. */
export function unsatisfiable(
	op: Operation,
	supplied: Record<string, unknown>,
): Unsatisfiable[] {
	const missing: Unsatisfiable[] = [];
	for (const token of op.pathParams) {
		if (supplied[token] === undefined)
			missing.push({ kind: "path", param: token });
	}
	const group = op.requiresAnyOf;
	const groupMember = new Set(group ?? []);
	if (group && group.length > 0) {
		const anySupplied = group.some((name) => supplied[name] !== undefined);
		if (!anySupplied) missing.push({ kind: "group", members: group });
	}
	for (const [key, spec] of Object.entries(op.params)) {
		if (groupMember.has(key)) continue; // governed by the group
		if (
			spec.required &&
			spec.default === undefined &&
			supplied[key] === undefined
		) {
			missing.push({ kind: "query", param: key });
		}
	}
	return missing;
}

/** Render unsatisfiable entries exactly as the verify report shows them. */
function renderForReport(items: Unsatisfiable[]): string[] {
	return items.map((item) => {
		switch (item.kind) {
			case "group":
				return `one of: ${item.members.join(", ")}`;
			case "path":
			case "query":
				return item.param;
		}
	});
}

/** Render unsatisfiable entries as one sentinel key per param. */
export function renderForSentinels(items: Unsatisfiable[]): string[] {
	return items.flatMap((item) => {
		switch (item.kind) {
			case "group":
				return item.members;
			case "path":
			case "query":
				return [item.param];
		}
	});
}

/** Load the co-located verify.json sidecar, best-effort. */
export function loadVerifyJson(
	dirName: string,
):
	| { data: Record<string, Record<string, unknown>> }
	| { error: string }
	| null {
	const p = join(getUserGuidesDir(), dirName, "verify.json");
	if (!existsSync(p)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { data: parsed as Record<string, Record<string, unknown>> };
		}
		return { error: "expected a JSON object" };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** `name (member)` when a fan-out run is tagged, else `name`. */
function opTag(name: string, tag?: string): string {
	return tag === undefined ? name : `${name} (${tag})`;
}

/** One report line for a successful op run. A transform warning is noted but
 *  non-blocking — the HTTP op succeeded, so the op counts as pass. */
function opLine(
	outcome: Extract<ResolveOpResult, { ok: true }>,
	op: Operation,
	tag?: string,
): string {
	const name = opTag(op.name, tag);
	if (outcome.via === "restGet") {
		const r = outcome.result as RestGetResult;
		const warn =
			r.transformWarning === undefined
				? ""
				: ` — transform warning: ${r.transformWarning}`;
		return `  ✓ ${name} — ${op.path} (restGet)${warn}`;
	}
	const r = outcome.result as PaginateResult;
	return `  ✓ ${name} — ${r.totalFetched} item(s) (paginate)`;
}

/**
 * Stamp `verified: today` into the raw guide.md (frontmatter-isolated,
 * line-level — comments + key order preserved), then invalidate the cache so
 * the next api-guide / api-fetch sees the fresh date immediately.
 */
function stampVerified(dirName: string): void {
	const filepath = join(getUserGuidesDir(), dirName, "guide.md");
	const raw = readFileSync(filepath, "utf-8");
	const stamped = stampFrontmatterField(raw, "verified", TODAY());
	writeFileSync(filepath, stamped, "utf-8");
	invalidateCache();
}
