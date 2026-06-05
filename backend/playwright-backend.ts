/**
 * Level 2: Playwright Chromium Backend
 *
 * Full browser automation with headless Chromium. Uses accessibility tree
 * for page representation and getByRole() for interaction mapping.
 */

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { parseSnapshot, buildLocator, type AriaCachedNode } from "../utils/accessibility-tree";
import { installDialogHandlers, formatDialogLog, getConsoleLog as getRawConsoleLog, clearConsoleLog, clearAllLogs } from "../utils/cdp-supervisor";
import { sessionManager } from "../utils/session-manager";

// ─── Types ────────────────────────────────────────────────────────────

export interface PlaywrightNavigateResult {
  success: boolean;
  url: string;
  title: string;
  /** Text representation of the a11y tree */
  snapshot: string;
  /** Number of a11y tree elements */
  elementCount: number;
  backend: "chromium";
  botDetected?: boolean;
  error?: string;
}

export interface PlaywrightSnapshotResult {
  success: boolean;
  snapshot: string;
  elementCount: number;
  error?: string;
}

export interface PlaywrightInteractionResult {
  success: boolean;
  error?: string;
  newUrl?: string;
  newTitle?: string;
  /** Auto-captured snapshot after interaction */
  snapshot?: string;
  /** Number of elements in the auto-captured snapshot */
  elementCount?: number;
}

export interface PlaywrightScreenshotResult {
  success: boolean;
  /** Base64-encoded PNG data URI */
  dataUri: string;
  error?: string;
}

export interface PlaywrightConsoleMessage {
  type: string;
  text: string;
  location?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function getOrCreateContext(taskId: string): Promise<{ context: BrowserContext; page: Page; isNew: boolean }> {
  return _getOrCreateContext(taskId);
}

// Module-level browser and context cache
let _browser: Browser | null = null;
const _contexts = new Map<string, { context: BrowserContext; page: Page }>();
const _elementCache = new Map<string, Map<string, AriaCachedNode>>();

async function _getOrCreateContext(
  taskId: string,
): Promise<{ context: BrowserContext; page: Page; isNew: boolean }> {
  const existing = _contexts.get(taskId);
  if (existing) {
    // Check if the page is still alive (not closed/crashed)
    if (existing.page.isClosed()) {
      // Page was closed — recreate it in the same context
      try {
        const newPage = await existing.context.newPage();
        installDialogHandlers(taskId, newPage);
        existing.page = newPage;
      } catch {
        // Context is also dead — remove and recreate
        _contexts.delete(taskId);
        _elementCache.delete(taskId);
      }
    } else {
      return { ...existing, isNew: false };
    }
  }

  // Lazy-init the shared browser
  if (!_browser) {
    _browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    sessionManager.setPlaywrightBrowser(_browser);

    // Auto-recover from browser crash/disconnect
    _browser.on("disconnected", () => {
      _browser = null;
      sessionManager.setPlaywrightBrowser(null);
      // Mark all sessions as crashed before clearing
      for (const [tid] of _contexts) {
        sessionManager.updateSession(tid, { crashed: true });
        _elementCache.delete(tid);
      }
      _contexts.clear();
    });
  }

  const context = await _browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  _contexts.set(taskId, { context, page });
  _elementCache.set(taskId, new Map());

  // Install dialog handlers (auto-dismiss JS alerts/confirms/prompts)
  installDialogHandlers(taskId, page);

  // Update session manager with the context
  const session = sessionManager.getSession(taskId);
  if (session) {
    session.context = context;
  }

  return { context, page, isNew: true };
}

function getPage(taskId: string): Page | undefined {
  return _contexts.get(taskId)?.page;
}

function getElementCache(taskId: string): Map<string, AriaCachedNode> {
  let cache = _elementCache.get(taskId);
  if (!cache) {
    cache = new Map();
    _elementCache.set(taskId, cache);
  }
  return cache;
}

// ─── Navigation ───────────────────────────────────────────────────────

export async function navigate(
  url: string,
  taskId: string,
  timeoutMs: number = 30_000,
  signal?: AbortSignal,
): Promise<PlaywrightNavigateResult> {
  try {
    const { page, isNew } = await getOrCreateContext(taskId);

    // Wire up abort
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          page.close().catch(() => {});
        },
        { once: true },
      );
    }

    // Navigate (with one retry for transient network errors)
    let response: Response | null = null;
    let lastError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await page.goto(url, {
          waitUntil: "networkidle",
          timeout: timeoutMs,
        });
        break; // success
      } catch (gotoErr: unknown) {
        lastError = gotoErr instanceof Error ? gotoErr.message : String(gotoErr);
        const isTransient = /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|Interrupted/i.test(lastError);
        if (!isTransient || attempt > 0) {
          // Not transient or already retried — throw to outer catch
          throw gotoErr;
        }
        // Brief pause before retry
        await page.waitForTimeout(2000);
      }
    }

    // Check for bot detection (Cloudflare, etc.)
    const botDetected = await checkBotDetection(page);

    // Wait for dynamic content to settle: DOM stabilization + generous timeout
    await page.waitForLoadState("domcontentloaded");
    try {
      await page.waitForFunction(
        () => new Promise<boolean>((resolve) => {
          const count = document.querySelectorAll("*").length;
          setTimeout(() => {
            resolve(document.querySelectorAll("*").length === count || count > 5000);
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
    getElementCache(taskId).clear();
    for (const [ref, node] of parsed.elements) {
      getElementCache(taskId).set(ref, node);
    }

    const title = await page.title();

    // Check for auto-dismissed dialogs
    const dialogInfo = formatDialogLog(taskId);
    const snapshotWithDialogs = dialogInfo
      ? parsed.text + "\n\n--- Auto-dismissed dialogs ---\n" + dialogInfo
      : parsed.text;

    // Update session manager
    sessionManager.updateSession(taskId, {
      currentUrl: page.url(),
      currentTitle: title,
      level: "chromium",
    });

    return {
      success: true,
      url: page.url(),
      title,
      snapshot: snapshotWithDialogs,
      elementCount: parsed.count,
      backend: "chromium",
      botDetected,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Check for common bot detection patterns in error
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
      backend: "chromium",
      botDetected,
      error: msg,
    };
  }
}

// ─── Snapshot (current page) ───────────────────────────────────────────

export async function snapshot(
  taskId: string,
): Promise<PlaywrightSnapshotResult> {
  const page = getPage(taskId);
  if (!page) {
    return { success: false, snapshot: "", elementCount: 0, error: "No active session" };
  }

  try {
    const snap = await page.ariaSnapshot();
    const parsed = parseSnapshot(snap);

    // Update cache
    getElementCache(taskId).clear();
    for (const [ref, node] of parsed.elements) {
      getElementCache(taskId).set(ref, node);
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

// ─── Click ─────────────────────────────────────────────────────────────

export async function click(
  taskId: string,
  ref: string,
): Promise<PlaywrightInteractionResult> {
  const page = getPage(taskId);
  if (!page) {
    return { success: false, error: "No active session" };
  }

  // Strip @ if present
  const key = ref.startsWith("@") ? ref.slice(1) : ref;
  const cache = getElementCache(taskId);
  const node = cache.get(key);

  if (!node) {
    return { success: false, error: `Element ${ref} not found in accessibility tree. Refresh with browser-snapshot first.` };
  }

  try {
    const locator = buildLocator(page, node);
    if (!locator) {
      return { success: false, error: `Could not build locator for ${ref} (role: ${node.role})` };
    }

    await locator.waitFor({ state: "visible", timeout: 5000 });
    await locator.click();

    // Wait for potential navigation
    await page.waitForTimeout(300);

    const newUrl = page.url();
    const newTitle = await page.title();
    sessionManager.updateSession(taskId, { currentUrl: newUrl, currentTitle: newTitle });

    // Auto-snapshot after click so the model sees updated page state
    const snapshotResult = await takeSnapshot(taskId, page);

    return { success: true, newUrl, newTitle, snapshot: snapshotResult.snapshot, elementCount: snapshotResult.elementCount };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Type ──────────────────────────────────────────────────────────────

export async function type(
  taskId: string,
  ref: string,
  text: string,
): Promise<PlaywrightInteractionResult> {
  const page = getPage(taskId);
  if (!page) {
    return { success: false, error: "No active session" };
  }

  const key = ref.startsWith("@") ? ref.slice(1) : ref;
  const cache = getElementCache(taskId);
  const node = cache.get(key);

  if (!node) {
    return { success: false, error: `Element ${ref} not found in accessibility tree. Refresh with browser-snapshot first.` };
  }

  try {
    const locator = buildLocator(page, node);
    if (!locator) {
      return { success: false, error: `Could not build locator for ${ref}` };
    }

    await locator.waitFor({ state: "visible", timeout: 5000 });
    await locator.click(); // Focus first
    await locator.fill(text);

    // Auto-snapshot after type so the model sees updated page state
    const snapshotResult = await takeSnapshot(taskId, page);

    return { success: true, snapshot: snapshotResult.snapshot, elementCount: snapshotResult.elementCount };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Scroll ────────────────────────────────────────────────────────────

export async function scroll(
  taskId: string,
  direction: "up" | "down",
): Promise<PlaywrightInteractionResult> {
  const page = getPage(taskId);
  if (!page) {
    return { success: false, error: "No active session" };
  }

  try {
    const delta = direction === "down" ? 800 : -800;
    await page.evaluate((d: number) => {
      window.scrollBy({ top: d, behavior: "smooth" });
    }, delta);
    await page.waitForTimeout(200);

    // Auto-snapshot after scroll so the model sees updated page state
    const snapshotResult = await takeSnapshot(taskId, page);

    return { success: true, snapshot: snapshotResult.snapshot, elementCount: snapshotResult.elementCount };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Scroll failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Screenshot ────────────────────────────────────────────────────────

export async function screenshot(
  taskId: string,
  fullPage: boolean = false,
): Promise<PlaywrightScreenshotResult> {
  const page = getPage(taskId);
  if (!page) {
    return { success: false, dataUri: "", error: "No active session" };
  }

  try {
    // Use JPEG at 80% quality for smaller payloads (vs PNG)
    // Constrain viewport width to 1024px max for manageable screenshots
    const currentViewport = page.viewportSize();
    if (currentViewport && currentViewport.width > 1024) {
      await page.setViewportSize({ width: 1024, height: currentViewport.height });
    }

    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 80,
      fullPage,
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

// ─── Go Back ───────────────────────────────────────────────────────────

export async function goBack(taskId: string): Promise<PlaywrightInteractionResult> {
  const page = getPage(taskId);
  if (!page) {
    return { success: false, error: "No active session" };
  }

  try {
    await page.goBack({ waitUntil: "networkidle" });
    await page.waitForTimeout(300);

    const newUrl = page.url();
    const newTitle = await page.title();
    sessionManager.updateSession(taskId, { currentUrl: newUrl, currentTitle: newTitle });

    // Auto-snapshot after goBack so the model sees the previous page
    const snapshotResult = await takeSnapshot(taskId, page);

    return { success: true, newUrl, newTitle, snapshot: snapshotResult.snapshot, elementCount: snapshotResult.elementCount };
  } catch (err: unknown) {
    return {
      success: false,
      error: `GoBack failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Press Key ─────────────────────────────────────────────────────────

export async function press(
  taskId: string,
  key: string,
): Promise<PlaywrightInteractionResult> {
  const page = getPage(taskId);
  if (!page) {
    return { success: false, error: "No active session" };
  }

  try {
    await page.keyboard.press(key);
    await page.waitForTimeout(200);

    // Auto-snapshot after press so the model sees updated page state
    const snapshotResult = await takeSnapshot(taskId, page);

    return { success: true, snapshot: snapshotResult.snapshot, elementCount: snapshotResult.elementCount };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Press failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Snapshot Helper ──────────────────────────────────────────────────

async function takeSnapshot(taskId: string, page: Page): Promise<{ snapshot: string; elementCount: number }> {
  try {
    const snap = await page.ariaSnapshot();
    const parsed = parseSnapshot(snap);
    // Update cache
    getElementCache(taskId).clear();
    for (const [ref, node] of parsed.elements) {
      getElementCache(taskId).set(ref, node);
    }

    // Check for auto-dismissed dialogs
    const dialogInfo = formatDialogLog(taskId);
    const text = dialogInfo ? parsed.text + "\n\n--- Auto-dismissed dialogs ---\n" + dialogInfo : parsed.text;

    return { snapshot: text, elementCount: parsed.count };
  } catch {
    return { snapshot: "(snapshot not available)", elementCount: 0 };
  }
}

// ─── Images ────────────────────────────────────────────────────────────

export interface PlaywrightImageInfo {
  src: string;
  alt: string;
  width: number;
  height: number;
}

/**
 * Extract all <img> tags from the page.
 * Returns src, alt, width, height for each image.
 * Excludes data URIs.
 */
export async function getImages(taskId: string): Promise<{ success: boolean; images: PlaywrightImageInfo[]; error?: string }> {
  const page = getPage(taskId);
  if (!page) {
    return { success: false, images: [], error: "No active session" };
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

// ─── Console ───────────────────────────────────────────────────────────

/**
 * Retrieve captured console messages for a task.
 * Console events are captured automatically via page.on('console', ...)
 * installed during createSession.
 */
export async function getConsoleMessages(
  taskId: string,
): Promise<PlaywrightConsoleMessage[]> {
  const raw = getRawConsoleLog(taskId);
  return raw.map((c) => ({
    type: c.type,
    text: c.text,
  }));
}

/**
 * Clear captured console log for a task.
 */
export async function clearConsole(taskId: string): Promise<void> {
  clearConsoleLog(taskId);
}

export async function evaluate(
  taskId: string,
  expression: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const page = getPage(taskId);
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

// ─── Cleanup ───────────────────────────────────────────────────────────

export async function cleanup(taskId: string): Promise<void> {
  const entry = _contexts.get(taskId);
  if (entry) {
    try {
      await entry.page.close();
    } catch { /* ok */ }
    try {
      await entry.context.close();
    } catch { /* ok */ }
    _contexts.delete(taskId);
    _elementCache.delete(taskId);
  }
}

export async function cleanupAll(): Promise<void> {
  for (const taskId of _contexts.keys()) {
    await cleanup(taskId);
  }
  if (_browser) {
    try {
      await _browser.close();
    } catch { /* ok */ }
    _browser = null;
  }
}

// ─── Bot Detection ────────────────────────────────────────────────────

async function checkBotDetection(page: Page): Promise<boolean> {
  try {
    const title = (await page.title()).toLowerCase();
    const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "");

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
