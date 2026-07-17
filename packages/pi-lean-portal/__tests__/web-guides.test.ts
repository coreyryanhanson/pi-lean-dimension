/**
 * Tests for Web Navigation Guides (core/guides.ts)
 *
 * Covers types, resolveApplicableGuides, formatGuideFooter, formatGuideList,
 * parseGuideFile, buildDomainMap, and guide structure.
 * All tests run without Chromium.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	type Guide,
	type ApplicableGuide,
	resolveApplicableGuides,
	parseGuideContent,
	parseGuideFile,
	formatGuideList,
	formatGuideFooter,
	sortApplicableGuides,
	getGuideContent,
	_setGuideContentForTest,
	buildDomainMap,
	BUILTIN_GUIDES,
} from "../core/guides.js";

// ── Isolate from on-disk user guides ──────────────────────────
// User guide files in ~/.pi/agent/pi-lean-portal/web-guides/ must not leak
// into tests. Mocking existsSync for the web-guides path ensures
// loadUserGuides() returns {} (guarded by existsSync at the top).
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

// ─── Types ──────────────────────────────────────────────────────

describe("types", () => {
	it("Guide interface is structural — icon and shortName now required", () => {
		const g: Guide = {
			content: "test",
			updated: "2026-01-01",
			category: "site",
			source: "builtin",
			icon: "📖",
			shortName: "test",
		};
		expect(g.icon).toBe("📖");
		expect(g.shortName).toBe("test");
	});

	it("triggerSignal field on Guide works correctly", () => {
		const g: Guide = {
			content: "test",
			updated: "2026-01-01",
			category: "pattern",
			source: "builtin",
			icon: "⚠",
			shortName: "test",
			triggerSignal: "botDetected",
		};
		expect(g.triggerSignal).toBe("botDetected");
	});

	it("ApplicableGuide interface — name, icon, shortName, reason, category required", () => {
		const r: ApplicableGuide = {
			name: "test",
			icon: "⚠",
			shortName: "test",
			reason: "test reason",
			category: "pattern",
		};
		expect(r.name).toBe("test");
		expect(r.category).toBe("pattern");
	});
});

// ─── resolveApplicableGuides ────────────────────────────────────

function injectTestFixture(): void {
	// Inject a test-only site guide with a domain mapping for domain resolution tests.
	const base = getGuideContent();
	if (!base["_builtin-test-fixture"]) {
		_setGuideContentForTest({
			...base,
			"_builtin-test-fixture": {
				category: "site",
				source: "builtin",
				updated: "2026-06-13",
				icon: "📖",
				shortName: "test fixture",
				domains: ["_internal-test.example"],
				content:
					"Test-only builtin site guide for exercising domain resolution.",
			},
		});
	}
}

describe("resolveApplicableGuides", () => {
	beforeEach(() => {
		injectTestFixture();
	});

	afterEach(() => {
		_setGuideContentForTest();
	});

	const hasDialog = true;
	const noDialog = false;
	const anyUrl = "https://example.com/page";

	it("returns empty array when no trigger matches", () => {
		const result = resolveApplicableGuides(anyUrl, noDialog, false);
		expect(result).toEqual([]);
	});

	// ── Domain hints ───────────────────────────────────────────────

	it("returns domain guide for known domain (_internal-test.example)", () => {
		const result = resolveApplicableGuides(
			"https://_internal-test.example/page",
			noDialog,
			false,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("_builtin-test-fixture");
		expect(result[0]!.reason).toContain("_internal-test.example");
	});

	it("returns empty for unknown domain", () => {
		const result = resolveApplicableGuides(
			"https://unknown-site-12345.com/page",
			noDialog,
			false,
		);
		expect(result).toEqual([]);
	});

	it("domain guide includes icon and shortName", () => {
		const result = resolveApplicableGuides(
			"https://_internal-test.example/some/path",
			noDialog,
			false,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.icon).toBe("📖");
		expect(result[0]!.shortName).toBe("test fixture");
	});

	// ── Bot detection ──────────────────────────────────────────────

	it("returns bot-detection when botDetected is true", () => {
		const result = resolveApplicableGuides(anyUrl, noDialog, true);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("bot-detection");
		expect(result[0]!.icon).toBe("⚠");
		expect(result[0]!.shortName).toBe("bot detection");
		expect(result[0]!.reason).toBe("challenge page detected");
	});

	it("returns bot-detection on every call (no suppression)", () => {
		// No per-task state — same result every time
		const first = resolveApplicableGuides(anyUrl, noDialog, true);
		const second = resolveApplicableGuides(anyUrl, noDialog, true);
		expect(first).toEqual(second);
	});

	// ── Dialog presence ────────────────────────────────────────────

	it("returns cookie-consent when dialog is detected", () => {
		const result = resolveApplicableGuides(anyUrl, hasDialog, false);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("cookie-consent");
		expect(result[0]!.icon).toBe("🍪");
		expect(result[0]!.shortName).toBe("consent");
		expect(result[0]!.reason).toBe("consent dialog detected");
	});

	it("does not return cookie-consent when no dialog detected", () => {
		const result = resolveApplicableGuides(anyUrl, noDialog, false);
		expect(result).toEqual([]);
	});

	// ── All applicable — no priority suppression ────────────────────

	it("returns both bot-detection and cookie-consent when both signals fire", () => {
		const result = resolveApplicableGuides(anyUrl, hasDialog, true);
		expect(result).toHaveLength(2);
		const names = result.map((g) => g.name).sort();
		expect(names).toEqual(["bot-detection", "cookie-consent"]);
	});

	it("returns all three (bot + dialog + domain) when all match", () => {
		const result = resolveApplicableGuides(
			"https://_internal-test.example/page",
			hasDialog,
			true,
		);
		expect(result).toHaveLength(3);
		const names = result.map((g) => g.name).sort();
		expect(names).toEqual([
			"_builtin-test-fixture",
			"bot-detection",
			"cookie-consent",
		]);
	});

	// ── Invalid URL ────────────────────────────────────────────────

	it("returns pattern results for invalid URL (botDetected)", () => {
		const result = resolveApplicableGuides("not-a-valid-url", noDialog, true);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("bot-detection");
	});

	it("returns pattern results for invalid URL (dialogDetected)", () => {
		const result = resolveApplicableGuides("not-a-valid-url", hasDialog, false);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("cookie-consent");
	});

	it("returns empty for invalid URL with no pattern triggers", () => {
		const result = resolveApplicableGuides("not-a-valid-url", noDialog, false);
		expect(result).toEqual([]);
	});

	it("domain lookup is skipped for invalid URL", () => {
		// _internal-test.example should NOT match through an invalid URL
		const result = resolveApplicableGuides("not-a-valid-url", noDialog, false);
		expect(result.map((g) => g.name)).not.toContain("_builtin-test-fixture");
	});
});

// ─── formatGuideFooter ──────────────────────────────────────────

describe("formatGuideFooter", () => {
	it("returns empty string for empty input", () => {
		expect(formatGuideFooter([])).toBe("");
	});

	it("renders a single pattern guide with header and bullet, no Site:", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "bot-detection",
				icon: "⚠",
				shortName: "bot detection",
				reason: "challenge page detected",
				category: "pattern",
			},
		];
		const result = formatGuideFooter(guides);
		expect(result).toContain("Guides available for this page");
		expect(result).toContain(
			'• ⚠ bot detection — challenge page detected (web-guide guide="bot-detection")',
		);
		expect(result).not.toContain("Site:");
	});

	it("renders a single site guide with header, Site subheader, and bullet", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "reddit",
				icon: "📖",
				shortName: "reddit",
				reason: "site guide for reddit.com",
				category: "site",
			},
		];
		const result = formatGuideFooter(guides);
		expect(result).toContain("Guides available for this page");
		expect(result).toContain("Site:");
		expect(result).toContain(
			'• 📖 reddit — site guide for reddit.com (web-guide guide="reddit")',
		);
	});

	it("renders mixed patterns + sites with correct ordering", () => {
		const guides: ApplicableGuide[] = sortApplicableGuides([
			{
				name: "reddit",
				icon: "📖",
				shortName: "reddit",
				reason: "site guide for reddit.com",
				category: "site",
			},
			{
				name: "cookie-consent",
				icon: "🍪",
				shortName: "consent",
				reason: "consent dialog detected",
				category: "pattern",
			},
			{
				name: "bot-detection",
				icon: "⚠",
				shortName: "bot detection",
				reason: "challenge page detected",
				category: "pattern",
			},
		]);
		const result = formatGuideFooter(guides);
		const lines = result.split("\n");

		// Header line
		expect(lines[0]).toContain("Guides available");

		// Patterns first, alphabetical (bot detection before consent)
		const botLineIndex = lines.findIndex((l) => l.includes("bot detection"));
		const consentLineIndex = lines.findIndex((l) => l.includes("consent"));
		expect(botLineIndex).toBeLessThan(consentLineIndex);

		// Site subheader after patterns
		const siteHeaderIndex = lines.findIndex((l) => l.trim() === "Site:");
		expect(siteHeaderIndex).toBeGreaterThan(consentLineIndex);

		// Site guide after subheader
		const siteLineIndex = lines.findIndex((l) => l.includes("reddit"));
		expect(siteLineIndex).toBeGreaterThan(siteHeaderIndex);
	});

	it("bullet format matches expected pattern", () => {
		const guides: ApplicableGuide[] = [
			{
				name: "bot-detection",
				icon: "⚠",
				shortName: "bot detection",
				reason: "challenge page detected",
				category: "pattern",
			},
		];
		const result = formatGuideFooter(guides);
		expect(result).toMatch(
			/• ⚠ bot detection.*web-guide guide="bot-detection"/,
		);
	});
});

// ─── sortApplicableGuides ─────────────────────────────────────

describe("sortApplicableGuides", () => {
	it("sorts patterns before sites", () => {
		const input: ApplicableGuide[] = [
			{
				name: "site-guide",
				icon: "📖",
				shortName: "site",
				reason: "test",
				category: "site",
			},
			{
				name: "bot-detection",
				icon: "⚠",
				shortName: "bot detection",
				reason: "test",
				category: "pattern",
			},
		];
		const sorted = sortApplicableGuides(input);
		expect(sorted[0]!.category).toBe("pattern");
		expect(sorted[1]!.category).toBe("site");
	});

	it("sorts alphabetically within same category", () => {
		const input: ApplicableGuide[] = [
			{
				name: "z-guide",
				icon: "📖",
				shortName: "zebra",
				reason: "test",
				category: "pattern",
			},
			{
				name: "a-guide",
				icon: "⚠",
				shortName: "alpha",
				reason: "test",
				category: "pattern",
			},
		];
		const sorted = sortApplicableGuides(input);
		expect(sorted[0]!.shortName).toBe("alpha");
		expect(sorted[1]!.shortName).toBe("zebra");
	});

	it("does not mutate the input array", () => {
		const input: ApplicableGuide[] = [
			{
				name: "b",
				icon: "📖",
				shortName: "b",
				reason: "test",
				category: "site",
			},
			{
				name: "a",
				icon: "📖",
				shortName: "a",
				reason: "test",
				category: "pattern",
			},
		];
		const originalNames = input.map((g) => g.name);
		sortApplicableGuides(input);
		expect(input.map((g) => g.name)).toEqual(originalNames);
	});
});

// ─── formatGuideList ────────────────────────────────────────────

describe("formatGuideList", () => {
	it("lists all guides grouped by category", () => {
		const text = formatGuideList();
		expect(text).toContain("Site guides:");
		expect(text).toContain("Pattern guides:");
		expect(text).toContain("builtin");
		expect(text).toContain('web-guide guide="<name>"');
	});

	it("includes icon, shortName, and trigger signal info (no presence)", () => {
		const text = formatGuideList();
		expect(text).toContain("⚠ bot detection");
		expect(text).toContain("fires on botDetected");
		expect(text).toContain("🍪 consent");
		expect(text).toContain("fires on dialogDetected");
		expect(text).not.toContain("auto-inject");
		expect(text).not.toContain("auto-hint");
	});
});

// ─── parseGuideContent / parseGuideFile ───────────────────────────

describe("parseGuideContent", () => {
	const validGuide = [
		"---",
		"category: site",
		"updated: 2026-06-01",
		"icon: 📖",
		"shortName: My Guide",
		"---",
		"## My Guide",
		"Some guidance text",
	].join("\n");

	const patternWithTrigger = [
		"---",
		"category: pattern",
		"updated: 2026-06-02",
		"trigger.signal: botDetected",
		"---",
		"## Pattern Guide",
		"Triggered when bot detection fires",
	].join("\n");

	it("parses valid guide with icon and shortName", () => {
		const result = parseGuideContent(validGuide, "my-site.md");
		expect(result).not.toBeNull();
		const [name, guide] = result!;
		expect(name).toBe("my-site");
		expect(guide.category).toBe("site");
		expect(guide.source).toBe("user");
		expect(guide.updated).toBe("2026-06-01");
		expect(guide.icon).toBe("📖");
		expect(guide.shortName).toBe("My Guide");
		expect(guide.content).toContain("## My Guide");
		expect(guide.content).toContain("Some guidance text");
		expect(guide.triggerSignal).toBeUndefined();
		expect(guide.domains).toBeUndefined();
	});

	it("parses pattern guide with trigger (no presence)", () => {
		const result = parseGuideContent(patternWithTrigger, "my-pattern.md");
		expect(result).not.toBeNull();
		const [name, guide] = result!;
		expect(name).toBe("my-pattern");
		expect(guide.category).toBe("pattern");
		expect(guide.source).toBe("user");
		expect(guide.updated).toBe("2026-06-02");
		expect(guide.content).toContain("## Pattern Guide");
		expect(guide.triggerSignal).toBe("botDetected");
		expect(guide.domains).toBeUndefined();
	});

	it("defaults icon to 📖 when not specified", () => {
		const result = parseGuideContent(
			[
				"---",
				"category: site",
				"updated: 2026-06-01",
				"---",
				"## Default",
			].join("\n"),
			"defaulted.md",
		);
		expect(result).not.toBeNull();
		expect(result![1].icon).toBe("📖");
	});

	it("defaults shortName to filename when not specified", () => {
		const result = parseGuideContent(
			["---", "category: site", "updated: 2026-06-01", "---", "## Short"].join(
				"\n",
			),
			"my-custom-name.md",
		);
		expect(result).not.toBeNull();
		expect(result![1].shortName).toBe("my-custom-name");
	});

	it("returns null for content with no frontmatter", () => {
		const result = parseGuideContent(
			"Just regular markdown without frontmatter",
			"test.md",
		);
		expect(result).toBeNull();
	});

	it("defaults category to 'site' when not specified", () => {
		const result = parseGuideContent(
			["---", "updated: 2026-06-03", "---", "## Defaulted"].join("\n"),
			"defaulted.md",
		);
		expect(result).not.toBeNull();
		expect(result![1].category).toBe("site");
	});

	it("defaults updated to today when not specified", () => {
		const result = parseGuideContent(
			["---", "category: pattern", "---", "## Today"].join("\n"),
			"today.md",
		);
		expect(result).not.toBeNull();
		const today = new Date().toISOString().slice(0, 10);
		expect(result![1].updated).toBe(today);
	});

	it("trims content whitespace", () => {
		const result = parseGuideContent(
			"---\ncategory: site\n---\n\n  padded content  \n",
			"padding.md",
		);
		expect(result).not.toBeNull();
		expect(result![1].content).toBe("padded content");
	});

	// ── domains frontmatter parsing ─────────────────────────────

	it("parses single domain from frontmatter", () => {
		const raw =
			"---\ncategory: site\ndomains: reddit.com\nupdated: 2026-06-01\n---\n## Reddit Guide";
		const result = parseGuideContent(raw, "reddit.com.md");
		expect(result).not.toBeNull();
		expect(result![1].domains).toEqual(["reddit.com"]);
	});

	it("parses comma-separated domains from frontmatter", () => {
		const raw =
			"---\ncategory: site\ndomains: reddit.com, www.reddit.com, old.reddit.com\nupdated: 2026-06-01\n---\n## Reddit Guide";
		const result = parseGuideContent(raw, "reddit.com.md");
		expect(result).not.toBeNull();
		expect(result![1].domains).toEqual([
			"reddit.com",
			"www.reddit.com",
			"old.reddit.com",
		]);
	});

	it("handles missing domains field as undefined", () => {
		const raw = "---\ncategory: site\nupdated: 2026-06-01\n---\n## No Domains";
		const result = parseGuideContent(raw, "no-domains.md");
		expect(result).not.toBeNull();
		expect(result![1].domains).toBeUndefined();
	});

	it("filters trailing comma and empty segments", () => {
		const raw =
			"---\ncategory: site\ndomains: reddit.com, , www.reddit.com, \nupdated: 2026-06-01\n---\n## Reddit";
		const result = parseGuideContent(raw, "reddit.com.md");
		expect(result).not.toBeNull();
		expect(result![1].domains).toEqual(["reddit.com", "www.reddit.com"]);
	});

	it("trims whitespace from domain entries", () => {
		const raw =
			"---\ncategory: site\ndomains:  reddit.com ,  www.reddit.com  \nupdated: 2026-06-01\n---\n## Reddit";
		const result = parseGuideContent(raw, "reddit.com.md");
		expect(result).not.toBeNull();
		expect(result![1].domains).toEqual(["reddit.com", "www.reddit.com"]);
	});
});

describe("parseGuideFile", () => {
	it("returns null for non-existent file", () => {
		const result = parseGuideFile("/nonexistent/guide.md", "guide.md");
		expect(result).toBeNull();
	});
});

// ─── Dynamic Domain Map ────────────────────────────────────────

describe("buildDomainMap", () => {
	beforeEach(() => {
		injectTestFixture();
	});

	afterEach(() => {
		_setGuideContentForTest();
	});

	it("includes fixtures from guides with domains field", () => {
		const map = buildDomainMap();
		expect(map["_internal-test.example"]).toBe("_builtin-test-fixture");
	});

	it("excludes pattern guides (no domains field)", () => {
		const map = buildDomainMap();
		// Pattern guides should not appear as domain entries
		for (const [name] of Object.entries(getGuideContent())) {
			if (getGuideContent()[name]?.category === "pattern") {
				expect(Object.values(map)).not.toContain(name);
			}
		}
	});

	it("derives from getGuideContent() (single source of truth)", () => {
		// buildDomainMap uses getGuideContent() internally, not loadUserGuides()
		const map = buildDomainMap();
		expect(map).toBeDefined();
		expect(Object.keys(map).length).toBeGreaterThanOrEqual(1);
	});
});

describe("getGuideContent", () => {
	afterEach(() => {
		_setGuideContentForTest();
	});

	it("returns builtin guides", () => {
		const content = getGuideContent();
		expect(content["bot-detection"]).toBeDefined();
	});
});

// ─── Builtin guide structure ────────────────────────────────────

describe("BUILTIN_GUIDES structure", () => {
	it("all builtin guides have source: 'builtin'", () => {
		for (const [, guide] of Object.entries(BUILTIN_GUIDES)) {
			expect(guide.source).toBe("builtin");
		}
	});

	it("all builtin guides have required fields including icon and shortName", () => {
		for (const [guideName, guide] of Object.entries(BUILTIN_GUIDES)) {
			expect(guideName).toBeTruthy();
			expect(guide.content).toBeTruthy();
			expect(guide.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(["site", "pattern"]).toContain(guide.category);
			expect(guide.icon).toBeTruthy();
			expect(guide.shortName).toBeTruthy();
		}
	});

	it("all builtin guides have correct icon/shortName values", () => {
		const expected: Record<string, { icon: string; shortName: string }> = {
			"bot-detection": { icon: "⚠", shortName: "bot detection" },
			"cookie-consent": { icon: "🍪", shortName: "consent" },
			pagination: { icon: "📄", shortName: "pagination" },
			search: { icon: "🔍", shortName: "search" },
		};
		for (const [name, expectedValues] of Object.entries(expected)) {
			const guide = BUILTIN_GUIDES[name]!;
			expect(guide.icon).toBe(expectedValues.icon);
			expect(guide.shortName).toBe(expectedValues.shortName);
		}
	});

	it("pattern guides with trigger have signal but no presence", () => {
		const botGuide = BUILTIN_GUIDES["bot-detection"]!;
		expect(botGuide.triggerSignal).toBe("botDetected");

		const cookieGuide = BUILTIN_GUIDES["cookie-consent"]!;
		expect(cookieGuide.triggerSignal).toBe("dialogDetected");
	});

	it("pattern guides (pagination, search) have no trigger (on-demand)", () => {
		const onDemandPatterns = ["pagination", "search"];
		for (const name of onDemandPatterns) {
			const guide = BUILTIN_GUIDES[name]!;
			expect(guide.category).toBe("pattern");
			expect(guide.triggerSignal).toBeUndefined();
		}
	});
});

// ─── getGuideContent merge ──────────────────────────────────────

describe("getGuideContent merge", () => {
	it("contains all builtin guides", () => {
		for (const name of Object.keys(BUILTIN_GUIDES)) {
			expect(getGuideContent()[name]).toBeDefined();
			expect(getGuideContent()[name]!.content).toBe(
				BUILTIN_GUIDES[name]!.content,
			);
		}
	});

	it("builtin guides maintain trigger in getGuideContent()", () => {
		const botGuide = getGuideContent()["bot-detection"];
		expect(botGuide?.triggerSignal).toBe("botDetected");
	});
});

// ─── Builtin guide override ────────────────────────────────────

describe("builtin guide override", () => {
	afterEach(() => {
		_setGuideContentForTest();
	});

	it("override wins and keeps firing — user bot-detection with custom shortName/icon", () => {
		const base = getGuideContent();
		_setGuideContentForTest({
			...base,
			"bot-detection": {
				category: "pattern",
				source: "user",
				updated: "2026-07-01",
				icon: "🤖",
				shortName: "my bot guide",
				triggerSignal: "botDetected",
				content: "Custom bot guidance.",
			},
		});

		const result = resolveApplicableGuides(
			"https://example.com/page",
			false,
			true,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.icon).toBe("🤖");
		expect(result[0]!.shortName).toBe("my bot guide");
		expect(result[0]!.name).toBe("bot-detection");
	});

	it("override that drops trigger.signal stops the pattern", () => {
		const base = getGuideContent();
		_setGuideContentForTest({
			...base,
			"bot-detection": {
				category: "pattern",
				source: "user",
				updated: "2026-07-01",
				icon: "🤖",
				shortName: "my bot guide",
				// No triggerSignal — override disables auto-fire
				content: "Custom bot guidance, no trigger.",
			},
		});

		const result = resolveApplicableGuides(
			"https://example.com/page",
			false,
			true,
		);
		// bot-detection key exists but has no triggerSignal, so it should not fire
		expect(result.filter((g) => g.name === "bot-detection")).toEqual([]);
	});

	it("site-vs-pattern namespaces are disjoint — site guide for www.botdetection.com coexists with builtin bot-detection pattern", () => {
		const base = getGuideContent();
		_setGuideContentForTest({
			...base,
			"www.botdetection.com": {
				category: "site",
				source: "user",
				updated: "2026-07-01",
				icon: "📖",
				shortName: "Bot Detection Site",
				domains: ["www.botdetection.com"],
				content: "Site-specific guide for bot detection domain.",
			},
		});

		const result = resolveApplicableGuides(
			"https://www.botdetection.com/page",
			false,
			true,
		);
		expect(result).toHaveLength(2);
		const names = result.map((g) => g.name).sort();
		expect(names).toEqual(["bot-detection", "www.botdetection.com"]);
	});

	it("override with category:site + domains replaces the pattern entirely — pattern stops firing", () => {
		const base = getGuideContent();
		_setGuideContentForTest({
			...base,
			"bot-detection": {
				category: "site",
				source: "user",
				updated: "2026-07-01",
				icon: "📖",
				shortName: "bot detection site",
				domains: ["botdetection.example"],
				// No triggerSignal — this is a site guide, not a pattern
				content: "Site guide that shadows the builtin bot-detection.",
			},
		});

		// botDetected=true, but the bot-detection key is now a site guide with no triggerSignal
		const result = resolveApplicableGuides(
			"https://example.com/page",
			false,
			true,
		);
		expect(result.filter((g) => g.name === "bot-detection")).toEqual([]);

		// The site guide should match via its domain though
		const domainResult = resolveApplicableGuides(
			"https://botdetection.example/page",
			false,
			false,
		);
		expect(domainResult).toHaveLength(1);
		expect(domainResult[0]!.name).toBe("bot-detection");
		expect(domainResult[0]!.category).toBe("site");
	});
});
