/**
 * Navigation settle detection — waits for framenavigated event or DOM
 * stabilisation after interactions, eliminating stale-@e-ref bugs from fixed sleeps.
 *
 * Constants (timeouts, race window) are sourced from the shared
 * ``browser-data.json`` so the TypeScript and Python sides never drift.
 */

import { NAV_SETTLE } from "./browser-data.js";

// ─── Public types ───────────────────────────────────────────────────

/**
 * Minimal Page-like interface sufficient for navigation settle detection.
 *
 * The Playwright `Page` type structurally satisfies this interface, so
 * callers can pass a real `Page` directly. Mocks in unit tests implement
 * this interface to avoid importing Playwright.
 */
export interface NavigationSettlePage {
	url(): string;
	mainFrame(): unknown;
	on(event: string, handler: (...args: unknown[]) => void): void;
	off(event: string, handler: (...args: unknown[]) => void): void;
	waitForTimeout(ms: number): Promise<void>;
	waitForLoadState(
		state?: "load" | "domcontentloaded" | "networkidle",
		options?: { timeout?: number },
	): Promise<void>;
}

/** Options for `waitForNavigationSettle`. */
export interface NavigationSettleOptions {
	/**
	 * Maximum time (ms) to wait for page readiness (load + networkidle)
	 * when a navigation is detected.  Shared budget for both waits.
	 * Default: 5000.
	 */
	navTimeoutMs?: number;
	/**
	 * Short settle delay (ms) when no navigation occurs. This allows
	 * client-side rerenders / animations to finish. Default: 400.
	 */
	settleTimeoutMs?: number;
}

/** Result of `waitForNavigationSettle`. */
export interface NavigationSettleResult {
	/** Whether a `framenavigated` event was observed on the main frame. */
	navigated: boolean;
	/** The page URL after settling (guaranteed consistent with DOM). */
	url: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Wait for the page to be fully ready after a navigation.
 *
 * Calls `waitForLoadState("load")` for the document + sub-resources,
 * then also waits for network idle so that SPA same-document route
 * changes (pushState) settle before we snapshot.  Errors/timeouts
 * are swallowed — the caller proceeds with whatever state it has.
 */
async function waitForPageReady(
	page: NavigationSettlePage,
	timeout: number,
): Promise<void> {
	// Cross-document or same-document navigation started.
	// waitForLoadState("load") resolves after the document and its
	// sub-resources load; for same-document pushState it resolves
	// immediately since "load" already fired.
	await page.waitForLoadState("load", { timeout }).catch(() => {
		// Timeout or error — continue anyway. The caller gets the
		// current URL and can decide how to proceed.
	});

	// For SPA route changes (pushState/replaceState), "load" is already
	// satisfied and resolves instantly — the SPA may still be fetching
	// data. A bounded networkidle wait catches the XHR/fetch burst
	// without hanging on long-polling sites.
	await page.waitForLoadState("networkidle", { timeout }).catch(() => {
		// Timeout or error — continue regardless.
	});
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Wait for navigation to settle after a user interaction (click, press,
 * etc.) that may or may not trigger a page navigation.
 *
 * **Usage:**
 * ```ts
 * const urlBefore = page.url();
 * await locator.click();
 * const { navigated, url } = await waitForNavigationSettle(page, urlBefore);
 * ```
 *
 * **How it works:**
 * 1. Registers a `framenavigated` listener on the page *before* settling.
 * 2. Races a brief window (~150 ms) against the `framenavigated` event
 *    so that instant navigations don't pay the full window.
 * 3. If the main frame navigated (cross-document or same-document via
 *    `pushState`), calls `waitForPageReady` for load + bounded networkidle
 *    (capped at `navTimeoutMs` each).
 * 4. Falls back to URL-change detection if the URL changed without a
 *    `framenavigated` event (defense-in-depth).
 * 5. Otherwise, waits `settleTimeoutMs` for client-side rerenders.
 * 6. A late-arrival gate catches navigations that start during the settle
 *    window (e.g. an async click handler with setTimeout).
 *
 * The returned URL is always read **after** settling, guaranteeing
 * consistency between the URL and the current DOM.
 *
 * @param page - A Page-like object (real Playwright Page or mock).
 * @param urlBefore - The page URL before the interaction.
 * @param opts - Optional timeout overrides.
 * @returns `{ navigated, url }` after the page has settled.
 */
export async function waitForNavigationSettle(
	page: NavigationSettlePage,
	urlBefore: string,
	opts?: NavigationSettleOptions,
): Promise<NavigationSettleResult> {
	const navTimeout = opts?.navTimeoutMs ?? NAV_SETTLE.navTimeoutMs;
	const settleTimeout = opts?.settleTimeoutMs ?? NAV_SETTLE.settleTimeoutMs;

	let navigated = false;

	// Deferred promise that resolves when framenavigated fires on the main
	// frame.  We race this against the detection window so that instant
	// navigations don't pay the full 150ms.
	let navResolve: () => void = () => {};
	const navStarted = new Promise<void>((resolve) => {
		navResolve = resolve;
	});

	const onNav = (frame: unknown) => {
		if (frame === page.mainFrame()) {
			navigated = true;
			navResolve();
		}
	};

	page.on("framenavigated", onNav);

	try {
		// Race the detection window against the framenavigated event.
		// Most link clicks and Enter presses trigger navigation within one
		// event-loop tick; the race means we don't waste time when nav
		// starts immediately.
		await Promise.race([
			page.waitForTimeout(NAV_SETTLE.settleRaceMs),
			navStarted,
		]);

		let waitedForLoad = false;
		if (navigated) {
			await waitForPageReady(page, navTimeout);
			waitedForLoad = true;
		} else if (page.url() !== urlBefore) {
			// URL changed without a framenavigated event (possible edge case).
			await waitForPageReady(page, navTimeout);
			waitedForLoad = true;
		} else {
			// No navigation detected yet — allow client-side rerenders /
			// scrolling to settle before reading the snapshot.
			await page.waitForTimeout(settleTimeout);
		}

		// Late-arrival gate: a navigation may have started during the settle
		// timeout (e.g. an async click handler with a 200ms setTimeout).  If
		// we didn't already call waitForPageReady but navigated has since
		// become true (or the URL changed), wait for readiness now.
		if (!waitedForLoad && (navigated || page.url() !== urlBefore)) {
			await waitForPageReady(page, navTimeout);
		}
	} finally {
		page.off("framenavigated", onNav);
	}

	return { navigated, url: page.url() };
}
