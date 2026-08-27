/**
 * `/api oauth <domain>` — provision / inspect / revoke OAuth2 tokens.
 *
 * - `oauth <domain>`           — mint a token and stamp the token store.
 *   client_credentials: pure HTTP. authorization_code: print the authorize URL
 *   (redirect_uri = http://localhost/callback, RFC 8252 §7.3), the user
 *   consents in their own browser and pastes the redirect URL back — inline
 *   prompt (TUI) or `--code <redirect-url-or-code>` (headless/scripting).
 * - `oauth <domain> --status`  — metadata-only token state (no network).
 * - `oauth <domain> --refresh` — force a fresh token (client_credentials:
 *   re-mint; authorization_code: refresh via the stored refresh token, or a
 *   fresh authorize URL when there is none).
 * - `oauth <domain> --revoke`  — revoke at the provider's revokeUrl (if declared) and clear the store.
 * - `oauth <domain> --code <code>` — complete an authorization-code flow with
 *   the pasted redirect URL (or bare code) from a previous authorize step.
 * - `oauth` (bare)             — list token-store domains with status metadata.
 *
 * Tokens can outlive their guide (deleted via /api delete, or minted while
 * testing), so bare listing, `--status`, and `--revoke` also work guide-less
 * (keyed by the literal domain; revoke is then local-only — no revokeUrl
 * without a guide). Minting/refreshing still requires the guide.
 *
 * Always-available / not focus-guarded — a peer of `secrets`/`verify`/`delete`
 * (writes the token store, not toolset state). The client secret lives in the
 * secrets store; only minted tokens land here.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findGuidesByDomain } from "./guide-store.js";
import { pickGuide } from "./guide-picker.js";
import {
	formatGuideListings,
	selectGuideByShortName,
	shortNameErrorText,
} from "./parse-api-guide.js";
import {
	canonicalStoreDomain,
	isTokenExpired,
	resolveAccessToken,
	revokeAccessToken,
	OAuthTokenMissingError,
} from "./auth.js";
import {
	readToken,
	deleteToken,
	deletePendingFlow,
	listTokenDomains,
	getOAuthDir,
} from "./oauth-store.js";
import type { OAuthToken } from "./oauth-store.js";
import { mintAuthCodeToken } from "./oauth-flow.js";
import type { ApiGuide } from "./api-guide-types.js";

/** Full usage + storage docs, surfaced by `--help`. */
function helpText(): string {
	return [
		"Usage: /api oauth <domain> [--status | --refresh | --revoke | --code <code>]",
		"  /api oauth <domain>          mint a token and stamp the token store",
		"                               (client_credentials: pure HTTP; authorization_code:",
		"                                authorize URL + paste the redirect URL back)",
		"  /api oauth <domain> --status metadata-only token state (no network)",
		"  /api oauth <domain> --refresh force a fresh token (auth-code: refresh via the",
		"                                stored refresh token, or a fresh authorize URL)",
		"  /api oauth <domain> --revoke  revoke at the guide's revokeUrl (if declared) and clear the store",
		"  /api oauth <domain> --code <code>  complete an auth-code flow with the pasted",
		"                                redirect URL (or bare code)",
		"  /api oauth                    list token-store domains (guide-independent);",
		"                                --status/--revoke on orphaned tokens use the literal domain",
		"",
		`Tokens are stored per-domain as JSON (0600) at ${getOAuthDir()}/<domain>.json.`,
		"The client secret lives in the secrets store (/api secrets <domain>), never here.",
	].join("\n");
}

function tokenState(token: OAuthToken): string {
	return isTokenExpired(token)
		? `expired${token.refreshToken ? " (refreshable)" : ""}`
		: "valid";
}

function tokenExpiry(token: OAuthToken): string {
	return token.expiresAt === undefined
		? "unknown"
		: new Date(token.expiresAt).toISOString();
}

/**
 * Handle the `oauth` subcommand of `/api`.
 *
 * @param args  The text after "oauth" ("" / "<domain>" / "<domain> <flag>")
 * @param ctx   The extension command context
 */
export async function handleOauthSubcommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);

	// `--help` (or `help`) short-circuits before domain dispatch.
	if (parts.includes("--help") || parts.includes("help")) {
		ctx.ui.notify(helpText(), "info");
		return;
	}

	const statusFlag = parts.includes("--status");
	const refreshFlag = parts.includes("--refresh");
	const revokeFlag = parts.includes("--revoke");
	const codeIdx = parts.indexOf("--code");
	const codeArg = codeIdx >= 0 ? parts[codeIdx + 1] : undefined;
	if (parts.includes("--code") && codeArg === undefined) {
		ctx.ui.notify(
			"Usage: /api oauth <domain> --code <code> — the code is missing.",
			"warning",
		);
		return;
	}
	const tokens = parts.filter(
		(p) =>
			p !== codeArg &&
			!["--status", "--refresh", "--revoke", "--code"].includes(p),
	);
	const domain = tokens[0];
	const selector = tokens[1];

	if (!domain) {
		// Bare `/api oauth` — list the token store (guide-independent).
		const domains = listTokenDomains();
		if (domains.length === 0) {
			ctx.ui.notify(
				"🔑 OAuth2 token store is empty. Provision a token with /api oauth <domain> (needs an oauth2 guide) — see /api oauth --help.",
				"info",
			);
			return;
		}
		const lines = ["🔑 OAuth2 token store:"];
		for (const d of domains) {
			const t = readToken(d);
			lines.push(
				t
					? `  ${d} — ${tokenState(t)}, expires ${tokenExpiry(t)}`
					: `  ${d} — unreadable`,
			);
		}
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// Resolve the guide by domain; only oauth2 guides are token-provisionable.
	const allMatches = findGuidesByDomain(domain);
	if (allMatches.length === 0) {
		// Guide-less fallback: tokens can outlive their guide, so --status /
		// --revoke work on the literal domain. Minting/refreshing still needs
		// the guide's tokenUrl + grant.
		if (statusFlag) {
			const token = readToken(domain);
			ctx.ui.notify(
				token
					? [
							`🔑 OAuth2 for '${domain}' (no guide)`,
							`  State: ${tokenState(token)}`,
							`  Expires: ${tokenExpiry(token)}`,
							...(token.refreshToken ? ["  Refresh token: present"] : []),
							...(token.scope ? [`  Scope: ${token.scope}`] : []),
						].join("\n")
					: `🔑 OAuth2 for '${domain}': no token.`,
				"info",
			);
			return;
		}
		if (revokeFlag) {
			if (!readToken(domain)) {
				ctx.ui.notify(`🔑 OAuth2 for '${domain}': no token.`, "info");
				return;
			}
			deletePendingFlow(domain);
			deleteToken(domain);
			ctx.ui.notify(
				`🔑 OAuth2 token for '${domain}' cleared locally — no guide, so provider-side revocation was not attempted.`,
				"info",
			);
			return;
		}
		ctx.ui.notify(
			`No API guide for '${domain}'. ` +
				`Call api-guide({}) to list available guides, or api-learn({domain: "${domain}"}) to author one.`,
			"warning",
		);
		return;
	}
	const matches = allMatches.filter(({ guide }) => guide.auth.kind === "oauth2");
	if (matches.length === 0) {
		ctx.ui.notify(
			`No OAuth2 guide for '${domain}' (${allMatches.length} guide(s) found, none with auth.kind: oauth2). ` +
				`Token provisioning needs an oauth2 guide.`,
			"warning",
		);
		return;
	}

	let selected: { guide: ApiGuide; dirName: string };
	if (matches.length === 1) {
		selected = matches[0]!;
	} else if (selector) {
		const sel = selectGuideByShortName(matches, selector);
		if (!sel.ok) {
			ctx.ui.notify(
				shortNameErrorText(
					sel,
					domain,
					selector,
					`Call /api oauth ${domain} to see the menu.`,
				),
				"warning",
			);
			return;
		}
		selected = sel;
	} else {
		// N oauth2 guides, no selector → interactive pick (TUI) or the menu
		// fallback (headless/RPC/print or cancelled), nothing run yet.
		const picked = await pickGuide(ctx, matches);
		if (!picked) {
			ctx.ui.notify(
				[
					`${matches.length} OAuth2 guides for '${domain}':`,
					formatGuideListings(matches),
					`Call /api oauth ${domain} <shortName> to pick one.`,
				].join("\n"),
				"info",
			);
			return;
		}
		selected = picked;
	}

	const { guide } = selected;
	const auth = guide.auth;
	if (auth.kind !== "oauth2") return; // unreachable — filtered above
	// Token store key is the canonical store domain, decoupled from the
	// routing `domain` (same rule as the secrets store).
	const storeDomain = canonicalStoreDomain(guide);

	if (revokeFlag) {
		await revokeAccessToken(auth, storeDomain);
		deletePendingFlow(storeDomain);
		ctx.ui.notify(
			`🔑 OAuth2 token for '${storeDomain}' revoked and cleared.`,
			"info",
		);
		return;
	}

	if (statusFlag) {
		const token = readToken(storeDomain);
		if (!token) {
			ctx.ui.notify(
				`🔑 OAuth2 for '${storeDomain}': no token. Run /api oauth ${storeDomain} to mint one.`,
				"info",
			);
			return;
		}
		const lines = [
			`🔑 OAuth2 for '${storeDomain}' (grant ${auth.grant})`,
			`  State: ${tokenState(token)}`,
			`  Expires: ${tokenExpiry(token)}`,
		];
		if (token.refreshToken) lines.push(`  Refresh token: present`);
		if (token.scope) lines.push(`  Scope: ${token.scope}`);
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// Mint (or refresh) a token. The token store is read fresh inside
	// resolveAccessToken, so a re-mint here is visible to the next api-fetch
	// call. authorization_code guides route through the paste flow (print the
	// authorize URL, user consents in their own browser, pastes the redirect
	// URL back); client_credentials stays pure HTTP.
	try {
		if (auth.grant === "authorization_code") {
			await mintAuthCodeToken(auth, storeDomain, ctx, {
				...(codeArg === undefined ? {} : { code: codeArg }),
				...(refreshFlag ? { refresh: true } : {}),
			});
		} else {
			if (refreshFlag) deleteToken(storeDomain);
			await resolveAccessToken(guide, storeDomain);
		}
	} catch (err) {
		if (err instanceof OAuthTokenMissingError) {
			ctx.ui.notify(`🔑 ${err.message}`, "warning");
			return;
		}
		ctx.ui.notify(
			`⚡ OAuth2 provisioning failed for '${storeDomain}': ` +
				`${err instanceof Error ? err.message : String(err)}`,
			"warning",
		);
		return;
	}
	ctx.ui.notify(
		`🔑 OAuth2 token for '${storeDomain}' ${refreshFlag ? "refreshed" : "provisioned"} (grant ${auth.grant}).`,
		"info",
	);
}
