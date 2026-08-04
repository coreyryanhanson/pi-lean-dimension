/**
 * Plugin Architecture v2 — Core Interface & Unified Result Types
 *
 * This module defines the contract that every interactive browser backend
 * must satisfy.  The 12 required operations map to the registered tools
 * (screenshot is required internally for auto-capture). Lifecycle hooks
 * (init, cleanupAll) are called by the framework.
 *
 * Plugins return **raw results**.  The router is responsible for
 * cross-cutting transformations (truncation, count fields, botDetected
 * warning injection, etc.).
 */

import type { AriaCachedNode } from "./shared/accessibility-tree.js";

// ─── Capabilities ────────────────────────────────────────────────

/**
 * Read-only capabilities that a plugin advertises.  The router uses
 * these to adapt behaviour (e.g. fall back from fullPage to viewport
 * screenshot when unsupported).
 */
export interface PluginCapabilities {
	supportsFullPageScreenshot: boolean;
	supportsJavaScriptEvaluate: boolean;
	/** Browser engine (used for display/debugging only) */
	engine: "chromium" | "firefox" | "webkit" | string;
}

/** Default capabilities matching a full-featured Chromium backend. */
export const DEFAULT_CAPABILITIES: PluginCapabilities = {
	supportsFullPageScreenshot: true,
	supportsJavaScriptEvaluate: true,
	engine: "chromium",
};

// ─── Unified Result Types ─────────────────────────────────────────

/**
 * A JavaScript dialog event (alert, confirm, prompt, beforeunload) that was
 * auto-dismissed by the browser plugin.  Returned as part of navigate,
 * snapshot, and interaction results so the router can surface them to
 * the agent without polluting the accessibility tree text.
 */
export interface DialogEvent {
	/** Event type as reported by the browser (dialog types or "crash") */
	type: string;
	message: string;
	/** How a dialog was handled; absent for non-dialog events like crash */
	handledAs?: "accepted" | "dismissed";
}

/**
 * Base shape shared by all result types.
 * Operations return `{ success: false, error }` for expected failures.
 * They **may throw** for infrastructure failures (process crash, OOM).
 * The router catches throws and normalises them.
 */
export interface ResultBase {
	success: boolean;
	error?: string;
}

export interface NavigateResult extends ResultBase {
	url: string;
	title: string;
	/** Accessibility-tree text with @e refs */
	snapshot: string;
	elementCount: number;
	/** Plugin-internal signal: page may be blocked by bot detection */
	botDetected?: boolean;
	/** Whether a dialog (role="dialog" or role="alertdialog") was detected in the parsed element cache */
	dialogDetected?: boolean;
	/** Auto-dismissed JavaScript dialogs (alert/confirm/prompt) since last navigate */
	dialogEvents?: DialogEvent[];
	profileMode?: "none" | "session" | "named";
	/** Which profile was loaded for this session (if any) */
	profileName?: string;
}

export interface SnapshotResult extends ResultBase {
	/** Accessibility-tree text with @e refs */
	snapshot: string;
	elementCount: number;
	/** Auto-dismissed JavaScript dialogs (alert/confirm/prompt) since last snapshot */
	dialogEvents?: DialogEvent[];
}

/** Result from interaction tools (click, type, scroll, goBack, press) */
export interface InteractionResult extends ResultBase {
	/** URL after the interaction (if navigation occurred) */
	newUrl?: string;
	/** Title after the interaction (if navigation occurred) */
	newTitle?: string;
	/** Auto-captured snapshot after the interaction */
	snapshot?: string;
	elementCount?: number;
	/** Auto-dismissed JavaScript dialogs since the interaction */
	dialogEvents?: DialogEvent[];
}

export interface ScreenshotResult extends ResultBase {
	/** JPEG data URI of the screenshot */
	dataUri: string;
}

export interface ConsoleMessagesResult extends ResultBase {
	messages: Array<{ type: string; text: string }>;
}

/** Result from evaluate (browser-console JS eval) */
export interface EvaluateResult extends ResultBase {
	result?: unknown;
}

// ─── Cookie & Storage State Types ─────────────────────────────────

/**
 * A single browser cookie, matching Playwright's Cookie shape.
 * Fields are optional to accommodate both directions:
 * - Reading (cookies() output): all fields are always populated
 * - Writing (addCookies() input): domain and path are effectively required
 *   at runtime by Playwright; sameSite defaults to browser policy (Lax).
 */
export interface Cookie {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	/** Unix timestamp in seconds; -1 for session cookies */
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
}

export interface CookieResult extends ResultBase {
	cookies: Cookie[];
}

/** Options for browser-clearCookies — all fields optional (omit all to clear everything) */
export interface ClearCookiesOptions {
	name?: string;
	domain?: string;
	path?: string;
}

export interface StorageStateResult extends ResultBase {
	cookies: Cookie[];
	origins: Array<{
		origin: string;
		localStorage: Array<{ name: string; value: string }>;
	}>;
}

// ─── BrowserPlugin Interface ──────────────────────────────────────

/**
 * The contract every interactive browser backend must implement.
 *
 * The 18 required operations (plus getElementCache and cookie/storage
 * methods) make up the full contract. Lifecycle hooks are called by
 * the framework, not the agent.
 */
export interface BrowserPlugin {
	// ── Identity ───────────────────────────────────────────────
	/** Unique stable identifier (e.g. "chromium", "camoufox") */
	readonly name: string;

	/** Advertised capabilities — read by the router for adaptation */
	readonly capabilities: PluginCapabilities;

	// ── Lifecycle hooks (framework-triggered) ─────────────────

	/**
	 * Optional one-time initialisation.  Called once at plugin
	 * registration (extension startup).  Receives the `config` bag
	 * from `settings.json`.
	 */
	init?(config?: Record<string, unknown>): Promise<void>;

	/**
	 * Required shutdown hook.  Called on extension shutdown.
	 * Cleans up ALL sessions and resources (browsers, subprocesses, etc.).
	 */
	cleanupAll(): Promise<void>;

	// ── Navigation & state ────────────────────────────────────

	navigate(
		url: string,
		taskId: string,
		timeoutMs: number,
		options?: {
			signal?: AbortSignal;
			/** Playwright storage state for profile-based session restoration */
			storageState?: unknown;
			/** Profile name for shared-context resolution */
			profileName?: string;
			/** Profile mode for shared-context resolution */
			profileMode?: "none" | "session" | "named";
		},
	): Promise<NavigateResult>;

	snapshot(taskId: string): Promise<SnapshotResult>;

	// ── Cookies & storage state ────────────────────────────────

	getCookies(taskId: string, urls?: string[]): Promise<CookieResult>;

	/**
	 * Add cookies to the browser context.
	 * Playwright requires name, value, domain, and path at runtime.
	 */
	addCookies(taskId: string, cookies: Cookie[]): Promise<ResultBase>;

	/**
	 * Clear cookies from the browser context.
	 * With no options, ALL cookies are cleared (Playwright default).
	 */
	clearCookies(
		taskId: string,
		options?: ClearCookiesOptions,
	): Promise<ResultBase>;

	/**
	 * Get the full storage state (cookies + localStorage + IndexedDB).
	 * Primarily used by storage-state persistence.
	 */
	getStorageState(taskId: string): Promise<StorageStateResult>;

	// ── Interaction ───────────────────────────────────────────

	click(taskId: string, ref: string): Promise<InteractionResult>;

	type(taskId: string, ref: string, text: string): Promise<InteractionResult>;

	scroll(taskId: string, direction: "up" | "down"): Promise<InteractionResult>;

	goBack(taskId: string): Promise<InteractionResult>;

	press(taskId: string, key: string): Promise<InteractionResult>;

	// ── Media ─────────────────────────────────────────────────

	screenshot(
		taskId: string,
		options?: { fullPage?: boolean },
	): Promise<ScreenshotResult>;

	// ── Console & eval ────────────────────────────────────────

	getConsoleMessages(taskId: string): Promise<ConsoleMessagesResult>;

	clearConsole(taskId: string): Promise<void>;

	evaluate(
		taskId: string,
		expression: string,
		readOnly?: boolean,
	): Promise<EvaluateResult>;

	// ── Element cache access ─────────────────────────────────

	/**
	 * Return the plugin's element cache for the given task.
	 * Returns null if the session/task has no cache (navigate or snapshot
	 * has not been called yet).
	 */
	getElementCache(taskId: string): Map<string, AriaCachedNode> | null;

	// ── Per-task cleanup ──────────────────────────────────────

	cleanup(taskId: string): Promise<void>;
}
