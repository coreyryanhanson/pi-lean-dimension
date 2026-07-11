/**
 * browser-inspect unit tests — all browser-free, using MockPlugin.
 *
 * Covers:
 * - DOM extractor (runExtractor) — mocked evaluate responses
 * - Correlation (correlateElements) — reverse-index @e ref annotation
 * - Element cache query (queryElementCache) — ref, role, name, subtree filters
 * - Router dispatch — integration with session lifecycle, staleness, errors
 * - Output formatting — formatElementList, formatRoleCountSummary
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as router from "../core/router.js";
import { pluginRegistry } from "../core/plugin-registry.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin.js";
import type { AriaCachedNode } from "../core/shared/accessibility-tree.js";
import {
	runExtractor,
	correlateElements,
	queryElementCache,
	formatElementList,
	formatRoleCountSummary,
	type QueryStatus,
} from "../core/shared/dom-extractor.js";

// ─── Helpers ───────────────────────────────────────────────────────

/** Create a sample element cache for testing. */
function makeSampleCache(): Map<string, AriaCachedNode> {
	return new Map([
		[
			"e1",
			{
				ref: "e1",
				role: "link",
				name: "Lexical Analysis",
				props: [],
				depth: 1,
				raw: "",
				occurrenceIndex: 0,
			},
		],
		[
			"e2",
			{
				ref: "e2",
				role: "link",
				name: "Parsing",
				props: [],
				depth: 1,
				raw: "",
				occurrenceIndex: 0,
			},
		],
		[
			"e3",
			{
				ref: "e3",
				role: "button",
				name: "Subscribe for more",
				props: [],
				depth: 2,
				raw: "",
				occurrenceIndex: 0,
			},
		],
		[
			"e4",
			{
				ref: "e4",
				role: "button",
				name: "Submit",
				props: [],
				depth: 2,
				raw: "",
				occurrenceIndex: 0,
			},
		],
		[
			"e5",
			{
				ref: "e5",
				role: "button",
				name: "Submit",
				props: [],
				depth: 3,
				raw: "",
				occurrenceIndex: 1,
				parentRef: "e4",
			},
		],
		[
			"e6",
			{
				ref: "e6",
				role: "dialog",
				name: "Sign Up",
				props: [],
				depth: 0,
				raw: "",
				occurrenceIndex: 0,
			},
		],
		[
			"e7",
			{
				ref: "e7",
				role: "button",
				name: "Close",
				props: [],
				depth: 1,
				raw: "",
				occurrenceIndex: 0,
				parentRef: "e6",
			},
		],
		[
			"e8",
			{
				ref: "e8",
				role: "heading",
				name: "Welcome",
				props: ["level=2"],
				depth: 1,
				raw: "",
				occurrenceIndex: 0,
			},
		],
	]);
}

const MOCK_EXTRACTOR_RESPONSE = JSON.stringify({
	title: "Test Page",
	headings: [{ level: 1, text: "Heading One" }],
	paragraphs: [{ text: "Some paragraph content." }],
	links: [{ text: "Click here", href: "https://example.com" }],
	images: [{ alt: "Test image", src: "https://example.com/img.png" }],
	interactive: [
		{ text: "Submit", role: "button", type: "submit", disabled: false },
	],
});

/**
 * Generate a large extractor response that produces > 3000 chars of
 * correlated text output — used to test the default ~2500 truncation.
 */
function makeLargeExtractorResponse(paragraphCount: number): string {
	const paragraphs: Array<{ text: string }> = [];
	for (let i = 0; i < paragraphCount; i++) {
		paragraphs.push({
			text: `This is automatically generated paragraph number ${i}. It contains enough words to be a reasonable mock paragraph for testing truncation behavior.`,
		});
	}
	return JSON.stringify({
		title: "Large Page",
		headings: [{ level: 1, text: "Big Heading" }],
		paragraphs,
		links: [],
		images: [],
		interactive: [],
	});
}

// ─── DOM Extractor tests ──────────────────────────────────────────

describe("runExtractor()", () => {
	it("returns structured result from valid evaluate response", async () => {
		const mockPlugin = new MockPlugin("test");
		mockPlugin.evalResult = {
			success: true,
			result: MOCK_EXTRACTOR_RESPONSE,
		};

		const outcome = await runExtractor("test-task", mockPlugin);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.title).toBe("Test Page");
		expect(outcome.result.headings).toHaveLength(1);
		expect(outcome.result.headings[0]!.text).toBe("Heading One");
		expect(outcome.result.paragraphs).toHaveLength(1);
		expect(outcome.result.links).toHaveLength(1);
		expect(outcome.result.images).toHaveLength(1);
		expect(outcome.result.interactive).toHaveLength(1);
	});

	it("returns null on evaluate failure", async () => {
		const mockPlugin = new MockPlugin("test");
		mockPlugin.evalResult = {
			success: false,
			error: "evaluate failed",
		};

		const outcome = await runExtractor("test-task", mockPlugin);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("evaluate failed");
	});

	it("returns null on invalid JSON from evaluate", async () => {
		const mockPlugin = new MockPlugin("test");
		mockPlugin.evalResult = {
			success: true,
			result: "not valid json {{{",
		};

		const outcome = await runExtractor("test-task", mockPlugin);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("invalid JSON");
	});

	it("returns null when script returns error field", async () => {
		const mockPlugin = new MockPlugin("test");
		mockPlugin.evalResult = {
			success: true,
			result: JSON.stringify({ error: "Something went wrong" }),
		};

		const outcome = await runExtractor("test-task", mockPlugin);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toBe("Something went wrong");
	});

	it("forwards readOnly: true to plugin.evaluate", async () => {
		const mockPlugin = new MockPlugin("test");
		mockPlugin.evalResult = {
			success: true,
			result: MOCK_EXTRACTOR_RESPONSE,
		};

		await runExtractor("test-task", mockPlugin);
		const evaluateCalls = mockPlugin.calls.get("evaluate");
		expect(evaluateCalls).toBeDefined();
		expect(evaluateCalls!.length).toBe(1);
		// Third arg must be true (readOnly)
		const args = evaluateCalls![0] as unknown[];
		expect(args[2]).toBe(true);
	});
});

// ─── Correlation tests ─────────────────────────────────────────────

describe("correlateElements()", () => {
	it("single match annotates with a single @e ref", () => {
		const cache = new Map([
			[
				"e1",
				{
					ref: "e1",
					role: "link",
					name: "Click here",
					props: [],
					depth: 1,
					raw: "",
					occurrenceIndex: 0,
				},
			],
		]);
		const result = correlateElements(
			{
				title: "Test",
				headings: [],
				paragraphs: [],
				links: [{ text: "Click here", href: "https://example.com" }],
				images: [],
				interactive: [],
			},
			cache,
			true,
		);
		expect(result.text).toContain("@e1");
		expect(result.matchedRefs).toBe(1);
		expect(result.staleCache).toBe(false);
	});

	it("multiple matches for same name annotates all refs", () => {
		const cache = new Map([
			[
				"e5",
				{
					ref: "e5",
					role: "button",
					name: "Submit",
					props: [],
					depth: 2,
					raw: "",
					occurrenceIndex: 0,
				},
			],
			[
				"e12",
				{
					ref: "e12",
					role: "button",
					name: "Submit",
					props: [],
					depth: 3,
					raw: "",
					occurrenceIndex: 1,
				},
			],
		]);
		const result = correlateElements(
			{
				title: "",
				headings: [],
				paragraphs: [],
				links: [],
				images: [],
				interactive: [{ text: "Submit", role: "button", disabled: false }],
			},
			cache,
			true,
		);
		expect(result.text).toContain("@e5, @e12");
		expect(result.matchedRefs).toBe(2);
	});

	it("no match produces text without annotations", () => {
		const cache = new Map();
		const result = correlateElements(
			{
				title: "No Refs",
				headings: [],
				paragraphs: [{ text: "Plain text with no ref" }],
				links: [],
				images: [],
				interactive: [],
			},
			cache,
			true,
		);
		expect(result.text).not.toContain("@e");
		expect(result.matchedRefs).toBe(0);
	});

	it("cache is fresh — no staleness notice", () => {
		const cache = new Map([
			[
				"e1",
				{
					ref: "e1",
					role: "link",
					name: "Fresh link",
					props: [],
					depth: 1,
					raw: "",
					occurrenceIndex: 0,
				},
			],
		]);
		const result = correlateElements(
			{
				title: "",
				headings: [],
				paragraphs: [],
				links: [{ text: "Fresh link", href: "https://example.com" }],
				images: [],
				interactive: [],
			},
			cache,
			true,
		);
		expect(result.text).not.toContain("stale");
		expect(result.staleCache).toBe(false);
	});

	it("cache is stale with matched refs — staleness notice appended", () => {
		const cache = new Map([
			[
				"e1",
				{
					ref: "e1",
					role: "link",
					name: "Stale link",
					props: [],
					depth: 1,
					raw: "",
					occurrenceIndex: 0,
				},
			],
		]);
		const result = correlateElements(
			{
				title: "",
				headings: [],
				paragraphs: [],
				links: [{ text: "Stale link", href: "https://example.com" }],
				images: [],
				interactive: [],
			},
			cache,
			false,
		);
		expect(result.text).toContain("Element refs may be stale");
		expect(result.staleCache).toBe(true);
	});

	it("cache is stale with no matched refs — no staleness notice", () => {
		const cache = new Map([
			[
				"e1",
				{
					ref: "e1",
					role: "button",
					name: "Old button",
					props: [],
					depth: 1,
					raw: "",
					occurrenceIndex: 0,
				},
			],
		]);
		const result = correlateElements(
			{
				title: "",
				headings: [],
				paragraphs: [],
				links: [],
				images: [],
				interactive: [
					{
						text: "New button",
						role: "button",
						type: "submit",
						disabled: false,
					},
				],
			},
			cache,
			false,
		);
		expect(result.text).not.toContain("stale");
		expect(result.staleCache).toBe(false);
	});

	it("empty cache — all items unannotated", () => {
		const cache = new Map();
		const result = correlateElements(
			{
				title: "",
				headings: [{ level: 1, text: "Heading" }],
				paragraphs: [{ text: "Para" }],
				links: [],
				images: [],
				interactive: [],
			},
			cache,
			true,
		);
		expect(result.text).not.toContain("@e");
		expect(result.matchedRefs).toBe(0);
	});
});

// ─── Element cache query tests ─────────────────────────────────────

describe("queryElementCache()", () => {
	const cache = makeSampleCache();

	it("filters by role", () => {
		const results = queryElementCache(cache, { role: "button" });
		expect(results).toHaveLength(4); // e3, e4, e5, e7
		expect(results.every((n) => n.role === "button")).toBe(true);
	});

	it("filters by multiple roles", () => {
		const results = queryElementCache(cache, { role: "link,heading" });
		expect(results).toHaveLength(3);
		const roles = new Set(results.map((n) => n.role));
		expect(roles.has("link")).toBe(true);
		expect(roles.has("heading")).toBe(true);
	});

	it("filters by name substring", () => {
		const results = queryElementCache(cache, { name: "submit" });
		expect(results).toHaveLength(2); // "Submit" x2 ("Subscribe" does not contain "submit")
	});

	it("looks up a single ref with @ prefix", () => {
		const results = queryElementCache(cache, { ref: "@e3" });
		expect(results).toHaveLength(1);
		expect(results[0]!.name).toBe("Subscribe for more");
	});

	it("looks up a single ref without @ prefix", () => {
		const results = queryElementCache(cache, { ref: "e1" });
		expect(results).toHaveLength(1);
		expect(results[0]!.role).toBe("link");
	});

	it("returns empty for unknown ref", () => {
		const results = queryElementCache(cache, { ref: "@e99" });
		expect(results).toHaveLength(0);
	});

	it("filters by subtree — dialog contents", () => {
		const results = queryElementCache(cache, { subtree: "dialog" });
		expect(results).toHaveLength(1);
		expect(results[0]!.ref).toBe("e7"); // Close button inside dialog
	});

	it("returns empty for subtree with no matches", () => {
		const results = queryElementCache(cache, { subtree: "navigation" });
		expect(results).toHaveLength(0);
	});

	it("combines role and name", () => {
		const results = queryElementCache(cache, {
			role: "button",
			name: "submit",
		});
		expect(results).toHaveLength(2); // Two Submit buttons
		expect(results.every((n) => n.role === "button")).toBe(true);
	});

	describe("QueryStatus out-param", () => {
		it("ref present + extra role filter that does not match", () => {
			const status: QueryStatus = {};
			const results = queryElementCache(
				cache,
				{ ref: "@e6", role: "button" },
				status,
			);
			expect(results).toHaveLength(0);
			expect(status.refFilteredOut).toBeDefined();
			expect(status.refFilteredOut!.filter).toBe("role");
			expect(status.refFilteredOut!.value).toBe("button");
			expect(status.refFilteredOut!.node.role).toBe("dialog");
		});

		it("ref present + extra name filter that does not match", () => {
			const status: QueryStatus = {};
			const results = queryElementCache(
				cache,
				{ ref: "@e6", name: "close" },
				status,
			);
			expect(results).toHaveLength(0);
			expect(status.refFilteredOut).toBeDefined();
			expect(status.refFilteredOut!.filter).toBe("name");
			expect(status.refFilteredOut!.value).toBe("close");
			expect(status.refFilteredOut!.node.name).toBe("Sign Up");
		});

		it("ref genuinely absent", () => {
			const status: QueryStatus = {};
			const results = queryElementCache(cache, { ref: "@e99" }, status);
			expect(results).toHaveLength(0);
			expect(status.refFilteredOut).toBeUndefined();
		});

		it("ref present + matching extra filter", () => {
			const status: QueryStatus = {};
			const results = queryElementCache(
				cache,
				{ ref: "@e6", role: "dialog" },
				status,
			);
			expect(results).toHaveLength(1);
			expect(results[0]!.ref).toBe("e6");
			expect(status.refFilteredOut).toBeUndefined();
		});
	});
});

// ─── Router dispatch integration tests ─────────────────────────────

describe("router.browserInspect()", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		mock.elementCache = makeSampleCache();
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	it("no params returns role-count summary", async () => {
		// Create session + navigate first
		await router.navigate("https://example.com", { taskId: "test-1" });

		const result = await router.browserInspect("test-1", {});
		expect(result.success).toBe(true);
		expect(result.content).toContain("buttons");
		expect(result.content).toContain("links");
	});

	it("text=true returns text with @e annotations", async () => {
		// Override mock evaluate to return extractor data
		mock.evalResult = {
			success: true,
			result: MOCK_EXTRACTOR_RESPONSE,
		};

		await router.navigate("https://example.com", { taskId: "test-2" });

		const result = await router.browserInspect("test-2", { text: true });
		expect(result.success).toBe(true);
		expect(result.content).toContain("@e");
		expect(result.content).toContain("Test Page");
	});

	it("role=button returns filtered element list", async () => {
		await router.navigate("https://example.com", { taskId: "test-3" });

		const result = await router.browserInspect("test-3", { role: "button" });
		expect(result.success).toBe(true);
		expect(result.content).toContain("4 elements");
		expect(result.content).toContain("@e3");
		expect(result.content).toContain("@e4");
	});

	it("no active session returns session error", async () => {
		const result = await router.browserInspect("nonexistent", {});
		expect(result.success).toBe(false);
		expect(result.error).toContain("No active session");
	});

	it("plugin without supportsJavaScriptEvaluate returns capability error", async () => {
		const noEvalMock = new MockPlugin("noeval", {
			supportsJavaScriptEvaluate: false,
		});
		noEvalMock.elementCache = makeSampleCache();
		pluginRegistry.clear();
		pluginRegistry.register(noEvalMock, makeConfig({ name: "noeval" }));

		await router.navigate("https://example.com", {
			strategy: "noeval",
			taskId: "test-4",
		});

		const result = await router.browserInspect("test-4", { text: true });
		expect(result.success).toBe(false);
		expect(result.error).toContain("not supported by this backend");
	});

	it("ref lookup with @ prefix normalizes correctly", async () => {
		await router.navigate("https://example.com", { taskId: "test-5" });

		const result = await router.browserInspect("test-5", { ref: "@e1" });
		expect(result.success).toBe(true);
		expect(result.content).toContain("Lexical Analysis");
	});

	it("ref + role mismatch shows found-but-filtered message", async () => {
		await router.navigate("https://example.com", { taskId: "test-5b" });

		const result = await router.browserInspect("test-5b", {
			ref: "@e6",
			role: "button",
		});
		expect(result.success).toBe(true);
		expect(result.content).toContain("found in cache");
		expect(result.content).toContain("does not match");
		expect(result.content).toContain('filter role="button"');
		expect(result.content).not.toContain("not found in cache");
	});

	it("ref genuinely absent keeps not-found message", async () => {
		await router.navigate("https://example.com", { taskId: "test-5c" });

		const result = await router.browserInspect("test-5c", { ref: "@e99" });
		expect(result.success).toBe(true);
		expect(result.content).toContain("not found in cache");
	});

	it("ref + role match returns element normally", async () => {
		await router.navigate("https://example.com", { taskId: "test-5d" });

		const result = await router.browserInspect("test-5d", {
			ref: "@e6",
			role: "dialog",
		});
		expect(result.success).toBe(true);
		expect(result.content).toContain("@e6");
		expect(result.content).toContain("Sign Up");
		expect(result.content).not.toContain("found in cache");
	});

	it("empty element cache returns 'no elements cached' message", async () => {
		const emptyMock = new MockPlugin("empty");
		emptyMock.elementCache = new Map();
		pluginRegistry.clear();
		pluginRegistry.register(emptyMock, makeConfig({ name: "empty" }));

		await router.navigate("https://example.com", {
			strategy: "empty",
			taskId: "test-6",
		});

		const result = await router.browserInspect("test-6", { text: true });
		expect(result.success).toBe(false);
		expect(result.error).toContain("No elements cached yet");
	});

	it("stale cache notice present when lastInteractionAt > cachePopulatedAt", async () => {
		await router.navigate("https://example.com", { taskId: "test-7" });

		// Set cachePopulatedAt and lastInteractionAt to make stale
		const session = sessionManager.getSession("test-7")!;
		session.cachePopulatedAt = Date.now() - 100_000;
		session.lastInteractionAt = Date.now();

		mock.evalResult = {
			success: true,
			result: MOCK_EXTRACTOR_RESPONSE,
		};
		const result = await router.browserInspect("test-7", { text: true });
		expect(result.staleCacheWarning).toBe(true);
	});

	it("subtree filter scopes to dialog elements", async () => {
		await router.navigate("https://example.com", { taskId: "test-8" });

		const result = await router.browserInspect("test-8", { subtree: "dialog" });
		expect(result.success).toBe(true);
		expect(result.content).toContain("Found 1 element");
		expect(result.content).toContain("Close");
	});

	it("maxChars truncation works", async () => {
		mock.evalResult = {
			success: true,
			result: MOCK_EXTRACTOR_RESPONSE,
		};
		await router.navigate("https://example.com", { taskId: "test-9" });

		const result = await router.browserInspect("test-9", {
			text: true,
			maxChars: 10,
		});
		expect(result.success).toBe(true);
		// Truncation: first 10 chars + "\n… X more chars (use maxChars=0 for full content)"
		expect(result.content).toMatch(
			/^.{10}\n… \d+ more chars \(use maxChars=0 for full content\)$/,
		);
	});

	it("default maxChars truncates at ~2500 when content exceeds limit", async () => {
		mock.evalResult = {
			success: true,
			result: makeLargeExtractorResponse(50),
		};
		// The extraction path needs a non-empty cache to proceed
		mock.elementCache = new Map([
			[
				"e1",
				{
					ref: "e1",
					role: "heading",
					name: "Big Heading",
					props: [],
					depth: 0,
					raw: "",
					occurrenceIndex: 0,
				},
			],
		]);
		await router.navigate("https://example.com", { taskId: "test-9b" });

		const result = await router.browserInspect("test-9b", {
			text: true,
		});
		expect(result.success).toBe(true);
		// Default maxChars=2500 applied; content should be truncated with notice
		expect(result.content).toMatch(
			/… \d+ more chars \(use maxChars=0 for full content\)$/,
		);
		// Truncated content + notice should be around 2500-2600 chars
		expect(result.content.length).toBeGreaterThan(2490);
		expect(result.content.length).toBeLessThan(2600);
	});

	it("maxChars=0 returns full content with no truncation notice", async () => {
		mock.evalResult = {
			success: true,
			result: MOCK_EXTRACTOR_RESPONSE,
		};
		await router.navigate("https://example.com", { taskId: "test-9c" });

		const result = await router.browserInspect("test-9c", {
			text: true,
			maxChars: 0,
		});
		expect(result.success).toBe(true);
		// maxChars=0 means no limit, so truncation notice should not appear
		expect(result.content).not.toContain("more chars");
		expect(result.content).toContain("Title: Test Page");
	});

	it("query filters paragraphs to matching content", async () => {
		mock.evalResult = {
			success: true,
			result: JSON.stringify({
				title: "Test",
				headings: [{ level: 1, text: "Climate Update" }],
				paragraphs: [
					{ text: "The climate is changing rapidly." },
					{ text: "Stock markets rallied today." },
					{ text: "Climate action requires global cooperation." },
				],
				links: [],
				images: [],
				interactive: [],
			}),
		};
		// Need at least one cache entry for the text path to proceed
		mock.elementCache = new Map([
			[
				"e1",
				{
					ref: "e1",
					role: "heading",
					name: "Climate Update",
					props: [],
					depth: 0,
					raw: "",
					occurrenceIndex: 0,
				},
			],
		]);
		await router.navigate("https://example.com", { taskId: "test-query-1" });

		const result = await router.browserInspect("test-query-1", {
			text: true,
			query: "climate",
		});
		expect(result.success).toBe(true);
		// Should include the two climate paragraphs and the heading
		expect(result.content).toContain("Climate Update");
		expect(result.content).toContain("climate is changing");
		expect(result.content).toContain("Climate action requires");
		// Should NOT include the non-matching paragraph
		expect(result.content).not.toContain("Stock markets");
	});

	it("query with no matches appends notice", async () => {
		mock.evalResult = {
			success: true,
			result: JSON.stringify({
				title: "Test",
				headings: [],
				paragraphs: [
					{ text: "Apples are fruit." },
					{ text: "Oranges are citrus." },
				],
				links: [],
				images: [],
				interactive: [],
			}),
		};
		mock.elementCache = new Map([
			[
				"e1",
				{
					ref: "e1",
					role: "button",
					name: "dummy",
					props: [],
					depth: 0,
					raw: "",
					occurrenceIndex: 0,
				},
			],
		]);
		await router.navigate("https://example.com", { taskId: "test-query-2" });

		const result = await router.browserInspect("test-query-2", {
			text: true,
			query: "banana",
		});
		expect(result.success).toBe(true);
		// Should contain the empty-results notice
		expect(result.content).toContain('No content matched "banana"');
	});

	it("query works with maxChars=0 for full filtered output", async () => {
		mock.evalResult = {
			success: true,
			result: JSON.stringify({
				title: "Test",
				headings: [],
				paragraphs: [
					{ text: "Apple pie recipe" },
					{ text: "Apple strudel" },
					{ text: "Apple crumble" },
				],
				links: [],
				images: [],
				interactive: [],
			}),
		};
		mock.elementCache = new Map([
			[
				"e1",
				{
					ref: "e1",
					role: "button",
					name: "dummy",
					props: [],
					depth: 0,
					raw: "",
					occurrenceIndex: 0,
				},
			],
		]);
		await router.navigate("https://example.com", { taskId: "test-query-3" });

		const result = await router.browserInspect("test-query-3", {
			text: true,
			query: "Apple",
			maxChars: 0,
		});
		expect(result.success).toBe(true);
		// All three Apple items should be present with no truncation
		expect(result.content).toContain("pie");
		expect(result.content).toContain("strudel");
		expect(result.content).toContain("crumble");
		expect(result.content).not.toContain("more chars");
	});

	it("evaluate failure returns extraction error", async () => {
		mock.evalResult = {
			success: false,
			error: "browser disconnected",
		};
		await router.navigate("https://example.com", { taskId: "test-10" });

		const result = await router.browserInspect("test-10", { text: true });
		expect(result.success).toBe(false);
		expect(result.error).toContain(
			"Text extraction failed: browser disconnected",
		);
		expect(result.error).toContain("browser-inspect with role=");
		expect(result.error).not.toContain("browser-snapshot to inspect visually");
		expect(result.error).toMatch(/\(8 elements\) is available/);
	});

	describe("Changes 3 & 4 — silent-empty guards", () => {
		it("correlateElements valid-but-empty result appends notice", () => {
			const cache = new Map<string, AriaCachedNode>();
			const result = correlateElements(
				{
					title: "",
					headings: [],
					paragraphs: [],
					links: [],
					images: [],
					interactive: [],
				},
				cache,
				true,
			);
			expect(result.text).toContain("No extractable content");
			expect(result.text.length).toBeGreaterThan(0);
			expect(result.matchedRefs).toBe(0);
			expect(result.staleCache).toBe(false);
		});

		it("text=true + empty extractor + populated cache returns notice", async () => {
			mock.evalResult = {
				success: true,
				result: JSON.stringify({
					title: "",
					headings: [],
					paragraphs: [],
					links: [],
					images: [],
					interactive: [],
				}),
			};
			await router.navigate("https://example.com", { taskId: "test-11" });

			const result = await router.browserInspect("test-11", { text: true });
			expect(result.success).toBe(true);
			expect(result.content).toContain("No extractable content");
		});

		it("text=true + query + empty extractor input appends no-match notice", async () => {
			mock.evalResult = {
				success: true,
				result: JSON.stringify({
					title: "",
					headings: [],
					paragraphs: [],
					links: [],
					images: [],
					interactive: [],
				}),
			};
			await router.navigate("https://example.com", { taskId: "test-12" });

			const result = await router.browserInspect("test-12", {
				text: true,
				query: "anything",
			});
			expect(result.success).toBe(true);
			expect(result.content).toContain('No content matched "anything"');
		});
	});
});

// ─── Output formatting tests ───────────────────────────────────────

describe("formatElementList()", () => {
	it("formats empty list", () => {
		const result = formatElementList([]);
		expect(result).toContain("No matching elements found");
	});

	it("formats ref lookup not found", () => {
		const result = formatElementList([], { ref: "@e99" });
		expect(result).toContain("not found in cache");
	});

	it("formats single element", () => {
		const node: AriaCachedNode = {
			ref: "e1",
			role: "button",
			name: "Click me",
			props: [],
			depth: 1,
			raw: "",
			occurrenceIndex: 0,
		};
		const result = formatElementList([node]);
		expect(result).toContain("@e1");
		expect(result).toContain("Click me");
	});

	it("formats multiple elements", () => {
		const nodes: AriaCachedNode[] = [
			{
				ref: "e1",
				role: "link",
				name: "Link A",
				props: [],
				depth: 1,
				raw: "",
				occurrenceIndex: 0,
			},
			{
				ref: "e2",
				role: "button",
				name: "Button B",
				props: ["disabled"],
				depth: 2,
				raw: "",
				occurrenceIndex: 0,
			},
		];
		const result = formatElementList(nodes);
		expect(result).toContain("2 elements");
		expect(result).toContain("@e1");
		expect(result).toContain("@e2");
		expect(result).toContain("[disabled]");
	});
});

describe("formatRoleCountSummary()", () => {
	it("returns summary sorted by count descending", () => {
		const result = formatRoleCountSummary(makeSampleCache());
		expect(result).toContain("buttons");
		expect(result).toContain("links");
		// buttons appear first (3 buttons, 2 links, 1 dialog, 1 heading)
		expect(result.indexOf("buttons")).toBeLessThan(result.indexOf("links"));
	});

	it("handles empty cache", () => {
		const result = formatRoleCountSummary(new Map());
		expect(result).toContain("No elements cached yet");
	});

	it("includes role=, name=, text=true hint", () => {
		const result = formatRoleCountSummary(makeSampleCache());
		expect(result).toContain("role=");
		expect(result).toContain("text=true");
	});
});
