/**
 * `/api oauth <domain>` — provision / inspect / revoke OAuth2 tokens.
 *
 * - `oauth <domain>`           — mint a token and stamp the token store.
 *   client_credentials: pure HTTP. authorization_code: print the authorize URL
 *   (redirect_uri = http://127.0.0.1/callback, RFC 8252 §7.3), the user
 *   consents in their own browser and pastes the redirect URL back — inline
 *   prompt (TUI) or `--code <redirect-url-or-code>` (headless/scripting).
 * - `oauth <domain> --status`  — metadata-only token state (no network).
 * - `oauth <domain> --refresh` — force a fresh token (client_credentials:
 *   re-mint; authorization_code: refresh via the stored refresh token, or a
 *   fresh authorize URL when there is none).
 * - `oauth <domain> --revoke`  — revoke at the provider's revokeUrl (if declared) and clear the store.
 *   Tokens live in slot-keyed store entries (`<grant>__<hash(tokenUrl)>` within
 *   one `<domain>.json`), so an app token and a user token coexist per domain.
 * - `oauth <domain> --code <code>` — complete an authorization-code flow with
 *   the pasted redirect URL (or bare code) from a previous authorize step.
 * - `oauth init <domain> [flags]` — guide-less bootstrap: provision
 *   a token without an oauth2 guide. Interactive wizard (ctx.hasUI) or headless
 *   flags (--grant --token-url --client-id [--client-secret] [--authorize-url]
 *   [--scopes] [--token-endpoint-auth-method]); auth-code completion is the
 *   two-call `init <domain> <same flags> --code <paste>`. Client credentials
 *   are secrets-store NAMES picked from what's provisioned — values never
 *   enter the transcript.
 * - `oauth` (bare)             — list token-store slots (domain · grant · issuer) with status metadata.
 *
 * Tokens can outlive their guide (deleted via /api delete, or minted while
 * testing), so bare listing, `--status`, and `--revoke` also work guide-less
 * (keyed by the literal domain; revoke is then local-only — no revokeUrl
 * without a guide). Minting/refreshing goes through the guide's flow, or
 * guide-less through `init`.
 *
 * Always-available / not focus-guarded — a peer of `secrets`/`verify`/`delete`
 * (writes the token store, not toolset state). The client secret lives in the
 * secrets store; only minted tokens land here.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findGuidesByDomain } from "./guide-store.js";
import { pickGuide } from "./guide-picker.js";
import { pickWithDescription, type PickerItem } from "./select-picker.js";
import {
	formatGuideListings,
	selectGuideByShortName,
	shortNameErrorText,
} from "./parse-api-guide.js";
import {
	buildSyntheticOAuth2Auth,
	canonicalStoreDomain,
	credentialNameGap,
	isTokenExpired,
	mintFreshClientCredentials,
	resolveAccessToken,
	resolveProvisionedParentDomain,
	revokeAccessToken,
	slotOverwriteWarning,
	OAuthTokenMissingError,
} from "./auth.js";
import type { SyntheticOAuth2Fields } from "./auth.js";
import {
	readToken,
	deleteToken,
	deletePendingFlow,
	readPendingFlow,
	listTokenDomains,
	listSlots,
	getOAuthDir,
} from "./oauth-store.js";
import type { OAuthToken } from "./oauth-store.js";
import { REDIRECT_URI, mintAuthCodeToken } from "./oauth-flow.js";
import { listNames } from "./secrets-store.js";
import type { ApiGuide, OAuth2Grant } from "./api-guide-types.js";

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
		"  /api oauth <domain> [--redirect-uri <url>]  override the default redirect URI",
		"                                (default http://127.0.0.1/callback; some providers",
		"                                require the localhost spelling or https — match your",
		"                                app registration; only matters for auth-code mint)",
		"  /api oauth init <domain>     guide-less bootstrap (no oauth2 guide needed):",
		"                               interactive wizard (TUI), or headless flags:",
		"                               --grant client_credentials|authorization_code",
		"                               --token-url <url> --client-id <store name>",
		"                               [--client-secret <store name>] [--authorize-url <url>]",
		"                               [--scopes a,b] [--token-endpoint-auth-method <method>]",
		"                               auth-code completion (headless two-call): /api oauth init",
		"                               <domain> <same flags> --code <redirect-url-or-code>",
		"  /api oauth                    list token-store domains (guide-independent);",
		"                                --status/--revoke on orphaned tokens accept an",
		"                                optional grant qualifier when the domain has 2+ slots",
		"",
		`Tokens are stored per-domain (0600) at ${getOAuthDir()}/<domain>.json, keyed by`,
		"slot = <grant>__<hash(tokenUrl)> — one domain can hold an app token and a user",
		"token (and tokens from two issuers) side by side. The client secret lives in",
		"the secrets store (/api secrets <domain>), never here.",
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

/** State/Expires/Refresh/Scope detail lines shared by both --status arms. */
function tokenDetailLines(token: OAuthToken): string[] {
	return [
		`  State: ${tokenState(token)}`,
		`  Expires: ${tokenExpiry(token)}`,
		...(token.refreshToken ? ["  Refresh token: present"] : []),
		...(token.scope ? [`  Scope: ${token.scope}`] : []),
	];
}

/** The grant qualifier accepted after a domain in `--status`/`--revoke`. */
const GRANT_QUALIFIERS: readonly OAuth2Grant[] = [
	"client_credentials",
	"authorization_code",
];

/** Render slot rows (grant · issuer · state) for a listing / usage error. */
function slotRows(
	slots: { grant: string; tokenUrl: string; token: OAuthToken }[],
): string {
	return slots
		.map((s) => `  · ${s.grant} · ${s.tokenUrl} — ${tokenState(s.token)}`)
		.join("\n");
}

/**
 * Shared `--flag <value>` grammar for both oauth command arms. Each name in
 * `valueFlags` consumes the following token as its value (position-based — a
 * value that happens to spell a flag name is never mistaken for one); names
 * in `boolFlags` are recognized bare; unknown `--flags` are rejected.
 */
type FlagParse =
	| {
			ok: true;
			flags: Record<string, string>;
			bools: Set<string>;
			positional: string[];
	  }
	| { ok: false; message: string };

function parseFlags(
	parts: readonly string[],
	valueFlags: readonly string[],
	boolFlags: readonly string[],
): FlagParse {
	const flags: Record<string, string> = {};
	const bools = new Set<string>();
	const positional: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (valueFlags.includes(p)) {
			const value = parts[i + 1];
			if (value === undefined) {
				return {
					ok: false,
					message: `Flag '${p}' is missing its value — see /api oauth --help.`,
				};
			}
			flags[p] = value;
			i++;
			continue;
		}
		if (boolFlags.includes(p)) {
			bools.add(p);
			continue;
		}
		if (p.startsWith("--")) {
			return {
				ok: false,
				message: `Unknown flag '${p}' — see /api oauth --help.`,
			};
		}
		positional.push(p);
	}
	return { ok: true, flags, bools, positional };
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

	// `init` subcommand — guide-less bootstrap. Its own flag
	// grammar, so it short-circuits before the plain-command parsing below.
	if (parts[0] === "init") {
		await handleOauthInit(args.trim().replace(/^init\b\s*/, ""), ctx);
		return;
	}

	const parsed = parseFlags(
		parts,
		["--code", "--redirect-uri"],
		["--status", "--refresh", "--revoke"],
	);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.message, "warning");
		return;
	}
	const statusFlag = parsed.bools.has("--status");
	const refreshFlag = parsed.bools.has("--refresh");
	const revokeFlag = parsed.bools.has("--revoke");
	// `--code` completes an auth-code flow with the pasted redirect URL (or
	// bare code); `--redirect-uri <url>` overrides the RFC 8252 default for
	// the mint arm — some providers constrain the spelling (Twitch: https or
	// `localhost`; OSM: unencrypted must be 127.0.0.1). Stored on the pending
	// flow, so the `--code` completion needs no flag.
	const codeArg = parsed.flags["--code"];
	const redirectUriArg = parsed.flags["--redirect-uri"];
	const domain = parsed.positional[0];
	const selector = parsed.positional[1];

	if (!domain) {
		// Bare `/api oauth` — list the token store (guide-independent).
		const domains = listTokenDomains();
		if (domains.length === 0) {
			ctx.ui.notify(
				"🔑 OAuth2 token store is empty. Provision a token with /api oauth <domain> (needs an oauth2 guide) or guide-less with /api oauth init <domain> — see /api oauth --help.",
				"info",
			);
			return;
		}
		const lines = ["🔑 OAuth2 token store:"];
		for (const d of domains) {
			const slots = listSlots(d);
			if (slots.length === 0) {
				lines.push(`  ${d} — unreadable`);
				continue;
			}
			for (const s of slots) {
				lines.push(
					`  ${d} · ${s.grant} · ${s.tokenUrl} — ${tokenState(s.token)}, expires ${tokenExpiry(s.token)}`,
				);
			}
		}
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// Resolve the guide by domain; only oauth2 guides are token-provisionable.
	const allMatches = findGuidesByDomain(domain);
	if (allMatches.length === 0) {
		// Guide-less fallback: tokens can outlive their guide, so --status /
		// --revoke work on the orphaned slots (all of them, or the one a grant
		// qualifier names when the domain has 2+). The lookup applies the same
		// parent-domain normalization `init` stamps with, so a subdomain spelling
		// still finds the slots. Minting/refreshing still needs auth facts.
		if (statusFlag || revokeFlag) {
			const storeDomain = resolveProvisionedParentDomain(domain);
			const qualifier = parsed.positional[1];
			if (
				qualifier !== undefined &&
				!GRANT_QUALIFIERS.includes(qualifier as OAuth2Grant)
			) {
				ctx.ui.notify(
					`Unknown grant qualifier '${qualifier}' — use client_credentials or authorization_code.`,
					"warning",
				);
				return;
			}
			const slots = listSlots(storeDomain);
			if (slots.length === 0) {
				ctx.ui.notify(
					`🔑 OAuth2 for '${storeDomain}' (no guide): no token.`,
					"info",
				);
				return;
			}
			const target =
				qualifier === undefined
					? slots
					: slots.filter((s) => s.grant === qualifier);
			if (target.length === 0) {
				ctx.ui.notify(
					`🔑 OAuth2 for '${storeDomain}' — no '${qualifier}' slot. Slots:\n` +
						slotRows(slots),
					"info",
				);
				return;
			}
			if (target.length > 1) {
				if (qualifier === undefined) {
					// 2+ slots and no qualifier — list + usage error, never a guess.
					ctx.ui.notify(
						`🔑 OAuth2 for '${storeDomain}' (no guide) has ${target.length} slots — pass the grant qualifier (client_credentials | authorization_code):\n` +
							slotRows(target),
						"info",
					);
					return;
				}
				// Same grant on two issuers behind one domain — the grant qualifier
				// alone can't disambiguate; list and stop, never a guess.
				ctx.ui.notify(
					`🔑 OAuth2 for '${storeDomain}' has ${target.length} '${qualifier}' slots (two issuers, same grant) — the grant qualifier alone can't disambiguate; use a guide-backed call.\n` +
						slotRows(target),
					"info",
				);
				return;
			}
			const slot = target[0]!;
			if (statusFlag) {
				const pending = readPendingFlow(storeDomain, slot.grant, slot.tokenUrl);
				ctx.ui.notify(
					[
						`🔑 OAuth2 for '${storeDomain}' (no guide) — slot ${slot.grant}`,
						`  Token URL: ${slot.tokenUrl}`,
						...tokenDetailLines(slot.token),
						...(pending ? ["  Pending flow: awaiting --code paste"] : []),
					].join("\n"),
					"info",
				);
				return;
			}
			// revoke — guide-less, so provider-side revocation isn't possible.
			// The slot's record is stamped (grant + tokenUrl), so these facts
			// round-trip the exact slot key the record was written under.
			deletePendingFlow(storeDomain, slot.grant, slot.tokenUrl);
			deleteToken(storeDomain, slot.grant, slot.tokenUrl);
			ctx.ui.notify(
				`🔑 OAuth2 token slot (${slot.grant}) for '${storeDomain}' cleared locally — no guide, so provider-side revocation was not attempted.`,
				"info",
			);
			return;
		}
		ctx.ui.notify(
			`No API guide for '${domain}'. ` +
				`Call api-guide({}) to list available guides, or api-learn({domain: "${domain}"}) to author one. ` +
				`To bootstrap a token guide-less, run: /api oauth init ${domain}.`,
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
		// Slot-scoped: a bare pending delete would leave a stale verifier for a
		// sibling-grant/prior-issuer slot to consume.
		deletePendingFlow(storeDomain, auth.grant, auth.tokenUrl);
		ctx.ui.notify(
			`🔑 OAuth2 token for '${storeDomain}' revoked and cleared.`,
			"info",
		);
		return;
	}

	if (statusFlag) {
		const token = readToken(storeDomain, auth.grant, auth.tokenUrl);
		if (!token) {
			ctx.ui.notify(
				`🔑 OAuth2 for '${storeDomain}': no token. Run /api oauth ${storeDomain} to mint one.`,
				"info",
			);
			return;
		}
		const lines = [
			`🔑 OAuth2 for '${storeDomain}' (grant ${auth.grant})`,
			...tokenDetailLines(token),
		];
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// Mint (or refresh) a token. The token store is read fresh inside
	// resolveAccessToken, so a re-mint here is visible to the next api-fetch
	// call. authorization_code guides route through the paste flow (print the
	// authorize URL, user consents in their own browser, pastes the redirect
	// URL back); client_credentials stays pure HTTP.
	if (
		auth.grant !== "authorization_code" &&
		(codeArg !== undefined || redirectUriArg !== undefined)
	) {
		ctx.ui.notify(authCodeOnlyFlagsNote(storeDomain, auth.grant), "warning");
		return;
	}
	try {
		if (auth.grant === "authorization_code") {
			await mintAuthCodeToken(auth, storeDomain, ctx, {
				...(codeArg === undefined ? {} : { code: codeArg }),
				...(refreshFlag ? { refresh: true } : {}),
				...(redirectUriArg === undefined ? {} : { redirectUri: redirectUriArg }),
			});
		} else {
			// Cached token resolves as-is; the delete is conditional on --refresh
			// (unlike the bootstrap paths, which always want a fresh mint).
			if (refreshFlag) deleteToken(storeDomain, auth.grant, auth.tokenUrl);
			await resolveAccessToken(auth, storeDomain);
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

// ═══════════════════════════════════════════════════════════════
// init — guide-less OAuth2 bootstrap
// ═══════════════════════════════════════════════════════════════

const INIT_USAGE = [
	"Usage: /api oauth init <domain> [flags] — guide-less OAuth2 bootstrap (no oauth2 guide needed).",
	"  Flags (headless/scripting; TUI users get a wizard instead):",
	"    --grant client_credentials|authorization_code   (inferred from --authorize-url when omitted)",
	"    --token-url <url>            token endpoint",
	"    --client-id <store name>     provisioned secrets-store NAME (never a literal)",
	"    --client-secret <store name> required for client_credentials",
	"    --authorize-url <url>        required for authorization_code",
	"    --scopes a,b                 comma-separated",
	"    --token-endpoint-auth-method client_secret_post|client_secret_basic|none",
	"    --redirect-uri <url>         override the default redirect URI (default",
	"                                 http://127.0.0.1/callback — match your app registration;",
	"                                 the TUI wizard prompts for this too)",
	"  auth-code completion (headless two-call): re-run with the same flags + --code <redirect-url-or-code>.",
	"  Client credentials are store names resolved from the secrets store — values never enter the transcript.",
].join("\n");

/** Flags with values the `init` grammar understands. */
const INIT_FLAG_NAMES: readonly string[] = [
	"--grant",
	"--token-url",
	"--authorize-url",
	"--client-id",
	"--client-secret",
	"--scopes",
	"--token-endpoint-auth-method",
	"--redirect-uri",
	"--code",
];

/**
 * Serialize SyntheticOAuth2Fields into the init flag grammar above. Lives
 * next to INIT_FLAG_NAMES so a flag rename here can't silently drift the
 * escape-hatch hint oauth-mint emits.
 */
export function initFlagsFromFields(fields: SyntheticOAuth2Fields): string[] {
	return [
		`--grant ${fields.grant}`,
		`--token-url ${fields.tokenUrl}`,
		...(fields.authorizeUrl === undefined
			? []
			: [`--authorize-url ${fields.authorizeUrl}`]),
		`--client-id ${fields.clientId}`,
		...(fields.clientSecret === undefined
			? []
			: [`--client-secret ${fields.clientSecret}`]),
		...(fields.tokenEndpointAuthMethod === undefined
			? []
			: [`--token-endpoint-auth-method ${fields.tokenEndpointAuthMethod}`]),
	];
}

/** Wizard picker option meaning "no client secret" (PKCE public client). */
const OMIT_SECRET = "(omit — PKCE public client)";

/**
 * `/api oauth init <domain>` — provision a token WITHOUT an oauth2 guide.
 * The interactive grant's bootstrap previously required authoring a
 * throwaway draft guide first; the wizard dissolves that asymmetry with
 * client-credentials (which probe mint-on-demand already solved). The wizard collects flow facts (grant, tokenUrl, authorizeUrl,
 * store-NAME credentials) into a synthetic oauth2 auth and feeds the
 * EXISTING flow machinery (`mintAuthCodeToken` / `resolveAccessToken`) —
 * no new mint mechanism, no schema change, nothing saved.
 *
 * Interactive (ctx.hasUI, no flags) → wizard prompts mirroring the
 * `secrets-command` assisted-entry precedent. Headless or scripted → the
 * flag one-shot acts directly (the same split the paste flow already uses).
 * Token-store keying applies the probe's parent-domain normalization
 * (longest provisioned parent in the SECRETS store); a normalized stamp is
 * called out so it doesn't go invisible to the eventual guide.
 */
/** Shared refusal prose for auth-code-only flags on a pure-HTTP mint arm
 *  (plain command + init wizard — one message, one place). */
function authCodeOnlyFlagsNote(storeDomain: string, grant: string): string {
	return (
		"--code and --redirect-uri apply only to the authorization_code grant — " +
		`'${storeDomain}' mints via ${grant} (pure HTTP, nothing to paste).`
	);
}

async function handleOauthInit(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);

	// Parse the flag grammar (shared with the plain command): each known flag
	// consumes one value; anything else is a positional (exactly one — the
	// domain).
	const parsed = parseFlags(parts, INIT_FLAG_NAMES, []);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.message, "warning");
		return;
	}
	const flags = parsed.flags;
	const domain = parsed.positional[0];
	if (domain === undefined || parsed.positional.length > 1) {
		ctx.ui.notify(INIT_USAGE, "info");
		return;
	}
	const codeArg = flags["--code"];

	// Token-store key wrinkle: normalize against the SECRETS store (same
	// longest-provisioned-parent lookup the probe uses) so a bootstrap as
	// `api.example.org` lands where a guide keyed `example.org` looks.
	// No provisioned match → use the domain as given (fail at exchange,
	// not silently).
	const storeDomain = resolveProvisionedParentDomain(domain);
	const viaFlags = Object.keys(flags).length > 0;

	let fields: SyntheticOAuth2Fields;
	let wizardRedirectUri: string | undefined;
	if (viaFlags) {
		const scopesRaw = flags["--scopes"];
		const grant =
			flags["--grant"] ??
			(flags["--authorize-url"] === undefined
				? "client_credentials"
				: "authorization_code");
		const methodFlag = flags["--token-endpoint-auth-method"];
		fields = {
			grant: grant as SyntheticOAuth2Fields["grant"],
			tokenUrl: flags["--token-url"] ?? "",
			clientId: flags["--client-id"] ?? "",
			...(flags["--client-secret"] === undefined
				? {}
				: { clientSecret: flags["--client-secret"] }),
			...(flags["--authorize-url"] === undefined
				? {}
				: { authorizeUrl: flags["--authorize-url"] }),
			...(scopesRaw === undefined
				? {}
				: {
						scopes: scopesRaw
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean),
					}),
			...(methodFlag === undefined
				? {}
				: {
						tokenEndpointAuthMethod: methodFlag as NonNullable<
							SyntheticOAuth2Fields["tokenEndpointAuthMethod"]
						>,
					}),
		};
	} else if (ctx.hasUI) {
		const gathered = await wizardFields(ctx, storeDomain);
		if (gathered === undefined) return; // cancelled / aborted (message shown)
		fields = gathered.fields;
		wizardRedirectUri = gathered.redirectUri;
	} else {
		ctx.ui.notify(INIT_USAGE, "info");
		return;
	}

	let synthetic;
	try {
		synthetic = buildSyntheticOAuth2Auth(fields);
	} catch (err) {
		ctx.ui.notify(
			`⚡ ${err instanceof Error ? err.message : String(err)}\n\n${INIT_USAGE}`,
			"warning",
		);
		return;
	}

	// Store-name rule (hard): every credential is a provisioned store NAME,
	// resolved at flow time. A miss points at /api secrets — never a value
	// prompt, never a free-typed literal.
	const gap = credentialNameGap(
		storeDomain,
		fields.clientId,
		fields.clientSecret,
	);
	if (gap !== null) {
		ctx.ui.notify(gap, "warning");
		return;
	}

	const provisionedMsg = () => {
		const lines = [
			`🔑 OAuth2 token for '${storeDomain}' provisioned via /api oauth init (grant ${synthetic.grant}).`,
		];
		if (storeDomain !== domain) {
			// Ordering dependency the plan calls out: normalization matched the
			// SECRETS store, but the eventual guide keys on its domains[0].
			lines.push(
				`Note: provision secrets under the same domain the guide will claim as domains[0] — the token was stamped at '${storeDomain}' (normalized from '${domain}').`,
			);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	};

	// auth-code-only flags: --code / --redirect-uri do nothing on a
	// client_credentials mint — refuse loudly instead of reporting success
	// while the flag did nothing.
	if (
		synthetic.grant !== "authorization_code" &&
		(codeArg !== undefined || flags["--redirect-uri"] !== undefined)
	) {
		ctx.ui.notify(authCodeOnlyFlagsNote(storeDomain, synthetic.grant), "warning");
		return;
	}

	try {
		if (codeArg !== undefined) {
			// Headless two-call completion: reconstruct the synthetic auth from
			// the same flags used to start; the pending flow holds verifier+state.
			await mintAuthCodeToken(synthetic, storeDomain, ctx, { code: codeArg });
			provisionedMsg();
			return;
		}
		if (synthetic.grant === "client_credentials") {
			// Bootstrap wants a fresh mint, not a cached token (mirrors the
			// plain command's --refresh path).
			const overwrite = slotOverwriteWarning(synthetic, storeDomain);
			if (overwrite) ctx.ui.notify(overwrite, "warning");
			await mintFreshClientCredentials(synthetic, storeDomain);
			provisionedMsg();
			return;
		}
		// authorization_code start: prints the authorize URL and persists the
		// pending flow (including the redirect URI, so the --code completion
		// exchanges with the same value); interactive users complete inline,
		// headless awaits `init ... --code`.
		const mintRedirectUri = flags["--redirect-uri"] ?? wizardRedirectUri;
		try {
			await mintAuthCodeToken(
				synthetic,
				storeDomain,
				ctx,
				mintRedirectUri === undefined ? {} : { redirectUri: mintRedirectUri },
			);
			provisionedMsg();
		} catch (err) {
			if (!(err instanceof OAuthTokenMissingError)) throw err;
			if (viaFlags) {
				// Headless start: the pending flow survived — teach the init-owned
				// completion call (reconstructs the synthetic auth from flags).
				ctx.ui.notify(
					`🔑 Awaiting the OAuth2 authorization result for '${storeDomain}'. ` +
						`Open the URL above, authorize, then complete:\n` +
						`  /api oauth init ${args.trim()} --code <redirect-url-or-code>`,
					"info",
				);
			} else {
				// Wizard user cancelled the paste prompt — flags-based completion
				// isn't available to them; a re-run generates a fresh URL.
				ctx.ui.notify(
					`🔑 Cancelled. Re-run /api oauth init ${domain} to generate a fresh authorize URL (or complete with flags + --code).`,
					"info",
				);
			}
		}
	} catch (err) {
		if (err instanceof OAuthTokenMissingError) {
			ctx.ui.notify(`🔑 ${err.message}`, "warning");
			return;
		}
		ctx.ui.notify(
			`⚡ OAuth2 bootstrap failed for '${storeDomain}': ` +
				`${err instanceof Error ? err.message : String(err)}`,
			"warning",
		);
	}
}

/**
 * Interactive wizard — the wizard branch tree is deliberately short: grant → tokenUrl → client credentials as
 * store NAMES from a picker → auth-code extras. DPoP, PAR, device flow, JWT
 * assertions etc. must NOT grow wizard branches — this is a provisioning aid,
 * not an OAuth playground. Returns undefined when the user cancels/aborts.
 */
const GRANT_ITEMS: PickerItem[] = [
	{
		value: "client_credentials",
		label: "client_credentials",
		description: "Server-to-server — no browser; one POST to the token endpoint.",
	},
	{
		value: "authorization_code",
		label: "authorization_code",
		description:
			"Consent in your own browser (PKCE), then paste the redirect URL back.",
	},
];

const AUTH_METHOD_ITEMS: PickerItem[] = [
	{
		value: "client_secret_post",
		label: "client_secret_post",
		description: "Credentials in the token-POST body.",
	},
	{
		value: "client_secret_basic",
		label: "client_secret_basic",
		description: "Credentials in a Basic Authorization header.",
	},
];

async function wizardFields(
	ctx: ExtensionCommandContext,
	storeDomain: string,
): Promise<
	{ fields: SyntheticOAuth2Fields; redirectUri?: string } | undefined
> {
	const cancelled = () =>
		ctx.ui.notify("Cancelled — nothing provisioned.", "info");

	const grant = await pickWithDescription(
		ctx,
		`OAuth2 grant for '${storeDomain}'`,
		GRANT_ITEMS,
	);
	if (grant === undefined) {
		await cancelled();
		return undefined;
	}
	let redirectUri: string | undefined;
	if (grant === "authorization_code") {
		// Ask first: the redirect URI is a fact of the user's app registration,
		// not the provider's API — if it isn't registered at the provider,
		// nothing later in the wizard matters, so fail fast (empty keeps the
		// RFC 8252 convention). The pending flow carries it through to the
		// --code exchange (RFC 6749 §4.1.3).
		const raw = (
			await ctx.ui.input(
				`Redirect URI — make sure your provider app has this registered (empty for the default ${REDIRECT_URI})`,
				REDIRECT_URI,
			)
		)?.trim();
		if (raw === undefined) {
			await cancelled();
			return undefined;
		}
		if (raw !== "") redirectUri = raw;
	}
	const tokenUrl = (
		await ctx.ui.input(
			`Token endpoint URL for '${storeDomain}'`,
			"https://provider.example.com/oauth/token",
		)
	)?.trim();
	if (!tokenUrl) {
		await cancelled();
		return undefined;
	}
	// Store-name rule: client-id/secret are picked from provisioned secrets —
	// never values, never free-typed literals (the /api secrets audit rule).
	const names = listNames(storeDomain);
	if (names.length === 0) {
		ctx.ui.notify(
			`No provisioned secrets for '${storeDomain}' — client credentials are store NAMES, never free-typed literals. ` +
				`Provision them first: /api secrets ${storeDomain} <name>.`,
			"warning",
		);
		return undefined;
	}
	const clientId = await ctx.ui.select(
		`client-id STORE NAME for '${storeDomain}' (value resolves from the store)`,
		names,
	);
	if (clientId === undefined) {
		await cancelled();
		return undefined;
	}
	const clientSecret = await ctx.ui.select(
		`client-secret STORE NAME for '${storeDomain}'`,
		grant === "client_credentials" ? names : [OMIT_SECRET, ...names],
	);
	if (clientSecret === undefined) {
		await cancelled();
		return undefined;
	}
	if (grant === "client_credentials") {
		return {
			fields: {
				grant: "client_credentials",
				tokenUrl,
				clientId,
				clientSecret: clientSecret!,
			},
		};
	}
	const authorizeUrl = (
		await ctx.ui.input(
			`Authorization endpoint URL for '${storeDomain}'`,
			"https://provider.example.com/oauth/authorize",
		)
	)?.trim();
	if (!authorizeUrl) {
		await cancelled();
		return undefined;
	}
	const scopesRaw = await ctx.ui.input(
		"Scopes (comma-separated)",
		"e.g. read,profile — empty to skip",
	);
	if (scopesRaw === undefined) {
		await cancelled();
		return undefined;
	}
	const scopes = scopesRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// A public PKCE client (secret omitted) sends no client credentials —
	// method is forced to none; the prompt only fires when a secret was chosen.
	const tokenEndpointAuthMethod =
		clientSecret === OMIT_SECRET
			? ("none" as const)
			: await pickWithDescription(
					ctx,
					"Token-endpoint auth method",
					AUTH_METHOD_ITEMS,
				);
	if (clientSecret !== OMIT_SECRET && tokenEndpointAuthMethod === undefined) {
		await cancelled();
		return undefined;
	}
	return {
		fields: {
			grant: grant as SyntheticOAuth2Fields["grant"],
			tokenUrl,
			clientId,
			...(clientSecret === OMIT_SECRET ? {} : { clientSecret: clientSecret! }),
			authorizeUrl,
			...(scopes.length > 0 ? { scopes } : {}),
			...(tokenEndpointAuthMethod === undefined
				? {}
				: {
						tokenEndpointAuthMethod: tokenEndpointAuthMethod as NonNullable<
							SyntheticOAuth2Fields["tokenEndpointAuthMethod"]
						>,
					}),
		},
		...(redirectUri === undefined ? {} : { redirectUri }),
	};
}
