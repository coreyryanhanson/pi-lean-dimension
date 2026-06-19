/**
 * Navigation settle detection for the browser extension.
 *
 * After a user interaction (click, press) that may or may not trigger
 * a page navigation, this module provides a reliable way to wait for
 * the page to settle before reading URL / title / snapshot.
 *
 * The core insight: instead of a fixed sleep (e.g. `waitForTimeout(300)`)
 * that races against navigation commit, we listen for the actual
 * `framenavigated` event and wait for `waitForLoadState("load")` only
 * when navigation has actually started.
 *
 * This eliminates the URL / DOM mismatch that causes stale-@e-ref and
 * mismatched URL/content bugs.
 */

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
	 * Maximum time (ms) to wait for `waitForLoadState("load")` when a
	 * navigation is detected. Default: 5000.
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
 * 2. Waits a brief window (~150 ms) for a navigation to *begin*.
 * 3. If the main frame navigated (cross-document or same-document via
 *    `pushState`), waits for `waitForLoadState("load")` (capped at
 *    `navTimeoutMs`).
 * 4. Falls back to URL-change detection if the URL changed without a
 *    `framenavigated` event (defense-in-depth).
 * 5. Otherwise, waits `settleTimeoutMs` for client-side rerenders.
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
	const navTimeout = opts?.navTimeoutMs ?? 5000;
	const settleTimeout = opts?.settleTimeoutMs ?? 400;

	let navigated = false;

	const onNav = (frame: unknown) => {
		if (frame === page.mainFrame()) {
			navigated = true;
		}
	};

	page.on("framenavigated", onNav);

	try {
		// Brief window for a navigation to begin after the user interaction.
		// Most link clicks and Enter presses trigger navigation within one
		// event-loop tick, but we give a comfortable margin.
		await page.waitForTimeout(150);

		let waitedForLoad = false;
		if (navigated) {
			// Cross-document or same-document (pushState) navigation started.
			// waitForLoadState resolves immediately if load already fired.
			await page.waitForLoadState("load", { timeout: navTimeout }).catch(() => {
				// Timeout or error — continue anyway; the page will be in a
				// partially-loaded state, but we return the current URL so
				// the caller can decide how to proceed.
			});
			waitedForLoad = true;
		} else if (page.url() !== urlBefore) {
			// URL changed without a framenavigated event (possible edge case).
			await page.waitForLoadState("load", { timeout: navTimeout }).catch(() => {
				// Same graceful handling as above.
			});
			waitedForLoad = true;
		} else {
			// No navigation detected yet — allow client-side rerenders /
			// scrolling to settle before reading the snapshot.
			await page.waitForTimeout(settleTimeout);
		}

		// Late-arrival gate: a navigation may have started during the settle
		// timeout (e.g. an async click handler with a 200ms setTimeout).  If
		// we didn't already call waitForLoadState but navigated has since
		// become true (or the URL changed), wait for load now.
		if (!waitedForLoad && (navigated || page.url() !== urlBefore)) {
			await page.waitForLoadState("load", { timeout: navTimeout }).catch(() => {
				// Graceful handling as above.
			});
		}
	} finally {
		page.off("framenavigated", onNav);
	}

	return { navigated, url: page.url() };
}
