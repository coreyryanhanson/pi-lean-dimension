/**
 * Tests for Web Navigation Guides (core/guides.ts)
 *
 * Covers types, resolveGuidePresence, cleanupInjectedGuides, formatGuideList,
 * parseGuideFile, and DOMAIN_MAP consistency.
 * All tests run without Chromium.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	type Guide,
	type GuideTrigger,
	type DomainEntry,
	type GuidePresenceResult,
	resolveGuidePresence,
	cleanupInjectedGuides,
	parseGuideContent,
	parseGuideFile,
	formatGuideList,
	getGuideContent,
	invalidateGuideContent,
	buildDomainMap,
	getDomainMap,
	invalidateDomainMap,
	BUILTIN_GUIDES,
	DOMAIN_MAP,
} from "../core/guides.js";

// ─── Types ──────────────────────────────────────────────────────

describe("types", () => {
	it("Guide interface is structural — objects with correct shape work", () => {
		const g: Guide = {
			content: "test",
			updated: "2026-01-01",
			category: "site",
			source: "builtin",
		};
		expect(g.content).toBe("test");
	});

	it("GuideTrigger interface — signal and presence required", () => {
		const t: GuideTrigger = { signal: "botDetected", presence: "inject" };
		expect(t.signal).toBe("botDetected");
		expect(t.presence).toBe("inject");
	});

	it("DomainEntry interface — guide and strategy optional", () => {
		const d: DomainEntry = {};
		expect(d.guide).toBeUndefined();
		expect(d.strategy).toBeUndefined();
	});

	it("GuidePresenceResult interface — type, guideName, text required", () => {
		const r: GuidePresenceResult = {
			type: "inject",
			guideName: "test",
			text: "hello",
		};
		expect(r.type).toBe("inject");
	});
});

// ─── resolveGuidePresence ───────────────────────────────────────

describe("resolveGuidePresence", () => {
	const TASK_A = "test-task-a";
	const TASK_B = "test-task-b";
	const hasDialog = true;
	const noDialog = false;
	const anyUrl = "https://example.com/page";

	beforeEach(() => {
		cleanupInjectedGuides(TASK_A);
		cleanupInjectedGuides(TASK_B);
	});

	afterEach(() => {
		cleanupInjectedGuides(TASK_A);
		cleanupInjectedGuides(TASK_B);
	});

	it("returns undefined when no trigger matches", () => {
		const result = resolveGuidePresence(TASK_A, anyUrl, noDialog, false);
		expect(result).toBeUndefined();
	});

	// ── Domain hints ───────────────────────────────────────────────

	it("returns hint for known domain (_internal-test.example)", () => {
		const result = resolveGuidePresence(
			TASK_A,
			"https://_internal-test.example/page",
			noDialog,
			false,
		);
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("hint");
		expect(result!.guideName).toBe("_builtin-test-fixture");
	});

	it("returns undefined for unknown domain", () => {
		const result = resolveGuidePresence(
			TASK_A,
			"https://unknown-site-12345.com/page",
			noDialog,
			false,
		);
		expect(result).toBeUndefined();
	});

	it("domain hint matches _internal-test.example URL", () => {
		const result = resolveGuidePresence(
			TASK_A,
			"https://_internal-test.example/some/path",
			noDialog,
			false,
		);
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("hint");
		expect(result!.text).toContain("_builtin-test-fixture");
		expect(result!.text).toContain("_internal-test.example");
		expect(result!.text).toContain("(if you haven't already reviewed it)");
	});

	// ── Bot detection ──────────────────────────────────────────────

	it("returns inject for first bot detection in a task", () => {
		const result = resolveGuidePresence(TASK_A, anyUrl, noDialog, true);
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("inject");
		expect(result!.guideName).toBe("bot-detection");
		expect(result!.text.length).toBeGreaterThan(50);
		// Should include the guide content, not just a hint
		expect(result!.text).toContain("Bot Detection");
	});

	it("returns hint for repeat bot detection in same task (suppression)", () => {
		// First call — inject
		resolveGuidePresence(TASK_A, anyUrl, noDialog, true);
		// Second call — should be downgraded to hint
		const result = resolveGuidePresence(TASK_A, anyUrl, noDialog, true);
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("hint");
		expect(result!.guideName).toBe("bot-detection");
		expect(result!.text).toContain("web-guide");
	});

	it("returns inject for a different taskId (independent state)", () => {
		// Inject in task A
		resolveGuidePresence(TASK_A, anyUrl, noDialog, true);
		// Task B should get inject again (independent)
		const result = resolveGuidePresence(TASK_B, anyUrl, noDialog, true);
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("inject");
	});

	// ── Dialog presence ────────────────────────────────────────────

	it('returns hint when role="dialog" is detected', () => {
		const result = resolveGuidePresence(TASK_A, anyUrl, hasDialog, false);
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("hint");
		expect(result!.guideName).toBe("cookie-consent");
	});

	it('returns hint when role="alertdialog" is detected', () => {
		const result = resolveGuidePresence(TASK_A, anyUrl, true, false);
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("hint");
		expect(result!.guideName).toBe("cookie-consent");
	});

	it("does not return dialog hint when no dialog detected", () => {
		const result = resolveGuidePresence(TASK_A, anyUrl, noDialog, false);
		expect(result).toBeUndefined();
	});

	// ── Priority order ─────────────────────────────────────────────

	it("bot detection wins over dialog presence (first match)", () => {
		// Both botDetected AND dialog present — bot detection should win
		const result = resolveGuidePresence(TASK_A, anyUrl, hasDialog, true);
		expect(result).not.toBeUndefined();
		expect(result!.guideName).toBe("bot-detection");
	});

	// ── autoInject config override ──────────────────────────────────

	it("autoInject: false suppresses inject, returns hint instead", () => {
		const result = resolveGuidePresence(TASK_A, anyUrl, noDialog, true, {
			autoInject: false,
		});
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("hint");
		expect(result!.guideName).toBe("bot-detection");
		expect(result!.text).toContain("web-guide");
	});

	// ── Invalid URL ────────────────────────────────────────────────

	it("returns undefined for an invalid URL", () => {
		const result = resolveGuidePresence(
			TASK_A,
			"not-a-valid-url",
			noDialog,
			false,
		);
		expect(result).toBeUndefined();
	});

	// ── cleanupInjectedGuides ──────────────────────────────────────

	it("cleanupInjectedGuides resets injection state", () => {
		// First call — inject
		resolveGuidePresence(TASK_A, anyUrl, noDialog, true);
		// Cleanup
		cleanupInjectedGuides(TASK_A);
		// After cleanup, should get inject again
		const result = resolveGuidePresence(TASK_A, anyUrl, noDialog, true);
		expect(result).not.toBeUndefined();
		expect(result!.type).toBe("inject");
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
});

// ─── parseGuideContent / parseGuideFile ───────────────────────────

describe("parseGuideContent", () => {
	const validGuide = [
		"---",
		"category: site",
		"updated: 2026-06-01",
		"---",
		"## My Guide",
		"Some guidance text",
	].join("\n");

	const patternWithTrigger = [
		"---",
		"category: pattern",
		"updated: 2026-06-02",
		"trigger.signal: botDetected",
		"trigger.presence: inject",
		"---",
		"## Pattern Guide",
		"Triggered when bot detection fires",
	].join("\n");

	it("parses valid guide with YAML frontmatter", () => {
		const result = parseGuideContent(validGuide, "my-site.md");
		expect(result).not.toBeNull();
		const [name, guide] = result!;
		expect(name).toBe("my-site");
		expect(guide.category).toBe("site");
		expect(guide.source).toBe("user");
		expect(guide.updated).toBe("2026-06-01");
		expect(guide.content).toContain("## My Guide");
		expect(guide.content).toContain("Some guidance text");
		expect(guide.trigger).toBeUndefined();
		expect(guide.domains).toBeUndefined();
	});

	it("parses pattern guide with trigger fields", () => {
		const result = parseGuideContent(patternWithTrigger, "my-pattern.md");
		expect(result).not.toBeNull();
		const [name, guide] = result!;
		expect(name).toBe("my-pattern");
		expect(guide.category).toBe("pattern");
		expect(guide.source).toBe("user");
		expect(guide.updated).toBe("2026-06-02");
		expect(guide.content).toContain("## Pattern Guide");
		expect(guide.trigger).toBeDefined();
		expect(guide.trigger!.signal).toBe("botDetected");
		expect(guide.trigger!.presence).toBe("inject");
		expect(guide.domains).toBeUndefined();
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

// ─── DOMAIN_MAP consistency ─────────────────────────────────────

describe("DOMAIN_MAP consistency", () => {
	it("all DOMAIN_MAP guide references exist in getGuideContent()", () => {
		for (const [, entry] of Object.entries(DOMAIN_MAP)) {
			if (entry.guide) {
				expect(getGuideContent()[entry.guide]).toBeDefined();
			}
		}
	});
});

// ─── Dynamic Domain Map ────────────────────────────────────────

describe("buildDomainMap", () => {
	it("includes the builtin DOMAIN_MAP fixture", () => {
		const map = buildDomainMap();
		expect(map["_internal-test.example"]).toBeDefined();
	});

	it("excludes pattern guides (no domains field)", () => {
		const map = buildDomainMap();
		// Pattern guides should not appear as domain entries
		for (const [name] of Object.entries(getGuideContent())) {
			if (getGuideContent()[name]?.category === "pattern") {
				expect(Object.values(map).some((e) => e.guide === name)).toBe(false);
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

describe("getDomainMap / invalidateDomainMap", () => {
	beforeEach(() => {
		invalidateDomainMap();
	});

	afterEach(() => {
		invalidateDomainMap();
	});

	it("first call builds cache", () => {
		const map = getDomainMap();
		expect(map["_internal-test.example"]).toBeDefined();
	});

	it("subsequent calls return same cached object", () => {
		const first = getDomainMap();
		const second = getDomainMap();
		expect(first).toBe(second);
	});

	it("after invalidation, next call rescans", () => {
		invalidateDomainMap();
		const after = getDomainMap();
		expect(after).toBeDefined();
		expect(after["_internal-test.example"]).toBeDefined();
	});
});

describe("getGuideContent / invalidateGuideContent", () => {
	beforeEach(() => {
		invalidateGuideContent();
	});

	afterEach(() => {
		invalidateGuideContent();
	});

	it("returns builtin guides", () => {
		const content = getGuideContent();
		expect(content["bot-detection"]).toBeDefined();
	});

	it("after invalidation, returns fresh content (same keys)", () => {
		const before = getGuideContent();
		invalidateGuideContent();
		const after = getGuideContent();
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
	});
});

// ─── Builtin guide structure ────────────────────────────────────

describe("BUILTIN_GUIDES structure", () => {
	it("all builtin guides have source: 'builtin'", () => {
		for (const [, guide] of Object.entries(BUILTIN_GUIDES)) {
			expect(guide.source).toBe("builtin");
		}
	});

	it("all builtin guides have required fields", () => {
		for (const [guideName, guide] of Object.entries(BUILTIN_GUIDES)) {
			expect(guideName).toBeTruthy();
			expect(guide.content).toBeTruthy();
			expect(guide.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(["site", "pattern"]).toContain(guide.category);
		}
	});

	it("pattern guides with trigger have correct structure", () => {
		const botGuide = BUILTIN_GUIDES["bot-detection"]!;
		expect(botGuide.trigger).toBeDefined();
		expect(botGuide.trigger!.signal).toBe("botDetected");
		expect(botGuide.trigger!.presence).toBe("inject");

		const cookieGuide = BUILTIN_GUIDES["cookie-consent"]!;
		expect(cookieGuide.trigger).toBeDefined();
		expect(cookieGuide.trigger!.signal).toBe("dialogDetected");
		expect(cookieGuide.trigger!.presence).toBe("hint");
	});

	it("site guide (_builtin-test-fixture) has no trigger", () => {
		const guide = BUILTIN_GUIDES["_builtin-test-fixture"]!;
		expect(guide.category).toBe("site");
		expect(guide.trigger).toBeUndefined();
	});

	it("pattern guides (pagination, search) have no trigger (on-demand)", () => {
		const onDemandPatterns = ["pagination", "search"];
		for (const name of onDemandPatterns) {
			const guide = BUILTIN_GUIDES[name]!;
			expect(guide.category).toBe("pattern");
			expect(guide.trigger).toBeUndefined();
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
		expect(botGuide?.trigger?.signal).toBe("botDetected");
	});
});
