/**
 * twitch synthetic axis guide — oauth2 client_credentials, mocked transport.
 *
 * Covers the `client_credentials` facet of the `oauth2-auth` axis
 * guide-driven: an on-disk parsed oauth2 guide (the loader path), the
 * `secretRefs` merge (Client-Id rides alongside the Bearer token —
 * `makeOAuthGuide` in `__tests__/oauth.test.ts` declares no `secretRefs`,
 * so the merged-header behavior is untested there), cc auto-mint, the
 * token stamped into the right `(domain, grant, tokenUrl)` slot, the
 * no-refresh re-mint on expiry (app tokens are not refreshable), and the
 * `listStyle: repeat` wire form on the repeatable `id`/`login` params.
 *
 * Mint mechanics themselves (form encoding, refresh, skew, 401 scrub) stay
 * owned structurally by `__tests__/oauth.test.ts` — this guide proves the
 * *parsed guide → resolveOpForExecution* seam. No live endpoint.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiGuide, OAuth2Auth } from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { resolveOpForExecution } from "../../core/resolve-op.js";
import { setSecretsDir, writeSecret } from "../../core/secrets-store.js";
import { setOAuthDir, readToken, writeToken } from "../../core/oauth-store.js";
import {
	stageGuides,
	findOp,
	stubTokenEndpoint,
	tokenResponse,
} from "../../__tests__/test-utils.js";

const TT = "https://id.twitch.tv/oauth2/token";
const STORE_DOMAIN = "twitch.tv"; // canonicalStoreDomain = guide.domains[0]

let tmpBase: string;

/** Stage the on-disk twitch guide into a tmp guides dir and load it. */
async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const { guides } = stageGuides(tmpBase, new URL("../", import.meta.url), [
		"twitch",
	]);
	return { guide: guides["twitch"]! };
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-twitch-axis-"));
	setOAuthDir(join(tmpBase, "oauth"));
});
afterAll(() => {
	vi.unstubAllGlobals();
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("twitch oauth2 client_credentials (mocked transport)", () => {
	it("parses as oauth2 client_credentials with the Client-Id secretRef", async () => {
		const { guide } = await setupRecipe();
		expect(guide.auth.kind).toBe("oauth2");
		const auth = guide.auth as OAuth2Auth;
		expect(auth.grant).toBe("client_credentials");
		expect(auth.tokenUrl).toBe(TT);
		expect(auth.clientId).toEqual({ secret: "client_id" });
		// The fixture's genuine delta over __tests__/oauth.test.ts: the merged
		// secretRefs shape (Client-Id) survives the on-disk parse.
		expect(auth.secretRefs).toEqual({
			"Client-Id": { secret: "client_id" },
		});
	});

	it("auto-mints, merges Bearer + Client-Id headers into the request, and stamps the token slot", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ data: [{ id: "1", login: "sodapoppin" }] }),
			cached: false,
		});

		// Provision both store secrets under the canonical store domain.
		setSecretsDir(join(tmpBase, "secrets"));
		writeSecret(STORE_DOMAIN, "client_id", "MY_CLIENT");
		writeSecret(STORE_DOMAIN, "client_secret", "S3CRET");

		stubTokenEndpoint((url, init) => {
			expect(url).toBe(TT);
			expect(String(init.body)).toContain("grant_type=client_credentials");
			expect(String(init.body)).toContain("client_id=MY_CLIENT");
			expect(String(init.body)).toContain("client_secret=S3CRET");
			return tokenResponse({ access_token: "APP-1", expires_in: 3600 });
		});

		const { guide } = await setupRecipe();
		const outcome = await resolveOpForExecution(
			guide,
			findOp(guide, "users"),
			"twitch",
			{ userParams: { login: "sodapoppin" } },
		);

		expect(outcome.ok).toBe(true);
		// Both headers reach the transport — the secretRefs merge through the
		// parsed-guide path (untested by makeOAuthGuide-based structural tests).
		const call = mock.mock.calls.at(-1)!;
		const opts = call[1] as { headers?: Record<string, string> } | undefined;
		expect(opts?.headers?.["authorization"]).toBe("Bearer APP-1");
		expect(opts?.headers?.["Client-Id"]).toBe("MY_CLIENT");
		// Stamped into the (twitch.tv, client_credentials, tokenUrl) slot.
		const token = readToken(STORE_DOMAIN, "client_credentials", TT);
		expect(token?.accessToken).toBe("APP-1");
	});

	it("listStyle: repeat on id/login fans out repeated wire pairs", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ data: [{ id: "11" }, { id: "22" }] }),
			cached: false,
		});

		setSecretsDir(join(tmpBase, "secrets"));
		writeSecret(STORE_DOMAIN, "client_id", "MY_CLIENT");
		writeSecret(STORE_DOMAIN, "client_secret", "S3CRET");
		stubTokenEndpoint(() =>
			tokenResponse({ access_token: "APP-1", expires_in: 3600 }),
		);

		const { guide } = await setupRecipe();
		const outcome = await resolveOpForExecution(
			guide,
			findOp(guide, "users"),
			"twitch",
			{
				userParams: { id: ["111", "222"] },
			},
		);
		expect(outcome.ok).toBe(true);
		const call = mock.mock.calls.at(-1)!;
		const url = call[0];
		// Repeated wire form — one pair per element, under the declared name.
		expect(url).toContain("id=111&id=222");
		expect(url).not.toContain("id=%5B");
		// Surfaced params keep the widened array shape under the declared name.
		if (outcome.ok) {
			expect(outcome.result.params["id"]).toEqual(["111", "222"]);
		}
	});

	it("expired app token with no refresh token → re-mints (never refreshes)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ data: [{ id: "2", login: "nymn" }] }),
			cached: false,
		});
		writeToken(STORE_DOMAIN, "client_credentials", TT, {
			accessToken: "OLD",
			expiresAt: Date.now() - 1000, // expired, no refresh token
		});

		stubTokenEndpoint((_url, init) => {
			// Re-mint, not refresh: grant_type stays client_credentials.
			expect(String(init.body)).toContain("grant_type=client_credentials");
			expect(String(init.body)).not.toContain("refresh_token=");
			return tokenResponse({ access_token: "REMINTED", expires_in: 3600 });
		});

		const { guide } = await setupRecipe();
		const outcome = await resolveOpForExecution(
			guide,
			findOp(guide, "users"),
			"twitch",
			{ userParams: { login: "nymn" } },
		);
		expect(outcome.ok).toBe(true);
		const call = mock.mock.calls.at(-1)!;
		const opts = call[1] as { headers?: Record<string, string> } | undefined;
		expect(opts?.headers?.["authorization"]).toBe("Bearer REMINTED");
	});
});
