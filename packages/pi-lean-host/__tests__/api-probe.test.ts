/**
 * api-probe structural tests — pure shape logic, no external network.
 *
 * Covers the plan's unit-test list:
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
import { summarize, emitDraft, probe } from "../tools/api-probe.js";
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
