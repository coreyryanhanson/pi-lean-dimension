/**
 * /api oauth init <domain> — guide-less OAuth2 bootstrap (Phase 2.7) tests.
 *
 * Mocked transport; covers the plan's touch-list axes:
 *  - Headless flags, client_credentials: mint + stamp under the
 *    parent-normalized store domain, with the domains[0] ordering note.
 *  - Headless flags, authorization_code: start persists the pending flow and
 *    teaches the init-owned completion; the two-call `init … --code <paste>`
 *    completes it; state mismatch survives for a retry.
 *  - Store-name rule: unprovisioned client-id nudges /api secrets, no fetch.
 *  - Interactive wizard (mocked ctx.ui): both grants, store-NAME pickers
 *    (values never offered), omit-secret → public PKCE client (method none),
 *    no-secrets abort, cancel.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOauthSubcommand } from "../core/oauth-command.js";
import { REDIRECT_URI } from "../core/oauth-flow.js";
import {
	readToken,
	readPendingFlow,
	setOAuthDir,
} from "../core/oauth-store.js";
import { writeSecret, setSecretsDir } from "../core/secrets-store.js";

const TOKEN_URL = "https://token.example.com/oauth/token";
const AUTHORIZE_URL = "https://auth.example.com/oauth/authorize";
const OMIT = "(omit — PKCE public client)";

let tmpSecrets: string;
let tmpOAuth: string;

beforeAll(() => {
	tmpSecrets = mkdtempSync(join(tmpdir(), "host-oauthcmd-secrets-"));
	tmpOAuth = mkdtempSync(join(tmpdir(), "host-oauthcmd-tokens-"));
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

function tokenResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function makeCtx(opts: { hasUI?: boolean } = {}): {
	ctx: Parameters<typeof handleOauthSubcommand>[1];
	out: () => string;
	selects: string[];
	inputs: string[];
} {
	const notify = vi.fn();
	const inputs: string[] = [];
	const selects: string[] = [];
	const ctx = {
		hasUI: opts.hasUI ?? false,
		ui: {
			notify,
			input: vi.fn(async () => inputs.shift()),
			select: vi.fn(async () => selects.shift()),
		},
	} as unknown as Parameters<typeof handleOauthSubcommand>[1];
	const out = () => notify.mock.calls.map((c) => String(c[0])).join("\n");
	return { ctx, out, inputs, selects };
}

// ═══════════════════════════════════════════════════════════════
// Headless flags — client_credentials
// ═══════════════════════════════════════════════════════════════

describe("oauth init — headless flags, client_credentials", () => {
	it("mints and stamps under the parent-normalized store domain, with the ordering note", async () => {
		// Secrets live under the api-subdomain's parent — normalization must
		// land the token where a guide keyed `ccprov.invalid` will look.
		writeSecret("ccprov.invalid", "client_id", "MY_CLIENT");
		writeSecret("ccprov.invalid", "client_secret", "S3CRET");
		const fetchMock = stubTokenEndpoint((_url, init) => {
			expect(String(init.body)).toContain("grant_type=client_credentials");
			expect(String(init.body)).toContain("client_id=MY_CLIENT");
			expect(String(init.body)).toContain("client_secret=S3CRET");
			return tokenResponse({ access_token: "CC", expires_in: 3600 });
		});
		const m = makeCtx();
		await handleOauthSubcommand(
			`init api.ccprov.invalid --grant client_credentials --token-url ${TOKEN_URL} --client-id client_id --client-secret client_secret`,
			m.ctx,
		);
		expect(m.out()).toContain("provisioned via /api oauth init");
		expect(m.out()).toContain("domains[0]"); // normalization note
		expect(readToken("ccprov.invalid")?.accessToken).toBe("CC");
		expect(readToken("api.ccprov.invalid")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cc without --client-secret fails closed (parser invariant)", async () => {
		const fetchMock = stubTokenEndpoint(() =>
			tokenResponse({ access_token: "X" }),
		);
		const m = makeCtx();
		await handleOauthSubcommand(
			`init ccnosecret.invalid --grant client_credentials --token-url ${TOKEN_URL} --client-id client_id`,
			m.ctx,
		);
		expect(m.out()).toContain("--client-secret");
		expect(readToken("ccnosecret.invalid")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("invalid --token-endpoint-auth-method fails closed (no silent none)", async () => {
		writeSecret("badmethod.invalid", "client_id", "MY_CLIENT");
		writeSecret("badmethod.invalid", "client_secret", "S3CRET");
		const fetchMock = stubTokenEndpoint(() => tokenResponse({ access_token: "X" }));
		const m = makeCtx();
		await handleOauthSubcommand(
			`init badmethod.invalid --grant client_credentials --token-url ${TOKEN_URL} --client-id client_id --client-secret client_secret --token-endpoint-auth-method bogus`,
			m.ctx,
		);
		expect(m.out()).toContain("--token-endpoint-auth-method must be");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("dangling flag at end of args reports the missing value", async () => {
		const m = makeCtx();
		await handleOauthSubcommand("init dangle.invalid --token-url", m.ctx);
		expect(m.out()).toContain("'--token-url' is missing its value");
	});

	it("bad --token-url and unknown flags fail closed with usage", async () => {
		const m = makeCtx();
		await handleOauthSubcommand(
			`init bad.invalid --grant client_credentials --token-url notaurl --client-id x --client-secret y`,
			m.ctx,
		);
		expect(m.out()).toContain("--token-url must be an http(s) URL");
		const m2 = makeCtx();
		await handleOauthSubcommand("init bad2.invalid --frobnicate x", m2.ctx);
		expect(m2.out()).toContain("Unknown flag '--frobnicate'");
	});

	it("--scopes parses the comma list into the token request", async () => {
		writeSecret("ccscopes.invalid", "client_id", "MY_CLIENT");
		writeSecret("ccscopes.invalid", "client_secret", "S3CRET");
		const fetchMock = stubTokenEndpoint((_url, init) => {
			expect(String(init.body)).toContain("scope=read+profile");
			return tokenResponse({ access_token: "SCOPED", expires_in: 3600 });
		});
		await handleOauthSubcommand(
			"init ccscopes.invalid --grant client_credentials --token-url " +
				TOKEN_URL +
				" --client-id client_id --client-secret client_secret --scopes read,profile",
			makeCtx().ctx,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(readToken("ccscopes.invalid")?.accessToken).toBe("SCOPED");
	});
});

// ═══════════════════════════════════════════════════════════════
// Headless flags — authorization_code (start + two-call --code completion)
// ═══════════════════════════════════════════════════════════════

describe("oauth init — headless flags, authorization_code", () => {
	it("start prints the authorize URL, persists the pending flow, and teaches the init-owned completion", async () => {
		writeSecret("acstart.invalid", "client_id", "MY_CLIENT");
		const m = makeCtx();
		// --grant omitted → inferred from --authorize-url.
		await handleOauthSubcommand(
			`init acstart.invalid --token-url ${TOKEN_URL} --authorize-url ${AUTHORIZE_URL} --client-id client_id`,
			m.ctx,
		);
		const text = m.out();
		expect(text).toContain("127.0.0.1/callback");
		const url = text.match(/https?:\/\/\S*code_challenge=\S+/)?.[0];
		expect(url).toContain("client_id=MY_CLIENT");
		expect(url).toContain("redirect_uri=" + encodeURIComponent(REDIRECT_URI));
		// Pending flow persisted (verifier must survive for the exchange).
		expect(readPendingFlow("acstart.invalid")).not.toBeNull();
		// The plain command's --code is NOT the completion path here — init owns it.
		expect(text).toContain("/api oauth init");
		expect(text).toContain("--code <redirect-url-or-code>");
		expect(readToken("acstart.invalid")).toBeNull();
	});

	it("two-call completion: init … --code <paste> exchanges with the persisted verifier", async () => {
		writeSecret("actwo.invalid", "client_id", "MY_CLIENT");
		stubTokenEndpoint(() =>
			tokenResponse({
				access_token: "TWOCALL",
				refresh_token: "RT",
				expires_in: 3600,
			}),
		);
		const start = makeCtx();
		await handleOauthSubcommand(
			`init actwo.invalid --token-url ${TOKEN_URL} --authorize-url ${AUTHORIZE_URL} --client-id client_id`,
			start.ctx,
		);
		const pending = readPendingFlow("actwo.invalid");
		expect(pending).not.toBeNull();

		// Full address-bar paste with state → completes and stamps.
		const m = makeCtx();
		await handleOauthSubcommand(
			`init actwo.invalid --token-url ${TOKEN_URL} --authorize-url ${AUTHORIZE_URL} --client-id client_id --code ${REDIRECT_URI}?code=GOOD&state=${pending?.state}`,
			m.ctx,
		);
		expect(m.out()).toContain("provisioned via /api oauth init");
		expect(readToken("actwo.invalid")?.accessToken).toBe("TWOCALL");
		expect(readPendingFlow("actwo.invalid")).toBeNull();
	});

	it("state mismatch rejects the paste; the pending flow survives for a retry", async () => {
		writeSecret("acstate.invalid", "client_id", "MY_CLIENT");
		const start = makeCtx();
		await handleOauthSubcommand(
			`init acstate.invalid --token-url ${TOKEN_URL} --authorize-url ${AUTHORIZE_URL} --client-id client_id`,
			start.ctx,
		);
		expect(readPendingFlow("acstate.invalid")).not.toBeNull();
		const m = makeCtx();
		await handleOauthSubcommand(
			`init acstate.invalid --token-url ${TOKEN_URL} --authorize-url ${AUTHORIZE_URL} --client-id client_id --code "http://127.0.0.1/callback?code=X&state=WRONG"`,
			m.ctx,
		);
		expect(m.out()).toContain("state mismatch");
		expect(readPendingFlow("acstate.invalid")).not.toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════
// Store-name rule + usage
// ═══════════════════════════════════════════════════════════════

describe("oauth init — store-name rule", () => {
	it("unprovisioned client-id nudges /api secrets, never fetches", async () => {
		const fetchMock = stubTokenEndpoint(() =>
			tokenResponse({ access_token: "X" }),
		);
		const m = makeCtx();
		await handleOauthSubcommand(
			`init unprov.invalid --grant client_credentials --token-url ${TOKEN_URL} --client-id client_id --client-secret client_secret`,
			m.ctx,
		);
		expect(m.out()).toContain("/api secrets unprov.invalid <name>");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("no flags + headless prints the init usage", async () => {
		const m = makeCtx();
		await handleOauthSubcommand("init usage.invalid", m.ctx);
		expect(m.out()).toContain("guide-less OAuth2 bootstrap");
		expect(m.out()).toContain("--grant");
	});
});

// ═══════════════════════════════════════════════════════════════
// Interactive wizard (mocked ctx.ui)
// ═══════════════════════════════════════════════════════════════

describe("oauth init — interactive wizard", () => {
	it("client_credentials arm: prompts, picks store NAMES, mints inline", async () => {
		writeSecret("wzd.invalid", "client_id", "MY_CLIENT");
		writeSecret("wzd.invalid", "client_secret", "S3CRET");
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "WZD", expires_in: 3600 }),
		);
		const m = makeCtx({ hasUI: true });
		// grant, client-id, client-secret �� cc list has no omit option.
		m.selects.push("client_credentials", "client_id", "client_secret");
		m.inputs.push(TOKEN_URL);
		await handleOauthSubcommand("init wzd.invalid", m.ctx);
		expect(readToken("wzd.invalid")?.accessToken).toBe("WZD");
		// The pickers offered provisioned NAMES, never values.
		const selectArgs = JSON.stringify(
			(m.ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls,
		);
		expect(selectArgs).not.toContain("S3CRET");
		expect(selectArgs).toContain("client_id");
	});

	it("auth-code with omitted secret → public PKCE client (method none), inline paste completes", async () => {
		writeSecret("wzda.invalid", "client_id", "MY_CLIENT");
		stubTokenEndpoint((_url, init) => {
			// Public PKCE client: no client_secret in the exchange body and no
			// Basic auth header.
			expect(String(init.body)).not.toContain("client_secret=");
			const headers = (init.headers ?? {}) as Record<string, string>;
			expect(headers["authorization"]).toBeUndefined();
			return tokenResponse({ access_token: "PUBLIC", expires_in: 3600 });
		});
		const m = makeCtx({ hasUI: true });
		// Destructure so the paste-prompt implementation can read the queue.
		const { inputs } = m;
		// grant, client-id, client-secret (omit) — omitting the secret
		// short-circuits the method prompt, so only two selects fire.
		m.selects.push("authorization_code", "client_id", OMIT);
		m.inputs.push(TOKEN_URL, AUTHORIZE_URL, "");
		// After the queue is exhausted the next input call is the paste prompt;
		// the pending flow (written before the prompt) holds the state.
		(m.ctx.ui.input as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			const queued = inputs.shift();
			if (queued !== undefined) return queued;
			const pending = readPendingFlow("wzda.invalid");
			return `${REDIRECT_URI}?code=CB&state=${pending?.state}`;
		});
		await handleOauthSubcommand("init wzda.invalid", m.ctx);
		expect(readToken("wzda.invalid")?.accessToken).toBe("PUBLIC");
		expect(readPendingFlow("wzda.invalid")).toBeNull();
	});

	it("wizard with no provisioned secrets aborts with the /api secrets nudge", async () => {
		const m = makeCtx({ hasUI: true });
		m.selects.push("client_credentials");
		m.inputs.push(TOKEN_URL);
		await handleOauthSubcommand("init nosec.invalid", m.ctx);
		expect(m.out()).toContain("/api secrets nosec.invalid");
		expect(readToken("nosec.invalid")).toBeNull();
	});

	it("cancelling the grant picker provisions nothing", async () => {
		const m = makeCtx({ hasUI: true });
		(m.ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			undefined,
		);
		await handleOauthSubcommand("init cancel.invalid", m.ctx);
		expect(m.out()).toContain("Cancelled");
		expect(readToken("cancel.invalid")).toBeNull();
	});
});
