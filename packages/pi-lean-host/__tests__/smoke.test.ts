/**
 * Smoke tests.
 *
 * Verifies the extension loads without throwing and vendored primitives
 * work as expected.
 */

import { describe, it, expect } from "vitest";
import { ssrfGuard } from "../core/ssrf-guard.js";
import { buildDomainMap, type Guide } from "../core/guide-loader.js";

// ─── index.ts loads without throwing ─────────────────────────────

describe("extension smoke", () => {
	it("loads index.ts without error", async () => {
		// Dynamic import to verify the module is loadable.
		// We expect a default export function.
		const mod = await import("../index.js");
		expect(mod.default).toBeTypeOf("function");
	});
});

// ─── ssrfGuard ───────────────────────────────────────────────────

describe("ssrfGuard", () => {
	function expectRejected(raw: string): void {
		const result = ssrfGuard(raw);
		expect(result.ok).toBe(false);
		const r = result as { ok: false; reason: string };
		expect(r.reason).toBeTruthy();
	}

	it("rejects AWS metadata endpoint", () => {
		const result = ssrfGuard("http://169.254.169.254/latest/meta-data/");
		expect(result.ok).toBe(false);
		expect((result as { ok: false; reason: string }).reason).toContain(
			"169.254.169.254",
		);
	});

	it("rejects private IP 10.x.x.x", () => {
		const result = ssrfGuard("http://10.0.0.1/admin");
		expect(result.ok).toBe(false);
		expect((result as { ok: false; reason: string }).reason).toContain(
			"private network",
		);
	});

	it("rejects 127.0.0.1 (loopback)", () => {
		expectRejected("http://127.0.0.1/");
	});

	it("rejects 192.168.x.x (private network)", () => {
		expectRejected("http://192.168.1.1/");
	});

	it("rejects metadata.google.internal", () => {
		expectRejected("http://metadata.google.internal/");
	});

	it("allows a legitimate public API URL", () => {
		const result = ssrfGuard("https://apidatos.boe.es/v1/diario/20260717");
		expect(result.ok).toBe(true);
	});

	it("rejects malformed URL", () => {
		const result = ssrfGuard("not a url at all");
		expect(result.ok).toBe(false);
		expect((result as { ok: false; reason: string }).reason).toBe(
			"Malformed URL",
		);
	});
});

// ─── buildDomainMap ──────────────────────────────────────────────

describe("buildDomainMap", () => {
	const guides: Record<string, Guide> = {
		boe: {
			category: "site",
			source: "user",
			updated: "2026-07-17",
			icon: "🏛",
			shortName: "BOE",
			content: "Content",
			domains: ["boe.es", "apidatos.boe.es"],
		},
		reddit: {
			category: "site",
			source: "builtin",
			updated: "2026-01-01",
			icon: "🔴",
			shortName: "Reddit",
			content: "Content",
			domains: ["reddit.com"],
		},
		"no-domains": {
			category: "site",
			source: "user",
			updated: "2026-01-01",
			icon: "📖",
			shortName: "No Domains",
			content: "Content",
		},
	};

	it("maps all domains to their guide names", () => {
		const map = buildDomainMap(guides);
		expect(map["boe.es"]).toEqual(["boe"]);
		expect(map["apidatos.boe.es"]).toEqual(["boe"]);
		expect(map["reddit.com"]).toEqual(["reddit"]);
	});

	it("excludes guides without domains", () => {
		const map = buildDomainMap(guides);
		expect(map["no-domains"]).toBeUndefined();
	});
});
