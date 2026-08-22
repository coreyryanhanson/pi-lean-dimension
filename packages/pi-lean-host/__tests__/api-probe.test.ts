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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	summarize,
	emitDraft,
	probe,
	formatProbeResult,
	MAX_VERSION_WALK,
	resolveProbeStoreDomain,
} from "../tools/api-probe.js";
import { apiProbeTool } from "../tools/index.js";
import { contentText } from "../tools/utils.js";
import { Check } from "typebox/value";
import {
	writeSecret,
	setSecretsDir,
	getSecretsDir,
} from "../core/secrets-store.js";
import {
	setUserGuidesDir,
	getUserGuidesDir,
	invalidateCache,
} from "../core/guide-store.js";
import { parseApiGuide } from "../core/parse-api-guide.js";
import { GUIDE_SCHEMA_VERSION } from "../core/api-guide-types.js";
import {
	_setToggleStateForTest,
	_resetToggleStateForTest,
} from "../core/api-toggle.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

	it("scaffoldNudge: true appends the scaffold: true footer line", () => {
		const text = formatProbeResult({
			...base,
			status: 200,
			ok: true,
			shape: summarize({ data: [1, 2, 3] }),
			scaffoldNudge: true,
		});
		expect(text).toContain("pass scaffold: true to emit a full recipe skeleton");
	});

	it("no scaffoldNudge → no scaffold footer line", () => {
		const text = formatProbeResult({
			...base,
			status: 200,
			ok: true,
			shape: summarize({ data: [1, 2, 3] }),
		});
		expect(text).not.toContain("pass scaffold: true");
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

	it("auth injected, nothing missing, server 403 → injected-but-rejected wording (403 variant)", async () => {
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
			expect(result.note ?? "").toContain(
				"auth injected but rejected; verify header name",
			);
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, 403 with CMC error_code 1006 → plan-limit wording, not verify-header", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-403-plan-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "K");
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
			expect(note).toContain(
				"key accepted — endpoint not on your subscription plan",
			);
			expect(note).not.toContain("verify header name");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, 403 with plan-text message → plan-limit wording (general fallback)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-403-plantext-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("api.example.com", "api_key", "K");
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
			expect(note).toContain(
				"key accepted — endpoint not on your subscription plan",
			);
			expect(note).not.toContain("verify header name");
		} finally {
			server.close();
			server.closeAllConnections?.();
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("auth injected, 401 with plan text → stays verify-header (plan check is 403-only)", async () => {
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

// ═══════════════════════════════════════════════════════════════════
// List mode — learn-gated secrets discovery (the bootstrap-gap closure)
// ═══════════════════════════════════════════════════════════════════

const ETHERSCAN_RECIPE = `---
domains: [etherscan.io]
apiHost: https://api.etherscan.io/v2/api
auth:
  kind: static-key
  secretQueryRefs:
    apikey: api_key
  requires:
    - api_key
responseShape:
  format: json
operations:
  - name: ping
    via: restGet
    path: /
    accept: json
    params: {}
---
`;

let listTmpSecrets: string;
let listTmpGuides: string;

beforeAll(() => {
	listTmpSecrets = mkdtempSync(join(tmpdir(), "host-probe-secrets-"));
	listTmpGuides = mkdtempSync(join(tmpdir(), "host-probe-guides-"));
	setSecretsDir(listTmpSecrets);
	setUserGuidesDir(listTmpGuides);
	// Learn mode on for the discovery tests (reset per test where needed).
	_setToggleStateForTest(true, true);
	// Provision the key + register a guide that declares it (routing domain etherscan.io).
	writeSecret("etherscan.io", "api_key", "REALKEY");
	const dir = join(listTmpGuides, "etherscan.io");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), ETHERSCAN_RECIPE);
	// A hostname-routable secret for the domain-default test (host == domain).
	writeSecret("api.github.com", "gh_token", "GHKEY");
	invalidateCache();
});

afterAll(() => {
	rmSync(listTmpSecrets, { recursive: true, force: true });
	rmSync(listTmpGuides, { recursive: true, force: true });
	_resetToggleStateForTest();
});

function runList(
	params: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof apiProbeTool.execute>>> {
	return apiProbeTool.execute(
		"t",
		params,
		undefined,
		undefined,
		undefined as any,
	);
}

describe("api-probe listSecrets mode (the bootstrap-gap closure)", () => {
	it("tool + param descriptions advertise the bare-call orphan view", () => {
		const params = apiProbeTool.parameters as unknown as {
			properties?: {
				listSecrets?: { description?: string };
			};
		};
		const listDesc = params.properties?.listSecrets?.description ?? "";
		// Both modes named, incl. the no-domain bootstrap view + gaps.
		expect(listDesc).toContain("provisioned-but-guideless");
		expect(listDesc).toContain("authoring-bootstrap");
		expect(listDesc).toContain("declared-vs-stored gaps");
		// Tool description directs the author to call it empty first in learn mode.
		expect(apiProbeTool.description).toContain("listSecrets: true");
		expect(apiProbeTool.description).toContain("store-miss round-trip");
	});
	it("in learn mode returns provisioned + declared names, no fetch fields", async () => {
		const res = await runList({
			apiHost: "https://api.etherscan.io/v2/api",
			path: "/",
			domain: "etherscan.io", // routing domain — hostname (api.etherscan.io) differs
			listSecrets: true,
		});
		const d = res.details as Record<string, unknown>;
		const secrets = d.secrets as {
			domain: string;
			provisioned: string[];
			declared?: string[];
		};
		expect(secrets.domain).toBe("etherscan.io");
		expect(secrets.provisioned).toEqual(["api_key"]);
		expect(secrets.declared).toContain("api_key");
		// Fetch fields are empty in list mode.
		expect(d.url).toBeUndefined();
		expect(d.status).toBeUndefined();
		expect(d.raw).toBeUndefined();
		expect(d.shape).toBeUndefined();
	});

	it("domain defaults to apiHost's hostname", async () => {
		const res = await runList({
			apiHost: "https://api.github.com",
			path: "/repos",
			listSecrets: true,
		});
		const secrets = (res.details as Record<string, unknown>).secrets as {
			domain: string;
			provisioned: string[];
		};
		expect(secrets.domain).toBe("api.github.com");
		expect(secrets.provisioned).toContain("gh_token");
	});

	it("apiHost without domain falls back to the provisioned parent domain in the report", async () => {
		// Isolated store: the secret lives under the registrable domain; the
		// apiHost is the api subdomain. listSecrets must report the parent.
		const tmp = mkdtempSync(join(tmpdir(), "host-probe-list-fallback-"));
		const prevDir = getSecretsDir();
		setSecretsDir(tmp);
		writeSecret("coinmarketcap.com", "api_key", "CMC-KEY");
		try {
			const res = await runList({
				apiHost: "https://pro-api.coinmarketcap.com",
				path: "/v1/cryptocurrency/map",
				listSecrets: true,
			});
			const secrets = (res.details as Record<string, unknown>).secrets as {
				domain: string;
				provisioned: string[];
			};
			expect(secrets.domain).toBe("coinmarketcap.com");
			expect(secrets.provisioned).toEqual(["api_key"]);
			expect(contentText(res)).not.toContain("CMC-KEY"); // names only
		} finally {
			setSecretsDir(prevDir);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("names only — never emits a secret value", async () => {
		const res = await runList({
			apiHost: "https://api.etherscan.io/v2/api",
			path: "/",
			domain: "etherscan.io",
			listSecrets: true,
		});
		expect(contentText(res)).not.toContain("REALKEY");
	});

	it("declared is omitted when no guide is registered for the domain", async () => {
		const res = await runList({
			apiHost: "https://api.unknown.test",
			path: "/",
			listSecrets: true,
			domain: "api.unknown.test",
		});
		const secrets = (res.details as Record<string, unknown>).secrets as {
			provisioned: string[];
			declared?: string[];
		};
		expect(secrets.provisioned).toEqual([]);
		expect(secrets.declared).toBeUndefined();
	});

	it("learn gate: refused under /api on (non-learn), does not touch the store", async () => {
		_setToggleStateForTest(true, false); // /api on — learn off
		try {
			const res = await runList({
				apiHost: "https://api.etherscan.io/v2/api",
				path: "/",
				domain: "etherscan.io",
				listSecrets: true,
			});
			const d = res.details as Record<string, unknown>;
			expect(d.error).toBe("learn_mode_only");
			expect(d.secrets).toBeUndefined(); // no discovery happened
			expect(contentText(res)).toContain("learn mode only");
		} finally {
			_setToggleStateForTest(true, true);
		}
	});

	it("bare listSecrets (no domain, no apiHost) lists unscoped store domains only", async () => {
		const res = await runList({ listSecrets: true });
		const d = res.details as Record<string, unknown>;
		const unscoped = d.unscoped as string[];
		expect(unscoped).toContain("api.github.com"); // provisioned, no guide
		expect(unscoped).not.toContain("etherscan.io"); // scoped to a guide
		expect(d.secrets).toBeUndefined(); // no per-domain view
		const text = contentText(res);
		expect(text).toContain("unscoped store domains");
		expect(text).not.toContain("REALKEY"); // names only
		// bare call: nothing suppressed, so no note
		expect(text).not.toContain("probe suppressed");
	});

	it("bare listSecrets: true is schema-legal and reaches the orphan view (through the schema)", async () => {
		// The documented bootstrap call is rejected by the schema when apiHost/
		// path are required — the regression runList's direct execute bypasses.
		expect(Check(apiProbeTool.parameters, { listSecrets: true })).toBe(true);
		const res = await runList({ listSecrets: true });
		const d = res.details as Record<string, unknown>;
		const unscoped = d.unscoped as string[];
		expect(unscoped).toContain("api.github.com");
		expect(d.secrets).toBeUndefined();
	});

	it("missing apiHost/path (non-listSecrets) returns the guard error, not a throw", async () => {
		const res = await runList({ path: "/items" });
		const d = res.details as Record<string, unknown>;
		expect(d.error).toBe("missing_apiHost_or_path");
		expect(contentText(res)).toContain("apiHost and path are required");
	});

	it("apiHost without domain lists unscoped first, then the per-domain view", async () => {
		const res = await runList({
			apiHost: "https://api.github.com",
			path: "/repos",
			listSecrets: true,
		});
		const d = res.details as Record<string, unknown>;
		const secrets = d.secrets as { domain: string; provisioned: string[] };
		const unscoped = d.unscoped as string[];
		expect(unscoped).toContain("api.github.com");
		expect(secrets.domain).toBe("api.github.com");
		expect(secrets.provisioned).toContain("gh_token");
		const text = contentText(res);
		// orphan list first, then the per-domain view
		expect(text.indexOf("unscoped store domains")).toBeLessThan(
			text.indexOf("secrets for api.github.com"),
		);
		// apiHost present means a real probe was suppressed — say so
		expect(text).toContain("probe suppressed because listSecrets: true");
	});

	it("domain present: per-domain view unchanged, no unscoped section", async () => {
		const res = await runList({
			apiHost: "https://api.etherscan.io/v2/api",
			path: "/",
			domain: "etherscan.io",
			listSecrets: true,
		});
		const d = res.details as Record<string, unknown>;
		expect(d.unscoped).toBeUndefined();
		expect(contentText(res)).not.toContain("unscoped store domains");
		const secrets = d.secrets as { domain: string };
		expect(secrets.domain).toBe("etherscan.io");
		// domain present also suppresses the probe
		expect(contentText(res)).toContain(
			"probe suppressed because listSecrets: true",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Scaffold emission — full skeleton vs op-block + merge note
// ═══════════════════════════════════════════════════════════════════

const SCAFFOLD_GUIDE = `---
domains: [archive.org]
apiHost: https://archive.org/wayback
responseShape:
  format: json
operations:
  - name: ping
    via: restGet
    path: /
    accept: json
    params: {}
---
`;

// The probe hits a live localhost server; the scaffold decision is driven by
// guides on a temp dir (0 / 1 / N claiming the routed domain).
describe("api-probe scaffold", () => {
	let scaffoldTmpGuides: string;
	let prevGuidesDir: string;
	let server: http.Server;
	let base: string;

	beforeAll(async () => {
		prevGuidesDir = getUserGuidesDir();
		scaffoldTmpGuides = mkdtempSync(
			join(tmpdir(), "host-probe-scaffold-guides-"),
		);
		// 1-guide domain: archive.org
		const one = join(scaffoldTmpGuides, "archive.org");
		mkdirSync(one, { recursive: true });
		writeFileSync(join(one, "guide.md"), SCAFFOLD_GUIDE);
		// N-guide domain: two dirs both claiming multi.test
		for (const dir of ["multi-a", "multi-b"]) {
			const d = join(scaffoldTmpGuides, dir);
			mkdirSync(d, { recursive: true });
			writeFileSync(
				join(d, "guide.md"),
				SCAFFOLD_GUIDE.replace("archive.org", "multi.test"),
			);
		}
		setUserGuidesDir(scaffoldTmpGuides);
		invalidateCache();
		server = http.createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: 1 }], total_count: 10 }));
		});
		await new Promise<void>((r) => server.listen(0, r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => {
		server.close();
		server.closeAllConnections?.();
		setUserGuidesDir(prevGuidesDir);
		invalidateCache();
		rmSync(scaffoldTmpGuides, { recursive: true, force: true });
	});

	it("bootstrap (0 guides): parseable full skeleton with static-key auth translated from injection params", async () => {
		const result = await probe(
			base,
			"/items",
			{},
			{
				scaffold: true,
				domain: "api.example.com",
				auth: {
					secretRefs: { Authorization: "apiKey" },
					headerPrefixes: { Authorization: "Bearer " },
				},
			},
		);
		const draft = result.draft;
		expect(draft).toContain("---");
		expect(draft).toContain("kind: api");
		expect(draft).toContain("domains: [api.example.com]");
		expect(draft).toContain(`apiHost: ${base}`);
		expect(draft).toContain("responseShape:");
		expect(draft).toContain("gatherAllMax: 1000");
		expect(draft).toContain(`schemaVersion: ${GUIDE_SCHEMA_VERSION}`);
		expect(draft).toContain("auth:");
		expect(draft).toContain("kind: static-key");
		expect(draft).toContain("requires: [apiKey]");
		expect(draft).toContain("secretRefs:");
		expect(draft).toContain("Authorization: apiKey");
		expect(draft).toContain("headerPrefixes:");
		expect(draft).toContain('Authorization: "Bearer "');
		// Pagination stays op-level only — never a top-level default.
		expect(draft).not.toMatch(/^pagination:/m);
		// The skeleton parses cleanly and carries the detection-ready vintage.
		const parsed = parseApiGuide(draft, { filename: "scaffold" });
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.guide.auth.kind).toBe("static-key");
			expect(parsed.guide.auth.requires).toEqual(["apiKey"]);
			expect(parsed.guide.auth.secretRefs).toEqual({ Authorization: "apiKey" });
			expect(parsed.guide.schemaVersion).toBe(GUIDE_SCHEMA_VERSION);
		}
	});

	it("translates secretQueryRefs into the auth block too", async () => {
		const result = await probe(
			base,
			"/items",
			{},
			{
				scaffold: true,
				domain: "api.example.com",
				auth: { secretQueryRefs: { apikey: "api_key" } },
			},
		);
		expect(result.draft).toContain("kind: static-key");
		expect(result.draft).toContain("requires: [api_key]");
		expect(result.draft).toContain("secretQueryRefs:");
		expect(result.draft).toContain("apikey: api_key");
	});

	it("1 guide: op block only + merge note naming the one dirName", async () => {
		const result = await probe(
			base,
			"/items",
			{},
			{
				scaffold: true,
				domain: "archive.org",
			},
		);
		expect(result.draft).not.toContain("---");
		expect(result.draft).toContain("  - name:");
		expect(result.note ?? "").toContain("merge into `archive.org`");
	});

	it("N guides: op block only + merge note listing every candidate dirName", async () => {
		const result = await probe(
			base,
			"/items",
			{},
			{
				scaffold: true,
				domain: "multi.test",
			},
		);
		expect(result.draft).not.toContain("---");
		expect(result.note ?? "").toContain("merge into one of: multi-a, multi-b");
	});

	it("scaffold absent: output unchanged (op block only, no frontmatter)", async () => {
		const plain = await probe(base, "/items", {});
		const explicitFalse = await probe(base, "/items", {}, { scaffold: false });
		expect(explicitFalse.draft).toBe(plain.draft);
		expect(plain.draft).not.toContain("---");
		expect(plain.draft).not.toMatch(/^pagination:/m);
	});

	it("scaffold absent + no guide → scaffoldNudge true (footer suggests scaffold: true)", async () => {
		const result = await probe(base, "/items", {}, { domain: "api.example.com" });
		expect(result.scaffoldNudge).toBe(true);
		expect(formatProbeResult(result)).toContain(
			"pass scaffold: true to emit a full recipe skeleton",
		);
	});

	it("scaffold absent + guide exists → no nudge", async () => {
		const result = await probe(base, "/items", {}, { domain: "archive.org" });
		expect(result.scaffoldNudge).toBeUndefined();
	});

	it("scaffold: true + no guide → no nudge (already used the skeleton)", async () => {
		const result = await probe(
			base,
			"/items",
			{},
			{ domain: "api.example.com", scaffold: true },
		);
		expect(result.scaffoldNudge).toBeUndefined();
	});

	it("tool description names scaffold: true and its auto-degrade behavior", () => {
		expect(apiProbeTool.description).toContain("scaffold: true");
		expect(apiProbeTool.description).toContain("auto-degrades");
	});
});
