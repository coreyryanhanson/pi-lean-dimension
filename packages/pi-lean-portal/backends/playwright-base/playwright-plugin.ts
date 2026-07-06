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

import type { Browser, BrowserContext, BrowserServer, Page } from "playwright";
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
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { saveStorageState } from "../../core/shared/storage-state.js";
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

	/** Advertised capabilities */
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

	/**
	 * Cached CDP endpoint for external attach (BrowserGym Mode A, chromium
	 * family). Populated by subclasses in `onBrowserLaunched()`. Remains
	 * `null` for the firefox family (which uses `_wsEndpoint` instead) and
	 * other backends that don't expose one.
	 *
	 * Reset to `null` on browser disconnect so a re-launch re-discovers.
	 */
	protected _cdpEndpoint: string | null = null;

	/**
	 * BrowserServer handle for the `launchServer` path (firefox family).
	 * Set by subclasses inside `launchBrowser()` when they opt into
	 * `firefox.launchServer()` / `browser_type.launch_server()`. When
	 * non-null, the base treats the connected `Browser` as a *client* of
	 * this server: a disconnect triggers a reconnect (`_reconnectBrowser()`)
	 * instead of a relaunch, and `cleanupAll()` closes both the Browser
	 * and the BrowserServer.
	 *
	 * Remains `null` for default-path backends (chromium, plain firefox) —
	 * their lifecycle is unchanged.
	 */
	protected _browserServer: BrowserServer | null = null;

	/**
	 * Cached WebSocket endpoint for the `launchServer` path. Set by
	 * subclasses alongside `_browserServer`. Exposed to external clients
	 * via the subclass's `getWsEndpoint()` implementation. Reset to
	 * `null` when the BrowserServer closes.
	 */
	protected _wsEndpoint: string | null = null;

	// ── Private state ──────────────────────────────────────────

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
	 * In-flight reconnect promise for the launchServer path. Set by the
	 * `disconnected` handler when it kicks off `_reconnectBrowser()`;
	 * cleared when the promise settles. `_newBrowserContext` awaits it
	 * (instead of relaunching) so a navigate that races in during the
	 * reconnect window reuses the reconnected Browser rather than
	 * launching a second BrowserServer and leaking the first.
	 */
	private _reconnectPromise: Promise<Browser> | null = null;

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

		// launchServer path: the connected Browser is just a client of the
		// server — closing it does NOT close the server. Close the server
		// explicitly so the browser process exits. No-op for default-path
		// backends (the field stays null).
		if (this._browserServer) {
			try {
				await this._browserServer.close();
			} catch {
				/* server may already be closed */
			}
			this._browserServer = null;
			this._wsEndpoint = null;
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

	/**
	 * Post-launch hook called once after the shared browser successfully
	 * launches (and the `disconnected` recovery handler is wired). Runs
	 * before any context/page is created on the new browser.
	 *
	 * Subclasses override this to perform once-per-launch setup — most
	 * notably the chromium plugin discovers the `--remote-debugging-port=0`
	 * endpoint via `ss -tlnp` and caches it in `_cdpEndpoint` so
	 * `getCdpEndpoint()` can return it synchronously.
	 *
	 * Default: no-op. Failures thrown from overrides are caught and
	 * logged by the caller (`_newBrowserContext`) so a port-scan glitch
	 * never blocks normal browsing.
	 */
	protected async onBrowserLaunched(): Promise<void> {
		// default: no-op
	}

	/**
	 * Reconnect to the BrowserServer after the connected `Browser`
	 * disconnects (crash, network drop). Only meaningful for the
	 * `launchServer` path — the server stays up across Browser
	 * disconnects, so a fresh `connect(wsEndpoint)` recovers without
	 * relaunching.
	 *
	 * Default implementation throws: only `launchServer` subclasses
	 * (firefox Node, firefox-py adapter) override this. The base never
	 * calls it when `_browserServer` is null, so default-path backends
	 * never hit the throw.
	 */
	protected async _reconnectBrowser(): Promise<Browser> {
		throw new Error(
			`${this.name}: _reconnectBrowser() not implemented ` +
				"(launchServer path not active)",
		);
	}

	/**
	 * Wire the `disconnected` handler on a freshly-launched or
	 * freshly-reconnected `Browser`. Extracted from `_newBrowserContext`
	 * so the launchServer reconnect path can re-wire it on the new
	 * connection without duplicating the recovery logic.
	 *
	 * Behavior split by `_browserServer`:
	 * - **Default path** (`_browserServer === null`): null `_browser` and
	 *   `_cdpEndpoint`, mark in-flight sessions crashed. The next call
	 *   re-launches from scratch.
	 * - **launchServer path** (`_browserServer !== null`): the server is
	 *   still up — mark in-flight sessions crashed (their contexts are
	 *   gone with the disconnected Browser), null `_browser`, then
	 *   attempt `_reconnectBrowser()`. On success, install the new
	 *   Browser and re-wire this handler on it. On failure, leave
	 *   `_browser` null; `_browserServer` stays until its own `close`
	 *   event or `cleanupAll()`.
	 */
	private _wireDisconnectHandler(browser: Browser): void {
		browser.on("disconnected", () => {
			// In-flight sessions are dead regardless of path — their
			// contexts lived on the just-disconnected Browser.
			for (const tid of this._pages.keys()) {
				sessionManager.updateSession(tid, { crashed: true });
				this._elementCache.delete(tid);
			}
			this._pages.clear();
			this._browser = null;

			if (this._browserServer) {
				// launchServer path: try to reconnect to the still-up server.
				// Track the promise so a navigate racing in during the
				// reconnect window awaits it (in `_newBrowserContext`)
				// instead of relaunching a second BrowserServer. Fire-and-
				// forget with respect to the disconnect handler itself —
				// in-flight callers already saw their pages die; the
				// reconnect services *future* sessions.
				const reconnectPromise = this._reconnectBrowser();
				this._reconnectPromise = reconnectPromise;
				reconnectPromise
					.then((reconnected) => {
						// Only accept if this is still the pending reconnect
						// (not superseded by a relaunch or cleanup).
						if (this._reconnectPromise === reconnectPromise) {
							this._browser = reconnected;
							this._wireDisconnectHandler(reconnected);
							this._reconnectPromise = null;
							this._log("reconnect", {
								plugin: this.name,
								success: true,
							});
						}
					})
					.catch((err: unknown) => {
						if (this._reconnectPromise === reconnectPromise) {
							this._reconnectPromise = null;
						}
						this._log("reconnect", {
							plugin: this.name,
							success: false,
							error: err instanceof Error ? err.message : String(err),
						});
						// _browser stays null; _browserServer persists until
						// its `close` event or cleanupAll(). A subsequent
						// navigate will relaunch (closing the stale server
						// first — see _newBrowserContext).
					});
				return;
			}

			// Default path: drop the cached CDP endpoint too — a relaunch
			// re-discovers it via onBrowserLaunched().
			this._cdpEndpoint = null;
		});
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
		// launchServer path: if the connected Browser crashed and a
		// reconnect is in flight, await it instead of relaunching. This
		// avoids a second `launchBrowser()` call creating a new
		// BrowserServer and leaking the still-reconnecting one. If the
		// reconnect failed, fall through to the relaunch block (which
		// closes the stale server first).
		if (!this._browser && this._reconnectPromise) {
			try {
				this._browser = await this._reconnectPromise;
			} catch {
				// reconnect failed — fall through to relaunch
			} finally {
				this._reconnectPromise = null;
			}
		}

		// Lazy-init the shared browser
		if (!this._browser) {
			// If a stale BrowserServer lingers from a failed reconnect,
			// close it before launching a fresh one to avoid a process
			// leak. Capture into a local so the field nulling doesn't
			// poison TS narrowing for the new-server read below. No-op
			// for default-path backends (`_browserServer` stays null).
			const staleServer = this._browserServer;
			if (staleServer) {
				this._browserServer = null;
				this._wsEndpoint = null;
				await staleServer.close().catch(() => {});
			}

			this._browser = await this._launchWithHint();

			// Auto-recover from browser crash/disconnect. The launchServer
			// path (firefox family) reconnects instead of relaunching; the
			// default path nulls state so the next call re-launches.
			this._wireDisconnectHandler(this._browser);

			// launchServer path: wire a one-time close handler on the server
			// so a server-side shutdown nulls `_browserServer` / `_wsEndpoint`.
			// Read with an explicit type annotation — `launchBrowser()` (called
			// by `_launchWithHint` above) sets `_browserServer` in subclasses,
			// but TS can't see that cross-method mutation, so without this the
			// earlier `= null` would narrow the field to `null` and dead-code
			// this block.
			const newServer: BrowserServer | null = this._browserServer;
			if (newServer) {
				newServer.on("close", () => {
					if (this._browserServer === newServer) {
						this._browserServer = null;
						this._wsEndpoint = null;
					}
				});
			}

			// UA capture at first launch (Firefox opt-in)
			if (this.captureUserAgent) {
				await this._captureUA();
			}

			// Post-launch hook: subclasses can discover a CDP/ws endpoint
			// (e.g. chromium scans `ss -tlnp` for the `--remote-debugging-port=0`
			// port) or perform other once-per-launch setup. Failures are
			// swallowed so a port-scan glitch never blocks normal browsing —
			// `getCdpEndpoint()` will simply return null and Mode A attach
			// will be unavailable for that session.
			try {
				await this.onBrowserLaunched();
			} catch (err) {
				this._log("onBrowserLaunched", {
					plugin: this.name,
					error: err instanceof Error ? err.message : String(err),
				});
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
		if (!session?.persistState) return undefined;

		try {
			const state = await context.storageState();
			const name = session.profileName ?? "default";
			saveStorageState(name, state);
			return state;
		} catch (err) {
			console.warn(
				`[pi-lean-portal] Failed to auto-save storage state for profile ` +
					`'${session.profileName ?? "default"}': ` +
					`${err instanceof Error ? err.message : String(err)}. ` +
					"Session state may be lost.",
			);
			return undefined;
		}
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
				pluginName: this.name,
			});

			this._log("navigate", {
				url: page.url(),
				plugin: this.name,
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
				plugin: this.name,
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

			this._log("snapshot", {
				taskId,
				success: true,
				elementCount,
				dialogEvents: dialogEvents.length,
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
			const urlBefore = page.url();
			await locator.click({ timeout: 5000 });
			phases.click = Math.round(performance.now() - _start);

			// Wait for potential navigation to settle (replaces fixed sleep)
			const { navigated } = await waitForNavigationSettle(page, urlBefore);
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
				navigated,
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
			const urlBefore = page.url();
			await page.keyboard.press(key);

			// Wait for potential navigation to settle (replaces fixed sleep).
			// Shorter nav timeout since Enter-on-link nav is typically fast.
			const { navigated } = await waitForNavigationSettle(page, urlBefore, {
				navTimeoutMs: 3000,
			});

			const newUrl = page.url();
			const newTitle = await page.title();
			sessionManager.updateSession(taskId, {
				currentUrl: newUrl,
				currentTitle: newTitle,
			});

			const snapResult = await this.takeSnapshot(taskId, page);

			this._log("press", {
				taskId,
				key,
				success: true,
				navigated,
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
