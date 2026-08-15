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
import { summarize, emitDraft, probe } from "../tools/api-probe.js";
import { apiProbeTool } from "../tools/index.js";
import { contentText } from "../tools/utils.js";
import { writeSecret, setSecretsDir } from "../core/secrets-store.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
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

	it("maps a bare top-level array to paginate with $ (root sentinel)", () => {
		const s = summarize([{ sha: "abc" }, { sha: "def" }]);
		expect(s.topLevel).toBe("array");
		expect(s.isArray).toBe(true);
		expect(s.suggestedVia).toBe("paginate");
		expect(s.suggestedItemsPath).toBe("$");
		expect(s.arrayLen).toBe(2);
	});

	it("maps a single object to restGet with no itemsPath", () => {
		const s = summarize({ login: "octocat", id: 583231 });
		expect(s.topLevel).toBe("object");
		expect(s.suggestedVia).toBe("restGet");
		expect(s.suggestedItemsPath).toBe("");
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
	});
});
