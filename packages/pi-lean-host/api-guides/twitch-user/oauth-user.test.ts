/**
 * twitch-user synthetic axis guide — oauth2 authorization_code, mocked
 * transport.
 *
 * Covers the `authorization_code` facet of the `oauth2-auth` axis
 * guide-driven, plus the multi-grant slot coexistence pair-test:
 *  - the parsed-guide shape (authorizeUrl, scopes, shared secretRefs);
 *  - fail-closed pre-request: no user token → `resolveOpForExecution`
 *    returns `reason: "oauth_token_missing"` and dispatches nothing
 *    (the mapping itself is asserted nowhere else);
 *  - slot coexistence: the two sibling fixtures carry distinct
 *    `(grant, tokenUrl)` facts (authoring-drift tripwire) and resolve into
 *    distinct slots of one store domain through the parsed-guide path —
 *    minting the app token never clobbers the user token.
 *
 * Token-mint/refresh mechanics stay owned by `__tests__/oauth.test.ts`
 * (`resolveAccessToken` level) and `__tests__/oauth-flow.test.ts` (the
 * paste flow). No live endpoint.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ApiGuide,
	OAuth2Auth,
	Operation,
} from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";
import { resolveOpForExecution } from "../../core/resolve-op.js";
import { setSecretsDir, writeSecret } from "../../core/secrets-store.js";
import { setOAuthDir, readToken, writeToken } from "../../core/oauth-store.js";

const TT = "https://id.twitch.tv/oauth2/token";
const STORE_DOMAIN = "twitch.tv"; // canonicalStoreDomain = guide.domains[0]

function stubTokenEndpoint(
	handler: (url: string, init: RequestInit) => Response,
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn((url: unknown, init?: RequestInit) =>
			Promise.resolve(handler(String(url), init ?? {})),
		),
	);
}

function tokenResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

let tmpBase: string;

/** Stage on-disk guides into a tmp guides dir and load them. */
async function setupRecipes(
	dirs: string[],
): Promise<{ guides: Record<string, ApiGuide> }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	for (const dir of dirs) {
		const domainDir = join(guidesDir, dir);
		mkdirSync(domainDir, { recursive: true });
		const source = readFileSync(
			new URL(`../${dir}/guide.md`, import.meta.url),
			"utf-8",
		);
		writeFileSync(join(domainDir, "guide.md"), source, "utf-8");
	}
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guides: loaded.guides as Record<string, ApiGuide> };
}

function findOp(guide: ApiGuide, name: string): Operation {
	const op = guide.operations.find((o) => o.name === name);
	if (!op) throw new Error(`op ${name} not found`);
	return op;
}

function provisionCreds(): void {
	setSecretsDir(join(tmpBase, "secrets"));
	writeSecret(STORE_DOMAIN, "client_id", "MY_CLIENT");
	writeSecret(STORE_DOMAIN, "client_secret", "S3CRET");
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-twitch-user-axis-"));
	setOAuthDir(join(tmpBase, "oauth"));
});
afterAll(() => {
	vi.unstubAllGlobals();
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("twitch-user oauth2 authorization_code (mocked transport)", () => {
	it("parses as authorization_code with authorizeUrl, scopes, and the shared Client-Id ref", async () => {
		const { guides } = await setupRecipes(["twitch-user"]);
		const auth = guides["twitch-user"]!.auth as OAuth2Auth;
		expect(auth.grant).toBe("authorization_code");
		expect(auth.authorizeUrl).toBe("https://id.twitch.tv/oauth2/authorize");
		expect(auth.tokenUrl).toBe(TT);
		expect(auth.scopes).toContain("user:read:follows");
		expect(auth.secretRefs).toEqual({ "Client-Id": { secret: "client_id" } });
	});

	it("fail-closed: no minted user token → oauth_token_missing before any request", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		provisionCreds();

		const { guides } = await setupRecipes(["twitch-user"]);
		const guide = guides["twitch-user"]!;

		const outcome = await resolveOpForExecution(
			guide,
			findOp(guide, "me"),
			"twitch-user",
		);

		// Not a throw — a structured non-run outcome; no API request was made.
		expect(outcome.ok).toBe(false);
		if (!outcome.ok && outcome.reason === "oauth_token_missing") {
			expect(outcome.message).toContain("/api oauth");
		} else {
			expect.unreachable("expected oauth_token_missing");
		}
		expect(mock).not.toHaveBeenCalled();
	});

	it("with a user token in the slot, me and followedStreams run under the Bearer", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock.mockImplementation(async (_url: string) => {
			// The stored token is fresh — no token-endpoint call may happen.
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					data: [{ id: "9", login: "tester" }],
					pagination: {},
				}),
				cached: false,
			};
		});
		writeToken(STORE_DOMAIN, "authorization_code", TT, {
			accessToken: "USER-1",
			refreshToken: "RT-1",
			expiresAt: Date.now() + 300_000, // well beyond the 60s skew
		});

		const { guides } = await setupRecipes(["twitch-user"]);
		const guide = guides["twitch-user"]!;

		const me = await resolveOpForExecution(
			guide,
			findOp(guide, "me"),
			"twitch-user",
		);
		expect(me.ok).toBe(true);
		const call = mock.mock.calls.at(-1)!;
		const opts = call[1] as { headers?: Record<string, string> } | undefined;
		expect(opts?.headers?.["authorization"]).toBe("Bearer USER-1");
		expect(opts?.headers?.["Client-Id"]).toBe("MY_CLIENT");

		const followed = await resolveOpForExecution(
			guide,
			findOp(guide, "followedStreams"),
			"twitch-user",
			{ userParams: { user_id: "9" } },
		);
		expect(followed.ok).toBe(true);
		if (followed.ok && "urls" in followed.result) {
			expect(followed.result.urls[0]).toContain("user_id=9");
		}
	});

	it("slot coexistence: sibling guides on twitch.tv resolve into distinct (grant, tokenUrl) slots — no clobber", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ data: [{ id: "1", login: "sodapoppin" }] }),
			cached: false,
		});
		provisionCreds();

		// Both sibling guides on disk — the pair, not a single guide.
		const { guides } = await setupRecipes(["twitch", "twitch-user"]);
		const app = guides["twitch"]!;
		const user = guides["twitch-user"]!;

		// Authoring-drift tripwire: the shipped fixtures carry distinct grant
		// facts (a copy-paste drift would collapse the slots into one).
		const appAuth = app.auth as OAuth2Auth;
		const userAuth = user.auth as OAuth2Auth;
		expect(appAuth.grant).toBe("client_credentials");
		expect(userAuth.grant).toBe("authorization_code");

		// A user token already in the store, minted via the paste flow.
		writeToken(STORE_DOMAIN, "authorization_code", TT, {
			accessToken: "USER-TOKEN",
			refreshToken: "RT-USER",
		});

		// Mint the app token through the parsed `twitch` guide…
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "APP-TOKEN", expires_in: 3600 }),
		);
		const mint = await resolveOpForExecution(
			app,
			findOp(app, "users"),
			"twitch",
			{ userParams: { login: "sodapoppin" } },
		);
		expect(mint.ok).toBe(true);

		// …and read a user-token op through the parsed `twitch-user` guide —
		// distinct slots, one <domain>.json file, no clobber either way.
		const meAgain = await resolveOpForExecution(
			user,
			findOp(user, "me"),
			"twitch-user",
		);
		expect(meAgain.ok).toBe(true);
		const lastCall = mock.mock.calls.at(-1)!;
		const opts = lastCall[1] as { headers?: Record<string, string> } | undefined;
		expect(opts?.headers?.["authorization"]).toBe("Bearer USER-TOKEN");

		expect(readToken(STORE_DOMAIN, "client_credentials", TT)?.accessToken).toBe(
			"APP-TOKEN",
		);
		expect(readToken(STORE_DOMAIN, "authorization_code", TT)?.accessToken).toBe(
			"USER-TOKEN",
		);
	});
});
