/**
 * telegram-bot synthetic axis guide — path-secret auth (`secretPathRefs`),
 * mocked transport.
 *
 * Covers the `path-secret-auth` axis guide-driven: an on-disk parsed
 * static-key guide whose auth is a `secretPathRefs` block (path-only — no
 * secret header/query surface), driven through the parsed guide →
 * resolveOpForExecution seam. Proves, on the fixture itself:
 *   - the declared shape survives the on-disk parse
 *   - an unprovisioned store fails closed before any fetch
 *   - the store value fills the URL path (restGet AND every paginate page)
 *   - an agent-supplied value for the secret-owned token is dropped
 *   - the token never reaches a query string
 *   - every surfaced URL (`result.url`, `PaginateResult.urls`) is redacted
 *
 * The full output-channel audit (raw + both hex redaction forms, 401 body
 * scrub, HelperError.url, D4 transport gating, verify carve-out) is owned
 * structurally by `__tests__/path-secrets.test.ts` and
 * `__tests__/path-secrets-transport.test.ts`. No live endpoint.
 */

import {
	describe,
	it,
	expect,
	vi,
	beforeAll,
	beforeEach,
	afterAll,
} from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiGuide, Operation } from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { fetchUrl } from "../../core/transport.js";
const fetchUrlMock = vi.mocked(fetchUrl);

import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";
import { resolveOpForExecution } from "../../core/resolve-op.js";
import { setSecretsDir, writeSecret } from "../../core/secrets-store.js";

// Telegram-shaped bot token: <id>:<secret> — the colon is what makes the
// encodeURIComponent form (`%3A`) a distinct redaction target.
const TOKEN = "110201543:AAHdqTcvCH1";
const TOKEN_ENC = encodeURIComponent(TOKEN);
const STORE_DOMAIN = "telegram.org"; // canonicalStoreDomain = guide.domains[0]

let tmpBase: string;

/** Stage the on-disk guide into a tmp guides dir and load it. */
async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "telegram-bot");
	mkdirSync(domainDir, { recursive: true });
	const source = readFileSync(new URL("./guide.md", import.meta.url), "utf-8");
	writeFileSync(join(domainDir, "guide.md"), source, "utf-8");
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["telegram-bot"]! };
}

function findOp(guide: ApiGuide, name: string): Operation {
	const op = guide.operations.find((o) => o.name === name);
	if (!op) throw new Error(`op ${name} not found`);
	return op;
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-telegram-axis-"));
});
beforeEach(() => {
	// Fresh call history per test — mockResolvedValue from a sibling test
	// must not leak into this file's multi-page walk.
	fetchUrlMock.mockReset();
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("telegram-bot path-secret auth (mocked transport)", () => {
	it("parses as static-key with the declared secretPathRefs shape", async () => {
		const { guide } = await setupRecipe();
		expect(guide.auth.kind).toBe("static-key");
		if (guide.auth.kind === "static-key") {
			expect(guide.auth.secretPathRefs).toEqual({
				token: { secret: "bot_token" },
			});
		}
	});

	it("unprovisioned store fails closed before any fetch", async () => {
		setSecretsDir(join(tmpBase, "secrets-empty"));
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true, result: [] }),
			cached: false,
		});

		const { guide } = await setupRecipe();
		const outcome = await resolveOpForExecution(
			guide,
			findOp(guide, "getMe"),
			"telegram-bot",
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok && outcome.reason === "auth_required_not_provisioned") {
			expect(outcome.missing).toEqual(["bot_token"]);
		} else {
			expect.unreachable("expected auth_required_not_provisioned");
		}
		expect(fetchUrlMock).not.toHaveBeenCalled();
	});

	it("getMe: store fills the path; an agent-supplied token is dropped; result.url is redacted", async () => {
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true, result: { id: 1, username: "axisbot" } }),
			cached: false,
		});
		setSecretsDir(join(tmpBase, "secrets"));
		writeSecret(STORE_DOMAIN, "bot_token", TOKEN);

		const { guide } = await setupRecipe();
		const outcome = await resolveOpForExecution(
			guide,
			findOp(guide, "getMe"),
			"telegram-bot",
			// An agent trying to smuggle its own token value — dropped.
			{ userParams: { token: "agent-supplied" } },
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		// The transport-fetched URL carries the store value in the path.
		const call = fetchUrlMock.mock.calls.at(-1)!;
		const fetchedUrl = String(call[0]);
		expect(fetchedUrl).toContain(`/bot${TOKEN_ENC}/getMe`);
		expect(fetchedUrl).not.toContain("agent-supplied");

		// The surfaced URL is redacted (raw + encoded forms).
		const result = outcome.result as { url: string };
		expect(result.url).toContain("/bot***/getMe");
		expect(result.url).not.toContain(TOKEN);
		expect(result.url).not.toContain(TOKEN_ENC);
	});

	it("getUpdates: the token survives every page build and never reaches a query string", async () => {
		fetchUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: {},
			body: JSON.stringify({
				ok: true,
				result: [{ update_id: 100 }, { update_id: 101 }],
			}),
			cached: false,
		});
		fetchUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true, result: [{ update_id: 102 }] }),
			cached: false,
		});
		// Empty final page → structural exhaustion; later pages (should the
		// walk continue) keep returning empty.
		fetchUrlMock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true, result: [] }),
			cached: false,
		});
		setSecretsDir(join(tmpBase, "secrets"));
		writeSecret(STORE_DOMAIN, "bot_token", TOKEN);

		const { guide } = await setupRecipe();
		const outcome = await resolveOpForExecution(
			guide,
			findOp(guide, "getUpdates"),
			"telegram-bot",
			{ userParams: { limit: 2 }, gatherAll: true },
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		expect(fetchUrlMock.mock.calls.length).toBe(3);
		for (const call of fetchUrlMock.mock.calls) {
			const url = String(call[0]);
			// Token fills the path on every page build…
			expect(url).toContain(`/bot${TOKEN_ENC}/getUpdates`);
			// …and never rides the query string.
			expect(new URL(url).search).not.toContain("110201543");
		}
		// The cursor advances from the previous page's last update_id.
		expect(String(fetchUrlMock.mock.calls[1]![0])).toContain("offset=101");
		expect(String(fetchUrlMock.mock.calls[2]![0])).toContain("offset=102");

		const result = outcome.result as { items: unknown[]; urls: string[] };
		expect(result.items.length).toBe(3);
		// Every surfaced URL is redacted (raw + encoded forms absent).
		expect(result.urls.length).toBe(3);
		for (const u of result.urls) {
			expect(u).toContain("/bot***/getUpdates");
			expect(u).not.toContain(TOKEN);
			expect(u).not.toContain(TOKEN_ENC);
		}
	});
});
