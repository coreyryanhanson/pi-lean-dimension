/**
 * Tests for fetch-backend.ts — webFetch() and supporting utilities.
 *
 * Uses vi.spyOn(global, 'fetch') to mock HTTP responses, avoiding
 * URL safety restrictions (127.0.0.1 is blocked) and providing
 * deterministic control over response timing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { webFetch, cleanupFetchTempFiles } from "../core/fetch-backend";

// ─── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
	cleanupFetchTempFiles();
});

afterEach(() => {
	vi.restoreAllMocks();
	cleanupFetchTempFiles();
});

// ─── Mock helpers ─────────────────────────────────────────────

interface MockFetchOpts {
	body: string;
	title?: string;
	status?: number;
	/** If set, delay responding by this many ms (for timeout tests). */
	delayMs?: number;
	/**
	 * If true, never respond unless aborted (for pre-aborted signal test).
	 * Only meaningful when delayMs is not set.
	 */
	abortOnly?: boolean;
}

/**
 * Mock global.fetch with a response that respects abort signals.
 *
 * - If the passed signal is already aborted, rejects with AbortError.
 * - Listens for signal abort and rejects if it fires.
 * - Resolves with the HTML response after an optional delay.
 */
function mockFetch(opts: MockFetchOpts): void {
	const title = opts.title ?? "Test Page";
	const html = `<!DOCTYPE html><html><head><title>${title}</title></head><body>${opts.body}</body></html>`;

	vi.spyOn(global, "fetch").mockImplementationOnce(
		(_url, _init) =>
			new Promise((resolve, reject) => {
				const signal = (_init as RequestInit | undefined)?.signal;

				if (signal) {
					if (signal.aborted) {
						reject(new DOMException("The operation was aborted", "AbortError"));
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							);
						},
						{ once: true },
					);
				}

				if (opts.abortOnly) {
					// Never respond — rely on abort to reject
					return;
				}

				const respond = (): void => {
					resolve(
						new Response(html, {
							status: opts.status ?? 200,
							statusText: opts.status === 200 ? "OK" : "",
							headers: { "Content-Type": "text/html" },
						}),
					);
				};

				if (opts.delayMs) {
					setTimeout(respond, opts.delayMs);
				} else {
					respond();
				}
			}),
	);
}

/** Mock that rejects every fetch with AbortError (for pre-aborted signal path). */
function mockFetchAlwaysAbort(): void {
	vi.spyOn(global, "fetch").mockRejectedValue(
		new DOMException("The operation was aborted", "AbortError"),
	);
}

/** Generate a string of repeated characters. */
function longText(minChars: number): string {
	return "A".repeat(minChars);
}

// ─── Core Fetch ───────────────────────────────────────────────

describe("webFetch — core fetch", () => {
	it("fetches a page and returns markdown", async () => {
		mockFetch({ body: "<h1>Hello World</h1><p>This is a test.</p>" });

		const result = await webFetch({ url: "http://example.com/test" });

		expect(result.success).toBe(true);
		expect(result.backendUsed).toBe("fetch");
		expect(result.title).toBe("Test Page");
		expect(result.content).toContain("Hello World");
		expect(result.content).toContain("This is a test.");
		expect(result.statusCode).toBe(200);
	});

	it("extracts the page title", async () => {
		mockFetch({ body: "<p>Content</p>", title: "My Custom Title" });

		const result = await webFetch({ url: "http://example.com/title" });

		expect(result.success).toBe(true);
		expect(result.title).toBe("My Custom Title");
	});

	it("handles 404 errors gracefully", async () => {
		mockFetch({ body: "Not Found", status: 404 });

		const result = await webFetch({ url: "http://example.com/not-found" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/HTTP 404/);
		expect(result.statusCode).toBe(404);
	});

	it("handles 500 errors gracefully", async () => {
		mockFetch({ body: "Internal Server Error", status: 500 });

		const result = await webFetch({ url: "http://example.com/error" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/HTTP 500/);
		expect(result.statusCode).toBe(500);
	});

	it("handles empty body responses", async () => {
		// Return an HTTP response with truly empty body (no HTML wrapping)
		vi.spyOn(global, "fetch").mockResolvedValueOnce(
			new Response("", {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/html" },
			}),
		);

		const result = await webFetch({ url: "http://example.com/empty" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/empty/i);
	});

	it("reports the final URL after redirects", async () => {
		const response = new Response(
			"<!DOCTYPE html><html><head><title>Final</title></head><body><p>Arrived</p></body></html>",
			{
				status: 200,
				statusText: "OK",
				headers: { "Content-Type": "text/html" },
			},
		);
		Object.defineProperty(response, "url", {
			value: "http://example.com/final",
		});

		vi.spyOn(global, "fetch").mockResolvedValueOnce(response);

		const result = await webFetch({ url: "http://example.com/redirect-me" });
		expect(result.success).toBe(true);
		expect(result.title).toBe("Final");
		expect(result.content).toContain("Arrived");
	});
});

// ─── URL Safety ───────────────────────────────────────────────

describe("webFetch — URL safety", () => {
	it("rejects invalid URLs before fetching", async () => {
		const result = await webFetch({ url: "not a url" });
		expect(result.success).toBe(false);
		expect(result.error).toBe("Invalid URL");
	});

	it("rejects SSRF (localhost) before fetching", async () => {
		const result = await webFetch({ url: "http://localhost/admin" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/URL blocked/i);
	});

	it("rejects SSRF (private IP) before fetching", async () => {
		const result = await webFetch({ url: "http://127.0.0.1/secret" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/URL blocked/i);
	});

	it("rejects dangerous schemes before fetching", async () => {
		const result = await webFetch({ url: "file:///etc/passwd" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/URL blocked/i);
	});

	it("rejects URLs containing secrets before fetching", async () => {
		const result = await webFetch({
			url: "http://example.com/api?api_key=secret123",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/URL blocked/i);
	});
});

// ─── JavaScript Detection ─────────────────────────────────────

describe("webFetch — JS detection", () => {
	it("detects SPA shell (empty #root div)", async () => {
		mockFetch({ body: '<div id="root"></div><p>Hidden without JS</p>' });
		const result = await webFetch({ url: "http://example.com/spa" });
		expect(result.success).toBe(true);
		expect(result.needsJavaScript).toBe(true);
	});

	it("detects SPA shell with __next div", async () => {
		mockFetch({ body: '<div id="__next"></div>' });
		const result = await webFetch({ url: "http://example.com/next" });
		expect(result.success).toBe(true);
		expect(result.needsJavaScript).toBe(true);
	});

	it("detects noscript-heavy pages", async () => {
		mockFetch({
			body: "<noscript>Please enable JavaScript to view this content.</noscript><p>Small visible text</p>",
		});
		const result = await webFetch({ url: "http://example.com/noscript" });
		expect(result.success).toBe(true);
		expect(result.needsJavaScript).toBe(true);
	});

	it("does not set needsJavaScript on normal pages", async () => {
		mockFetch({ body: "<p>Static content with lots of text here.</p>" });
		const result = await webFetch({ url: "http://example.com/static" });
		expect(result.success).toBe(true);
		expect(result.needsJavaScript).toBeUndefined();
	});
});

// ─── Bot Detection ───────────────────────────────────────────

describe("webFetch — bot detection", () => {
	it("detects Cloudflare challenge pages", async () => {
		mockFetch({
			body: '<div class="cf-browser-verification"><p>Please verify you are human to continue.</p><p>Cloudflare</p></div>',
			title: "Attention Required! | Cloudflare",
		});
		const result = await webFetch({ url: "http://example.com/cf" });
		expect(result.success).toBe(true);
		expect(result.botDetected).toBe(true);
	});

	it("detects CAPTCHA pages", async () => {
		mockFetch({
			body: '<form><div class="g-recaptcha"></div><p>captcha verification required</p></form>',
			title: "Verify you are human",
		});
		const result = await webFetch({ url: "http://example.com/captcha" });
		expect(result.success).toBe(true);
		expect(result.botDetected).toBe(true);
	});

	it("does not set botDetected on normal pages", async () => {
		mockFetch({ body: "<p>Welcome to my website.</p>" });
		const result = await webFetch({ url: "http://example.com/normal" });
		expect(result.success).toBe(true);
		expect(result.botDetected).toBeUndefined();
	});
});

// ─── Content Capping ─────────────────────────────────────────

describe("webFetch — content capping", () => {
	it("keeps content inline when under spill threshold (< 5000 chars)", async () => {
		mockFetch({ body: "<p>Short content</p>" });
		const result = await webFetch({ url: "http://example.com/short" });

		expect(result.success).toBe(true);
		expect(result.filePath).toBeUndefined();
		expect(result.totalChars).toBeLessThan(5000);
		expect(result.content).toContain("Short content");
		expect(result.content).not.toContain("more chars");
	});

	it("spills large content to temp file (> 5000 chars)", async () => {
		mockFetch({ body: `<p>${longText(6000)}</p>` });
		const result = await webFetch({ url: "http://example.com/long" });

		expect(result.success).toBe(true);
		expect(result.filePath).toBeTruthy();
		expect(result.totalChars).toBeGreaterThan(5000);
		expect(result.content).toContain("more chars");
		expect(result.content).toContain("Full content saved to");
	});

	it("reports totalChars even for small content", async () => {
		mockFetch({ body: "<p>Hello</p>" });
		const result = await webFetch({ url: "http://example.com/small" });

		expect(result.success).toBe(true);
		expect(result.totalChars).toBeTypeOf("number");
		expect(result.totalChars).toBeGreaterThan(0);
		expect(result.totalChars).toBeLessThan(5000);
	});
});

// ─── Abort Signal ────────────────────────────────────────────

describe("webFetch — abort signal", () => {
	it("returns timeout when fetch rejects with AbortError", async () => {
		// Mock rejects every fetch with AbortError (simulates pre-aborted signal
		// propagating through performFetch's internal controller).
		mockFetchAlwaysAbort();

		const controller = new AbortController();
		controller.abort();

		const result = await webFetch({
			url: "http://example.com/test",
			signal: controller.signal,
			timeout: 30,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("timeout");
	});

	it("returns timeout when caller aborts mid-request", async () => {
		// Mock that never responds but listens for abort signal
		mockFetch({ body: "", abortOnly: true });

		const controller = new AbortController();

		// Give performFetch time to set up the internal listener
		setTimeout(() => controller.abort(), 20);

		const result = await webFetch({
			url: "http://example.com/mid-request",
			signal: controller.signal,
			timeout: 30,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("timeout");
	});
});

// ─── Timeout ──────────────────────────────────────────────────

describe("webFetch — timeout", () => {
	it("times out when server is too slow", async () => {
		// Mock delays response (3s) and listens for abort.
		// webFetch calls with timeout:1 (1s), so the timeout fires first.
		mockFetch({ body: "<p>Slow response</p>", delayMs: 3000 });

		const result = await webFetch({
			url: "http://example.com/slow",
			timeout: 1,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("timeout");
	});
});
