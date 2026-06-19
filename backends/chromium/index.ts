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
	getConsoleLog as getRawConsoleLog,
	clearConsoleLog,
} from "./browser-events.js";
import { sessionManager } from "../../core/shared/session-manager.js";
import { checkPage } from "../../core/shared/bot-detection.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { saveStorageState } from "../../core/shared/storage-state.js";
import {
	DEFAULT_CAPABILITIES,
	type BrowserPlugin,
	type PluginCapabilities,
	type DialogEvent,
	type NavigateResult,
	type SnapshotResult,
	type InteractionResult,
	type ScreenshotResult,
	type ConsoleMessagesResult,
	type EvaluateResult,
	type ResultBase,
	type Cookie,
	type CookieResult,
	type ClearCookiesOptions,
	type StorageStateResult,
} from "../../core/plugin-api.js";

// ─── Capabilities ──────────────────────────────────────────────────

const CHROMIUM_CAPABILITIES: PluginCapabilities = {
	...DEFAULT_CAPABILITIES,
};

// ─── Types ────────────────────────────────────────────────────────

/** A per-task page entry: isolated BrowserContext + Page + optional profile name. */
type PageEntry = {
	context: BrowserContext;
	page: Page;
	profileName?: string;
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

	/**
	 * Per-task context + page tracking.
	 * Each task gets its own isolated BrowserContext created fresh per navigate.
	 */
	private _pages = new Map<string, PageEntry>();

	/** Per-task element cache (ref → AriaCachedNode) */
	private _elementCache = new Map<string, Map<string, AriaCachedNode>>();

	// ── Lifecycle ───────────────────────────────────────────────

	async init(_config?: Record<string, unknown>): Promise<void> {
		// No config needed — all behavior is hardcoded defaults.
	}

	async cleanupAll(): Promise<void> {
		// Close all pages — each cleanup() handles page + context lifecycle
		for (const taskId of [...this._pages.keys()]) {
			await this.cleanup(taskId).catch(() => {});
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

	// ── Context lifecycle ────────────────────────────────────

	/**
	 * Get or create a BrowserContext and Page for a task.
	 *
	 * Always creates a fresh BrowserContext per navigate, closing any
	 * existing page/context for the task first. Storage state from disk
	 * is applied when a named/session profile is active.
	 */
	private async getOrCreateContext(
		taskId: string,
		options?: {
			storageState?: unknown;
			profileName?: string;
			profileMode?: "none" | "session" | "named";
		},
	): Promise<{
		context: BrowserContext;
		page: Page;
		isNew: boolean;
	}> {
		// 1. Check if task already has a page/context — close it (fresh per navigate)
		const existing = this._pages.get(taskId);
		if (existing) {
			try {
				await existing.page.close();
			} catch {
				/* page may already be closed */
			}
			try {
				await existing.context.close();
			} catch {
				/* context may already be closed */
			}
			this._pages.delete(taskId);
			this._elementCache.delete(taskId);
		}

		// 2. Create fresh context (storage state passed through from router)
		const context = await this._newBrowserContext(options?.storageState);
		const page = await context.newPage();

		const pageEntry: {
			context: BrowserContext;
			page: Page;
			profileName?: string;
		} = { context, page };
		if (options?.profileName) {
			pageEntry.profileName = options.profileName;
		}
		this._pages.set(taskId, pageEntry);
		installDialogHandlers(taskId, page);
		this._elementCache.set(taskId, new Map());

		return { context, page, isNew: true };
	}

	/**
	 * Create a new BrowserContext on the shared browser instance.
	 * Lazily initialises the shared browser if needed.
	 */
	private async _newBrowserContext(
		storageState?: unknown,
	): Promise<BrowserContext> {
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

			// Auto-recover from browser crash/disconnect
			this._browser.on("disconnected", () => {
				this._browser = null;
				for (const tid of this._pages.keys()) {
					sessionManager.updateSession(tid, { crashed: true });
					this._elementCache.delete(tid);
				}
				this._pages.clear();
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
		const traceDir = process.env.BROWSER_TRACE_DIR;
		if (traceDir) {
			try {
				await context.tracing.start({
					screenshots: true,
					snapshots: true,
					sources: true,
				});
			} catch {
				// Best-effort — trace is diagnostic only
			}
		}

		return context;
	}

	private getPage(taskId: string): Page | undefined {
		return this._pages.get(taskId)?.page;
	}

	/**
	 * Returns the page for `taskId` or `null` if there is no active session.
	 * Logs a "No active session" debug event when `op` is provided.
	 */
	private requirePage(taskId: string, op?: string): Page | null {
		const page = this.getPage(taskId);
		if (!page && op) {
			this._log(op, { taskId, success: false, error: "No active session" });
		}
		return page ?? null;
	}

	/**
	 * Returns the full page entry (context + page) for `taskId` or `null`.
	 * Logs a "No active session" debug event when `op` is provided.
	 * Used by cookie/storage methods that also need the BrowserContext.
	 */
	private requireEntry(taskId: string, op?: string): PageEntry | null {
		const entry = this._pages.get(taskId);
		if (!entry && op) {
			this._log(op, { taskId, success: false, error: "No active session" });
		}
		return entry ?? null;
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
	): Promise<{
		snapshot: string;
		elementCount: number;
		dialogEvents: DialogEvent[];
	}> {
		try {
			const snap = await page.ariaSnapshot();
			const parsed = parseSnapshot(snap);

			// Update cache
			this.getOrCreateCache(taskId).clear();
			for (const [ref, node] of parsed.elements) {
				this.getOrCreateCache(taskId).set(ref, node);
			}

			// Collect recent auto-dismissed dialog events (last 10)
			const rawDialogs = getDialogLog(taskId);
			const dialogEvents = rawDialogs.slice(-10).map((d) => ({
				type: d.type,
				message: d.message,
				handledAs: d.handledAs,
			}));

			return {
				snapshot: parsed.text,
				elementCount: parsed.count,
				dialogEvents,
			};
		} catch {
			return {
				snapshot: "(snapshot not available)",
				elementCount: 0,
				dialogEvents: [],
			};
		}
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
			// Also grab raw HTML to check for CAPTCHA widget embed codes.
			const html = await page.evaluate(
				() => document.documentElement?.innerHTML || "",
			);
			// checkPage handles all three: title (challenge phrases),
			// body (challenge phrases + CDN patterns), and HTML (CAPTCHA embeds).
			return checkPage(title, bodyText, html).isBlocked;
		} catch {
			return false;
		}
	}

	// ── Navigation & state ──────────────────────────────────────

	async navigate(
		url: string,
		taskId: string,
		timeoutMs: number = 30_000,
		options?: {
			signal?: AbortSignal;
			storageState?: unknown;
			profileName?: string;
			profileMode?: "none" | "session" | "named";
		},
	): Promise<NavigateResult> {
		const _start = performance.now();
		try {
			const ctxOpts: {
				storageState?: unknown;
				profileName?: string;
				profileMode?: "none" | "session" | "named";
			} = {};
			if (options?.storageState !== undefined)
				ctxOpts.storageState = options.storageState;
			if (options?.profileName !== undefined)
				ctxOpts.profileName = options.profileName;
			if (options?.profileMode !== undefined)
				ctxOpts.profileMode = options.profileMode;
			const { page } = await this.getOrCreateContext(taskId, ctxOpts);

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

			const title = await page.title();

			// Take accessibility snapshot + collect dialog events
			const {
				snapshot: snapshotText,
				elementCount,
				dialogEvents,
			} = await this.takeSnapshot(taskId, page);

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
				elementCount,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				url: page.url(),
				title,
				snapshot: snapshotText,
				elementCount,
				botDetected,
				dialogEvents,
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
		const page = this.requirePage(taskId, "snapshot");
		if (!page) {
			return {
				success: false,
				snapshot: "",
				elementCount: 0,
				error: "No active session",
			};
		}

		try {
			const {
				snapshot: snapText,
				elementCount,
				dialogEvents,
			} = await this.takeSnapshot(taskId, page);

			const dialogBlocks = dialogEvents.length;

			this._log("snapshot", {
				taskId,
				success: true,
				elementCount,
				dialogBlocks,
				fingerprint: snapText.slice(0, 16),
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				snapshot: snapText,
				elementCount,
				dialogEvents,
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
		const page = this.requirePage(taskId, "click");
		if (!page) {
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

		try {
			await locator.click({ timeout: 5000 });
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
				dialogEvents: snapResult.dialogEvents,
			};
		} catch (err: unknown) {
			this._log("click", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
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
		const page = this.requirePage(taskId, "type");
		if (!page) {
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
				result: "fail",
				error: `Could not build locator (role: ${node.role})`,
				time: Math.round(performance.now() - _start),
			});
			return {
				success: false,
				error: `Could not build locator for ${ref}`,
			};
		}

		try {
			await locator.click({ timeout: 5000 }); // Focus first
			await locator.fill(text);

			// Auto-snapshot
			const snapResult = await this.takeSnapshot(taskId, page);

			this._log("type", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
				result: "success",
				elementCount: snapResult.elementCount,
				time: Math.round(performance.now() - _start),
			});

			return {
				success: true,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
				dialogEvents: snapResult.dialogEvents,
			};
		} catch (err: unknown) {
			this._log("type", {
				taskId,
				ref,
				role: node.role,
				name: node.name,
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
		const page = this.requirePage(taskId, "scroll");
		if (!page) {
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
				dialogEvents: snapResult.dialogEvents,
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
		const page = this.requirePage(taskId, "goBack");
		if (!page) {
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
				dialogEvents: snapResult.dialogEvents,
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
		const page = this.requirePage(taskId, "press");
		if (!page) {
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
				dialogEvents: snapResult.dialogEvents,
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
		const page = this.requirePage(taskId);
		if (!page) {
			return { success: false, dataUri: "", error: "No active session" };
		}

		try {
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
		const page = this.requirePage(taskId);
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
		const entry = this.requireEntry(taskId, "getCookies");
		if (!entry) {
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
		const entry = this.requireEntry(taskId, "addCookies");
		if (!entry) {
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
		const entry = this.requireEntry(taskId, "clearCookies");
		if (!entry) {
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
		const entry = this.requireEntry(taskId, "getStorageState");
		if (!entry) {
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
		const entry = this._pages.get(taskId);
		if (!entry) return;

		const { context, page } = entry;

		// ── Auto-save storage state for persistent profiles ──────────
		const session = sessionManager.getSession(taskId);
		if (session?.persistState) {
			try {
				const state = await context.storageState();
				const name = session.profileName ?? "default";
				saveStorageState(name, state);
			} catch (err) {
				console.warn(
					`[pi-browser] Failed to auto-save storage state for profile ` +
						`'${session.profileName ?? "default"}': ` +
						`${err instanceof Error ? err.message : String(err)}. ` +
						"Session state may be lost.",
				);
			}
		}

		// ── Tracing: stop before closing (if enabled) ────────────────
		const traceDir = process.env.BROWSER_TRACE_DIR;
		if (traceDir) {
			try {
				mkdirSync(traceDir, { recursive: true });
				await context.tracing.stop({
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

		// ── Close page + context (always — no ref-counting) ──────────
		try {
			await page.close();
		} catch {
			/* page may already be closed */
		}
		try {
			await context.close();
		} catch {
			/* context may already be closed */
		}
		this._pages.delete(taskId);
		this._elementCache.delete(taskId);
	}
}

export default ChromiumPlugin;
