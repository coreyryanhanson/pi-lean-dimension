/**
 * github synthetic axis guide — static-key auth, mocked transport.
 *
 * Covers the `static-key-auth` axis guide-driven: the guide parses with the
 * declared `secretRefs`/`optional` shape, and store-injected auth headers
 * (passed through the executor's `authHeaders` opt — the `api-fetch`
 * call site resolves them from the secrets store via `resolveSecretHeaders`)
 * reach the transport on both a `restGet` and a `paginate` op.
 *
 * The full output-channel audit (scrubbing, fail-closed-before-request for a
 * *required* secret, SSRF-on-auth, canonical store domain) is owned
 * structurally by `__tests__/auth.test.ts` / `query-secrets.test.ts` —
 * this guide marks the key `optional` so the fixture runs without
 * provisioning. No live endpoint.
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
import type { ApiGuide, Operation } from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { restGet, paginate } from "../../core/helpers.js";
import { loadApiGuidesFromDir } from "../../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../../core/guide-store.js";

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	const domainDir = join(guidesDir, "github");
	mkdirSync(domainDir, { recursive: true });
	const source = readFileSync(new URL("./guide.md", import.meta.url), "utf-8");
	writeFileSync(join(domainDir, "guide.md"), source, "utf-8");
	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	return { guide: loaded.guides["github"]! };
}

function findOp(guide: ApiGuide, name: string): Operation {
	const op = guide.operations.find((o) => o.name === name);
	if (!op) throw new Error(`op ${name} not found`);
	return op;
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-github-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("github static-key auth (mocked transport)", () => {
	it("parses as static-key with the declared ref shape", async () => {
		const { guide } = await setupRecipe();
		expect(guide.auth.kind).toBe("static-key");
		expect(guide.auth.secretRefs).toEqual({ Authorization: "api_key" });
		expect(guide.auth.optional).toEqual(["api_key"]);
	});

	it("restGet forwards the injected Authorization header to the transport", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ id: 1, name: "octocat/repo" }),
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = findOp(guide, "getRepo");

		await restGet(guide.apiHost, op, { owner: "octocat", repo: "hello" }, guide, {
			authHeaders: { Authorization: "secret-token" },
		});

		const call = mock.mock.calls.at(-1)!;
		const opts = call[1] as { headers?: Record<string, string> } | undefined;
		expect(opts?.headers?.["Authorization"]).toBe("secret-token");
	});

	it("paginate searchRepos forwards the header and pages via ?page=1", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		const mock = vi.mocked(fetchUrl);
		mock.mockResolvedValue({
			status: 200,
			headers: {},
			body: JSON.stringify({ total_count: 1, items: [{ id: 1, name: "a" }] }),
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = findOp(guide, "searchRepos");

		const result = await paginate(guide.apiHost, op, { q: "octocat" }, guide, {
			authHeaders: { Authorization: "secret-token" },
		});

		expect(result.items.length).toBeGreaterThan(0);
		const call = mock.mock.calls.at(-1)!;
		const opts = call[1] as { headers?: Record<string, string> } | undefined;
		expect(opts?.headers?.["Authorization"]).toBe("secret-token");
		expect(result.urls[0]).toContain("page=1");
	});
});
