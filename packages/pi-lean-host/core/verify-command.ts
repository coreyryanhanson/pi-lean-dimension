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
	stampFrontmatterField,
	TODAY,
} from "./parse-api-guide.js";
import { pickGuide } from "./guide-picker.js";
import {
	resolveSecretHeaders,
	resolveSecretQueryParams,
	canonicalStoreDomain,
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
		"  are skipped, not failed. Supply them via a co-located verify.json:",
		`    ~/.pi/agent/pi-lean-host/api-guides/<domain>/verify.json`,
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

	// Resolve the guide by domain (D12 disambiguation for N-guide domains).
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
			if (sel.reason === "no_match") {
				ctx.ui.notify(
					`No guide named '${guideSelector}' for '${domain}'. ` +
						`Available guides: ${sel.valid.join(", ")}. ` +
						`Call /api verify ${domain} to see the menu.`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Ambiguous guide '${guideSelector}' for '${domain}' — ` +
					`${sel.directories.length} guides share that shortName ` +
					`(directories: ${sel.directories.join(", ")}). ` +
					`Rename one guide's shortName to disambiguate.`,
				"warning",
			);
			return;
		}
		selected = sel;
	} else {
		// N guides, no selector → interactive pick (TUI) or the D12 menu
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

	// Auth precheck (fail-fast): resolve the same secrets api-fetch does. If
	// any `requires` secret is unprovisioned, short-circuit with ONE message —
	// do not run N ops that all fail identically.
	if (guide.auth.kind === "static-key") {
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
		const supplied = verifyJson[op.name] ?? {};
		const missing = unsatisfiableParams(op, supplied);
		if (missing.length > 0) {
			skipped++;
			report.push(
				`  ⏭ ${op.name} — skipped: requires agent-supplied params (${missing.join(", ")}) — verify manually via api-fetch`,
			);
			continue;
		}

		let outcome: ResolveOpResult;
		try {
			outcome = await resolveOpForExecution(guide, op, dirName, {
				userParams: supplied,
			});
		} catch (err) {
			failed++;
			const msg =
				err instanceof HelperError
					? err.message
					: err instanceof Error
						? err.message
						: String(err);
			report.push(`  ✗ ${op.name} — ${msg}`);
			continue;
		}

		if (!outcome.ok) {
			if (outcome.reason === "helper_disabled") {
				// Session-persistent condition — unverifiable this session, not broken.
				skipped++;
				report.push(
					`  ⏭ ${op.name} — skipped: local helper disabled this session (${outcome.message})`,
				);
				continue;
			}
			// auth_required_not_provisioned — unreachable after the precheck
			// (auth is per-guide constant); defensive.
			failed++;
			report.push(
				`  ✗ ${op.name} — requires secret not provisioned: ${outcome.missing.join(", ")}`,
			);
			continue;
		}

		ran++;
		report.push(opLine(outcome, op));
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
				`⚠ NOT stamped — all ops skipped. Supply params via verify.json (${dirName}/verify.json) or verify manually via api-fetch.`,
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
 * The params an op still needs to run: path `{token}`s (never defaultable —
 * they're filled from the params map) and `required: true` query params with
 * no default. Anything the executor would throw on before making a request.
 */
function unsatisfiableParams(
	op: Operation,
	supplied: Record<string, unknown>,
): string[] {
	const missing: string[] = [];
	for (const token of op.pathParams) {
		if (supplied[token] === undefined) missing.push(token);
	}
	for (const [key, spec] of Object.entries(op.params)) {
		if (
			spec.required &&
			spec.default === undefined &&
			supplied[key] === undefined
		) {
			missing.push(key);
		}
	}
	return missing;
}

/** Load the co-located verify.json sidecar, best-effort. */
function loadVerifyJson(
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

/** One report line for a successful op run. A transform warning is noted but
 *  non-blocking — the HTTP op succeeded, so the op counts as pass. */
function opLine(
	outcome: Extract<ResolveOpResult, { ok: true }>,
	op: Operation,
): string {
	if (outcome.via === "restGet") {
		const r = outcome.result as RestGetResult;
		const warn =
			r.transformWarning === undefined
				? ""
				: ` — transform warning: ${r.transformWarning}`;
		return `  ✓ ${op.name} — ${op.path} (restGet)${warn}`;
	}
	const r = outcome.result as PaginateResult;
	return `  ✓ ${op.name} — ${r.totalFetched} item(s) (paginate)`;
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
