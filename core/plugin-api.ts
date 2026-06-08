/**
 * Plugin Architecture v2 — Core Interface & Unified Result Types
 *
 * This module defines the contract that every interactive browser backend
 * must satisfy.  The 13 agent-facing operations map 1:1 to tool calls;
 * lifecycle hooks (init, cleanupAll) are called by the framework.
 *
 * Plugins return **raw results**.  The router is responsible for
 * cross-cutting transformations (truncation, count fields, botDetected
 * warning injection, etc.) — see §3 of plan_v2.md.
 */

// ─── Capabilities ────────────────────────────────────────────────

/**
 * Read-only capabilities that a plugin advertises.  The router uses
 * these to adapt behaviour (e.g. fall back from fullPage to viewport
 * screenshot when unsupported).
 */
export interface PluginCapabilities {
	/** Can take full-page screenshots */
	supportsFullPageScreenshot: boolean;
	/** Can capture console messages via CDP or equivalent */
	supportsConsoleCapture: boolean;
	/** Can evaluate arbitrary JavaScript in the page */
	supportsJavaScriptEvaluate: boolean;
	/** Can detect bot/anti-automation signals (Cloudflare, CAPTCHA, etc.) */
	supportsBotDetection: boolean;
	/** Can auto-dismiss JS dialogs (alert/confirm/prompt) */
	supportsDialogAutoDismissal: boolean;
	/** Can accept an AbortSignal for long-running navigations */
	supportsAbortSignal: boolean;
	/** Browser engine (used for display/debugging only) */
	engine: "chromium" | "firefox" | "webkit" | string;
}

/** Default capabilities matching a full-featured Chromium backend. */
export const DEFAULT_CAPABILITIES: PluginCapabilities = {
	supportsFullPageScreenshot: true,
	supportsConsoleCapture: true,
	supportsJavaScriptEvaluate: true,
	supportsBotDetection: true,
	supportsDialogAutoDismissal: true,
	supportsAbortSignal: true,
	engine: "chromium",
};

// ─── Unified Result Types ─────────────────────────────────────────

/**
 * Base shape shared by all result types.
 * Operations return `{ success: false, error }` for expected failures.
 * They **may throw** for infrastructure failures (process crash, OOM).
 * The router catches throws and normalises them.
 */
interface ResultBase {
	success: boolean;
	error?: string;
}

/** Result from browser-navigate */
export interface NavigateResult extends ResultBase {
	url: string;
	title: string;
	/** Accessibility-tree text with @e refs */
	snapshot: string;
	/** Number of interactive elements found */
	elementCount: number;
	/** Plugin-internal signal: page may be blocked by bot detection */
	botDetected?: boolean;
}

/** Result from browser-snapshot */
export interface SnapshotResult extends ResultBase {
	/** Accessibility-tree text with @e refs */
	snapshot: string;
	/** Number of interactive elements found */
	elementCount: number;
}

/** Result from interaction tools (click, type, scroll, goBack, press) */
export interface InteractionResult extends ResultBase {
	/** URL after the interaction (if navigation occurred) */
	newUrl?: string;
	/** Title after the interaction (if navigation occurred) */
	newTitle?: string;
	/** Auto-captured snapshot after the interaction */
	snapshot?: string;
	/** Number of interactive elements in the auto-snapshot */
	elementCount?: number;
}

/** Result from browser-screenshot */
export interface ScreenshotResult extends ResultBase {
	/** JPEG data URI of the screenshot */
	dataUri: string;
}

/** Single image extracted from the page */
export interface PageImage {
	src: string;
	alt: string;
	width: number;
	height: number;
}

/** Result from browser-get-images */
export interface GetImagesResult extends ResultBase {
	images: PageImage[];
}

/** Result from getConsoleMessages */
export interface ConsoleMessagesResult extends ResultBase {
	messages: Array<{ type: string; text: string }>;
}

/** Result from evaluate (browser-console JS eval) */
export interface EvaluateResult extends ResultBase {
	result?: unknown;
}

// ─── BrowserPlugin Interface ──────────────────────────────────────

/**
 * The contract every interactive browser backend must implement.
 *
 * The 13 agent-facing operations map 1:1 to tool calls.
 * Lifecycle hooks are called by the framework, not the agent.
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
		options?: { signal?: AbortSignal },
	): Promise<NavigateResult>;

	snapshot(taskId: string): Promise<SnapshotResult>;

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

	getImages(taskId: string): Promise<GetImagesResult>;

	// ── Console & eval ────────────────────────────────────────

	getConsoleMessages(taskId: string): Promise<ConsoleMessagesResult>;

	clearConsole(taskId: string): Promise<void>;

	evaluate(taskId: string, expression: string): Promise<EvaluateResult>;

	// ── Per-task cleanup ──────────────────────────────────────

	/**
	 * Clean up resources for a specific task (browser context, page, etc.).
	 */
	cleanup(taskId: string): Promise<void>;
}

// ─── Plugin Config (from settings.json) ──────────────────────────

/** A single plugin entry from the user's settings.json */
export interface PluginConfig {
	/** Stable identifier used in strategy param, session tracking, errors */
	name: string;
	/** Directory name under backends/ containing the plugin code */
	dir: string;
	/** Whether this plugin is active (default: true) */
	enabled: boolean;
	/** Plugin-specific overrides passed to init() */
	config: Record<string, unknown>;
}

// ─── Plugin type auto-detection ──────────────────────────────────

export type PluginType = "node" | "python";

/** Result of inspecting a plugin directory for type detection */
export interface PluginDetection {
	type: PluginType;
	/** Absolute or relative path to the entry point */
	entryPoint: string;
}
