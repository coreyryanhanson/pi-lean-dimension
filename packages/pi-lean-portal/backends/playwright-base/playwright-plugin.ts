/**
 * Playwright Plugin Base — shared abstract base for Playwright-based browser backends.
 *
 * Implements the full BrowserPlugin interface using Playwright. Subclasses
 * parameterize engine, user-agent, launch args, capabilities, and install hints.
 *
 * Architecture:
 * - All interaction logic (navigate, snapshot, click, type, scroll, etc.) lives here.
 * - Subclasses are thin: ~30 lines overriding name, capabilities, userAgent,
 *   launchBrowser(), and installHint.
 * - UA capture (probe-then-cache at lazy browser init) is opt-in via captureUserAgent.
 * - Launch errors are wrapped with engine-specific install hints.
 */

import type { Browser, BrowserContext, Locator, Page } from "playwright";
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
} from "../../core/shared/browser-events.js";
import { sessionManager } from "../../core/shared/session-manager.js";
import { checkPage } from "../../core/shared/bot-detection.js";
import { waitForNavigationSettle } from "../../core/shared/nav-settle.js";
import { NAV_SETTLE } from "../../core/shared/browser-data.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { persistSessionState } from "../../core/shared/storage-state.js";
import { loadFullConfig } from "../../core/plugin-config.js";
import type {
	BrowserPlugin,
	PluginCapabilities,
	DialogEvent,
	NavigateResult,
	SnapshotResult,
	InteractionResult,
	ScreenshotResult,
	ConsoleMessagesResult,
	EvaluateResult,
	ResultBase,
	Cookie,
	CookieResult,
	ClearCookiesOptions,
	StorageStateResult,
} from "../../core/plugin-api.js";

// ─── Types ────────────────────────────────────────────────────────

/** A per-task page entry: isolated BrowserContext + Page + optional profile name. */
type PageEntry = {
	context: BrowserContext;
	page: Page;
	profileName?: string;
};

// ─── PlaywrightPluginBase ─────────────────────────────────────────

export abstract class PlaywrightPluginBase implements BrowserPlugin {
	// ── Subclass contract ──────────────────────────────────────

	/** Unique stable identifier (e.g. "chromium", "firefox") */
	abstract readonly name: string;

	abstract readonly capabilities: PluginCapabilities;

	/**
	 * Hardcoded fallback user-agent string.
	 * Used when `captureUserAgent` is false (Chromium) or as fallback when
	 * dynamic capture fails (Firefox).
	 */
	protected abstract get userAgent(): string;

	/**
	 * Launch a Playwright browser instance with engine-specific args.
	 * Called once at lazy init. Must return a connected Browser.
	 * Implementations should use `chromium.launch()` or `firefox.launch()`.
	 */
	protected abstract launchBrowser(): Promise<Browser>;

	/**
	 * Engine-specific install hint, shown when the browser executable
	 * is not installed. Example: "Run: npx playwright install firefox".
	 */
	protected abstract get installHint(): string;

	/**
	 * Set to true to enable UA probe-then-cache at lazy browser init.
	 * When true, the base class opens about:blank, reads navigator.userAgent,
	 * and caches the result for all subsequent contexts.
	 * Chromium keeps this false (uses hardcoded UA).
	 */
	protected readonly captureUserAgent: boolean = false;

	private readonly _debug = process.env.BROWSER_DEBUG === "1";

	private _log(event: string, data: Record<string, unknown>): void {
		if (this._debug) {
			process.stderr.write(`[browser] ${event}: ${JSON.stringify(data)}\n`);
		}
	}

	/**
	 * Wrap an async operation with automatic success/failure debug logging.
	 * Runs the body, then logs based on the result. Body should catch its own
	 * errors and return `{ success: false, error }` — an uncaught throw skips
	 * the log (but shouldn't happen in normal operation).
	 */
	private async _logOp<T extends { success: boolean; error?: string }>(
		op: string,
		ctx: Record<string, unknown>,
		body: () => Promise<T>,
		getExtra?: (result: T) => Record<string, unknown>,
	): Promise<T> {
		const result = await body();
		if (this._debug) {
			this._log(op, {
				...ctx,
				...(getExtra ? getExtra(result) : {}),
				success: result.success,
				...(result.error ? { error: result.error } : {}),
			});
		}
		return result;
	}

	/** Shared browser instance (lazy-initialised) */
	private _browser: Browser | null = null;

	/** Cached user-agent string after dynamic capture (Firefox) */
	private _cachedUA: string | null = null;

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

	/**
	 * Effective user-agent for new contexts.
	 * Returns the cached UA (if captureUserAgent is true and capture succeeded)
	 * or the subclass's hardcoded fallback.
	 */
	protected get effectiveUserAgent(): string {
		return this._cachedUA ?? this.userAgent;
	}

	/**
	 * Launch the browser engine with install-error wrapping.
	 * If the executable is missing, re-throws with the engine-specific install hint.
	 */
	private async _launchWithHint(): Promise<Browser> {
		try {
			return await this.launchBrowser();
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				/Executable doesn't exist|browserType\.launch/i.test(err.message)
			) {
				throw new Error(this.installHint);
			}
			throw err;
		}
	}

	/**
	 * Probe the user-agent from a throwaway about:blank page.
	 * Called once at lazy browser init when `captureUserAgent` is true.
	 * Silently falls back to `this.userAgent` on failure.
	 */
	private async _captureUA(): Promise<void> {
		if (this._cachedUA) return;
		let page: Page | undefined;
		try {
			page = await this._browser!.newPage();
			this._cachedUA = (await page.evaluate(
				() => navigator.userAgent,
			)) as string;
		} catch {
			// Swallow — fallback to this.userAgent
		} finally {
			if (page) await page.close().catch(() => {});
		}
	}

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
		let savedState: { cookies: unknown[]; origins: unknown[] } | undefined;
		if (existing) {
			// ── Save storage state before closing (persistent profiles) ─
			savedState = await this._persistState(taskId, existing.context).catch(
				() => undefined,
			);
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

		// 2. Determine effective storage state:
		//    - The router may pass pre-loaded state via options.storageState
		//    - If not provided, use the state we just saved (in-memory, no disk read)
		//    - This ensures a re-navigate immediately picks up cookies set during
		//      the just-ended session without waiting for a future disk load.
		const effectiveStorageState = options?.storageState ?? savedState;

		// 3. Create fresh context
		const context = await this._newBrowserContext(effectiveStorageState);
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
			this._browser = await this._launchWithHint();

			// Auto-recover from browser crash/disconnect.
			// Extracted as a named function for readability. On disconnect:
			// mark all sessions crashed, clear caches, and null `_browser`
			// so the next navigate() relaunches via lazy-init (which attaches
			// a fresh handler to the new browser).
			const onDisconnected = () => {
				// All Page/Context objects are dead once the Browser
				// disconnects — mark sessions crashed and clear caches.
				for (const tid of this._pages.keys()) {
					sessionManager.updateSession(tid, { crashed: true });
					this._elementCache.delete(tid);
				}
				this._pages.clear();
				this._browser = null;
			};
			this._browser.on("disconnected", onDisconnected);

			// UA capture at first launch (Firefox opt-in)
			if (this.captureUserAgent) {
				await this._captureUA();
			}
		}

		const contextOptions: Record<string, unknown> = {
			viewport: { width: 1280, height: 720 },
			userAgent: this.effectiveUserAgent,
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
			this._log(op, {
				taskId,
				success: false,
				error: "No active session",
			});
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
			this._log(op, {
				taskId,
				success: false,
				error: "No active session",
			});
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

	/**
	 * Save storage state to disk for persistent sessions, returning the
	 * raw state so callers can use it immediately (avoiding a disk read
	 * for the new context).
	 *
	 * Best-effort — failures are logged to stderr and swallowed.
	 * Checked against `session?.persistState` so non-persistent sessions
	 * never trigger disk I/O.
	 *
	 * @param taskId - The task/session ID.
	 * @param context - The Playwright BrowserContext to snapshot.
	 * @returns The raw storage state object (cookies + origins), or undefined
	 *          if the session is non-persistent or the save failed.
	 */
	private async _persistState(
		taskId: string,
		context: BrowserContext,
	): Promise<{ cookies: unknown[]; origins: unknown[] } | undefined> {
		const session = sessionManager.getSession(taskId);
		return persistSessionState(
			session,
			() => context.storageState(),
			"",
			loadFullConfig().browser.maxStorageStateSize,
		);
	}

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

			// Collect recent dialog/crash events (last 10)
			const rawDialogs = getDialogLog(taskId);
			const dialogEvents = rawDialogs.slice(-10).map((d) => ({
				type: d.type,
				message: d.message,
				...(d.handledAs ? { handledAs: d.handledAs } : {}),
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
			const bodyText: string = await page.evaluate(
				"document.body?.innerText || ''",
			);
			// Also grab raw HTML to check for CAPTCHA widget embed codes.
			const html: string = await page.evaluate(
				"document.documentElement?.innerHTML || ''",
			);
			// checkPage handles all three: title (challenge phrases),
			// body (challenge phrases + CDN patterns), and HTML (CAPTCHA embeds).
			return checkPage(title, bodyText, html);
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
				await page.waitForFunction(NAV_SETTLE.domStabilizationJs, {
					timeout: NAV_SETTLE.navTimeoutMs,
				});
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
				pluginName: this.name,
			});

			this._log("navigate", {
				url: page.url(),
				plugin: this.name,
				success: true,
				botDetected: botDetected ?? false,
				elementCount,
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
				plugin: this.name,
				success: false,
				botDetected: botDetected ?? false,
				elementCount: 0,
				error: msg,
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
		const page = this.requirePage(taskId, "snapshot");
		if (!page) {
			return {
				success: false,
				snapshot: "",
				elementCount: 0,
				error: "No active session",
			};
		}

		return this._logOp(
			"snapshot",
			{ taskId },
			async () => {
				const {
					snapshot: snapText,
					elementCount,
					dialogEvents,
				} = await this.takeSnapshot(taskId, page);
				return {
					success: true,
					snapshot: snapText,
					elementCount,
					dialogEvents,
				};
			},
			(r) => ({
				elementCount: r.elementCount,
				dialogEvents: r.dialogEvents.length,
				fingerprint: r.snapshot.slice(0, 16),
			}),
		);
	}

	/**
	 * Resolve a @ref to its page + locator, or return a failed InteractionResult.
	 * Handles the shared session/cache/locator preamble for interaction tools.
	 */
	private _resolveLocator(
		taskId: string,
		ref: string,
		op: string,
	):
		| { page: Page; locator: Locator; node: AriaCachedNode }
		| InteractionResult {
		const page = this.requirePage(taskId, op);
		if (!page) {
			return { success: false, error: "No active session" };
		}

		const key = ref.startsWith("@") ? ref.slice(1) : ref;
		const node = this.getOrCreateCache(taskId).get(key);

		if (!node) {
			this._log(op, {
				taskId,
				ref,
				role: "(none)",
				name: "(none)",
				result: "fail",
				error: `Element ${ref} not found in accessibility tree`,
			});
			return {
				success: false,
				error: `Element ${ref} not found in accessibility tree. Refresh with browser-snapshot first.`,
			};
		}

		const locator = buildLocator(page, node);
		if (!locator) {
			this._log(op, {
				taskId,
				ref,
				role: node.role,
				name: node.name,
				result: "fail",
				error: `Could not build locator (role: ${node.role})`,
			});
			return {
				success: false,
				error: `Could not build locator for ${ref} (role: ${node.role})`,
			};
		}

		return { page, locator, node };
	}

	// ── Interaction ────────────────────────────────────────────

	async click(taskId: string, ref: string): Promise<InteractionResult> {
		const resolved = this._resolveLocator(taskId, ref, "click");
		if (!("page" in resolved)) {
			return resolved;
		}
		const { page, locator, node } = resolved;

		return this._logOp(
			"click",
			{ taskId, ref, role: node.role, name: node.name },
			async () => {
				try {
					const urlBefore = page.url();
					await locator.click({ timeout: 5000 });

					// Wait for potential navigation to settle (replaces fixed sleep)
					const { navigated: _navigated } = await waitForNavigationSettle(
						page,
						urlBefore,
					);

					const newUrl = page.url();
					const newTitle = await page.title();
					sessionManager.updateSession(taskId, {
						currentUrl: newUrl,
						currentTitle: newTitle,
					});

					// Auto-snapshot
					const snapResult = await this.takeSnapshot(taskId, page);

					return {
						success: true,
						newUrl,
						newTitle,
						snapshot: snapResult.snapshot,
						elementCount: snapResult.elementCount,
						dialogEvents: snapResult.dialogEvents,
					};
				} catch (err: unknown) {
					return {
						success: false,
						error: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
		);
	}

	async type(
		taskId: string,
		ref: string,
		text: string,
	): Promise<InteractionResult> {
		const resolved = this._resolveLocator(taskId, ref, "type");
		if (!("page" in resolved)) {
			return resolved;
		}
		const { page, locator, node } = resolved;

		return this._logOp(
			"type",
			{ taskId, ref, role: node.role, name: node.name },
			async () => {
				try {
					await locator.click({ timeout: 5000 }); // Focus first
					await locator.fill(text);

					// Auto-snapshot
					const snapResult = await this.takeSnapshot(taskId, page);

					return {
						success: true,
						snapshot: snapResult.snapshot,
						elementCount: snapResult.elementCount,
						dialogEvents: snapResult.dialogEvents,
					};
				} catch (err: unknown) {
					return {
						success: false,
						error: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
			(r) => ({ elementCount: r.elementCount }),
		);
	}

	async scroll(
		taskId: string,
		direction: "up" | "down",
	): Promise<InteractionResult> {
		const page = this.requirePage(taskId, "scroll");
		if (!page) {
			return { success: false, error: "No active session" };
		}

		return this._logOp(
			"scroll",
			{ taskId, direction },
			async () => {
				try {
					const delta = direction === "down" ? 800 : -800;
					await page.evaluate(
						`window.scrollBy({ top: ${delta}, behavior: "smooth" })`,
					);
					await page.waitForTimeout(200);

					const snapResult = await this.takeSnapshot(taskId, page);

					return {
						success: true,
						snapshot: snapResult.snapshot,
						elementCount: snapResult.elementCount,
						dialogEvents: snapResult.dialogEvents,
					};
				} catch (err: unknown) {
					return {
						success: false,
						error: `Scroll failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
			(r) => ({ elementCount: r.elementCount }),
		);
	}

	async goBack(taskId: string): Promise<InteractionResult> {
		const page = this.requirePage(taskId, "goBack");
		if (!page) {
			return { success: false, error: "No active session" };
		}

		return this._logOp(
			"goBack",
			{ taskId },
			async () => {
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

					return {
						success: true,
						newUrl,
						newTitle,
						snapshot: snapResult.snapshot,
						elementCount: snapResult.elementCount,
						dialogEvents: snapResult.dialogEvents,
					};
				} catch (err: unknown) {
					return {
						success: false,
						error: `GoBack failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
			(r) => ({ elementCount: r.elementCount }),
		);
	}

	async press(taskId: string, key: string): Promise<InteractionResult> {
		const page = this.requirePage(taskId, "press");
		if (!page) {
			return { success: false, error: "No active session" };
		}

		return this._logOp(
			"press",
			{ taskId, key },
			async () => {
				try {
					const urlBefore = page.url();
					await page.keyboard.press(key);

					// Wait for potential navigation to settle (replaces fixed sleep).
					// Shorter nav timeout since Enter-on-link nav is typically fast.
					const { navigated: _navigated } = await waitForNavigationSettle(
						page,
						urlBefore,
						{
							navTimeoutMs: 3000,
						},
					);

					const newUrl = page.url();
					const newTitle = await page.title();
					sessionManager.updateSession(taskId, {
						currentUrl: newUrl,
						currentTitle: newTitle,
					});

					const snapResult = await this.takeSnapshot(taskId, page);

					return {
						success: true,
						newUrl,
						newTitle,
						snapshot: snapResult.snapshot,
						elementCount: snapResult.elementCount,
						dialogEvents: snapResult.dialogEvents,
					};
				} catch (err: unknown) {
					return {
						success: false,
						error: `Press failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
			(r) => ({ elementCount: r.elementCount }),
		);
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

	async evaluate(
		taskId: string,
		expression: string,
		_readOnly?: boolean,
	): Promise<EvaluateResult> {
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
		const entry = this.requireEntry(taskId, "getCookies");
		if (!entry) {
			return { success: false, cookies: [], error: "No active session" };
		}

		return this._logOp(
			"getCookies",
			{ taskId },
			async () => {
				try {
					const cookies = await entry.context.cookies(urls);
					return { success: true, cookies };
				} catch (err: unknown) {
					return {
						success: false,
						cookies: [],
						error: err instanceof Error ? err.message : String(err),
					};
				}
			},
			(r) => ({ count: r.cookies.length }),
		);
	}

	async addCookies(taskId: string, cookies: Cookie[]): Promise<ResultBase> {
		const entry = this.requireEntry(taskId, "addCookies");
		if (!entry) {
			return { success: false, error: "No active session" };
		}

		return this._logOp("addCookies", { taskId }, async () => {
			try {
				await entry.context.addCookies(cookies);
				return { success: true };
			} catch (err: unknown) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		});
	}

	async clearCookies(
		taskId: string,
		options?: ClearCookiesOptions,
	): Promise<ResultBase> {
		const entry = this.requireEntry(taskId, "clearCookies");
		if (!entry) {
			return { success: false, error: "No active session" };
		}

		return this._logOp("clearCookies", { taskId }, async () => {
			try {
				await entry.context.clearCookies({
					...(options?.name ? { name: options.name } : {}),
					...(options?.domain ? { domain: options.domain } : {}),
					...(options?.path ? { path: options.path } : {}),
				});
				return { success: true };
			} catch (err: unknown) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		});
	}

	async getStorageState(taskId: string): Promise<StorageStateResult> {
		const entry = this.requireEntry(taskId, "getStorageState");
		if (!entry) {
			return {
				success: false,
				cookies: [],
				origins: [],
				error: "No active session",
			};
		}

		return this._logOp(
			"getStorageState",
			{ taskId },
			async () => {
				try {
					const state = await entry.context.storageState();
					return {
						success: true,
						cookies: state.cookies,
						origins: state.origins,
					};
				} catch (err: unknown) {
					return {
						success: false,
						cookies: [],
						origins: [],
						error: err instanceof Error ? err.message : String(err),
					};
				}
			},
			(r) => ({ cookies: r.cookies.length, origins: r.origins.length }),
		);
	}

	// ── Per-task cleanup ───────────────────────────────────────

	async cleanup(taskId: string): Promise<void> {
		const entry = this._pages.get(taskId);
		if (!entry) return;

		const { context, page } = entry;

		// ── Auto-save storage state for persistent profiles ──────────
		await this._persistState(taskId, context).catch(() => {});

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
