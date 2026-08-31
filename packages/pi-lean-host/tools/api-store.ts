/**
 * api-store tool definition.
 *
 * Read-only, learn-gated inspection of BOTH credential stores in one call —
 * the agent-facing view of `/api secrets` + `/api oauth --status`. The
 * authoring question is never "show me tokens" in isolation; it is what
 * credentials exist for a domain, what's declared vs provisioned vs minted,
 * what's expired, and what needs minting next.
 *
 *  - Bare call (no domain, no apiHost) → orphan view: unscoped secret
 *    domains + token domains with no guide (authoring-bootstrap view).
 *  - With domain (or apiHost, resolved via the probe's store-domain seam —
 *    `resolveProvisionedParentDomain` + `hostnameOf` from core/auth) →
 *    combined per-domain report: provisioned/declared/gap secret names,
 *    token slots (issuer, granted scope, expiry, refreshable) and
 *    declared-slot gaps ("guide declares X: no token minted" — the pointer
 *    to `oauth-mint` that replaces a trial-and-error 401).
 *
 * Strictly read-only — no mint/refresh/revoke surface; those stay
 * human-typed (`/api oauth`) or human-consented (`oauth-mint`).
 *
 * Redaction posture: names + metadata only. `accessToken`/`refreshToken`
 * values are dropped at the collection boundary (TokenSlotMeta carries no
 * token object), so they can't leak into rendered text OR structured
 * `details`. Secret values never enter this file — `listNames` returns
 * names only.
 *
 * Two-layer learn gate (same as probe's former `listSecrets` arm): the tool
 * registers via the `api-learn` ToolsetSpec (masked when off) AND the
 * handler re-checks `isApiLearnEnabled()` at runtime — belt and suspenders.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { appendFooter, contentText } from "./utils.js";
import { listDomains, listNames } from "../core/secrets-store.js";
import { listSlots, listTokenDomains, slotKey } from "../core/oauth-store.js";
import { findGuidesByDomain, loadAllGuides } from "../core/guide-store.js";
import { hostnameOf, resolveProvisionedParentDomain } from "../core/auth.js";
import { isApiLearnEnabled } from "../core/api-toggle.js";
import type { ApiGuide } from "../core/api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Types — metadata only; no token/secret value ever lands in these
// ═══════════════════════════════════════════════════════════════════

/** One token slot's renderable metadata (no `accessToken`/`refreshToken`). */
export interface TokenSlotMeta {
	slot: string;
	grant: string;
	/** The token endpoint the token was minted from (self-describing store). */
	issuer: string;
	/** Granted scope — what the provider echoed, or the requested scopes with an "(assumed)" marker (RFC 6749 §5.1). */
	granted: string;
	/** Human expiry line ("in 6h (refreshable)" / "expired 2h ago" / "never"). */
	expires: string;
	refreshable: boolean;
}

/** A guide-declared oauth2 slot with no minted token — the next step is oauth-mint. */
export interface UnclaimedSlot {
	guide: string;
	grant: string;
	tokenUrl: string;
}

export interface DomainReport {
	domain: string;
	secrets: {
		provisioned: string[];
		/** Secret names the matching guides declare (oauth2 clientId/SecretRef included). */
		declared: string[];
		/** Declared but not provisioned. */
		gaps: string[];
		/** Directories of the guides that made the declaration (empty → no guide). */
		guides: string[];
	};
	tokens: {
		slots: TokenSlotMeta[];
		unclaimed: UnclaimedSlot[];
	};
}

export interface UnscopedView {
	/** Provisioned secret domains with no matching guide. */
	secretDomains: string[];
	/** Token-store domains with no matching guide. */
	tokenDomains: string[];
}

// ═══════════════════════════════════════════════════════════════════
// Collection (pure over the two stores + guide cache)
// ═══════════════════════════════════════════════════════════════════

/** Secret names a guide's auth block declares — store names only, both
 *  static-key refs and oauth2 clientId/clientSecret. */
function declaredSecretsOf(guide: ApiGuide): string[] {
	const names = new Set<string>();
	switch (guide.auth.kind) {
		case "static-key":
			for (const ref of Object.values(guide.auth.secretRefs ?? {}))
				names.add(ref.secret);
			for (const ref of Object.values(guide.auth.secretQueryRefs ?? {}))
				names.add(ref.secret);
			break;
		case "oauth2":
			for (const ref of [guide.auth.clientId, guide.auth.clientSecret])
				if (ref) names.add(ref.secret);
			for (const ref of Object.values(guide.auth.secretRefs ?? {}))
				names.add(ref.secret);
			break;
		case "none":
			break;
		default: {
			const _exhaustive: never = guide.auth;
			throw new Error(`Unhandled auth kind: ${_exhaustive}`);
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

function relSpan(ms: number): string {
	const m = Math.max(1, Math.round(ms / 60_000));
	if (m < 90) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

/** Human expiry line. Absent expiresAt → "never"; refresh token → "(refreshable)". */
function expiresLine(
	expiresAt: number | undefined,
	refreshable: boolean,
): string {
	let base: string;
	if (expiresAt === undefined) base = "never";
	else {
		const diff = expiresAt - Date.now();
		base = diff > 0 ? `in ${relSpan(diff)}` : `expired ${relSpan(-diff)} ago`;
	}
	return refreshable ? `${base} (refreshable)` : base;
}

/** Granted scope: what the provider echoed at mint; absent → the guide's
 *  requested scopes with "(assumed)" (RFC 6749 §5.1 — granted = requested).
 *  Live revocation is RFC 7662 territory — deferred. */
function grantedLine(scope: string | undefined, requested: string[]): string {
	if (scope) {
		const granted = scope.split(/\s+/).filter(Boolean).join(", ");
		return requested.length > 0 ? `${granted} (per mint)` : granted;
	}
	if (requested.length > 0) return `${requested.join(", ")} (assumed)`;
	return "(none recorded)";
}

/** Combined per-domain view: secrets (provisioned/declared/gaps) + token
 *  slots + declared-slot gaps. Metadata only by construction. */
export function collectDomainReport(domain: string): DomainReport {
	const provisioned = listNames(domain);
	const matches = findGuidesByDomain(domain);

	const declared = new Set<string>();
	for (const { guide } of matches)
		for (const name of declaredSecretsOf(guide)) declared.add(name);
	const declaredList = [...declared];

	const slots = listSlots(domain).map((s) => slotMeta(s));
	const claimed = new Set(slots.map((s) => s.slot));
	const unclaimed: UnclaimedSlot[] = [];
	for (const { guide, dirName } of matches) {
		if (guide.auth.kind !== "oauth2") continue;
		if (!claimed.has(slotKey(guide.auth.grant, guide.auth.tokenUrl))) {
			unclaimed.push({
				guide: dirName,
				grant: guide.auth.grant,
				tokenUrl: guide.auth.tokenUrl,
			});
		}
	}

	return {
		domain,
		secrets: {
			provisioned,
			declared: declaredList,
			gaps: declaredList.filter((d) => !provisioned.includes(d)),
			guides: matches.map((m) => m.dirName),
		},
		tokens: { slots, unclaimed },
	};
}

function slotMeta(s: {
	slot: string;
	grant: string;
	tokenUrl: string;
	token: { refreshToken?: string; expiresAt?: number; scope?: string };
}): TokenSlotMeta {
	const requested = requestedScopesFor(s.grant, s.tokenUrl);
	const refreshable = s.token.refreshToken !== undefined;
	return {
		slot: s.slot,
		grant: s.grant,
		issuer: s.tokenUrl,
		granted: grantedLine(s.token.scope, requested),
		expires: expiresLine(s.token.expiresAt, refreshable),
		refreshable,
	};
}

/** Requested scopes for a slot from any matching guide's oauth2 block —
 *  the RFC 6749 §5.1 fallback when the provider echoed no scope. Empty for
 *  guide-less tokens (nothing requested on record). */
function requestedScopesFor(grant: string, tokenUrl: string): string[] {
	// Declared-scope fallback is domain-agnostic: the same (grant, tokenUrl)
	// identifies the guide's oauth2 block regardless of routing domain, so
	// scan every loaded guide — including ones whose domain has no minted
	// tokens yet (those were invisible to the old token-domain-derived scan).
	for (const guide of Object.values(loadAllGuides().guides)) {
		if (guide.auth.kind !== "oauth2") continue;
		if (
			guide.auth.grant === grant &&
			guide.auth.tokenUrl === tokenUrl &&
			guide.auth.scopes?.length
		) {
			return guide.auth.scopes;
		}
	}
	return [];
}

/** Bare-call orphan view across both stores. Token orphan filtering matches
 *  guides via the same store-domain seam as minting: the token domain and
 *  its provisioned parent are both checked, so an `api.`-subdomain token
 *  resolves to its parent's guides instead of false-positive as guideless. */
export function collectUnscoped(): UnscopedView {
	const guideless = (d: string): boolean =>
		findGuidesByDomain(d).length === 0 &&
		findGuidesByDomain(resolveProvisionedParentDomain(d)).length === 0;
	return {
		secretDomains: listDomains().filter(guideless),
		tokenDomains: listTokenDomains().filter(guideless),
	};
}

// ═══════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════

export function formatOrphanView(v: UnscopedView): string {
	const lines: string[] = ["🔐 store overview", ""];
	lines.push(
		`  unscoped secret domains: ${v.secretDomains.length > 0 ? v.secretDomains.join(", ") : "none"}`,
	);
	lines.push(
		`  token domains with no guide: ${v.tokenDomains.length > 0 ? v.tokenDomains.join(", ") : "none"}`,
	);
	lines.push("");
	lines.push(
		"  (names + metadata only — secret and token values never leave the store)",
	);
	return lines.join("\n");
}

export function formatDomainReport(r: DomainReport): string {
	const lines: string[] = [`🔐 store: ${r.domain}`, "", "secrets"];
	const s = r.secrets;
	lines.push(
		`  provisioned: ${s.provisioned.length > 0 ? s.provisioned.join(", ") : "(none)"}`,
	);
	if (s.guides.length > 0) {
		lines.push(
			`  declared:    ${s.declared.length > 0 ? s.declared.join(", ") : "(none)"}  (guide: ${s.guides.join(", ")})`,
		);
		if (s.gaps.length > 0) lines.push(`  gaps:        ${s.gaps.join(", ")}`);
	}
	lines.push("", "tokens");
	if (r.tokens.slots.length === 0 && r.tokens.unclaimed.length === 0) {
		lines.push("  (no tokens minted, none declared)");
	}
	for (const t of r.tokens.slots) {
		lines.push(`  ${t.slot}`);
		lines.push(`    issuer:  ${t.issuer}`);
		lines.push(`    granted: ${t.granted}`);
		lines.push(`    expires: ${t.expires}`);
	}
	for (const u of r.tokens.unclaimed) {
		lines.push(
			`  — guide (${u.guide}) declares ${u.grant} via ${u.tokenUrl}: no token minted`,
		);
	}
	return lines.join("\n");
}

/** Collect + wrap a per-domain report into the tool result shape. */
function finishDomainReport(domain: string): {
	content: { type: "text"; text: string }[];
	details: DomainReport;
} {
	const report = collectDomainReport(domain);
	return {
		content: [{ type: "text", text: formatDomainReport(report) }],
		details: report,
	};
}

// ═══════════════════════════════════════════════════════════════════
// Tool definition
// ═══════════════════════════════════════════════════════════════════

export const apiStoreTool = defineTool({
	name: "api-store",
	label: "API Store",
	description:
		"Read-only inspection of both credential stores (secrets + OAuth2 tokens) in " +
		"one call — learn mode only (run /api learn first). Bare call (no domain, no " +
		"apiHost): orphan view — provisioned-but-guideless secret domains + guideless " +
		"token domains, the authoring-bootstrap check. With domain (or apiHost): " +
		"combined report — provisioned vs declared secret names and their gaps, minted " +
		"token slots (issuer, granted scope, expiry, refreshable), and declared-slot " +
		"gaps (a guide-declared oauth2 grant with no token minted → next step is " +
		"oauth-mint). Names + metadata only — secret and token values never leave the " +
		"store. Strictly read-only: mint/refresh/revoke stay human-typed (/api oauth) " +
		"or human-consented (oauth-mint).",

	parameters: Type.Object({
		domain: Type.Optional(
			Type.String({
				description:
					"Store domain to inspect (e.g. 'github.com'). Omit domain and apiHost for the bare orphan view.",
			}),
		),
		apiHost: Type.Optional(
			Type.String({
				description:
					"API base URL — the store domain defaults to its hostname (or the longest provisioned parent, e.g. pro-api.coinmarketcap.com → coinmarketcap.com). Ignored when domain is set.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { domain, apiHost } = params as {
			domain?: string;
			apiHost?: string;
		};

		// Runtime re-check (the toolset mask is the first layer): a stale
		// registration must not read the stores outside learn mode.
		if (!isApiLearnEnabled()) {
			return {
				content: [
					{
						type: "text",
						text:
							"api-store: store inspection is learn mode only — run /api learn first.",
					},
				],
				details: { error: "learn_mode_only" },
			};
		}

		if (domain) return finishDomainReport(domain);
		if (apiHost)
			return finishDomainReport(
				resolveProvisionedParentDomain(hostnameOf(apiHost)),
			);
		const unscoped = collectUnscoped();
		return {
			content: [{ type: "text", text: formatOrphanView(unscoped) }],
			details: { unscoped },
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("api-store "))];
		if (args.domain) parts.push(theme.fg("accent", `"${args.domain}"`));
		else if (args.apiHost) parts.push(theme.fg("accent", `"${args.apiHost}"`));
		else parts.push(theme.fg("dim", "orphan view"));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Inspecting…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) {
			return new Text(theme.fg("error", `⚠ ${contentText(result, "?")}`), 0, 0);
		}
		const unscoped = d?.unscoped as UnscopedView | undefined;
		let text = theme.fg("accent", theme.bold("🔐 api-store"));
		if (unscoped) {
			text += ` — ${unscoped.secretDomains.length} unscoped secret domain(s) · ${unscoped.tokenDomains.length} guideless token domain(s)`;
		} else {
			const secrets = d?.secrets as DomainReport["secrets"] | undefined;
			const tokens = d?.tokens as DomainReport["tokens"] | undefined;
			if (secrets && tokens) {
				text += ` — ${d?.domain} · ${secrets.provisioned.length} provisioned · ${tokens.slots.length} token slot(s)`;
				if (tokens.unclaimed.length > 0)
					text += ` · ${tokens.unclaimed.length} unclaimed`;
			}
		}
		return new Text(appendFooter(text, expanded, result, theme, 1000), 0, 0);
	},
});
