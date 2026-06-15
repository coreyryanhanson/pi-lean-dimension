/**
 * Chromium Plugin — Native Node backend using Playwright Chromium.
 *
 * This is the port of `backend/playwright-backend.ts` to the BrowserPlugin
 * interface.  All Playwright API calls, CDP supervisor integration, session
 * management, and element caching are preserved from the original.
 *
 * Changes from the module-based backend:
 * - Free functions → class methods implementing BrowserPlugin
 * - Shared `Browser` instance management → `init()` / `cleanupAll()` lifecycle
 * - Result types → unified types from `core/plugin-api.ts`
 * - `backend: "chromium"` field removed (identity is now `this.name`)
 */

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import {
	parseSnapshot,
	buildLocator,
	type AriaCachedNode,
} from "../../core/shared/accessibility-tree.js";
import {
	getDialogLog,
	installDialogHandlers,
	formatDialogLog,
	getConsoleLog as getRawConsoleLog,
	clearConsoleLog,
} from "../../core/shared/cdp-supervisor.js";
import { sessionManager } from "../../core/shared/session-manager.js";
import { checkPage } from "../../core/shared/bot-detection.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
	saveStorageState,
	profileDir,
} from "../../core/shared/storage-state.js";
import { releaseProfileLock } from "../../core/shared/profile-lock.js";
import type {
	BrowserPlugin,
	PluginCapabilities,
	NavigateResult,
	SnapshotResult,
	InteractionResult,
	ScreenshotResult,
	GetImagesResult,
	ConsoleMessagesResult,
	EvaluateResult,
	ResultBase,
	Cookie,
	CookieResult,
	ClearCookiesOptions,
	StorageStateResult,
} from "../../core/plugin-api.js";

// ─── Capabilities ──────────────────────────────────────────────────

const CHROMIUM_CAPABILITIES: PluginCapabilities = {
	supportsFullPageScreenshot: true,
	supportsConsoleCapture: true,
	supportsJavaScriptEvaluate: true,
	supportsBotDetection: true,
	supportsDialogAutoDismissal: true,
	supportsAbortSignal: true,
	engine: "chromium",
};

// ─── ChromiumPlugin ───────────────────────────────────────────────

export class ChromiumPlugin implements BrowserPlugin {
	readonly name = "chromium";
	readonly capabilities = CHROMIUM_CAPABILITIES;

	/** Enable structured debug logging via BROWSER_DEBUG env var */
	private readonly _debug = process.env.BROWSER_DEBUG === "1";

	/** Log a structured debug line to stderr when BROWSER_DEBUG=1 */
	private _log(event: string, data: Record<string, unknown>): void {
		if (this._debug) {
			process.stderr.write(`[browser] ${event}: ${JSON.stringify(data)}\n`);
		}
	}

	/** Shared browser instance (lazy-initialised) */
	private _browser: Browser | null = null;

	/** Per-task context + page */
	private _contexts = new Map<
		string,
		{ context: BrowserContext; page: Page }
	>();

	/** Per-task element cache (ref → AriaCachedNode) */
	private _elementCache = new Map<string, Map<string, AriaCachedNode>>();

	/** Timeout (ms) for verify-click occlusion fallback. Default: 1500. */
	private _verifyClickTimeoutMs = 1500;

	// ── Lifecycle ───────────────────────────────────────────────

	async init(config?: Record<string, unknown>): Promise<void> {
		// Accept verifyClickTimeoutMs from config for Experiment 2
		if (config?.verifyClickTimeoutMs != null) {
			const v = Number(config.verifyClickTimeoutMs);
			if (Number.isFinite(v) && v > 0) {
				this._verifyClickTimeoutMs = v;
			}
		}
	}

	async cleanupAll(): Promise<void> {
		for (const taskId of this._contexts.keys()) {
			await this.cleanup(taskId);
		}
		if (this._browser) {
			try {
				await this._browser.close();
			} catch {
				/* browser may already be closed */
			}
			this._browser = null;
		}
	}

	// ── Internal helpers ───────────────────────────────────────

	private async getOrCreateContext(
		taskId: string,
		storageState?: unknown,
	): Promise<{
		context: BrowserContext;
		page: Page;
		isNew: boolean;
	}> {
		const existing = this._contexts.get(taskId);
		if (existing) {
			// Check if the page is still alive (not closed/crashed)
			if (existing.page.isClosed()) {
				try {
					const newPage = await existing.context.newPage();
					installDialogHandlers(taskId, newPage);
					existing.page = newPage;
				} catch {
					// Context is also dead — remove and recreate
					this._contexts.delete(taskId);
					this._elementCache.delete(taskId);
				}
			} else {
				return { ...existing, isNew: false };
			}
		}

		// Lazy-init the shared browser
		if (!this._browser) {
			this._browser = await chromium.launch({
				headless: true,
				args: [
					"--no-sandbox",
					"--disable-setuid-sandbox",
					"--disable-dev-shm-usage",
					"--disable-gpu",
				],
			});
			sessionManager.setPlaywrightBrowser(this._browser);

			// Auto-recover from browser crash/disconnect
			this._browser.on("disconnected", () => {
				this._browser = null;
				sessionManager.setPlaywrightBrowser(null);
				for (const tid of this._contexts.keys()) {
					sessionManager.updateSession(tid, { crashed: true });
					this._elementCache.delete(tid);
				}
				this._contexts.clear();
			});
		}

		const contextOptions: Record<string, unknown> = {
			viewport: { width: 1280, height: 720 },
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		};

		// Apply storage state (cookies + localStorage) for profile restoration
		if (storageState !== undefined) {
			contextOptions.storageState = storageState;
		}

		const context = await this._browser.newContext(contextOptions);

		// Start Playwright trace capture if BROWSER_TRACE_DIR is set.
		// Traces include screenshots, DOM snapshots, and source for debugging.
		const traceDir = process.env.BROWSER_TRACE_DIR;
		if (traceDir) {
			try {
				await context.tracing.start({
					screenshots: true,
					snapshots: true,
					sources: true,
				});
				this._log("tracing", {
					taskId,
					action: "start",
					dir: traceDir,
				});
			} catch {
				// Best-effort — trace is diagnostic only
			}
		}

		const page = await context.newPage();
		this._contexts.set(taskId, { context, page });
		this._elementCache.set(taskId, new Map());

		// Install dialog handlers (auto-dismiss JS alerts/confirms/prompts)
		installDialogHandlers(taskId, page);

		// Update session manager with the context
		const session = sessionManager.getSession(taskId);
		if (session) {
			session.context = context;
		}

		return { context, page, isNew: true };
	}

	private getPage(taskId: string): Page | undefined {
		return this._contexts.get(taskId)?.page;
	}

	/**
	 * Public interface — returns null when no cache exists (no session yet).
	 * Does NOT auto-create an empty cache.
	 */
	getElementCache(taskId: string): Map<string, AriaCachedNode> | null {
		return this._elementCache.get(taskId) ?? null;
	}

	/**
	 * Private internal cache accessor — auto-creates an empty cache on miss
	 * so internal callers (takeSnapshot, etc.) never need null checks.
	 */
	private getOrCreateCache(taskId: string): Map<string, AriaCachedNode> {
		let cache = this._elementCache.get(taskId);
		if (!cache) {
			cache = new Map();
			this._elementCache.set(taskId, cache);
		}
		return cache;
	}

	/** Take an accessibility snapshot and update the element cache. */
	private async takeSnapshot(
		taskId: string,
		page: Page,
	): Promise<{ snapshot: string; elementCount: number }> {
		try {
			const snap = await page.ariaSnapshot();
			const parsed = parseSnapshot(snap);

			// Update cache
			this.getOrCreateCache(taskId).clear();
			for (const [ref, node] of parsed.elements) {
				this.getOrCreateCache(taskId).set(ref, node);
			}

			// Check for auto-dismissed dialogs
			const dialogInfo = formatDialogLog(taskId);
			const text = dialogInfo
				? parsed.text + "\n\n--- Auto-dismissed dialogs ---\n" + dialogInfo
				: parsed.text;

			return { snapshot: text, elementCount: parsed.count };
		} catch {
			return { snapshot: "(snapshot not available)", elementCount: 0 };
		}
	}

	/**
	 * Check if a locator is visually obscured by another element (modal, overlay).
	 *
	 * Uses `document.elementFromPoint()` at the locator's center to verify the
	 * target is the top-most element at that coordinate. Returns the occlusion
	 * error if obscured, or null if clear to proceed.
	 */
	private async checkOcclusion(
		locator: import("playwright").Locator,
		ref: string,
	): Promise<{ success: false; error: string } | null> {
		try {
			// Scroll element into view with center alignment so the center
			// point is within the viewport for elementFromPoint() checking.
			// Then check occlusion in a single evaluate to avoid layout races.
			const isObscured = await locator.evaluate((el: Element) => {
				el.scrollIntoView({ block: "center", inline: "nearest" });
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return true;
				const x = rect.left + rect.width / 2;
				const y = rect.top + rect.height / 2;
				if (
					y < 0 ||
					y > (window.innerHeight || document.documentElement.clientHeight) ||
					x < 0 ||
					x > (window.innerWidth || document.documentElement.clientWidth)
				) {
					return true;
				}
				const topEl = document.elementFromPoint(x, y);
				if (!topEl) return true;
				// If topEl is our element or a descendant, we're clear
				return !(topEl === el || el.contains(topEl));
			});

			if (isObscured) {
				const occlusionResult = {
					success: false as const,
					error:
						`Element ${ref} is obscured by another element (likely a modal/overlay). ` +
						`Try pressing Escape (browser-press key="Escape") to dismiss the overlay, then retry.`,
				};

				this._log("occlusion", {
					ref,
					isObscured: true,
					verifyClick: "skipped",
					reason: "elementFromPoint",
				});

				return occlusionResult;
			}

			this._log("occlusion", {
				ref,
				isObscured: false,
				verifyClick: "skipped",
				reason: "elementFromPoint",
			});
		} catch {
			// If the check itself fails, proceed with click (fail-safe)
			this._log("occlusion", {
				ref,
				isObscured: false,
				verifyClick: "skipped",
				reason: "elementFromPoint",
			});
		}
		return null;
	}

	/**
	 * Check for bot/anti-automation detection signals via shared utility.
	 *
	 * Checks the page TITLE against specific challenge phrases (avoids
	 * false positives like Wikipedia mentioning "captcha"), and additionally
	 * checks the BODY against high-specificity patterns that are unique to
	 * CDN block pages (Akamai reference IDs, Cloudflare challenge URLs, etc.).
	 */
	private async checkBotDetection(page: Page): Promise<boolean> {
		try {
			const title = await page.title();
			const bodyText = await page.evaluate(
				() => document.body?.innerText || "",
			);
			// checkPage handles both: title gets only challenge phrases,
			// body also gets high-specificity CDN patterns via BODY_ONLY_SIGNALS.
			return checkPage(title, bodyText).isBlocked;
		} catch {
			return false;
		}
	}

	// ── Navigation & state ──────────────────────────────────────

	async navigate(
		url: string,
		taskId: string,
		timeoutMs: number = 30_000,
		options?: { signal?: AbortSignal; storageState?: unknown },
	): Promise<NavigateResult> {
		const _start = performance.now();
		try {
			const { page } = await this.getOrCreateContext(
				taskId,
				options?.storageState,
			);

			// Wire up abort
			if (options?.signal) {
				options.signal.addEventListener(
					"abort",
					() => {
						page.close().catch(() => {});
					},
					{ once: true },
				);
			}

			// Navigate (with one retry for transient network errors)
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await page.goto(url, {
						// "load" instead of "networkidle" so Cloudflare challenge pages
						// finish loading their HTML; "networkidle" hangs on challenge
						// pages that keep polling via XHR.
						waitUntil: "load",
						timeout: timeoutMs,
					});
					break; // success
				} catch (gotoErr: unknown) {
					const lastError =
						gotoErr instanceof Error ? gotoErr.message : String(gotoErr);
					const isTransient =
						/net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|Interrupted/i.test(
							lastError,
						);
					if (!isTransient || attempt > 0) {
						throw gotoErr;
					}
					await page.waitForTimeout(2000);
				}
			}

			// Wait for dynamic content to settle
			try {
				await page.waitForFunction(
					() =>
						new Promise<boolean>((resolve) => {
							const count = document.querySelectorAll("*").length;
							setTimeout(() => {
								resolve(
									document.querySelectorAll("*").length === count ||
										count > 5000,
								);
							}, 400);
						}),
					{ timeout: 5000 },
				);
			} catch {
				// Stabilization timed out — proceed with whatever is rendered
			}

			// Check for bot detection (Cloudflare, etc.) — AFTER DOM stabilizes
			// so JS-injected challenge content is present when we check.
			const botDetected = await this.checkBotDetection(page);

			// Take accessibility snapshot
			const snap = await page.ariaSnapshot();
			const parsed = parseSnapshot(snap);

			// Cache elements for this session
			this.getOrCreateCache(taskId).clear();
			for (const [ref, node] of parsed.elements) {
				this.getOrCreateCache(taskId).set(ref, node);
			}

			const title = await page.title();

			// Check for auto-dismissed dialogs
			const dialogInfo = formatDialogLog(taskId);
			const snapshotText = dialogInfo
				? parsed.text + "\n\n--- Auto-dismissed dialogs ---\n" + dialogInfo
				: parsed.text;

			// Update session manager
			sessionManager.updateSession(taskId, {
				currentUrl: page.url(),
				currentTitle: title,
				pluginName: "chromium",
			});

			this._log("navigate", {
				url: page.url(),
				plugin: "chromium",
				success: true,
				botDetected: botDetected ?? false,
				elementCount: parsed.count,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				url: page.url(),
				title,
				snapshot: snapshotText,
				elementCount: parsed.count,
				botDetected,
			};
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);

			// Try to check page content even on error — challenge pages may have
			// loaded their HTML before the timeout.  Without this, Cloudflare
			// challenges that hang on "load" (rare) or other failures silently
			// swallow the bot-detection signal.
			let pageBotDetected = false;
			try {
				const currentPage = this.getPage(taskId);
				if (currentPage) {
					pageBotDetected = await this.checkBotDetection(currentPage);
				}
			} catch {
				// page may not exist
			}

			const botDetected =
				pageBotDetected ||
				msg.includes("captcha") ||
				msg.includes("cloudflare") ||
				msg.includes("blocked") ||
				msg.includes("challenge");

			this._log("navigate", {
				url,
				plugin: "chromium",
				success: false,
				botDetected: botDetected ?? false,
				elementCount: 0,
				error: msg,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: false,
				url,
				title: "",
				snapshot: "",
				elementCount: 0,
				botDetected,
				error: msg,
			};
		}
	}

	async snapshot(taskId: string): Promise<SnapshotResult> {
		const _start = performance.now();
		const page = this.getPage(taskId);
		if (!page) {
			this._log("snapshot", {
				taskId,
				success: false,
				elementCount: 0,
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});

			return {
				success: false,
				snapshot: "",
				elementCount: 0,
				error: "No active session",
			};
		}

		try {
			const snap = await page.ariaSnapshot();
			const parsed = parseSnapshot(snap);

			// Update cache
			this.getOrCreateCache(taskId).clear();
			for (const [ref, node] of parsed.elements) {
				this.getOrCreateCache(taskId).set(ref, node);
			}

			// Count auto-dismissed dialog entries for the log
			// The dialog info is NOT embedded in parsed.text in this path
			// (unlike takeSnapshot/navigate which format it), so check via supervisor.
			const dialogBlocks = getDialogLog(taskId).length;

			this._log("snapshot", {
				taskId,
				success: true,
				elementCount: parsed.count,
				dialogBlocks,
				fingerprint: parsed.text.slice(0, 16),
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				snapshot: parsed.text,
				elementCount: parsed.count,
			};
		} catch (err: unknown) {
			this._log("snapshot", {
				taskId,
				success: false,
				elementCount: 0,
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});

			return {
				success: false,
				snapshot: "",
				elementCount: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ── Interaction ────────────────────────────────────────────

	async click(taskId: string, ref: string): Promise<InteractionResult> {
		const _start = performance.now();
		const phases: Record<string, number> = {};
		const page = this.getPage(taskId);
		if (!page) {
			this._log("click", {
				taskId,
				ref,
				role: "(none)",
				name: "(none)",
				occlusionCheck: "skipped",
				result: "fail",
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return { success: false, error: "No active session" };
		}

		const key = ref.startsWith("@") ? ref.slice(1) : ref;
		const node = this.getOrCreateCache(taskId).get(key);

		if (!node) {
			this._log("click", {
				taskId,
				ref,
				role: "(none)",
				name: "(none)",
				occlusionCheck: "skipped",
				result: "fail",
				error: `Element ${ref} not found in accessibility tree`,
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `Element ${ref} not found in accessibility tree. Refresh with browser-snapshot first.`,
			};
		}

		const locator = buildLocator(page, node);
		if (!locator) {
			this._log("click", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
				occlusionCheck: "skipped",
				result: "fail",
				error: `Could not build locator (role: ${node.role})`,
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `Could not build locator for ${ref} (role: ${node.role})`,
			};
		}
		phases.locate = Math.round(performance.now() - _start);

		// Fast occlusion check — if elementFromPoint says blocked, verify with a
		// short click attempt to eliminate false positives (Reddit's close button
		// uses pointer-events: none child elements that confuse elementFromPoint).
		const occlusionCheck = await this.checkOcclusion(locator, ref);
		phases.occlusion = Math.round(performance.now() - _start);

		let occlusionStatus = "verified";
		if (occlusionCheck) {
			// Element appears obscured — verify with a quick click attempt
			try {
				await locator.click({ timeout: this._verifyClickTimeoutMs });
				// Click succeeded — occlusion was a false positive, continue below
				occlusionStatus = "blocked_verify_ok";
			} catch {
				// Confirmed obscured — return the helpful error
				this._log("click", {
					taskId,
					ref,
					role: node.role,
					name: node.name,
					occlusionCheck: "blocked",
					result: "fail",
					error: `Occlusion blocked: ${occlusionCheck.error}`,
					timings: phases,
					time: Math.round(performance.now() - _start),
				});
				return occlusionCheck;
			}
		}

		try {
			if (!occlusionCheck) {
				await locator.click({ timeout: 5000 });
			}
			phases.click = Math.round(performance.now() - _start);

			// Wait for potential navigation
			await page.waitForTimeout(300);
			phases.wait = Math.round(performance.now() - _start);

			const newUrl = page.url();
			const newTitle = await page.title();
			sessionManager.updateSession(taskId, {
				currentUrl: newUrl,
				currentTitle: newTitle,
			});

			// Auto-snapshot
			const snapResult = await this.takeSnapshot(taskId, page);
			phases.snapshot = Math.round(performance.now() - _start);

			this._log("click", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
				occlusionCheck: occlusionStatus,
				result: "success",
				timings: phases,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				newUrl,
				newTitle,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
			this._log("click", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
				occlusionCheck: occlusionStatus,
				result: "fail",
				error: err instanceof Error ? err.message : String(err),
				timings: phases,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: false,
				error: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async type(
		taskId: string,
		ref: string,
		text: string,
	): Promise<InteractionResult> {
		const _start = performance.now();
		const page = this.getPage(taskId);
		if (!page) {
			this._log("type", {
				taskId,
				ref,
				role: "(none)",
				name: "(none)",
				occlusionCheck: "skipped",
				result: "fail",
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return { success: false, error: "No active session" };
		}

		const key = ref.startsWith("@") ? ref.slice(1) : ref;
		const node = this.getOrCreateCache(taskId).get(key);

		if (!node) {
			this._log("type", {
				taskId,
				ref,
				role: "(none)",
				name: "(none)",
				occlusionCheck: "skipped",
				result: "fail",
				error: `Element ${ref} not found in accessibility tree`,
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `Element ${ref} not found in accessibility tree. Refresh with browser-snapshot first.`,
			};
		}

		const locator = buildLocator(page, node);
		if (!locator) {
			this._log("type", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
				occlusionCheck: "skipped",
				result: "fail",
				error: `Could not build locator (role: ${node.role})`,
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `Could not build locator for ${ref}`,
			};
		}

		// Fast occlusion check — verify with short click if flagged
		const occlusionCheck = await this.checkOcclusion(locator, ref);

		let occlusionStatus = "verified";
		if (occlusionCheck) {
			try {
				await locator.click({ timeout: this._verifyClickTimeoutMs });
				occlusionStatus = "blocked_verify_ok";
			} catch {
				this._log("type", {
					taskId,
					ref,
					role: node.role,
					name: node.name,
					occlusionCheck: "blocked",
					result: "fail",
					error: `Occlusion blocked: ${occlusionCheck.error}`,
					time: Math.round(performance.now() - _start),
				});
				return occlusionCheck;
			}
		}

		try {
			if (!occlusionCheck) {
				await locator.click({ timeout: 5000 }); // Focus first
			}
			await locator.fill(text);

			// Auto-snapshot
			const snapResult = await this.takeSnapshot(taskId, page);

			this._log("type", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
				occlusionCheck: occlusionStatus,
				result: "success",
				elementCount: snapResult.elementCount,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
			this._log("type", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
				occlusionCheck: occlusionStatus,
				result: "fail",
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async scroll(
		taskId: string,
		direction: "up" | "down",
	): Promise<InteractionResult> {
		const _start = performance.now();
		const page = this.getPage(taskId);
		if (!page) {
			this._log("scroll", {
				taskId,
				direction,
				success: false,
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return { success: false, error: "No active session" };
		}

		try {
			const delta = direction === "down" ? 800 : -800;
			await page.evaluate((d: number) => {
				window.scrollBy({ top: d, behavior: "smooth" });
			}, delta);
			await page.waitForTimeout(200);

			const snapResult = await this.takeSnapshot(taskId, page);

			this._log("scroll", {
				taskId,
				direction,
				success: true,
				elementCount: snapResult.elementCount,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
			this._log("scroll", {
				taskId,
				direction,
				success: false,
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `Scroll failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async goBack(taskId: string): Promise<InteractionResult> {
		const _start = performance.now();
		const page = this.getPage(taskId);
		if (!page) {
			this._log("goBack", {
				taskId,
				success: false,
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return { success: false, error: "No active session" };
		}

		try {
			await page.goBack({ waitUntil: "networkidle" });
			await page.waitForTimeout(300);

			const newUrl = page.url();
			const newTitle = await page.title();
			sessionManager.updateSession(taskId, {
				currentUrl: newUrl,
				currentTitle: newTitle,
			});

			const snapResult = await this.takeSnapshot(taskId, page);

			this._log("goBack", {
				taskId,
				success: true,
				elementCount: snapResult.elementCount,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				newUrl,
				newTitle,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
			this._log("goBack", {
				taskId,
				success: false,
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `GoBack failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async press(taskId: string, key: string): Promise<InteractionResult> {
		const _start = performance.now();
		const page = this.getPage(taskId);
		if (!page) {
			this._log("press", {
				taskId,
				key,
				success: false,
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return { success: false, error: "No active session" };
		}

		try {
			await page.keyboard.press(key);
			await page.waitForTimeout(200);

			const snapResult = await this.takeSnapshot(taskId, page);

			this._log("press", {
				taskId,
				key,
				success: true,
				elementCount: snapResult.elementCount,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
			this._log("press", {
				taskId,
				key,
				success: false,
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `Press failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	// ── Media ──────────────────────────────────────────────────

	async screenshot(
		taskId: string,
		options?: { fullPage?: boolean },
	): Promise<ScreenshotResult> {
		const page = this.getPage(taskId);
		if (!page) {
			return { success: false, dataUri: "", error: "No active session" };
		}

		try {
			// Constrain viewport width for manageable screenshots
			const currentViewport = page.viewportSize();
			if (currentViewport && currentViewport.width > 1024) {
				await page.setViewportSize({
					width: 1024,
					height: currentViewport.height,
				});
			}

			const buffer = await page.screenshot({
				type: "jpeg",
				quality: 80,
				fullPage: options?.fullPage ?? false,
			});
			const base64 = buffer.toString("base64");
			const dataUri = `data:image/jpeg;base64,${base64}`;

			return { success: true, dataUri };
		} catch (err: unknown) {
			return {
				success: false,
				dataUri: "",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async getImages(taskId: string): Promise<GetImagesResult> {
		const page = this.getPage(taskId);
		if (!page) {
			return {
				success: false,
				images: [],
				error: "No active session",
			};
		}

		try {
			const images = await page.evaluate(() => {
				return Array.from(document.querySelectorAll("img"))
					.map((img) => ({
						src: img.src,
						alt: img.alt || "",
						width: img.naturalWidth || img.width || 0,
						height: img.naturalHeight || img.height || 0,
					}))
					.filter((img) => !img.src.startsWith("data:"));
			});

			return { success: true, images };
		} catch (err: unknown) {
			return {
				success: false,
				images: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ── Console & eval ─────────────────────────────────────────

	async getConsoleMessages(taskId: string): Promise<ConsoleMessagesResult> {
		const raw = getRawConsoleLog(taskId);
		return {
			success: true,
			messages: raw.map((c) => ({ type: c.type, text: c.text })),
		};
	}

	async clearConsole(taskId: string): Promise<void> {
		clearConsoleLog(taskId);
	}

	async evaluate(taskId: string, expression: string): Promise<EvaluateResult> {
		const page = this.getPage(taskId);
		if (!page) {
			return { success: false, error: "No active session" };
		}

		try {
			const result = await page.evaluate(expression);
			return { success: true, result };
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ── Cookies & storage state ───────────────────────────────

	async getCookies(taskId: string, urls?: string[]): Promise<CookieResult> {
		const _start = performance.now();
		const entry = this._contexts.get(taskId);
		if (!entry) {
			this._log("getCookies", {
				taskId,
				success: false,
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return { success: false, cookies: [], error: "No active session" };
		}

		try {
			const cookies = await entry.context.cookies(urls);
			this._log("getCookies", {
				taskId,
				success: true,
				count: cookies.length,
				time: Math.round(performance.now() - _start),
			});
			return { success: true, cookies };
		} catch (err: unknown) {
			this._log("getCookies", {
				taskId,
				success: false,
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				cookies: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async addCookies(taskId: string, cookies: Cookie[]): Promise<ResultBase> {
		const _start = performance.now();
		const entry = this._contexts.get(taskId);
		if (!entry) {
			this._log("addCookies", {
				taskId,
				success: false,
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return { success: false, error: "No active session" };
		}

		try {
			await entry.context.addCookies(cookies);
			this._log("addCookies", {
				taskId,
				success: true,
				count: cookies.length,
				time: Math.round(performance.now() - _start),
			});
			return { success: true };
		} catch (err: unknown) {
			this._log("addCookies", {
				taskId,
				success: false,
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async clearCookies(
		taskId: string,
		options?: ClearCookiesOptions,
	): Promise<ResultBase> {
		const _start = performance.now();
		const entry = this._contexts.get(taskId);
		if (!entry) {
			this._log("clearCookies", {
				taskId,
				success: false,
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return { success: false, error: "No active session" };
		}

		try {
			await entry.context.clearCookies({
				...(options?.name ? { name: options.name } : {}),
				...(options?.domain ? { domain: options.domain } : {}),
				...(options?.path ? { path: options.path } : {}),
			});
			this._log("clearCookies", {
				taskId,
				success: true,
				time: Math.round(performance.now() - _start),
			});
			return { success: true };
		} catch (err: unknown) {
			this._log("clearCookies", {
				taskId,
				success: false,
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async getStorageState(taskId: string): Promise<StorageStateResult> {
		const _start = performance.now();
		const entry = this._contexts.get(taskId);
		if (!entry) {
			this._log("getStorageState", {
				taskId,
				success: false,
				error: "No active session",
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				cookies: [],
				origins: [],
				error: "No active session",
			};
		}

		try {
			const state = await entry.context.storageState();
			this._log("getStorageState", {
				taskId,
				success: true,
				cookies: state.cookies.length,
				origins: state.origins.length,
				time: Math.round(performance.now() - _start),
			});
			return {
				success: true,
				cookies: state.cookies,
				origins: state.origins,
			};
		} catch (err: unknown) {
			this._log("getStorageState", {
				taskId,
				success: false,
				error: err instanceof Error ? err.message : String(err),
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				cookies: [],
				origins: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ── Per-task cleanup ───────────────────────────────────────

	async cleanup(taskId: string): Promise<void> {
		const entry = this._contexts.get(taskId);
		if (entry) {
			// ── Auto-save storage state if session is persistent ──────
			const session = sessionManager.getSession(taskId);
			if (session?.persistState) {
				try {
					const state = await entry.context.storageState();
					const name = session.profileName ?? "default";
					const saved = saveStorageState(name, state);
					if (saved) {
						// Release profile lock so other sessions can use it
						try {
							releaseProfileLock(profileDir(name), taskId);
						} catch {
							/* best-effort */
						}
					}
				} catch (err) {
					console.warn(
						`[pi-browser] Failed to auto-save storage state for profile ` +
							`'${session.profileName ?? "default"}': ` +
							`${err instanceof Error ? err.message : String(err)}. ` +
							"Session state may be lost.",
					);
				}
			}

			// Stop and save Playwright trace if BROWSER_TRACE_DIR is set.
			// Traces are stored as trace-{taskId}-{timestamp}.zip.
			const traceDir = process.env.BROWSER_TRACE_DIR;
			if (traceDir) {
				try {
					mkdirSync(traceDir, { recursive: true });
					await entry.context.tracing.stop({
						path: join(traceDir, `trace-${taskId}-${Date.now()}.zip`),
					});
					this._log("tracing", {
						taskId,
						action: "stop",
						dir: traceDir,
					});
				} catch {
					// Best-effort — trace is diagnostic only
				}
			}
			try {
				await entry.page.close();
			} catch {
				/* page may already be closed */
			}
			try {
				await entry.context.close();
			} catch {
				/* context may already be closed */
			}
			this._contexts.delete(taskId);
			this._elementCache.delete(taskId);
		}
	}
}
