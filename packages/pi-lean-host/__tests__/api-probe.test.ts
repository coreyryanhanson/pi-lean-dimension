/**
 * api-probe structural tests — pure shape logic, no external network.
 *
 * Covers:
 *  - envelope → paginate + itemsPath
 *  - bare array → `$` (root sentinel)
 *  - single object → restGet
 *  - representative-ID pick
 *  - pagination marker → style guess (via emitDraft)
 *
 * One deterministic loopback exception: a localhost 301 → final-URL test
 * that exercises the real transport (redirect-follow + finalUrl capture),
 * since that behavior is only observable through an actual undici request.
 * No HOST_INTEGRATION (external) live suite — matching the tool's role as a
 * dev/discovery aid.
 */

import { describe, it, expect } from "vitest";
import {
	summarize,
	emitDraft,
	probe,
	formatProbeResult,
	MAX_VERSION_WALK,
} from "../tools/api-probe.js";
import { resolveProvisionedParentDomain as resolveProbeStoreDomain } from "../core/auth.js";
import { apiProbeTool } from "../tools/index.js";
import { Check } from "typebox/value";
import {
	writeSecret,
	setSecretsDir,
	getSecretsDir,
} from "../core/secrets-store.js";
import {
	readToken,
	writeToken,
	setOAuthDir,
	getOAuthDir,
} from "../core/oauth-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

describe("summarize", () => {
	it("maps an envelope with an array-valued key to paginate + itemsPath", () => {
		const s = summarize({
			offset: 0,
			limit: 30,
			endOfRecords: false,
			results: [{ id: 42, name: "x" }],
		});
		expect(s.topLevel).toBe("object");
		expect(s.suggestedVia).toBe("paginate");
		expect(s.suggestedItemsPath).toBe("results");
		expect(s.arrayLen).toBe(1);
		expect(s.paginationMarkers).toContain("offset");
		expect(s.paginationMarkers).toContain("limit");
	});

	it("maps a bare top-level array to restGet when no pagination markers present", () => {
		const s = summarize([{ sha: "abc" }, { sha: "def" }]);
		expect(s.topLevel).toBe("array");
		expect(s.isArray).toBe(true);
		expect(s.suggestedVia).toBe("restGet");
		expect(s.suggestedItemsPath).toBe("$");
		expect(s.arrayLen).toBe(2);
	});

	it("maps a single object to restGet with no itemsPath", () => {
		const s = summarize({ login: "octocat", id: 583231 });
		expect(s.topLevel).toBe("object");
		expect(s.suggestedVia).toBe("restGet");
		expect(s.suggestedItemsPath).toBe("");
	});

	it("restGet on an enveloped array with no pagination markers, keeping itemsPath", () => {
		const s = summarize({ data: [1, 2, 3] });
		expect(s.suggestedVia).toBe("restGet");
		expect(s.suggestedItemsPath).toBe("data");
	});

	it("paginate on an enveloped array with a pagination marker", () => {
		const s = summarize({ data: [{ id: 1 }], total_count: 100 });
		expect(s.suggestedVia).toBe("paginate");
		expect(s.suggestedItemsPath).toBe("data");
	});

	it("maps bare scalars to restGet", () => {
		expect(summarize(42).suggestedVia).toBe("restGet");
		expect(summarize("hello").suggestedVia).toBe("restGet");
		expect(summarize(null).topLevel).toBe("null");
	});

	it("picks a representative id from the first record", () => {
		const s = summarize([{ id: 7, name: "x" }]);
		expect(s.representativeId).toEqual({ field: "id", value: 7 });
	});

	it("falls back through the id-field priority list", () => {
		const s = summarize([{ sha: "abc123", name: "x" }]);
		expect(s.representativeId).toEqual({ field: "sha", value: "abc123" });
	});

	it("omits representativeId when the first record has no id-ish field", () => {
		const s = summarize([{ name: "x" }]);
		expect(s.representativeId).toBeUndefined();
	});

	it("prefers a known envelope key over an arbitrary array key", () => {
		const s = summarize({ data: [{ id: 1 }], meta: [{ id: 2 }] });
		expect(s.suggestedItemsPath).toBe("data");
	});
});

describe("emitDraft (marker → style guess)", () => {
	it("guesses page style when page/per_page markers are present", () => {
		const shape = summarize({
			page: 1,
			per_page: 30,
			results: [{ id: 1 }],
		});
		const draft = emitDraft(
			"/repos/{owner}/{repo}/branches",
			{ owner: "o" },
			shape,
		);
		expect(draft).toContain("style: page");
		expect(draft).toContain("pageParam: page");
		expect(draft).toContain("pageSizeParam: per_page");
		expect(draft).toContain("# unverified");
	});

	it("guesses offset-limit style otherwise", () => {
		const shape = summarize({
			offset: 0,
			limit: 30,
			results: [{ id: 1 }],
		});
		const draft = emitDraft("/items", {}, shape);
		expect(draft).toContain("style: offset-limit");
		expect(draft).toContain("pageParam: offset");
		expect(draft).toContain("pageSizeParam: limit");
		expect(draft).toContain("# unverified");
	});

	it("detects 1-based `start` marker and emits pageParam: start + base: 1", () => {
		// CMC/GBIF-style: 1-based row offset, not a 0-based offset or a page index.
		const shape = summarize({
			start: 1,
			limit: 100,
			data: [{ id: 1 }],
		});
		expect(shape.suggestedVia).toBe("paginate");
		const draft = emitDraft("/cryptocurrency/listings/latest", {}, shape);
		expect(draft).toContain("style: offset-limit");
		expect(draft).toContain("pageParam: start");
		expect(draft).toContain("pageSizeParam: limit");
		expect(draft).toContain("base: 1");
		expect(draft).not.toContain("pageParam: offset");
	});

	it("does not re-declare path tokens in the emitted params", () => {
		const shape = summarize({ results: [{ id: 1 }] });
		const draft = emitDraft(
			"/repos/{owner}/{repo}/branches",
			{ owner: "octocat", repo: "Hello-World", per_page: 30 },
			shape,
		);
		expect(draft).toContain("path: /repos/{owner}/{repo}/branches");
		expect(draft).toContain("params:");
		expect(draft).toContain("per_page:");
		expect(draft).not.toContain("owner:");
		expect(draft).not.toContain("repo:");
	});

	it("echoes the representative id as a comment", () => {
		const shape = summarize([{ id: 42, name: "x" }]);
		const draft = emitDraft("/users", {}, shape);
		expect(draft).toContain("# representative id: id=42");
	});

	it("no-marker restGet draft has no pagination block and notes the array", () => {
		const shape = summarize({ data: [1, 2, 3] });
		expect(shape.suggestedVia).toBe("restGet");
		const draft = emitDraft("/items", {}, shape);
		expect(draft).toContain("via: restGet");
		expect(draft).not.toContain("pagination:");
		expect(draft).toContain("no pagination markers");
		// The no-marker note must explain how paginate would advance, so the
		// author doesn't fall back to restGet just to avoid guessing (issue #3).
		expect(draft).toContain("base: 1 for 1-based `start` APIs like CMC");
	});
});

describe("#4 probe draft carries the verified version", () => {
	const paginateShape = summarize({ data: [{ id: 1 }], total_count: 10 });

	it("base case: apiHost /v3 prefix is prepended to a bare path", () => {
		const draft = emitDraft(
			"/cryptocurrency/listings/latest",
			{},
			paginateShape,
			"/v3",
		);
		expect(draft).toContain("path: /v3/cryptocurrency/listings/latest");
	});

	it("no-op when apiHost has no version (prefix empty)", () => {
		const draft = emitDraft("/counties", {}, paginateShape, "");
		expect(draft).toContain("path: /counties");
	});

	it("idempotent — path already carrying the prefix is not double-prefixed", () => {
		const draft = emitDraft(
			"/v3/cryptocurrency/listings/latest",
			{},
			paginateShape,
			"/v3",
		);
		expect(draft).toContain("path: /v3/cryptocurrency/listings/latest");
	});

	it("trailing slash on apiHost version is normalized (no double slash)", () => {
		const draft = emitDraft("/items", {}, paginateShape, "/v3");
		expect(draft).toContain("path: /v3/items");
	});

	it("walkVersions: over-claimed /v3 404 → walks backward to /v2 (via probe)", async () => {
		const urls: string[] = [];
		const server = http.createServer((req, res) => {
			urls.push(req.url ?? "");
			if (req.url === "/v3/items") {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: 1 }] }));
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3`;
		try {
			const result = await probe(base, "/items");
			expect(result.status).toBe(200);
			expect(result.note ?? "").toContain("version walk → /v2");
			expect(result.draft).toContain("path: /v2/items");
			// base (/v3) + one walk (/v2) — never guesses /v1 upward.
			expect(urls).toEqual(["/v3/items", "/v2/items"]);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("base case via probe: apiHost with trailing /v3 → draft path carries /v3", async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: 1 }], total_count: 10 }));
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3`;
		try {
			const result = await probe(base, "/cryptocurrency/listings/latest");
			expect(result.status).toBe(200);
			expect(result.url).toBe(`${base}/cryptocurrency/listings/latest`);
			expect(result.draft).toContain("path: /v3/cryptocurrency/listings/latest");
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});
});

describe("probe version walk (backward recovery)", () => {
	const json = (data: unknown) => JSON.stringify(data);

	it("version gaps: /v4 and /v3 404, /v2 live → /v2", async () => {
		const urls: string[] = [];
		const server = http.createServer((req, res) => {
			urls.push(req.url ?? "");
			if (req.url === "/v4/items" || req.url === "/v3/items") {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(json({ data: [{ id: 1 }] }));
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v4`;
		try {
			const result = await probe(base, "/items");
			expect(result.status).toBe(200);
			expect(result.note ?? "").toContain("version walk → /v2");
			expect(result.draft).toContain("path: /v2/items");
			expect(urls).toEqual(["/v4/items", "/v3/items", "/v2/items"]);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("walk hit that redirects notes finalUrl (draft version vs redirect target)", async () => {
		const server = http.createServer((req, res) => {
			if (req.url === "/v3/items") {
				res.writeHead(404);
				res.end();
				return;
			}
			if (req.url === "/v2/items") {
				res.writeHead(301, { Location: "/real/items" });
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: 1 }] }));
		});
		await new Promise<void>((r) => server.listen(0, r));
		const port = (server.address() as AddressInfo).port;
		const base = `http://127.0.0.1:${port}/v3`;
		try {
			const result = await probe(base, "/items");
			expect(result.status).toBe(200);
			expect(result.url).toBe(`http://127.0.0.1:${port}/v2/items`);
			expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/real/items`);
			expect(result.note ?? "").toContain("verify finalUrl (redirect target)");
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("same-version 200: no extra requests fired", async () => {
		const urls: string[] = [];
		const server = http.createServer((req, res) => {
			urls.push(req.url ?? "");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(json({ data: [{ id: 1 }] }));
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3`;
		try {
			const result = await probe(base, "/items");
			expect(result.status).toBe(200);
			expect(urls).toEqual(["/v3/items"]);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("walk cap: /v10 with all lower 404 fires at most MAX_VERSION_WALK walks", async () => {
		const urls: string[] = [];
		const server = http.createServer((req, res) => {
			urls.push(req.url ?? "");
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v10`;
		try {
			const result = await probe(base, "/items");
			expect(result.status).toBe(404);
			// base (v10) + MAX_VERSION_WALK walks (v9…v5); floor = max(10-5,1) = 5.
			expect(urls.length).toBe(MAX_VERSION_WALK + 1);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("bare host 404: no probing, walk-skip note (regression of removed forward-guess)", async () => {
		const urls: string[] = [];
		const server = http.createServer((req, res) => {
			urls.push(req.url ?? "");
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const result = await probe(base, "/items");
			expect(result.status).toBe(404);
			expect(result.note ?? "").toContain("no version walk");
			expect(urls).toEqual(["/items"]); // bare fetch only
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("non-integer pathname host: no walk, walk-skip note", async () => {
		const urls: string[] = [];
		const server = http.createServer((req, res) => {
			urls.push(req.url ?? "");
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
		try {
			const result = await probe(base, "/items");
			expect(result.status).toBe(404);
			expect(result.note ?? "").toContain("no version walk");
			expect(urls).toEqual(["/api/items"]);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("version-in-path (mixed convention): no host walk", async () => {
		const urls: string[] = [];
		const server = http.createServer((req, res) => {
			urls.push(req.url ?? "");
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3`;
		try {
			const result = await probe(base, "/v3/data");
			expect(result.status).toBe(404);
			expect(urls).toEqual(["/v3/v3/data"]); // single fetch, no host walk
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});
});

describe("formatProbeResult docs-first nudge", () => {
	const NUDGE = "probe validates shape only";
	const base = {
		url: "https://api.example.com/items",
		finalUrl: "https://api.example.com/items",
		raw: "",
		draft: "",
	};

	it("appends the nudge on a successful (200) probe", () => {
		const text = formatProbeResult({
			...base,
			status: 200,
			ok: true,
			shape: summarize({ data: [1, 2, 3] }),
		});
		expect(text).toContain(NUDGE);
		expect(text).toContain("llms.txt");
	});

	it("appends the nudge on a 404 probe", () => {
		const text = formatProbeResult({
			...base,
			status: 404,
			ok: false,
			shape: null,
			note: "404",
		});
		expect(text).toContain(NUDGE);
		expect(text).toContain("llms.txt");
	});
});

describe("probe redirect handling (live localhost)", () => {
	it("follows a 301 and reports the final URL + parsed body (the /packs → /packs/ case)", async () => {
		const server = http.createServer((req, res) => {
			if (req.url === "/packs") {
				res.writeHead(301, { Location: "/packs/" });
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: 1 }], meta: { total: 1 } }));
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const result = await probe(base, "/packs");
			expect(result.status).toBe(200);
			expect(result.ok).toBe(true);
			expect(result.url).toBe(`${base}/packs`);
			expect(result.finalUrl).toBe(`${base}/packs/`);
			expect(result.shape?.topLevel).toBe("object");
			expect(result.shape?.suggestedItemsPath).toBe("data");
			expect(result.draft).toContain("path: /packs");
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	// A store miss names the other provisioned domains (names only).
	describe("probe store-miss note lists provisioned domains", () => {
		it("a missing ref names the other provisioned domains", async () => {
			// Isolated store with one generic provisioned domain (no real hosts).
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-miss-secrets-"));
			const prevDir = getSecretsDir();
			setSecretsDir(tmp);
			writeSecret("example.com", "api_key", "K");
			const server = http.createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: 1 }] }));
			});
			await new Promise<void>((r) => server.listen(0, r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				const result = await probe(
					base,
					"/packs",
					{},
					{
						domain: "api.example.com",
						auth: { secretRefs: { "x-api-key": "api_key" } },
					},
				);
				expect(result.note ?? "").toContain(
					'secret "api_key" not found in store for domain "api.example.com"',
				);
				expect(result.note ?? "").toContain("provisioned domains: example.com");
				// Prescriptive: a miss tells the author to pass domain: <one>.
				expect(result.note ?? "").toContain("pass domain:");
			} finally {
				server.close();
				server.closeAllConnections?.();
				setSecretsDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});
	});

	// OAuth2 store-read injection: useTokenStore reads the token
	// store — the value never enters the transcript; miss/expiry nudge /api oauth.
	describe("probe useTokenStore (oauth2 bearer injection)", () => {
		it("injects Authorization: Bearer from the token store; value never surfaces", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-token-ok-"));
			const prevDir = getOAuthDir();
			setOAuthDir(tmp);
			writeToken(
				"example.com",
				"client_credentials",
				"https://token.example.test/oauth/token",
				{
					accessToken: "tok_secret_value",
					expiresAt: Date.now() + 600_000,
				},
			);
			let seenAuth: string | undefined;
			const server = http.createServer((req, res) => {
				seenAuth = req.headers.authorization;
				// Echo the header back so the scrub path is exercised too.
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
			});
			await new Promise<void>((r) => server.listen(0, r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				const result = await probe(
					base,
					"/me",
					{},
					{
						domain: "example.com",
						auth: {
							useTokenStore: true,
							grant: "client_credentials",
							tokenUrl: "https://token.example.test/oauth/token",
						},
					},
				);
				expect(seenAuth).toBe("Bearer tok_secret_value");
				expect(result.ok).toBe(true);
				// Output-channel audit: echoed token scrubbed from the raw slice.
				expect(result.raw).not.toContain("tok_secret_value");
				expect(result.note ?? "").not.toContain("tok_secret_value");
			} finally {
				server.close();
				server.closeAllConnections?.();
				setOAuthDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("a missing token proceeds unauthenticated and nudges /api oauth", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-token-miss-"));
			const prevDir = getOAuthDir();
			setOAuthDir(tmp);
			let sawAuthHeader = false;
			const server = http.createServer((req, res) => {
				sawAuthHeader = req.headers.authorization !== undefined;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: 1 }] }));
			});
			await new Promise<void>((r) => server.listen(0, r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				const result = await probe(
					base,
					"/me",
					{},
					{
						domain: "example.com",
						auth: {
							useTokenStore: true,
							grant: "client_credentials",
							tokenUrl: "https://token.example.test/oauth/token",
						},
					},
				);
				// Probe misses are never fail-closed: request went out, no header.
				expect(sawAuthHeader).toBe(false);
				expect(result.ok).toBe(true);
				expect(result.note ?? "").toContain(
					'no cached token for "example.com"; run /api oauth example.com to mint one',
				);
			} finally {
				server.close();
				server.closeAllConnections?.();
				setOAuthDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("an expired token is not injected; the note nudges --refresh", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-token-exp-"));
			const prevDir = getOAuthDir();
			setOAuthDir(tmp);
			writeToken(
				"example.com",
				"client_credentials",
				"https://token.example.test/oauth/token",
				{
					accessToken: "tok_stale",
					expiresAt: Date.now() - 1_000,
				},
			);
			let sawAuthHeader = false;
			const server = http.createServer((req, res) => {
				sawAuthHeader = req.headers.authorization !== undefined;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: 1 }] }));
			});
			await new Promise<void>((r) => server.listen(0, r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				const result = await probe(
					base,
					"/me",
					{},
					{
						domain: "example.com",
						auth: {
							useTokenStore: true,
							grant: "client_credentials",
							tokenUrl: "https://token.example.test/oauth/token",
						},
					},
				);
				// A stale token is not sent (a 401 from it would mislead the author).
				expect(sawAuthHeader).toBe(false);
				expect(result.note ?? "").toContain(
					'token for "example.com" is expired; run /api oauth example.com --refresh',
				);
			} finally {
				server.close();
				server.closeAllConnections?.();
				setOAuthDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("useTokenStore without grant + tokenUrl is a loud validation error, not a silent miss", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-token-badkey-"));
			const prevDir = getOAuthDir();
			setOAuthDir(tmp);
			try {
				await expect(
					probe(
						"https://example.com",
						"/me",
						{},
						{
							domain: "example.com",
							auth: { useTokenStore: true },
						},
					),
				).rejects.toThrow(/auth\.useTokenStore requires auth\.grant/);
			} finally {
				setOAuthDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});
	});

	// Mint-on-demand (client-credentials authoring bootstrap): inline tokenUrl
	// + clientId mints when the store has no usable token, stamps it, and
	// injects the fresh Bearer. Failures ride the note — never fail-closed.
	describe("probe mint-on-demand (client-credentials bootstrap)", () => {
		it("absent token + mint fields → POSTs tokenUrl, stamps the store, injects the Bearer", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-mint-ok-"));
			const prevDir = getOAuthDir();
			const prevSecrets = getSecretsDir();
			setOAuthDir(tmp);
			setSecretsDir(tmp);
			writeSecret("example.com", "client_id", "cid_value");
			writeSecret("example.com", "client_secret", "cs_value");
			let tokenPosts = 0;
			let seenAuth: string | undefined;
			const server = http.createServer((req, res) => {
				if (req.method === "POST" && req.url === "/token") {
					tokenPosts++;
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							access_token: "minted_tok",
							token_type: "Bearer",
							expires_in: 3600,
						}),
					);
					return;
				}
				seenAuth = req.headers.authorization;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: 1 }] }));
			});
			await new Promise<void>((r) => server.listen(0, r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				const result = await probe(
					base,
					"/me",
					{},
					{
						domain: "example.com",
						auth: {
							tokenUrl: `${base}/token`,
							clientId: "client_id",
							clientSecret: "client_secret",
						},
					},
				);
				expect(tokenPosts).toBe(1);
				expect(seenAuth).toBe("Bearer minted_tok");
				// The mint stamped the token store for the rest of the loop.
				expect(
					readToken("example.com", "client_credentials", `${base}/token`)
						?.accessToken,
				).toBe("minted_tok");
				expect(result.ok).toBe(true);
				// Output-channel audit: the minted token never surfaces.
				expect(result.raw).not.toContain("minted_tok");
			} finally {
				server.close();
				server.closeAllConnections?.();
				setOAuthDir(prevDir);
				setSecretsDir(prevSecrets);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("a fresh cached token short-circuits the mint (no POST)", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-mint-cache-"));
			const prevDir = getOAuthDir();
			setOAuthDir(tmp);
			let tokenPosts = 0;
			let seenAuth: string | undefined;
			const server = http.createServer((req, res) => {
				if (req.method === "POST") {
					tokenPosts++;
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ access_token: "x" }));
					return;
				}
				seenAuth = req.headers.authorization;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: 1 }] }));
			});
			await new Promise<void>((r) => server.listen(0, r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				// Same slot the mint stamps: (client_credentials, ${base}/token).
				writeToken("example.com", "client_credentials", `${base}/token`, {
					accessToken: "cached_tok",
					expiresAt: Date.now() + 600_000,
				});
				const result = await probe(
					base,
					"/me",
					{},
					{
						domain: "example.com",
						auth: {
							tokenUrl: `${base}/token`,
							clientId: "client_id",
							clientSecret: "client_secret",
						},
					},
				);
				expect(tokenPosts).toBe(0);
				expect(seenAuth).toBe("Bearer cached_tok");
				expect(result.ok).toBe(true);
			} finally {
				server.close();
				server.closeAllConnections?.();
				setOAuthDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("mint failure rides the note; the probe proceeds unauthenticated", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-mint-miss-"));
			const prevDir = getOAuthDir();
			const prevSecrets = getSecretsDir();
			setOAuthDir(tmp);
			setSecretsDir(tmp); // isolated empty store — clientId will miss
			let sawAuthHeader = false;
			const server = http.createServer((req, res) => {
				if (req.method === "POST") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ access_token: "x" }));
					return;
				}
				sawAuthHeader = req.headers.authorization !== undefined;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: 1 }] }));
			});
			await new Promise<void>((r) => server.listen(0, r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				const result = await probe(
					base,
					"/me",
					{},
					{
						domain: "example.com",
						auth: {
							tokenUrl: `${base}/token`,
							clientId: "client_id",
							clientSecret: "client_secret",
						},
					},
				);
				expect(sawAuthHeader).toBe(false);
				expect(result.ok).toBe(true);
				expect(result.note ?? "").toContain("client id 'client_id'");
			} finally {
				server.close();
				server.closeAllConnections?.();
				setOAuthDir(prevDir);
				setSecretsDir(prevSecrets);
				rmSync(tmp, { recursive: true, force: true });
			}
		});
	});

	// The probe infers the store domain from apiHost; a secret filed under the
	// registrable domain must be found when the probe hits an api subdomain.
	describe("resolveProbeStoreDomain (secret-domain fallback)", () => {
		it("falls back to the provisioned parent domain (pro-api → registrable) when the hostname isn't provisioned", () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-fallback-secrets-"));
			const prevDir = getSecretsDir();
			setSecretsDir(tmp);
			writeSecret("coinmarketcap.com", "api_key", "K");
			try {
				expect(resolveProbeStoreDomain("pro-api.coinmarketcap.com")).toBe(
					"coinmarketcap.com",
				);
			} finally {
				setSecretsDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("exact-match hostname beats the parent fallback", () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-exact-secrets-"));
			const prevDir = getSecretsDir();
			setSecretsDir(tmp);
			writeSecret("api.example.com", "api_key", "EXACT");
			writeSecret("example.com", "api_key", "PARENT");
			try {
				expect(resolveProbeStoreDomain("api.example.com")).toBe("api.example.com");
			} finally {
				setSecretsDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("picks the longest matching parent when several are provisioned", () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-longest-secrets-"));
			const prevDir = getSecretsDir();
			setSecretsDir(tmp);
			writeSecret("example.com", "api_key", "A");
			writeSecret("api.example.com", "api_key", "B");
			try {
				expect(resolveProbeStoreDomain("graphql.api.example.com")).toBe(
					"api.example.com",
				);
			} finally {
				setSecretsDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("no provisioned parent → returns the hostname as-is", () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-noparent-secrets-"));
			const prevDir = getSecretsDir();
			setSecretsDir(tmp);
			try {
				expect(resolveProbeStoreDomain("api.unknown.test")).toBe(
					"api.unknown.test",
				);
			} finally {
				setSecretsDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("leading-dot guard: a sibling hostname never matches (malicious-example.com ≠ example.com)", () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-dotguard-secrets-"));
			const prevDir = getSecretsDir();
			setSecretsDir(tmp);
			writeSecret("example.com", "api_key", "K");
			try {
				expect(resolveProbeStoreDomain("malicious-example.com")).toBe(
					"malicious-example.com",
				);
			} finally {
				setSecretsDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});
	});

	// A misplaced top-level key inside params errors loudly before
	// any request; unknown keys inside auth are rejected by the schema.
	describe("probe reserve-guard", () => {
		it.each(["domain", "apiHost", "path", "auth"])(
			"throws naming %s when it appears inside params (no request)",
			async (reserved) => {
				await expect(
					probe("https://api.example.com", "/items", { [reserved]: "x" }),
				).rejects.toThrow(
					`"${reserved}" is a top-level param, not a query param — move it out of params`,
				);
			},
		);

		it("auth schema rejects an unknown key (additionalProperties: false)", () => {
			const schema = apiProbeTool.parameters;
			// Valid injection block passes.
			expect(
				Check(schema, {
					apiHost: "https://api.example.com",
					path: "/items",
					auth: { secretRefs: { "x-api-key": "k" } },
				}),
			).toBe(true);
			// A stray `domain` (a valid top-level key, not an auth field) is rejected.
			expect(
				Check(schema, {
					apiHost: "https://api.example.com",
					path: "/items",
					auth: { secretRefs: { "x-api-key": "k" }, domain: "stray" },
				}),
			).toBe(false);
		});
	});

	describe("probe inline auth.headerPrefixes", () => {
		it("prepends the prefix on the wire and scrubs the raw token from the body", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "host-probe-prefix-secrets-"));
			const prevDir = getSecretsDir();
			setSecretsDir(tmp);
			writeSecret("api.example.com", "api_key", "RAW-TOKEN");
			let sawAuthHeader = "";
			const server = http.createServer((req, res) => {
				sawAuthHeader = (req.headers["x-api-key"] ?? "") as string;
				// Echo the BARE token in the body — the probe scrub must redact it.
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: 1, echoed: "RAW-TOKEN" }] }));
			});
			await new Promise<void>((r) => server.listen(0, r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				const result = await probe(
					base,
					"/packs",
					{},
					{
						domain: "api.example.com",
						auth: {
							secretRefs: { "x-api-key": "api_key" },
							headerPrefixes: { "x-api-key": "Bearer " },
						},
					},
				);
				expect(sawAuthHeader).toBe("Bearer RAW-TOKEN");
				expect(result.raw).not.toContain("RAW-TOKEN");
			} finally {
				server.close();
				server.closeAllConnections?.();
				setSecretsDir(prevDir);
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("auth schema accepts a headerPrefixes injection block", () => {
			const schema = apiProbeTool.parameters;
			expect(
				Check(schema, {
					apiHost: "https://api.example.com",
					path: "/items",
					auth: {
						secretRefs: { "x-api-key": "k" },
						headerPrefixes: { "x-api-key": "Bearer " },
					},
				}),
			).toBe(true);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════
// 401/403 error wording + headerPrefixes-without-secretRefs
// ═══════════════════════════════════════════════════════════════════

/** Tiny stub: a JSON server that always replies with the given status and
 *  body (defaults to a plain 200-ish JSON object). */
async function stubProbeServer(
	status: number,
	body: unknown = { data: [{ id: 1 }] },
): Promise<{ server: http.Server; base: string }> {
	const server = http.createServer((_req, res) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	});
	await new Promise<void>((r) => server.listen(0, r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { server, base };
}

describe("api-probe 401/403 wording", () => {
	it("no auth block, 401 → endpoint-requires-auth wording (no stale guide phrase)", async () => {
		const { server, base } = await stubProbeServer(401);
		try {
			const result = await probe(base, "/packs");
			expect(result.note ?? "").toContain(
				"endpoint requires auth; configure auth injection",
			);
			expect(result.note ?? "").not.toContain("guide is auth:none");
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("auth injected (secret provisioned) but server 401 → injected-but-rejected wording", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-401-secrets-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "K");
		const { server, base } = await stubProbeServer(401);
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: { secretRefs: { "x-api-key": "api_key" } },
				},
			);
			const note = result.note ?? "";
			expect(note).toContain("auth injected but rejected; verify header name");
			expect(note).not.toContain("not found in store");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, secret missing from store → auth rejected; names the secret", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-401-miss-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		const { server, base } = await stubProbeServer(401);
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: { secretRefs: { "x-api-key": "api_key" } },
				},
			);
			const note = result.note ?? "";
			expect(note).toContain("auth rejected;");
			expect(note).toContain(
				'secret "api_key" not found in store for domain "api.example.com"',
			);
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, nothing missing, server 403 with no message → bare status, not verify-header", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-403-secrets-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "K");
		const { server, base } = await stubProbeServer(403);
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: { secretRefs: { "x-api-key": "api_key" } },
				},
			);
			// A 403 is "authenticated but forbidden" — "verify header" is a
			// 401 signal. No parseable message → bare status, no false signal.
			expect(result.note ?? "").toBe("403");
			expect(result.note ?? "").not.toContain("verify header name");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, 403 → server's own message surfaced, not verify-header", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-403-msg-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "sk-abc123");
		const { server, base } = await stubProbeServer(403, {
			status: {
				timestamp: "2026-01-01T00:00:00.000Z",
				error_code: 1006,
				error_message:
					"Your API Key subscription plan doesn't support this endpoint",
			},
		});
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: { secretRefs: { "x-api-key": "api_key" } },
				},
			);
			const note = result.note ?? "";
			// The server's own words, not a synthesized classification — and the
			// plan-gating hint, since the reason reads as a plan limitation.
			expect(note).toContain(
				"Your API Key subscription plan doesn't support this endpoint",
			);
			expect(note).toContain("plan/subscription limitation");
			expect(note).not.toContain("verify header name");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, 403 with message field → server's words surfaced", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-403-plantext-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "sk-abc123");
		const { server, base } = await stubProbeServer(403, {
			error: "Your plan does not include access to this endpoint",
		});
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: { secretRefs: { "x-api-key": "api_key" } },
				},
			);
			const note = result.note ?? "";
			expect(note).toContain("Your plan does not include access to this endpoint");
			expect(note).not.toContain("verify header name");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, 403 with detail field (Django/FastAPI) → server's words surfaced", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-403-detail-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "sk-abc123");
		const { server, base } = await stubProbeServer(403, {
			detail: "You do not have permission to perform this action.",
		});
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: { secretRefs: { "x-api-key": "api_key" } },
				},
			);
			const note = result.note ?? "";
			expect(note).toContain("You do not have permission to perform this action.");
			expect(note).not.toContain("verify header name");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, 403 echoing the secret → scrubbed to *** in the note", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-403-scrub-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "sk-abc123");
		const { server, base } = await stubProbeServer(403, {
			error: "Invalid key: sk-abc123",
		});
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: { secretRefs: { "x-api-key": "api_key" } },
				},
			);
			const note = result.note ?? "";
			expect(note).toContain("Invalid key: ***");
			expect(note).not.toContain("sk-abc123");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, 401 → stays verify-header (message surfacing is 403-only)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-401-plan-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "K");
		const { server, base } = await stubProbeServer(401, {
			error: "Your plan does not include access to this endpoint",
		});
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: { secretRefs: { "x-api-key": "api_key" } },
				},
			);
			const note = result.note ?? "";
			expect(note).toContain("auth injected but rejected; verify header name");
			expect(note).not.toContain("key accepted");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("api-probe headerPrefixes without secretRefs", () => {
	const ROOT_CAUSE = "headerPrefixes ignored: no secretRefs to apply them to";

	it("headerPrefixes-only, server 2xx → warning fires", async () => {
		const { server, base } = await stubProbeServer(200);
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{ auth: { headerPrefixes: { "x-api-key": "Bearer " } } },
			);
			expect(result.note ?? "").toContain(ROOT_CAUSE);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("headerPrefixes-only, server 401 → both the auth wording and the root cause", async () => {
		const { server, base } = await stubProbeServer(401);
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{ auth: { headerPrefixes: { "x-api-key": "Bearer " } } },
			);
			const note = result.note ?? "";
			expect(note).toContain("endpoint requires auth; configure auth injection");
			expect(note).toContain(ROOT_CAUSE);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("headerPrefixes-only, server 500 → warning surfaces on non-auth errors too", async () => {
		const { server, base } = await stubProbeServer(500);
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{ auth: { headerPrefixes: { "x-api-key": "Bearer " } } },
			);
			expect(result.note ?? "").toContain(ROOT_CAUSE);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("secretQueryRefs + headerPrefixes, no secretRefs, server 2xx → warning fires (edge case)", async () => {
		const { server, base } = await stubProbeServer(200);
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					auth: {
						secretQueryRefs: { token: "t" },
						headerPrefixes: { "x-api-key": "Bearer " },
					},
				},
			);
			expect(result.note ?? "").toContain(ROOT_CAUSE);
		} finally {
			server.close();
			server.closeAllConnections?.();
		}
	});

	it("correct shape (secretRefs + headerPrefixes) with secret provisioned → no warning", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-prefix-ok-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "K");
		const { server, base } = await stubProbeServer(200);
		try {
			const result = await probe(
				base,
				"/packs",
				{},
				{
					domain: "api.example.com",
					auth: {
						secretRefs: { "x-api-key": "api_key" },
						headerPrefixes: { "x-api-key": "Bearer " },
					},
				},
			);
			expect(result.note ?? "").not.toContain("headerPrefixes ignored");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
