/**
 * oauth-mint tool — the human-in-the-loop mint of the agent-driven OAuth2
 * bootstrap. Mocked transport + mocked ctx.ui, mirroring
 * __tests__/oauth-command.test.ts idioms. Covers the locked test strategy:
 *  - headless throw before any prompt;
 *  - store-name precheck fires BEFORE any prompt (confirm never called);
 *  - the endpoint confirm is the FIRST prompt on BOTH grant arms (cc: plain
 *    confirm; auth-code: a combined select that proposes endpoint + redirect
 *    URI, with "Change redirect URI" dropping to an edit input that loops
 *    back — a typed override reaches the token exchange);
 *  - confirm (cc) / select-Esc / redirect-URI cancel / picker / paste cancel
 *    each throw the two-call `init … --code`
 *    escape-hatch hint built from the tool's own parameters;
 *  - scopes picker grant flows into the token request; all-unchecked Done
 *    grants nothing;
 *  - success summary carries granted scopes + store domain and NO token
 *    material;
 *  - pickChecklist component: toggle → Done proceeds; Esc cancels (driven
 *    through the captured ctx.ui.custom factory).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oauthMintTool, escapeHatchCommand } from "../tools/oauth-mint.js";
import { REDIRECT_URI } from "../core/oauth-flow.js";
import {
	readToken,
	readPendingFlow,
	writeToken,
	setOAuthDir,
} from "../core/oauth-store.js";
import { writeSecret, setSecretsDir } from "../core/secrets-store.js";
import { pickChecklist } from "../core/select-picker.js";

const TOKEN_URL = "https://token.example.com/oauth/token";
const AUTHORIZE_URL = "https://auth.example.com/oauth/authorize";

let tmpSecrets: string;
let tmpOAuth: string;

beforeAll(() => {
	tmpSecrets = mkdtempSync(join(tmpdir(), "host-mint-secrets-"));
	tmpOAuth = mkdtempSync(join(tmpdir(), "host-mint-tokens-"));
	setSecretsDir(tmpSecrets);
	setOAuthDir(tmpOAuth);
});

afterAll(() => {
	vi.unstubAllGlobals();
	rmSync(tmpSecrets, { recursive: true, force: true });
	rmSync(tmpOAuth, { recursive: true, force: true });
});

function stubTokenEndpoint(
	handler: (url: string, init: RequestInit) => Response,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn((url: unknown, init?: RequestInit) =>
		Promise.resolve(handler(String(url), init ?? {})),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function tokenResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Tool-context fake (ExtensionContext shape). `calls` records the prompt
 * order across confirm/input/custom so the prompt-order guarantee is
 * assertable.
 */
function makeToolCtx(
	opts: {
		hasUI?: boolean;
		mode?: string;
		confirm?: boolean | ((title: string, msg: string) => boolean);
		customResult?: string[] | undefined;
		/** Sequence of ctx.ui.select results (auth-code endpoint confirm; default ["Confirm"]). Esc = undefined. */
		selectResults?: (string | undefined)[];
		/** Result of the redirect-URI edit input (auth-code only; default "" keeps the proposed URI). */
		redirectResult?: string;
		/** If true, the paste input returns undefined (user cancels at the paste). */
		cancelPaste?: boolean;
	} = {},
): {
	ctx: any;
	confirms: [string, string][];
	selects: [string, string | undefined][];
	inputs: [string, string | undefined][];
	orders: string[];
} {
	const orders: string[] = [];
	const confirms: [string, string][] = [];
	const selects: [string, string | undefined][] = [];
	const inputs: [string, string | undefined][] = [];
	const notify = vi.fn();
	let selectIdx = 0;
	const ctx = {
		hasUI: opts.hasUI ?? true,
		mode: opts.mode ?? "tui",
		ui: {
			notify,
			select: vi.fn(async (title: string, options: string[]) => {
				orders.push("select");
				const r = opts.selectResults
					? opts.selectResults[Math.min(selectIdx, opts.selectResults.length - 1)]
					: "Confirm"; // default: accept the proposal (the common path)
				selectIdx++;
				selects.push([`${title} :: [${options.join(" | ")}]`, r]);
				return r;
			}),
			confirm: vi.fn(async (title: string, msg: string) => {
				orders.push("confirm");
				confirms.push([title, msg]);
				if (typeof opts.confirm === "function") return opts.confirm(title, msg);
				return opts.confirm ?? true;
			}),
			input: vi.fn(async (title: string) => {
				orders.push("input");
				// The redirect-URI edit is identified by title (it only fires when
				// "Change redirect URI" was selected); everything else is a paste.
				const isRedirectEdit = title.includes("Redirect URI for");
				const r = isRedirectEdit
					? (opts.redirectResult ?? "")
					: opts.cancelPaste
						? undefined
						: // Paste: simulate the user having authorized and pasting the
							// address-bar URL with the pending flow's state.
							`${REDIRECT_URI}?code=CB&state=${
								readPendingFlow("mint.invalid", "authorization_code", TOKEN_URL)?.state
							}`;
				inputs.push([title, r]);
				return r;
			}),
			custom: vi.fn(async () => {
				orders.push("custom");
				return opts.customResult;
			}),
		},
	};
	return { ctx, confirms, selects, inputs, orders };
}

// ═══════════════════════════════════════════════════════════════
// Headless + precheck
// ═══════════════════════════════════════════════════════════════

describe("oauth-mint — headless + store precheck", () => {
	it("throws immediately when !ctx.hasUI, before any prompt", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		writeSecret("mint.invalid", "client_secret", "S3CRET");
		const fetchMock = stubTokenEndpoint(() =>
			tokenResponse({ access_token: "X" }),
		);
		const m = makeToolCtx({ hasUI: false });
		await expect(
			oauthMintTool.execute(
				"test",
				{ ...CC_PARAMS_DEFAULTS },
				undefined,
				undefined,
				m.ctx,
			),
		).rejects.toThrow(/requires an interactive session/);
		expect(m.ctx.ui.confirm).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("store-name miss throws with the /api secrets nudge BEFORE any prompt", async () => {
		const fetchMock = stubTokenEndpoint(() =>
			tokenResponse({ access_token: "X" }),
		);
		const m = makeToolCtx();
		await expect(
			oauthMintTool.execute(
				"test",
				{ ...CC_PARAMS_DEFAULTS, clientId: "unprovisioned" },
				undefined,
				undefined,
				m.ctx,
			),
		).rejects.toThrow(/\/api secrets mint\.invalid <name>/);
		expect(m.ctx.ui.confirm).not.toHaveBeenCalled();
		expect(m.ctx.ui.custom).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("bad params fail closed before any prompt (buildSyntheticOAuth2Auth)", async () => {
		const m = makeToolCtx();
		await expect(
			oauthMintTool.execute(
				"test",
				{ ...CC_PARAMS_DEFAULTS, tokenUrl: "notaurl" },
				undefined,
				undefined,
				m.ctx,
			),
		).rejects.toThrow(/--token-url must be an http\(s\) URL/);
		expect(m.ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it("normalizes the store domain against provisioned parents", async () => {
		writeSecret("parent.invalid", "client_id", "MY_CLIENT");
		writeSecret("parent.invalid", "client_secret", "S3CRET");
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "NORM", expires_in: 3600 }),
		);
		const m = makeToolCtx();
		await oauthMintTool.execute(
			"test",
			{ ...CC_PARAMS_DEFAULTS, domain: "api.parent.invalid" },
			undefined,
			undefined,
			m.ctx,
		);
		expect(
			readToken("parent.invalid", "client_credentials", TOKEN_URL)?.accessToken,
		).toBe("NORM");
		expect(
			readToken("api.parent.invalid", "client_credentials", TOKEN_URL),
		).toBeNull();
	});
});

const CC_PARAMS_DEFAULTS = {
	domain: "mint.invalid",
	grant: "client_credentials",
	tokenUrl: TOKEN_URL,
	clientId: "client_id",
	clientSecret: "client_secret",
} as const;

// ═══════════════════════════════════════════════════════════════
// Token-URL confirm — first prompt, both grants
// ═══════════════════════════════════════════════════════════════

describe("oauth-mint — token-URL confirm", () => {
	it("mint-time overwrite warning: an existing token in the target slot is surfaced before minting", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		writeSecret("mint.invalid", "client_secret", "S3CRET");
		// Same-slot prior token (the same-grant scope collision 2.9 names).
		writeToken("mint.invalid", "client_credentials", TOKEN_URL, {
			accessToken: "PRIOR",
			scope: "old-scope",
		});
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "CC", expires_in: 3600 }),
		);
		const m = makeToolCtx();
		await oauthMintTool.execute(
			"test",
			{ ...CC_PARAMS_DEFAULTS },
			undefined,
			undefined,
			m.ctx,
		);
		const warned = (m.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
			.map((c: unknown[]) => String(c[0]))
			.join("\n");
		expect(warned).toContain("Overwriting an existing token");
		expect(warned).toContain("previous scope: old-scope");
		// Exactly once — the auth-code arm warns inside mintAuthCodeToken, the
		// cc arm here; a second inline copy would double-warn.
		expect(warned.match(/Overwriting an existing token/g)).toHaveLength(1);
		// The mint proceeded (fresh token replaced the prior one).
		expect(
			readToken("mint.invalid", "client_credentials", TOKEN_URL)?.accessToken,
		).toBe("CC");
	});

	it("client_credentials: confirm shows the FULL tokenUrl + client name, fires before the exchange", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		writeSecret("mint.invalid", "client_secret", "S3CRET");
		const fetchMock = stubTokenEndpoint(() =>
			tokenResponse({ access_token: "CC", expires_in: 3600 }),
		);
		const m = makeToolCtx();
		await oauthMintTool.execute(
			"test",
			{ ...CC_PARAMS_DEFAULTS },
			undefined,
			undefined,
			m.ctx,
		);
		expect(m.orders).toEqual(["confirm"]); // nothing prompted after
		expect(m.confirms[0]![1]).toContain("client_id");
		// client_credentials never sees a redirect line in the confirm.
		expect(m.confirms[0]![1]).not.toContain("Redirect URI");
		expect(m.confirms[0]![1]).toContain(TOKEN_URL);
		expect(
			readToken("mint.invalid", "client_credentials", TOKEN_URL)?.accessToken,
		).toBe("CC");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("authorization_code: the combined endpoint-confirm select fires before the paste prompt", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "AC", expires_in: 3600 }),
		);
		const m = makeToolCtx();
		await oauthMintTool.execute(
			"test",
			{
				domain: "mint.invalid",
				grant: "authorization_code",
				tokenUrl: TOKEN_URL,
				clientId: "client_id",
				authorizeUrl: AUTHORIZE_URL,
			},
			undefined,
			undefined,
			m.ctx,
		);
		expect(m.orders[0]).toBe("select");
		expect(m.orders.indexOf("select")).toBeLessThan(m.orders.indexOf("input"));
		// The select proposes both facts: token endpoint + redirect URI.
		expect(m.selects[0]![0]).toContain(TOKEN_URL);
		expect(m.selects[0]![0]).toContain(REDIRECT_URI);
		expect(m.selects[0]![0]).toContain("Change redirect URI");
		expect(
			readToken("mint.invalid", "authorization_code", TOKEN_URL)?.accessToken,
		).toBe("AC");
	});

	it("authorization_code: Esc on the combined dialog throws the escape-hatch hint, nothing provisioned", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		const fetchMock = stubTokenEndpoint(() =>
			tokenResponse({ access_token: "X" }),
		);
		const m = makeToolCtx({ selectResults: [undefined] });
		await expect(
			oauthMintTool.execute(
				"test",
				{
					domain: "mint.invalid",
					grant: "authorization_code",
					tokenUrl: TOKEN_URL,
					clientId: "client_id",
					authorizeUrl: AUTHORIZE_URL,
				},
				undefined,
				undefined,
				m.ctx,
			),
		).rejects.toThrow(/--code <redirect-url-or-code>/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("confirm cancel throws the two-call init escape-hatch hint (cc)", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		writeSecret("mint.invalid", "client_secret", "S3CRET");
		const fetchMock = stubTokenEndpoint(() =>
			tokenResponse({ access_token: "X" }),
		);
		const m = makeToolCtx({ confirm: () => false });
		await expect(
			oauthMintTool.execute(
				"test",
				{ ...CC_PARAMS_DEFAULTS },
				undefined,
				undefined,
				m.ctx,
			),
		).rejects.toThrow(
			new RegExp(
				`/api oauth init mint\\.invalid --grant client_credentials --token-url ${TOKEN_URL} --client-id client_id --client-secret client_secret --code`,
			),
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ═══════════════════════════════════════════════════════════════
// Scopes picker
// ═══════════════════════════════════════════════════════════════

const SCOPES = [
	{ name: "read", description: "Read public data" },
	{ name: "write", description: "Write access" },
];

describe("oauth-mint — scopes picker", () => {
	it("picker grant flows into the token request; success text carries scopes, no token material", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		writeSecret("mint.invalid", "client_secret", "S3CRET");
		stubTokenEndpoint((_url, init) => {
			expect(String(init.body)).toContain("scope=read");
			return tokenResponse({
				access_token: "SECRET_TOKEN_VALUE",
				expires_in: 3600,
				scope: "read",
			});
		});
		const m = makeToolCtx({ customResult: ["read"] });
		const result = await oauthMintTool.execute(
			"test",
			{ ...CC_PARAMS_DEFAULTS, scopes: SCOPES },
			undefined,
			undefined,
			m.ctx,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Granted scopes: read");
		expect(text).toContain("mint.invalid");
		expect(text).not.toContain("SECRET_TOKEN");
	});

	it("picker cancel (Esc → undefined) throws the init escape-hatch hint with real values", async () => {
		writeSecret("pickcancel.invalid", "client_id", "MY_CLIENT");
		stubTokenEndpoint(() => tokenResponse({ access_token: "X" }));
		const m = makeToolCtx({ customResult: undefined });
		await expect(
			oauthMintTool.execute(
				"test",
				{
					domain: "pickcancel.invalid",
					grant: "authorization_code",
					tokenUrl: TOKEN_URL,
					clientId: "client_id",
					authorizeUrl: AUTHORIZE_URL,
					scopes: SCOPES,
				},
				undefined,
				undefined,
				m.ctx,
			),
		).rejects.toThrow(
			new RegExp(
				`/api oauth init pickcancel\\.invalid --grant authorization_code --token-url ${TOKEN_URL} --authorize-url ${AUTHORIZE_URL} --client-id client_id`,
			),
		);
		expect(
			readToken("pickcancel.invalid", "client_credentials", TOKEN_URL),
		).toBeNull();
	});

	it("all-unchecked Done grants nothing (scope param absent)", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		writeSecret("mint.invalid", "client_secret", "S3CRET");
		const fetchMock = stubTokenEndpoint((_url, init) => {
			expect(String(init.body)).not.toContain("scope=");
			return tokenResponse({ access_token: "CC", expires_in: 3600 });
		});
		const m = makeToolCtx({ customResult: [] });
		await oauthMintTool.execute(
			"test",
			{ ...CC_PARAMS_DEFAULTS, scopes: SCOPES },
			undefined,
			undefined,
			m.ctx,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("provider echo narrower than requested → summary reports the echo, not the request", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		writeSecret("mint.invalid", "client_secret", "S3CRET");
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "CC", expires_in: 3600, scope: "read" }),
		);
		const m = makeToolCtx({ customResult: ["read", "write"] });
		const result = await oauthMintTool.execute(
			"test",
			{ ...CC_PARAMS_DEFAULTS, scopes: SCOPES },
			undefined,
			undefined,
			m.ctx,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Granted scopes: read");
		expect(text).not.toContain("write");
		const details = result.details as { scopes?: string[] };
		expect(details.scopes).toEqual(["read"]);
	});

	it("no provider echo → requested scopes reported as (assumed granted)", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		writeSecret("mint.invalid", "client_secret", "S3CRET");
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "CC", expires_in: 3600 }),
		);
		const m = makeToolCtx({ customResult: ["read"] });
		const result = await oauthMintTool.execute(
			"test",
			{ ...CC_PARAMS_DEFAULTS, scopes: SCOPES },
			undefined,
			undefined,
			m.ctx,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Requested scopes (assumed granted): read");
	});
});
// ═══════════════════════════════════════════════════════════════
// Auth-code arm: paste prompt + cancel
// ═══════════════════════════════════════════════════════════════

describe("oauth-mint — authorization_code arm", () => {
	it("paste prompt completes the flow; redirect URL never enters the transcript", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		stubTokenEndpoint(() =>
			tokenResponse({
				access_token: "PASTED",
				refresh_token: "RT",
				expires_in: 3600,
			}),
		);
		const m = makeToolCtx({ mode: "rpc" }); // non-TUI → paste is ui.input
		const result = await oauthMintTool.execute(
			"test",
			{
				domain: "mint.invalid",
				grant: "authorization_code",
				tokenUrl: TOKEN_URL,
				clientId: "client_id",
				authorizeUrl: AUTHORIZE_URL,
			},
			undefined,
			undefined,
			m.ctx,
		);
		expect(
			readToken("mint.invalid", "authorization_code", TOKEN_URL)?.accessToken,
		).toBe("PASTED");
		expect(
			readPendingFlow("mint.invalid", "authorization_code", TOKEN_URL),
		).toBeNull();
		// Success text: granted scopes + store domain only — no token material.
		const text = String((result.content[0] as { text: string }).text);
		expect(text).toContain("No scopes requested"); // no scopes passed here
		expect(text).toContain("mint.invalid");
		expect(text).not.toContain("PASTED");
	});

	it("paste cancel (after retries) throws the init escape-hatch hint; the pending flow survives", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		const fetchMock = stubTokenEndpoint(() =>
			tokenResponse({ access_token: "X" }),
		);
		const m = makeToolCtx({ mode: "rpc", cancelPaste: true });
		await expect(
			oauthMintTool.execute(
				"test",
				{
					domain: "mint.invalid",
					grant: "authorization_code",
					tokenUrl: TOKEN_URL,
					clientId: "client_id",
					authorizeUrl: AUTHORIZE_URL,
				},
				undefined,
				undefined,
				m.ctx,
			),
		).rejects.toThrow(/--code <redirect-url-or-code>/);
		expect(
			readPendingFlow("mint.invalid", "authorization_code", TOKEN_URL),
		).not.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("auth-code redirect-URI edit: proposes the default, human can override inline; the override reaches the exchange", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");

		// Default: the edit proposes the RFC 8252 convention; empty/Enter keeps
		// it, so the token exchange sends the default redirect_uri.
		const sentDefault: (string | null)[] = [];
		stubTokenEndpoint((_url, init) => {
			sentDefault.push(new URLSearchParams(String(init.body)).get("redirect_uri"));
			return tokenResponse({ access_token: "PASTED", expires_in: 3600 });
		});
		const def = makeToolCtx({
			mode: "rpc",
			selectResults: ["Change redirect URI", "Confirm"],
		});
		await oauthMintTool.execute(
			"test",
			{
				domain: "mint.invalid",
				grant: "authorization_code",
				tokenUrl: TOKEN_URL,
				clientId: "client_id",
				authorizeUrl: AUTHORIZE_URL,
			},
			undefined,
			undefined,
			def.ctx,
		);
		expect(def.inputs[0]![0]).toContain(REDIRECT_URI);
		expect(sentDefault[0]).toBe(REDIRECT_URI);

		// Human override via the edit input (not the param): the typed value
		// replaces the proposed default, so the exchange uses the same URI.
		const CUSTOM = "http://localhost:5173/callback";
		const sentCustom: (string | null)[] = [];
		stubTokenEndpoint((_url, init) => {
			sentCustom.push(new URLSearchParams(String(init.body)).get("redirect_uri"));
			return tokenResponse({ access_token: "PASTED", expires_in: 3600 });
		});
		const m = makeToolCtx({
			mode: "rpc",
			selectResults: ["Change redirect URI", "Confirm"],
			redirectResult: CUSTOM,
		});
		await oauthMintTool.execute(
			"test",
			{
				domain: "mint.invalid",
				grant: "authorization_code",
				tokenUrl: TOKEN_URL,
				clientId: "client_id",
				authorizeUrl: AUTHORIZE_URL,
			},
			undefined,
			undefined,
			m.ctx,
		);
		expect(sentCustom[0]).toBe(CUSTOM);
		expect(
			readToken("mint.invalid", "authorization_code", TOKEN_URL)?.accessToken,
		).toBe("PASTED");
	});

	it("auth-code redirect-URI edit proposes the param override (agent's proposal, human confirms inline)", async () => {
		writeSecret("mint.invalid", "client_id", "MY_CLIENT");
		const sent: (string | null)[] = [];
		stubTokenEndpoint((_url, init) => {
			sent.push(new URLSearchParams(String(init.body)).get("redirect_uri"));
			return tokenResponse({ access_token: "PASTED", expires_in: 3600 });
		});
		const CUSTOM = "https://custom.example/callback";
		const m = makeToolCtx({
			mode: "rpc",
			selectResults: ["Change redirect URI", "Confirm"],
		});
		await oauthMintTool.execute(
			"test",
			{
				domain: "mint.invalid",
				grant: "authorization_code",
				tokenUrl: TOKEN_URL,
				clientId: "client_id",
				authorizeUrl: AUTHORIZE_URL,
				redirectUri: CUSTOM,
			},
			undefined,
			undefined,
			m.ctx,
		);
		// The edit proposes the param's URI (not the default), so the human
		// sees the agent's proposal and can confirm it inline.
		expect(m.inputs[0]![0]).toContain(CUSTOM);
		expect(sent[0]).toBe(CUSTOM);
	});
});

// ═══════════════════════════════════════════════════════════════
// escapeHatchCommand
// ═══════════════════════════════════════════════════════════════

describe("escapeHatchCommand", () => {
	it("builds the ready-to-run two-call init form from the tool's own params", () => {
		const cmd = escapeHatchCommand("osm.invalid", {
			grant: "authorization_code",
			tokenUrl: "https://t.example/token",
			clientId: "client_id",
			authorizeUrl: "https://a.example/authorize",
			clientSecret: "client_secret",
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		expect(cmd).toContain(
			"/api oauth init osm.invalid --grant authorization_code --token-url https://t.example/token --authorize-url https://a.example/authorize --client-id client_id --client-secret client_secret --token-endpoint-auth-method client_secret_basic --code <redirect-url-or-code>",
		);
	});
});

// ═══════════════════════════════════════════════════════════════
// pickChecklist component
// ═══════════════════════════════════════════════════════════════

describe("pickChecklist", () => {
	it("non-TUI fallback: comma-separated input resolves checked names", async () => {
		const ctx = {
			mode: "rpc",
			ui: { input: vi.fn(async () => "read, write") },
		};
		expect(
			await pickChecklist(
				ctx as any,
				"Scopes",
				SCOPES.map((s) => ({ value: s.name, label: s.name })),
			),
		).toEqual(["read", "write"]);
	});

	it("unknown names in the fallback are dropped", async () => {
		const ctx = {
			mode: "rpc",
			ui: { input: vi.fn(async () => "read,bogus") },
		};
		expect(
			await pickChecklist(ctx as any, "Scopes", [
				{ value: "read", label: "read" },
			]),
		).toEqual(["read"]);
	});

	it("fallback cancel returns undefined", async () => {
		const ctx = {
			mode: "rpc",
			ui: { input: vi.fn(async () => undefined) },
		};
		expect(
			await pickChecklist(ctx as any, "Scopes", [
				{ value: "read", label: "read" },
			]),
		).toBeUndefined();
	});

	it("TUI: Enter toggles ✓/○, Enter on the Done row resolves the checked set", async () => {
		// Drive the real component through the captured ctx.ui.custom factory.
		let factory: any;
		const ctx = {
			mode: "tui",
			ui: {
				custom: vi.fn(async (f: any) => {
					factory = f;
					return new Promise<string[] | undefined>(() => {}); // resolved by done()
				}),
			},
		};
		void pickChecklist(ctx as any, "Scopes", [
			{ value: "read", label: "read", description: "Read public data" },
			{ value: "write", label: "write" },
		]);
		// The factory is invoked synchronously by ui.custom in production; here
		// we invoke it directly with fakes and drive key input.
		const fakeTui = { requestRender: vi.fn() };
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		let resolved: string[] | undefined;
		const done = (v: string[] | undefined) => {
			resolved = v;
		};
		const component = factory!(fakeTui, theme, {}, done as any);
		// Enter on row 0 toggles "read" ✓; down ×2 lands on the Done row; Enter
		// there resolves the checked set (all start unchecked).
		component.handleInput("\r"); // toggle read on
		component.handleInput("\x1b[B"); // down → write
		component.handleInput("\x1b[B"); // down → Done row
		component.handleInput("\r"); // Done
		await Promise.resolve();
		expect(resolved!).toEqual(["read"]);
	});

	it("TUI: Esc cancels (resolves undefined)", async () => {
		let factory: any;
		const ctx = {
			mode: "tui",
			ui: {
				custom: vi.fn(async (f: any) => {
					factory = f;
					return new Promise<string[] | undefined>(() => {});
				}),
			},
		};
		void pickChecklist(ctx as any, "Scopes", [{ value: "read", label: "read" }]);
		const component = factory!(
			{ requestRender: vi.fn() },
			{ fg: (_c: string, t: string) => t, bold: (t: string) => t },
			{},
			(v: string[] | undefined) => {
				resolved = v;
			},
		);
		let resolved: string[] | undefined;
		component.handleInput("\x1b");
		await Promise.resolve();
		expect(resolved).toBeUndefined();
	});
});
