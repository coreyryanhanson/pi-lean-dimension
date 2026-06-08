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
	installDialogHandlers,
	formatDialogLog,
	getConsoleLog as getRawConsoleLog,
	clearConsoleLog,
} from "../../core/shared/cdp-supervisor.js";
import { sessionManager } from "../../core/shared/session-manager.js";
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

	/** Shared browser instance (lazy-initialised) */
	private _browser: Browser | null = null;

	/** Per-task context + page */
	private _contexts = new Map<
		string,
		{ context: BrowserContext; page: Page }
	>();

	/** Per-task element cache (ref → AriaCachedNode) */
	private _elementCache = new Map<string, Map<string, AriaCachedNode>>();

	// ── Lifecycle ───────────────────────────────────────────────

	async init(_config?: Record<string, unknown>): Promise<void> {
		// Nothing to do at init — browser is lazy-launched on first use
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

	private async getOrCreateContext(taskId: string): Promise<{
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

		const context = await this._browser.newContext({
			viewport: { width: 1280, height: 720 },
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		});

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

	private getElementCache(taskId: string): Map<string, AriaCachedNode> {
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
			this.getElementCache(taskId).clear();
			for (const [ref, node] of parsed.elements) {
				this.getElementCache(taskId).set(ref, node);
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

	/** Check for bot/anti-automation detection signals. */
	private async checkBotDetection(page: Page): Promise<boolean> {
		try {
			const title = (await page.title()).toLowerCase();
			const bodyText = await page.evaluate(
				() => document.body?.innerText?.toLowerCase() || "",
			);

			const signals = [
				"please verify you are human",
				"attention required",
				"cloudflare",
				"just a moment",
				"checking your browser",
				"enable javascript",
				"captcha",
				"security check",
				"ddos protection",
				"you have been blocked",
				"access denied",
				"sorry, you have been blocked",
				"verify you are human",
			];

			for (const s of signals) {
				if (title.includes(s) || bodyText.includes(s)) {
					return true;
				}
			}

			return false;
		} catch {
			return false;
		}
	}

	// ── Navigation & state ──────────────────────────────────────

	async navigate(
		url: string,
		taskId: string,
		timeoutMs: number = 30_000,
		options?: { signal?: AbortSignal },
	): Promise<NavigateResult> {
		try {
			const { page } = await this.getOrCreateContext(taskId);

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
						waitUntil: "networkidle",
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

			// Check for bot detection (Cloudflare, etc.)
			const botDetected = await this.checkBotDetection(page);

			// Wait for dynamic content to settle
			await page.waitForLoadState("domcontentloaded");
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

			// Take accessibility snapshot
			const snap = await page.ariaSnapshot();
			const parsed = parseSnapshot(snap);

			// Cache elements for this session
			this.getElementCache(taskId).clear();
			for (const [ref, node] of parsed.elements) {
				this.getElementCache(taskId).set(ref, node);
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
			const botDetected =
				msg.includes("captcha") ||
				msg.includes("cloudflare") ||
				msg.includes("blocked") ||
				msg.includes("challenge");

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
		const page = this.getPage(taskId);
		if (!page) {
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
			this.getElementCache(taskId).clear();
			for (const [ref, node] of parsed.elements) {
				this.getElementCache(taskId).set(ref, node);
			}

			return {
				success: true,
				snapshot: parsed.text,
				elementCount: parsed.count,
			};
		} catch (err: unknown) {
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
		const page = this.getPage(taskId);
		if (!page) {
			return { success: false, error: "No active session" };
		}

		const key = ref.startsWith("@") ? ref.slice(1) : ref;
		const node = this.getElementCache(taskId).get(key);

		if (!node) {
			return {
				success: false,
				error: `Element ${ref} not found in accessibility tree. Refresh with browser-snapshot first.`,
			};
		}

		try {
			const locator = buildLocator(page, node);
			if (!locator) {
				return {
					success: false,
					error: `Could not build locator for ${ref} (role: ${node.role})`,
				};
			}

			await locator.waitFor({ state: "visible", timeout: 5000 });
			await locator.click();

			// Wait for potential navigation
			await page.waitForTimeout(300);

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
			};
		} catch (err: unknown) {
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
		const page = this.getPage(taskId);
		if (!page) {
			return { success: false, error: "No active session" };
		}

		const key = ref.startsWith("@") ? ref.slice(1) : ref;
		const node = this.getElementCache(taskId).get(key);

		if (!node) {
			return {
				success: false,
				error: `Element ${ref} not found in accessibility tree. Refresh with browser-snapshot first.`,
			};
		}

		try {
			const locator = buildLocator(page, node);
			if (!locator) {
				return {
					success: false,
					error: `Could not build locator for ${ref}`,
				};
			}

			await locator.waitFor({ state: "visible", timeout: 5000 });
			await locator.click(); // Focus first
			await locator.fill(text);

			// Auto-snapshot
			const snapResult = await this.takeSnapshot(taskId, page);

			return {
				success: true,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
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
		const page = this.getPage(taskId);
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

			return {
				success: true,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
			return {
				success: false,
				error: `Scroll failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async goBack(taskId: string): Promise<InteractionResult> {
		const page = this.getPage(taskId);
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

			return {
				success: true,
				newUrl,
				newTitle,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
			return {
				success: false,
				error: `GoBack failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async press(taskId: string, key: string): Promise<InteractionResult> {
		const page = this.getPage(taskId);
		if (!page) {
			return { success: false, error: "No active session" };
		}

		try {
			await page.keyboard.press(key);
			await page.waitForTimeout(200);

			const snapResult = await this.takeSnapshot(taskId, page);

			return {
				success: true,
				snapshot: snapResult.snapshot,
				elementCount: snapResult.elementCount,
			};
		} catch (err: unknown) {
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

	// ── Per-task cleanup ───────────────────────────────────────

	async cleanup(taskId: string): Promise<void> {
		const entry = this._contexts.get(taskId);
		if (entry) {
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
