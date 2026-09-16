/**
 * Smoke tests.
 *
 * Verifies the extension loads without throwing and vendored primitives
 * work as expected. (ssrfGuard unit tests live in ssrf-guard.test.ts.)
 */

import { describe, it, expect } from "vitest";
import { buildDomainMap, type Guide } from "../core/guide-loader.js";

// ─── index.ts loads without throwing ─────────────────────────────

describe("extension smoke", () => {
	it("loads index.ts without error", async () => {
		// Dynamic import to verify the module is loadable.
		// We expect a default export function.
		const mod = await import("../index.js");
		expect(mod.default).toBeTypeOf("function");
	}, 120_000); // the full extension import is slow under host load
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
