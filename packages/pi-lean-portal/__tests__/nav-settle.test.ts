/**
 * Navigation settle tests — verifies `waitForNavigationSettle` correctly
 * detects cross-document navigation, same-document (pushState) navigation,
 * no-navigation interactions, and edge cases.
 *
 * Mock strategy: the `waitForTimeout` mock uses `setTimeout(resolve, 0)`
 * which creates a real macrotask boundary.  Each `await new Promise(r =>
 * setTimeout(r, 0))` in a test advances the event loop by one macrotask,
 * allowing the implementation's async chain to progress naturally.
 *
 * All tests are browser-free — no Chromium needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitForNavigationSettle } from "../core/shared/nav-settle.js";
import type { NavigationSettlePage } from "../core/shared/nav-settle.js";

// ─── Mock Page factory ──────────────────────────────────────────────

interface MockPage extends NavigationSettlePage {
	/** Change the URL returned by `page.url()`. */
	setUrl(url: string): void;
	/** Synchronously fire the registered `framenavigated` handler. */
	fireNav(frame?: unknown): void;
}

function createMockPage(): MockPage {
	let _url = "https://example.com/";
	const _mainFrame = {};
	const _captured: { handler: (...args: unknown[]) => void } = {
		handler: () => {},
	};

	return {
		// ── NavigationSettlePage (all vi.fn'd) ────────

		url: vi.fn(() => _url),
		mainFrame: vi.fn(() => _mainFrame),

		on: vi.fn((_event: string, handler: (...args: unknown[]) => void) => {
			_captured.handler = handler;
		}),

		off: vi.fn(),

		waitForTimeout: vi.fn(
			(_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 0)),
		),

		waitForLoadState: vi.fn(() => Promise.resolve()),

		// ── Test helpers ──────────────────────────────

		setUrl(url: string) {
			_url = url;
		},

		fireNav(frame?: unknown) {
			_captured.handler(frame ?? _mainFrame);
		},
	};
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("waitForNavigationSettle", () => {
	let page: MockPage;

	beforeEach(() => {
		page = createMockPage();
	});

	// ── No navigation ─────────────────────────────────

	it("returns { navigated: false, url } when no navigation occurs", async () => {
		const promise = waitForNavigationSettle(page, page.url(), {
			settleTimeoutMs: 0,
			navTimeoutMs: 5000,
		});

		// Yield 1: Promise.race resolves (timeout wins over navStarted) →
		// else branch → waitForTimeout(0)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// Note: we do NOT fire any nav event nor change the URL, so the
		// else branch is taken.  At this point waitForLoadState has NOT
		// been called (we're in the settle path, not the nav path).
		expect(page.waitForLoadState).not.toHaveBeenCalled();

		// Yield 2: waitForTimeout(0) resolves → else branch completes →
		// late-arrival gate (navigated=false, URL same → skip) → return
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const result = await promise;

		expect(result.navigated).toBe(false);
		expect(result.url).toBe("https://example.com/");
		expect(page.waitForLoadState).not.toHaveBeenCalled();
	});

	// ── Cross-document navigation ─────────────────────

	it("detects cross-document navigation via framenavigated event", async () => {
		page.setUrl("https://example.com/page2");

		const promise = waitForNavigationSettle(page, "https://example.com/", {
			settleTimeoutMs: 0,
			navTimeoutMs: 5000,
		});

		// Fire nav AFTER the function has started (handler is registered
		// synchronously during the call).  This resolves navStarted
		// immediately so Promise.race picks it.
		page.fireNav();

		// All async work (microtasks) finishes before this macrotask runs.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// waitForPageReady calls waitForLoadState twice: load + networkidle
		expect(page.waitForLoadState).toHaveBeenCalledTimes(2);
		expect(page.waitForLoadState).toHaveBeenNthCalledWith(1, "load", {
			timeout: 5000,
		});
		expect(page.waitForLoadState).toHaveBeenNthCalledWith(2, "networkidle", {
			timeout: 5000,
		});

		const result = await promise;

		expect(result.navigated).toBe(true);
		expect(result.url).toBe("https://example.com/page2");
	});

	// ── Same-document navigation (pushState) ──────────

	it("detects same-document navigation via framenavigated event", async () => {
		// pushState fires framenavigated in Playwright, identical path.
		page.setUrl("https://example.com/page2");

		const promise = waitForNavigationSettle(page, "https://example.com/", {
			settleTimeoutMs: 0,
			navTimeoutMs: 5000,
		});

		page.fireNav();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(page.waitForLoadState).toHaveBeenCalledTimes(2);

		const result = await promise;

		expect(result.navigated).toBe(true);
		expect(result.url).toBe("https://example.com/page2");
	});

	// ── URL change without framenavigated (edge case) ─

	it("detects navigation via URL change when framenavigated does not fire", async () => {
		// Set the URL before the settle check — no fireNav call, so
		// navigated stays false.
		page.setUrl("https://example.com/page2");

		const promise = waitForNavigationSettle(page, "https://example.com/", {
			settleTimeoutMs: 0,
			navTimeoutMs: 5000,
		});

		// Yield: Promise.race resolves (timeout wins) → navigated=false,
		// URL differs → else-if branch → waitForPageReady (load + networkidle)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(page.waitForLoadState).toHaveBeenCalledTimes(2);

		const result = await promise;

		// navigated=false because no event was observed, but we still
		// waited for page readiness before returning.
		expect(result.navigated).toBe(false);
		expect(result.url).toBe("https://example.com/page2");
	});

	// ── Non-main frame navigation ─────────────────────

	it("ignores framenavigated for non-main frames", async () => {
		const iframe = {};

		const promise = waitForNavigationSettle(page, page.url(), {
			settleTimeoutMs: 0,
			navTimeoutMs: 5000,
		});

		// Yield 1: Promise.race resolves (timeout wins) → else branch →
		// waitForTimeout(0)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// Fire nav for the iframe (not main frame) — the handler fires
		// but frame !== page.mainFrame() so navigated stays false.
		page.fireNav(iframe);

		// Yield 2: waitForTimeout(0) resolves → late-arrival gate
		// (navigated=false, URL same → skip) → return
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(page.waitForLoadState).not.toHaveBeenCalled();

		const result = await promise;

		expect(result.navigated).toBe(false);
	});

	// ── Late-arriving navigation ─────────────────

	it("detects navigation that starts after the initial wait window", async () => {
		// The framenavigated event arrives after the 150ms check but
		// before the settle timeout fires.  The late-arrival gate must
		// catch this and call waitForPageReady (load + networkidle).
		const promise = waitForNavigationSettle(page, "https://example.com/", {
			settleTimeoutMs: 100,
			navTimeoutMs: 5000,
		});

		// Yield 1: Promise.race resolves (timeout wins) → else branch →
		// waitForTimeout(100)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// Late nav fires during the settle window
		page.setUrl("https://example.com/page2");
		page.fireNav();

		// Yield 2: waitForTimeout(100) resolves → else branch completes →
		// late-arrival gate (navigated=true → waitForPageReady) → return
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// The late-arrival gate calls waitForPageReady which calls
		// waitForLoadState twice: load + networkidle.
		expect(page.waitForLoadState).toHaveBeenCalledTimes(2);
		expect(page.waitForLoadState).toHaveBeenNthCalledWith(1, "load", {
			timeout: 5000,
		});
		expect(page.waitForLoadState).toHaveBeenNthCalledWith(2, "networkidle", {
			timeout: 5000,
		});

		const result = await promise;

		expect(result.navigated).toBe(true);
		expect(result.url).toBe("https://example.com/page2");
	});

	// ── Custom timeouts ────────────────────────────────

	it("uses custom nav timeout when provided", async () => {
		page.setUrl("https://example.com/page2");

		const promise = waitForNavigationSettle(page, "https://example.com/", {
			settleTimeoutMs: 0,
			navTimeoutMs: 3000,
		});

		page.fireNav();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// Both load and networkidle get the custom timeout
		expect(page.waitForLoadState).toHaveBeenNthCalledWith(1, "load", {
			timeout: 3000,
		});
		expect(page.waitForLoadState).toHaveBeenNthCalledWith(2, "networkidle", {
			timeout: 3000,
		});

		await promise;
	});

	it("uses custom settle timeout when provided", async () => {
		const promise = waitForNavigationSettle(page, page.url(), {
			settleTimeoutMs: 100,
			navTimeoutMs: 5000,
		});

		// Yield 1: Promise.race resolves (timeout wins) → else branch →
		// waitForTimeout(100)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// At this point, waitForTimeout was called with 150 (race window)
		// and 100 (custom settle).
		expect(page.waitForTimeout).toHaveBeenNthCalledWith(1, 150);
		expect(page.waitForTimeout).toHaveBeenNthCalledWith(2, 100);
		expect(page.waitForTimeout).toHaveBeenCalledTimes(2);

		// Yield 2: waitForTimeout(100) resolves → return
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		await promise;
	});

	// ── Default options ───────────────────────────────

	it("uses defaults when options are omitted", async () => {
		const promise = waitForNavigationSettle(page, page.url());

		// Yield 1: Promise.race resolves (timeout wins) → else branch →
		// waitForTimeout(400) (default settle)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(page.waitForTimeout).toHaveBeenNthCalledWith(1, 150);
		expect(page.waitForTimeout).toHaveBeenNthCalledWith(2, 400);
		expect(page.waitForTimeout).toHaveBeenCalledTimes(2);

		// Yield 2: waitForTimeout(400) resolves → return
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const result = await promise;

		expect(result.navigated).toBe(false);
		expect(result.url).toBe("https://example.com/");
	});

	// ── waitForLoadState rejection ────────────────────

	it("survives waitForLoadState rejection (timeout)", async () => {
		page.setUrl("https://example.com/page2");
		page.waitForLoadState = vi.fn(() =>
			Promise.reject(new Error("Navigation timeout")),
		);

		const promise = waitForNavigationSettle(page, "https://example.com/", {
			settleTimeoutMs: 0,
			navTimeoutMs: 1000,
		});

		page.fireNav();

		// Should not throw — each .catch(() => {}) swallows the rejection.
		// Both load and networkidle rejections are caught.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(page.waitForLoadState).toHaveBeenCalledTimes(2);

		const result = await promise;

		expect(result.navigated).toBe(true);
		expect(result.url).toBe("https://example.com/page2");
	});

	// ── Listener cleanup ──────────────────────────────

	it("de-registers the framenavigated listener after settling", async () => {
		const promise = waitForNavigationSettle(page, page.url(), {
			settleTimeoutMs: 0,
			navTimeoutMs: 5000,
		});

		// Yield twice to complete the no-nav flow
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await promise;

		expect(page.off).toHaveBeenCalledWith(
			"framenavigated",
			expect.any(Function),
		);
		expect(page.off).toHaveBeenCalledTimes(1);
	});

	it("removes the listener even when waitForLoadState throws", async () => {
		page.setUrl("https://example.com/page2");
		page.waitForLoadState = vi.fn(() => Promise.reject(new Error("Timeout")));

		const promise = waitForNavigationSettle(page, "https://example.com/", {
			settleTimeoutMs: 0,
			navTimeoutMs: 1000,
		});

		page.fireNav();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await promise;

		expect(page.off).toHaveBeenCalledWith(
			"framenavigated",
			expect.any(Function),
		);
	});

	// ── Race optimization: navStarted resolves before timeout ──

	it("resolves immediately when framenavigated fires before the detection window expires", async () => {
		page.setUrl("https://example.com/page2");

		const promise = waitForNavigationSettle(page, "https://example.com/", {
			settleTimeoutMs: 0,
			navTimeoutMs: 5000,
		});

		// Fire nav immediately — navStarted resolves synchronously,
		// Promise.race picks it, and we proceed to waitForPageReady
		// without waiting the full detection window.
		page.fireNav();

		// One yield is enough (race + waitForPageReady both complete
		// in the microtask chain).
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// Both load and networkidle were waited for
		expect(page.waitForLoadState).toHaveBeenCalledTimes(2);

		const result = await promise;
		expect(result.navigated).toBe(true);
		expect(result.url).toBe("https://example.com/page2");
	});

	it("does not call waitForLoadState when framenavigated fires for a non-main frame", async () => {
		const iframe = {};
		const promise = waitForNavigationSettle(page, page.url(), {
			settleTimeoutMs: 0,
			navTimeoutMs: 5000,
		});

		// Yield 1: Promise.race resolves → else branch → waitForTimeout(0)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// iframe nav resolves navStarted but navigated stays false
		page.fireNav(iframe);

		// Yield 2: settle done → late-arrival gate (navigated=false, URL same)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(page.waitForLoadState).not.toHaveBeenCalled();

		const result = await promise;
		expect(result.navigated).toBe(false);
	});
});
