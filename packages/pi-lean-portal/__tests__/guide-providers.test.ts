/**
 * Tests for peer-package guide provider integration (Sprint 7).
 *
 * Covers: registerGuideProvider / _clearGuideProviders, merged content
 * precedence (user > peer > builtin), kind propagation on ApplicableGuide,
 * host-first ordering (kind:"api" before kind:"web"), API section in
 * formatGuideList, API header in formatGuideFooter, and the projection
 * shape (no recipe fields leaking out of host).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	type Guide,
	type ApplicableGuide,
	getGuideContent,
	registerGuideProvider,
	_clearGuideProviders,
	resolveApplicableGuides,
	sortApplicableGuides,
	formatGuideList,
	formatGuideFooter,
	_setGuideContentForTest,
	buildDomainMap,
} from "../core/guides.js";

// ── Mock fs so on-disk user guides never leak into tests ───────
vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (p: unknown) =>
			typeof p === "string" && p.endsWith("web-guides")
				? false
				: actual.existsSync(p as string),
	};
});

// ── Fixtures ───────────────────────────────────────────────────

/** A peer-provided (host) guide projection — kind:"api", no recipe fields. */
function apiGuideFixture(name: string, domain: string): Guide {
	return {
		content: `API guide for ${domain}`,
		updated: "2026-07-01",
		category: "site",
		source: "builtin",
		icon: "📡",
		shortName: name,
		domains: [domain],
		kind: "api",
	};
}

/** A web site guide — kind omitted (defaults to "web"). */
function webGuideFixture(name: string, domain: string): Guide {
	return {
		content: `Web guide for ${domain}`,
		updated: "2026-07-01",
		category: "site",
		source: "user",
		icon: "📖",
		shortName: name,
		domains: [domain],
		// no kind → defaults to "web"
	};
}

// ── Setup / teardown ──────────────────────────────────────────

beforeEach(() => {
	_clearGuideProviders();
	_setGuideContentForTest(undefined);
});

afterEach(() => {
	_clearGuideProviders();
	_setGuideContentForTest(undefined);
});

// ═══════════════════════════════════════════════════════════════════
// Provider registry
// ═══════════════════════════════════════════════════════════════════

describe("registerGuideProvider", () => {
	it("registers a provider whose output appears in getGuideContent", () => {
		registerGuideProvider(() => ({
			"test-api": apiGuideFixture("test-api", "api.example.com"),
		}));

		const content = getGuideContent();
		expect(content["api:test-api"]).toBeDefined();
		expect(content["api:test-api"]!.kind).toBe("api");
	});

	it("supports multiple providers — output is merged", () => {
		registerGuideProvider(() => ({
			"api-a": apiGuideFixture("api-a", "a.example.com"),
		}));
		registerGuideProvider(() => ({
			"api-b": apiGuideFixture("api-b", "b.example.com"),
		}));

		const content = getGuideContent();
		expect(content["api:api-a"]).toBeDefined();
		expect(content["api:api-b"]).toBeDefined();
	});

	it("a throwing provider does not block the store", () => {
		registerGuideProvider(() => {
			throw new Error("bad provider");
		});
		registerGuideProvider(() => ({
			"good-api": apiGuideFixture("good-api", "good.example.com"),
		}));

		const content = getGuideContent();
		expect(content["api:good-api"]).toBeDefined();
	});

	it("_clearGuideProviders removes all registered providers", () => {
		registerGuideProvider(() => ({
			"test-api": apiGuideFixture("test-api", "api.example.com"),
		}));
		_clearGuideProviders();

		const content = getGuideContent();
		expect(content["api:test-api"]).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════
// Precedence: user > peer > builtin
// ═══════════════════════════════════════════════════════════════════

describe("precedence", () => {
	it("a same-named user web guide and peer api guide BOTH survive (namespaced)", () => {
		// Set up with test overrides simulating a user-authored web guide
		_setGuideContentForTest({
			"overlap-guide": webGuideFixture("overlap-guide", "user.example.com"),
		});

		registerGuideProvider(() => ({
			"overlap-guide": apiGuideFixture("overlap-guide", "peer.example.com"),
		}));

		const content = getGuideContent();
		// The user web guide keeps the bare key.
		expect(content["overlap-guide"]).toBeDefined();
		expect(content["overlap-guide"]!.kind).toBeUndefined();
		expect(content["overlap-guide"]!.domains).toEqual(["user.example.com"]);
		// The peer api projection survives under the api: namespace — it is
		// NOT clobbered by the same-named web guide.
		expect(content["api:overlap-guide"]).toBeDefined();
		expect(content["api:overlap-guide"]!.kind).toBe("api");
		expect(content["api:overlap-guide"]!.domains).toEqual(["peer.example.com"]);
	});

	it("an api-kind peer guide does NOT clobber a builtin guide of the same name", () => {
		// "bot-detection" is a builtin pattern guide; an api-kind peer guide
		// sharing its name is a different guide and must not overwrite it.
		registerGuideProvider(() => ({
			"bot-detection": {
				...apiGuideFixture("bot-api", "bot.example.com"),
				category: "pattern",
			},
		}));

		const content = getGuideContent();
		// Builtin survives unchanged (no kind — it's a web guide).
		expect(content["bot-detection"]).toBeDefined();
		expect(content["bot-detection"]!.kind).toBeUndefined();
		// The api-kind peer guide lives under the api: namespace.
		expect(content["api:bot-detection"]!.kind).toBe("api");
	});

	it("user-authored guide still wins over builtin (unchanged existing behavior)", () => {
		_setGuideContentForTest({
			"bot-detection": {
				category: "pattern",
				source: "user",
				updated: "2026-07-01",
				icon: "🤖",
				shortName: "custom bot",
				triggerSignal: "botDetected",
				content: "Custom bot guidance.",
			},
		});

		const content = getGuideContent();
		expect(content["bot-detection"]!.icon).toBe("🤖");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Kind propagation on ApplicableGuide
// ═══════════════════════════════════════════════════════════════════

describe("kind propagation in resolveApplicableGuides", () => {
	beforeEach(() => {
		registerGuideProvider(() => ({
			"test-api": apiGuideFixture("test-api", "api.example.com"),
			"web-site": webGuideFixture("web-site", "web.example.com"),
		}));
	});

	it("propagates kind:'api' for domain-matched API guides", () => {
		const result = resolveApplicableGuides(
			"https://api.example.com/foo",
			false,
			false,
		);
		const apiGuide = result.find((g) => g.kind === "api");
		expect(apiGuide).toBeDefined();
		expect(apiGuide!.reason).toBe("API guide for api.example.com");
	});

	it("propagates kind:'web' for domain-matched web guides", () => {
		const result = resolveApplicableGuides(
			"https://web.example.com/foo",
			false,
			false,
		);
		const webGuide = result.find((g) => g.kind === "web" || g.kind === undefined);
		expect(webGuide).toBeDefined();
		expect(webGuide!.reason).toBe("site guide for web.example.com");
	});

	it("propagates kind:'web' for pattern guides (no explicit kind)", () => {
		const result = resolveApplicableGuides("https://example.com/", true, false);
		const consent = result.find((g) => g.name === "cookie-consent");
		expect(consent).toBeDefined();
		expect(consent!.kind).toBe("web");
	});

	it("returns both api and web guides for the same page when both apply", () => {
		const result = resolveApplicableGuides(
			"https://api.example.com/foo",
			true,
			false,
		);
		// Should have the cookie-consent pattern + the api domain guide
		const kinds = result.map((g) => g.kind ?? "web").sort();
		expect(kinds).toContain("api");
		expect(kinds).toContain("web");
	});

	it("surfaces both an API guide and a web guide for the SAME domain (M2)", () => {
		// Overwrite the provider so both guides claim the same hostname.
		_clearGuideProviders();
		registerGuideProvider(() => ({
			"same-api": apiGuideFixture("same-api", "shared.example.com"),
		}));
		_setGuideContentForTest({
			"same-web": webGuideFixture("same-web", "shared.example.com"),
		});

		const result = resolveApplicableGuides(
			"https://shared.example.com/foo",
			false,
			false,
		);
		const names = result.map((g) => g.name);
		expect(names).toContain("api:same-api");
		expect(names).toContain("same-web");
		// API guide sorts first (host-first ordering).
		expect(names.indexOf("api:same-api")).toBeLessThan(names.indexOf("same-web"));
	});
});

// ═══════════════════════════════════════════════════════════════════
// Host-first ordering in sortApplicableGuides
// ═══════════════════════════════════════════════════════════════════

describe("sortApplicableGuides — host-first (kind:'api' before kind:'web')", () => {
	it("sorts api-kind guides before web-kind guides within site category", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "web-guide",
				icon: "📖",
				shortName: "web",
				reason: "site guide for example.com",
				category: "site",
				kind: "web",
			},
			{
				name: "api-guide",
				icon: "📡",
				shortName: "api",
				reason: "API guide for example.com",
				category: "site",
				kind: "api",
			},
		];

		const sorted = sortApplicableGuides(guides);
		expect(sorted[0]!.kind).toBe("api");
		expect(sorted[1]!.kind).toBe("web");
	});

	it("patterns still sort before sites regardless of kind", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "api-site",
				icon: "📡",
				shortName: "api site",
				reason: "API guide",
				category: "site",
				kind: "api",
			},
			{
				name: "bot-detection",
				icon: "⚠",
				shortName: "bot detection",
				reason: "challenge detected",
				category: "pattern",
				kind: "web",
			},
		];

		const sorted = sortApplicableGuides(guides);
		expect(sorted[0]!.category).toBe("pattern");
		expect(sorted[1]!.category).toBe("site");
	});

	it("within same kind, falls back to alphabetical by shortName", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "b-api",
				icon: "📡",
				shortName: "beta",
				reason: "API guide",
				category: "site",
				kind: "api",
			},
			{
				name: "a-api",
				icon: "📡",
				shortName: "alpha",
				reason: "API guide",
				category: "site",
				kind: "api",
			},
		];

		const sorted = sortApplicableGuides(guides);
		expect(sorted[0]!.shortName).toBe("alpha");
		expect(sorted[1]!.shortName).toBe("beta");
	});
});

// ═══════════════════════════════════════════════════════════════════
// formatGuideList — API guides section
// ═══════════════════════════════════════════════════════════════════

describe("formatGuideList — API section", () => {
	it("lists API guides under their own header when present", () => {
		registerGuideProvider(() => ({
			"test-api": apiGuideFixture("test-api", "api.example.com"),
		}));

		const text = formatGuideList();
		expect(text).toContain("API guides:");
		expect(text).toContain("api:test-api");
	});

	it("does NOT show API guides header when no API guides exist", () => {
		const text = formatGuideList();
		expect(text).not.toContain("API guides:");
	});

	it("still shows Site guides: and Pattern guides: even with API guides present", () => {
		registerGuideProvider(() => ({
			"test-api": apiGuideFixture("test-api", "api.example.com"),
		}));

		const text = formatGuideList();
		expect(text).toContain("Site guides:");
		expect(text).toContain("Pattern guides:");
	});
});

// ═══════════════════════════════════════════════════════════════════
// formatGuideFooter — API subheader
// ═══════════════════════════════════════════════════════════════════

describe("formatGuideFooter — API subheader", () => {
	it("shows API: subheader for api-kind guides", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "boe-api",
				icon: "📡",
				shortName: "BOE API",
				reason: "API guide for boe.es",
				category: "site",
				kind: "api",
				domain: "boe.es",
			},
		];

		const footer = formatGuideFooter(guides);
		expect(footer).toContain("API:");
		expect(footer).toContain("BOE API");
		// api-kind guides route to api-guide({domain, guide}), not web-guide.
		expect(footer).toContain('api-guide({domain: "boe.es", guide: "BOE API"})');
		expect(footer).not.toContain('web-guide guide="boe-api"');
	});

	it("falls back to the guide name when an api-kind guide has no domain", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "orphan-api",
				icon: "📡",
				shortName: "Orphan API",
				reason: "API guide for example.com",
				category: "site",
				kind: "api",
			},
		];
		const footer = formatGuideFooter(guides);
		expect(footer).toContain(
			'api-guide({domain: "orphan-api", guide: "Orphan API"})',
		);
	});

	it("web-kind site guides still route to web-guide", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "reddit",
				icon: "📖",
				shortName: "reddit",
				reason: "site guide for reddit.com",
				category: "site",
				kind: "web",
			},
		];
		const footer = formatGuideFooter(guides);
		expect(footer).toContain('web-guide guide="reddit"');
		expect(footer).not.toContain("api-guide");
	});

	it("multiple api guides on one domain each route to a distinct api-guide({domain, guide})", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "api:internet-archive",
				icon: "📖",
				shortName: "Internet Archive",
				reason: "API guide for archive.org",
				category: "site",
				kind: "api",
				domain: "archive.org",
			},
			{
				name: "api:wayback-availability",
				icon: "📖",
				shortName: "Wayback Availability",
				reason: "API guide for archive.org",
				category: "site",
				kind: "api",
				domain: "archive.org",
			},
			{
				name: "api:wayback-cdx-server",
				icon: "📖",
				shortName: "Wayback CDX Server",
				reason: "API guide for archive.org",
				category: "site",
				kind: "api",
				domain: "archive.org",
			},
		];

		const footer = formatGuideFooter(guides);
		// Each line carries its own guide selector — no disambiguation menu
		// round-trip, and no two lines share an invocation.
		expect(footer).toContain(
			'api-guide({domain: "archive.org", guide: "Internet Archive"})',
		);
		expect(footer).toContain(
			'api-guide({domain: "archive.org", guide: "Wayback Availability"})',
		);
		expect(footer).toContain(
			'api-guide({domain: "archive.org", guide: "Wayback CDX Server"})',
		);
		expect(footer).not.toContain('api-guide({domain: "archive.org"})');
	});

	it("shows API: then Site: when both api and web site guides are present (host-first order)", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "web-guide",
				icon: "📖",
				shortName: "web",
				reason: "site guide for example.com",
				category: "site",
				kind: "web",
			},
			{
				name: "api-guide",
				icon: "📡",
				shortName: "api",
				reason: "API guide for example.com",
				category: "site",
				kind: "api",
			},
		];

		const sorted = sortApplicableGuides(guides);
		const footer = formatGuideFooter(sorted);

		// API comes first (host-first sort), so API: header before Site:
		const apiIdx = footer.indexOf("API:");
		const siteIdx = footer.indexOf("Site:");
		expect(apiIdx).toBeGreaterThan(-1);
		expect(siteIdx).toBeGreaterThan(-1);
		expect(apiIdx).toBeLessThan(siteIdx);
	});

	it("pattern guides appear without an API: or Site: subheader", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "bot-detection",
				icon: "⚠",
				shortName: "bot detection",
				reason: "challenge page detected",
				category: "pattern",
				kind: "web",
			},
		];

		const footer = formatGuideFooter(guides);
		expect(footer).not.toContain("API:");
		expect(footer).not.toContain("Site:");
	});
});

// ═══════════════════════════════════════════════════════════════════
// buildDomainMap includes peer-provided guides
// ═══════════════════════════════════════════════════════════════════

describe("buildDomainMap with providers", () => {
	it("includes domains from peer-provided guides", () => {
		registerGuideProvider(() => ({
			"test-api": apiGuideFixture("test-api", "api.example.com"),
		}));

		const map = buildDomainMap();
		expect(map["api.example.com"]).toContain("api:test-api");
	});

	it("a domain can hold both an API guide and a web guide", () => {
		registerGuideProvider(() => ({
			"peer-api": apiGuideFixture("peer-api", "example.com"),
		}));
		_setGuideContentForTest({
			"user-web": webGuideFixture("user-web", "example.com"),
		});

		const map = buildDomainMap();
		expect(map["example.com"]).toEqual(
			expect.arrayContaining(["api:peer-api", "user-web"]),
		);
	});
});
