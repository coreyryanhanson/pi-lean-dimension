/**
 * oauth-mint tool definition.
 *
 * The human-in-the-loop mint of the agent-driven OAuth2 bootstrap
 * (docs/design/oauth2-agent-bootstrap.md — Phase 2.8). The agent supplies all
 * researched parameters (grant, tokenUrl, authorizeUrl, scopes as
 * {name, description} pairs, client credentials as STORE NAMES); the tool
 * does only what the agent cannot: fail-closed validation, store-name
 * precheck, the token-URL confirm prompt (the human is the trust root for the
 * secret-bearing destination), the scopes checklist picker, the paste prompt
 * (the redirect URL never enters the transcript), and the mint/stamp via the
 * existing `mintAuthCodeToken` / `resolveAccessToken` machinery.
 *
 * Prompt order is deliberate (cheapest-to-cancel first): confirm → picker →
 * paste. A cancel at the confirm or picker never discards a completed browser
 * authorization. Any cancel throws with the two-call `init … --code`
 * escape-hatch hint (plain `/api oauth <domain> --code` cannot complete
 * guide-less; bootstrap is guide-less by definition).
 *
 * Learn-gated: rides the existing `pi-lean-dimension.api-learn` ToolsetSpec —
 * no new spec, no runtime re-gate (masking is the gate).
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
	buildSyntheticOAuth2Auth,
	resolveAccessToken,
	resolveProvisionedParentDomain,
	OAuthTokenMissingError,
} from "../core/auth.js";
import type { SyntheticOAuth2Fields } from "../core/auth.js";
import { listNames } from "../core/secrets-store.js";
import { deleteToken } from "../core/oauth-store.js";
import { mintAuthCodeToken } from "../core/oauth-flow.js";
import { pickChecklist } from "../core/select-picker.js";
import { appendFooter } from "./utils.js";

/** The exact two-call completion command for the escape-hatch hint (D1). */
export function escapeHatchCommand(
	domain: string,
	fields: SyntheticOAuth2Fields,
): string {
	const flags = [
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
	return `/api oauth init ${domain} ${flags.join(" ")} --code <redirect-url-or-code>`;
}

function cancelledError(domain: string, fields: SyntheticOAuth2Fields): Error {
	return new Error(
		`OAuth2 mint cancelled — nothing was provisioned. ` +
			`Stop and ask the user how to proceed (a re-call starts a FRESH authorization). ` +
			`If they already authorized in their browser, they can finish without re-consenting via: ` +
			escapeHatchCommand(domain, fields),
	);
}

export const oauthMintTool = defineTool({
	name: "oauth-mint",
	label: "OAuth Mint",
	description:
		"Mint an OAuth2 token for a domain and stamp the token store — call AFTER you have researched " +
		"the provider's OAuth2 shape; this tool performs no discovery. Prompts the human to confirm " +
		"the token endpoint, select scopes, and paste the redirect URL; returns granted scopes + store domain.",

	promptGuidelines: [
		"The agent researches the provider's OAuth2 shape; this tool does no discovery — supply grant, tokenUrl, authorizeUrl, scopes, and credentials from your research.",
		"Never for static-key / API-key providers — use api-probe's inline auth or /api secrets instead.",
		"clientId / clientSecret are secrets-store NAMES, never literal values.",
		"If the user cancels a prompt, STOP and ask how to proceed — never auto-re-call. A re-call starts a fresh authorization; the cancel error prints the /api oauth init … --code two-call form to finish without re-consenting.",
	],

	parameters: Type.Object({
		domain: Type.String({
			description:
				"Token-store domain (e.g. 'openstreetmap.org'). Normalized against provisioned secrets; the token stamps there.",
		}),
		grant: Type.Union(
			[Type.Literal("client_credentials"), Type.Literal("authorization_code")],
			{
				description:
					"OAuth2 grant. authorization_code = interactive paste dance (PKCE).",
			},
		),
		tokenUrl: Type.String({
			description:
				"The provider's token endpoint (exchanges credentials/codes for tokens).",
		}),
		clientId: Type.String({
			description:
				"client-id STORE NAME from the secrets store — never a literal value.",
		}),
		clientSecret: Type.Optional(
			Type.String({
				description:
					"client-secret STORE NAME; required for client_credentials, omit for PKCE public clients.",
			}),
		),
		authorizeUrl: Type.Optional(
			Type.String({
				description: "Authorization endpoint (authorization_code only).",
			}),
		),
		scopes: Type.Optional(
			Type.Array(
				Type.Object({
					name: Type.String({
						description: "Scope name as the provider defines it.",
					}),
					description: Type.Optional(
						Type.String({
							description:
								"One line on what granting it allows — shown in the picker.",
						}),
					),
				}),
				{
					description:
						"Scopes to offer the human as a ✓/○ checklist (research what each means).",
				},
			),
		),
		tokenEndpointAuthMethod: Type.Optional(
			Type.Union(
				[
					Type.Literal("client_secret_basic"),
					Type.Literal("client_secret_post"),
					Type.Literal("none"),
				],
				{
					description:
						"How the client authenticates at the token endpoint (default client_secret_post).",
				},
			),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const p = params as {
			domain: string;
			grant: "client_credentials" | "authorization_code";
			tokenUrl: string;
			clientId: string;
			clientSecret?: string;
			authorizeUrl?: string;
			scopes?: { name: string; description?: string }[];
			tokenEndpointAuthMethod?:
				| "client_secret_basic"
				| "client_secret_post"
				| "none";
		};

		// H1 — one guard at the top; no degraded half-flow.
		if (!ctx.hasUI) {
			throw new Error(
				"oauth-mint requires an interactive session — use the `/api oauth init <domain> --grant … --token-url …` flags instead, or run pi interactively.",
			);
		}

		// Fail-closed validation of ALL params before any prompt (throws on any
		// invalid combination — the return value is rebuilt after scope picking).
		const fields: SyntheticOAuth2Fields = {
			grant: p.grant,
			tokenUrl: p.tokenUrl,
			clientId: p.clientId,
			...(p.clientSecret === undefined ? {} : { clientSecret: p.clientSecret }),
			...(p.authorizeUrl === undefined ? {} : { authorizeUrl: p.authorizeUrl }),
			...(p.scopes === undefined ? {} : { scopes: p.scopes.map((s) => s.name) }),
			...(p.tokenEndpointAuthMethod === undefined
				? {}
				: { tokenEndpointAuthMethod: p.tokenEndpointAuthMethod }),
		};
		buildSyntheticOAuth2Auth(fields);

		// Token-store keying: same longest-provisioned-parent normalization the
		// init wizard and probe use (matched against the SECRETS store).
		const storeDomain = resolveProvisionedParentDomain(p.domain);

		// Store-name precheck BEFORE any prompt (D1).
		const provisioned = listNames(storeDomain);
		const requiredNames = [
			fields.clientId,
			...(fields.clientSecret === undefined ? [] : [fields.clientSecret]),
		];
		const missing = requiredNames.filter((n) => !provisioned.includes(n));
		if (missing.length > 0) {
			throw new Error(
				`OAuth2 client credentials must be provisioned secrets-store NAMES, but ${missing.map((n) => `'${n}'`).join(", ")} ` +
					`are not in the store for '${storeDomain}'. Ask the user to provision them first: ` +
					`/api secrets ${storeDomain} <name> (values never enter the transcript).`,
			);
		}

		// Token-URL confirm — the FIRST prompt, both grants, before any
		// exchange: tokenUrl is the one agent-supplied parameter that receives
		// secret values, and the agent's research source is untrusted.
		const confirmed = await ctx.ui.confirm(
			`Confirm the token endpoint for '${storeDomain}'`,
			`Exchange credentials at ${p.tokenUrl} (client: '${p.clientId}')? The client secret is sent to this URL.`,
		);
		if (!confirmed) throw cancelledError(p.domain, fields);

		// Scopes checklist — the human's affirmative grant. No scopes → skip.
		let pickedScopes: string[] | undefined;
		if (p.scopes !== undefined && p.scopes.length > 0) {
			const picked = await pickChecklist(
				ctx,
				`Scopes to grant for '${storeDomain}'`,
				p.scopes.map((s) => ({
					value: s.name,
					label: s.name,
					...(s.description === undefined ? {} : { description: s.description }),
				})),
			);
			if (picked === undefined) throw cancelledError(p.domain, fields);
			pickedScopes = picked;
		}

		const finalFields: SyntheticOAuth2Fields = {
			...fields,
			...(pickedScopes === undefined ? {} : { scopes: pickedScopes }),
		};
		const finalSynthetic = buildSyntheticOAuth2Auth(finalFields);

		try {
			if (finalSynthetic.grant === "client_credentials") {
				// Bootstrap wants a fresh mint, not a cached token (mirrors the
				// init wizard / --refresh path).
				deleteToken(storeDomain);
				await resolveAccessToken(finalSynthetic, storeDomain);
			} else {
				// Prints the authorize URL + paste prompt (retry loop inside);
				// cancel lands in the OAuthTokenMissingError handler below.
				await mintAuthCodeToken(finalSynthetic, storeDomain, ctx, {});
			}
		} catch (err) {
			if (err instanceof OAuthTokenMissingError)
				throw cancelledError(p.domain, fields);
			throw err;
		}

		const granted = pickedScopes ?? [];
		const scopeLine =
			granted.length > 0
				? ` Granted scopes: ${granted.join(", ")}.`
				: " No scopes requested.";
		return {
			content: [
				{
					type: "text",
					text:
						`🔑 OAuth2 token minted for '${storeDomain}' (grant ${finalSynthetic.grant}).${scopeLine}\n` +
						`Report the granted scopes and store domain to the user.`,
				},
			],
			details: {
				mode: "minted",
				domain: storeDomain,
				grant: finalSynthetic.grant,
				...(granted.length > 0 ? { scopes: granted } : {}),
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts = [theme.fg("toolTitle", theme.bold("oauth-mint "))];
		const a = args as { domain?: string; grant?: string };
		parts.push(theme.fg("accent", `"${a.domain ?? "?"}"`));
		if (a.grant) parts.push(theme.fg("dim", a.grant));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded }, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		const grant = d?.grant as string | undefined;
		const text =
			theme.fg("accent", theme.bold("🔑 minted")) +
			theme.fg("dim", ` — ${d?.domain ?? "?"} (${grant ?? "?"})`);
		return new Text(appendFooter(text, expanded, result, theme, 400), 0, 0);
	},
});
