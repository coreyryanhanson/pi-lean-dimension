/**
 * `/api oauth <domain>` — provision / inspect / revoke OAuth2 tokens.
 *
 * - `oauth <domain>`           — mint a client-credentials token and stamp the token store.
 * - `oauth <domain> --status`  — metadata-only token state (no network).
 * - `oauth <domain> --refresh` — force a fresh token (delete + re-mint).
 * - `oauth <domain> --revoke`  — revoke at the provider's revokeUrl (if declared) and clear the store.
 *
 * Always-available / not focus-guarded — a peer of `secrets`/`verify`/`delete`
 * (writes the token store, not toolset state). The client secret lives in the
 * secrets store; only minted tokens land here. The interactive auth-code flow
 * (loopback listener + user's own browser) is Phase 2 — for now an
 * authorization_code guide without a token nudges to the not-yet interactive
 * flow.
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
import { readToken, deleteToken, getOAuthDir } from "./oauth-store.js";
import type { ApiGuide } from "./api-guide-types.js";

/** Full usage + storage docs, surfaced by `--help`. */
function helpText(): string {
	return [
		"Usage: /api oauth <domain> [--status | --refresh | --revoke]",
		"  /api oauth <domain>          mint a client-credentials token and stamp the token store",
		"  /api oauth <domain> --status metadata-only token state (no network)",
		"  /api oauth <domain> --refresh force a fresh token (re-mint)",
		"  /api oauth <domain> --revoke  revoke at the guide's revokeUrl (if declared) and clear the store",
		"",
		`Tokens are stored per-domain as JSON (0600) at ${getOAuthDir()}/<domain>.json.`,
		"The client secret lives in the secrets store (/api secrets <domain>), never here.",
	].join("\n");
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
	const tokens = parts.filter(
		(p) => !["--status", "--refresh", "--revoke"].includes(p),
	);
	const domain = tokens[0];
	const selector = tokens[1];

	if (!domain) {
		ctx.ui.notify(
			"Usage: /api oauth <domain> [--status | --refresh | --revoke] — see /api oauth --help.",
			"warning",
		);
		return;
	}

	// Resolve the guide by domain; only oauth2 guides are token-provisionable.
	const allMatches = findGuidesByDomain(domain);
	if (allMatches.length === 0) {
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
		const state = isTokenExpired(token)
			? `expired${token.refreshToken ? " (refreshable)" : ""}`
			: "valid";
		const expiry =
			token.expiresAt === undefined
				? "unknown"
				: new Date(token.expiresAt).toISOString();
		const lines = [
			`🔑 OAuth2 for '${storeDomain}' (grant ${auth.grant})`,
			`  State: ${state}`,
			`  Expires: ${expiry}`,
		];
		if (token.refreshToken) lines.push(`  Refresh token: present`);
		if (token.scope) lines.push(`  Scope: ${token.scope}`);
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// Mint (or, with --refresh, delete-then-re-mint). The token store is read
	// fresh inside resolveAccessToken, so a re-mint here is visible to the
	// next api-fetch call.
	if (refreshFlag) deleteToken(storeDomain);
	try {
		await resolveAccessToken(guide, storeDomain);
	} catch (err) {
		if (err instanceof OAuthTokenMissingError) {
			ctx.ui.notify(`🔑 ${err.message}`, "warning");
			return;
		}
		ctx.ui.notify(
			`🔑 OAuth2 provisioning failed for '${storeDomain}': ` +
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
