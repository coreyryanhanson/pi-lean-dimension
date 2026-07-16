import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
// fs functions used by profile/cookies handlers are in their respective modules

/**
 * Browser Toggle — integrated into pi-lean-portal extension.
 *
 * Provides /web on, /web off, /web learn, and /web status commands to enable / disable
 * browser automation tools (browsing tools) and learn tools (web-learn) in the system prompt.
 *
 * Three states: on (browsing only), learn (browsing + web-learn), off (all disabled).
 * Internally stores two independent booleans (browserToolsEnabled, learnToolsEnabled).
 *
 * When browser tools are disabled, the LLM cannot see them — no descriptions,
 * parameter schemas, prompt snippets, or guidelines are included in the context,
 * saving roughly 1500–2000 tokens per turn.
 *
 * ── Stateless fallback ─────────────────────────────────────────
 *
 * web-fetch is a stateless HTTP tool (no session, no interactivity).  If you
 * only need quick page content and never use the interactive browser tools,
 * you can leave browser tools disabled and rely on web-fetch alone.
 */

import { readMergedSettings } from "./core/shared/settings-reader.js";

// ---- Constants -------------------------------------------------

/** Default toggle config key */
const CONFIG_KEY = "browserToggle";

/** Names of every browser browsing tool registered by pi-lean-portal's index.ts (excludes learn tools). */
const BROWSER_TOOL_NAMES = new Set([
	"web-fetch",
	"browser-navigate",
	"browser-snapshot",
	"browser-click",
	"browser-type",
	"browser-scroll",
	"browser-back",
	"browser-press",
	"browser-console",
	"browser-inspect",
	"web-guide",
]);

/** Names of learn tools (web-learn) that require /web learn to be active. */
const LEARN_TOOL_NAMES = new Set(["web-learn"]);

/**
 * Names of sibling-package tools that are toggled alongside browser tools
 * by /web on|off|learn.
 *
 * - "web-search": SearXNG search from pi-lean-search.
 *
 * Exact-name `Set.has()` membership — NO regex (avoids false positives
 * on third-party web-* tools).
 */
const SIBLING_TOOL_NAMES = new Set<string>(["web-search"]);

/**
 * Update the search status bar glyph if sibling tools are installed.
 * Used by ``/web on|learn|off`` to keep the ``search`` slot in sync.
 */
function setSearchSlot(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	glyph: string,
): void {
	const hasSiblingTools = getRegisteredIn(pi, SIBLING_TOOL_NAMES).length > 0;
	if (hasSiblingTools) {
		ctx.ui.setStatus("search", glyph);
	}
}

/** Persisted state shape — two independent booleans plus conversation-scoped default profile. */
interface BrowserToggleState {
	browserToolsEnabled: boolean;
	learnToolsEnabled: boolean;
	/** Default profile for the current conversation. "none" means no override. */
	defaultProfile: string;
}

/** Last known toggle state — used by status bar */
let _lastToggleState = true;

/** Last known learn state — used by status bar for glyph coloring */
let _lastLearnState = false;

/** Conversation-scoped default profile. "none" means: read from config file. */
let _conversationDefaultProfile: string | undefined;

/**
 * Get the effective default profile. Returns the conversation-scoped override
 * if set, otherwise falls back to "none" (the router reads browser.defaultProfile
 * from settings.json as its own fallback).
 */
export function getConversationDefaultProfile(): string | undefined {
	return _conversationDefaultProfile;
}

// ---- Helpers ---------------------------------------------------

/** Return the subset of a tool-name set that is actually registered. */
function getRegisteredIn(pi: ExtensionAPI, names: Set<string>): string[] {
	return pi
		.getAllTools()
		.map((t) => t.name)
		.filter((n) => names.has(n));
}

/**
 * Check whether browser tools are currently active in the system prompt.
 */
function isBrowserEnabled(pi: ExtensionAPI): boolean {
	const registered = getRegisteredIn(pi, BROWSER_TOOL_NAMES);

	const active = new Set(pi.getActiveTools());
	return registered.some((name) => active.has(name));
}

/**
 * Apply a browser-tool state without persisting.
 * @param pi       ExtensionAPI
 * @param enable   true = add browser tools to the active set, false = remove them
 */
function applyBrowserState(pi: ExtensionAPI, enable: boolean): void {
	// Combine browser tools + sibling tools into one toggle set.
	// (/web on enables both; /web off disables both.)
	const registered = new Set([
		...getRegisteredIn(pi, BROWSER_TOOL_NAMES),
		...getRegisteredIn(pi, SIBLING_TOOL_NAMES),
	]);
	if (registered.size === 0) return;
	_lastToggleState = enable;

	if (enable) {
		// Merge browser+sibling tools back into whatever is currently active
		const current = pi.getActiveTools();
		pi.setActiveTools([...new Set([...current, ...registered])]);
	} else {
		// Keep everything that is NOT a browser+sibling tool
		const all = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(all.filter((name) => !registered.has(name)));
	}
}

/**
 * Persist the current toggle state into the session for branch-aware
 * restoration across /reload, /resume, /fork, and /tree navigation.
 */
function persistState(pi: ExtensionAPI, state: BrowserToggleState): void {
	pi.appendEntry<BrowserToggleState>("web-toggle-state", state);
}

// ---- Branch-aware restoration ----------------------------------

function restoreFromBranch(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	const registered = getRegisteredIn(pi, BROWSER_TOOL_NAMES);
	if (registered.length === 0) return false;

	let savedState: BrowserToggleState | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "web-toggle-state") {
			const data = entry.data as Record<string, unknown>;
			if (data && typeof data.browserToolsEnabled === "boolean") {
				savedState = data as unknown as BrowserToggleState;
			}
		}
	}

	if (savedState !== undefined) {
		applyBrowserState(pi, savedState.browserToolsEnabled);
		applyLearnState(pi, savedState.learnToolsEnabled);
		// Restore conversation-scoped default profile
		if (savedState.defaultProfile && savedState.defaultProfile !== "none") {
			_conversationDefaultProfile = savedState.defaultProfile;
		}
		return true;
	}

	return false;
}

/**
 * Apply the config-file default on a fresh session (no branch state found).
 * Reads `browserToggle.defaultEnabled` from pi's settings.json files.
 * Learn always starts disabled by default.
 */
function applyConfigDefault(pi: ExtensionAPI): void {
	const enabled = readBrowserToggleConfig();
	applyBrowserState(pi, enabled);
	applyLearnState(pi, false);
	// Persist so subsequent branch navigation sees this as the initial state
	persistState(pi, {
		browserToolsEnabled: enabled,
		learnToolsEnabled: false,
		defaultProfile: "none",
	});
}

// ---- Unit-test exports -----------------------------------------
// Helper functions are exported for testing while the default export
// wires the toggle into pi-lean-portal's runtime.

/**
 * Return the last known toggle state (true = enabled, false = disabled).
 * Returns true initially at startup (browser tools start enabled).
 */
export function getToggleState(): boolean {
	return _lastToggleState;
}

/**
 * Return the last known learn state (true = learn mode enabled).
 * Used by the status bar to color the glyph differently.
 */
export function getLearnState(): boolean {
	return _lastLearnState;
}

/** @internal Reset module-level state to defaults (test helper). */
function _resetToggleStateForTest(): void {
	_lastToggleState = true;
	_lastLearnState = false;
}

/**
 * Reset all module-level toggle state to defaults.
 *
 * Called at the start of the extension entry function to ensure safe
 * re-invocation when pi reuses the cached module factory (e.g.
 * during /resume to the same working directory).
 * Resets both the toggle status and conversation-scoped profile.
 */
export function resetToggleModuleState(): void {
	_lastToggleState = true;
	_lastLearnState = false;
	_conversationDefaultProfile = undefined;
}

// ---- Config-file support -----------------------------------------

/**
 * Read the browser toggle default from pi's settings.json files.
 *
 * Looks for `browserToggle.defaultEnabled` in:
 *   1. `~/.pi/agent/settings.json` (global)
 *   2. `.pi/settings.json` (project-local, overrides global)
 *
 * Returns the config value, or `true` if unset (backward-compatible default).
 * Silently returns `true` on missing files, parse errors, or type mismatches.
 */
function readBrowserToggleConfig(): boolean {
	const merged = readMergedSettings();
	const segment = merged[CONFIG_KEY];

	if (
		segment &&
		typeof segment === "object" &&
		!Array.isArray(segment) &&
		typeof (segment as Record<string, unknown>).defaultEnabled === "boolean"
	) {
		return (segment as Record<string, unknown>).defaultEnabled as boolean;
	}

	return true; // default: enabled
}

/**
 * Check whether learn tools are currently active.
 */
function isLearnEnabled(pi: ExtensionAPI): boolean {
	const registered = getRegisteredIn(pi, LEARN_TOOL_NAMES);
	const active = new Set(pi.getActiveTools());
	return registered.some((name) => active.has(name));
}

/**
 * Apply a learn-tool state without persisting.
 * Uses getActiveTools() (not getAllTools()) to avoid accidentally activating
 * learn tools that are not currently registered.
 */
function applyLearnState(pi: ExtensionAPI, enable: boolean): void {
	_lastLearnState = enable;
	const registered = new Set(getRegisteredIn(pi, LEARN_TOOL_NAMES));
	if (registered.size === 0) return;
	if (enable) {
		const current = pi.getActiveTools();
		pi.setActiveTools([...new Set([...current, ...registered])]);
	} else {
		// Remove learn tools from the *currently active* set
		const current = pi.getActiveTools();
		pi.setActiveTools(current.filter((name) => !registered.has(name)));
	}
}

// ── Test-only exports ──────────────────────────────────
// These are exported solely for unit testing.
// Do not import them directly from production code.
/** @internal */
export {
	getRegisteredIn,
	isBrowserEnabled,
	applyBrowserState,
	persistState,
	restoreFromBranch,
	readBrowserToggleConfig,
	applyConfigDefault,
	isLearnEnabled,
	applyLearnState,
	_resetToggleStateForTest,
};
export type { BrowserToggleState };

// ---- Profile & Cookies (extracted) ------------------------------

import { handleProfileSubcommand } from "./browser-profile.js";
import { handleCookiesSubcommand } from "./browser-cookies.js";
import { handleStatusSubcommand } from "./browser-status.js";

// ---- Internal helpers (used by delegated handlers) ---------------

/**
 * Set the conversation-scoped default profile.
 * Affects this conversation only; survives /reload, /resume, /fork.
 * "none" resets to the config-file default.
 */
function setConversationDefaultProfile(
	pi: ExtensionAPI,
	profile: string,
): void {
	if (profile === "none") {
		_conversationDefaultProfile = undefined;
	} else {
		_conversationDefaultProfile = profile;
	}

	// Persist so it survives /reload, /resume, /fork
	const currentState = getCurrentState(pi);
	persistState(pi, {
		...currentState,
		defaultProfile: profile,
	});
}

/** Read the current in-memory toggle state. */
function getCurrentState(
	pi: ExtensionAPI,
): Pick<BrowserToggleState, "browserToolsEnabled" | "learnToolsEnabled"> {
	return {
		browserToolsEnabled: isBrowserEnabled(pi),
		learnToolsEnabled: isLearnEnabled(pi),
	};
}

// ---- Toggle initializer ----------------------------------------

/**
 * Register the /web command and session-restoration hooks.
 * Called from pi-lean-portal's index.ts entry point.
 */
export default function initBrowserToggle(pi: ExtensionAPI) {
	// ── Commands ──────────────────────────────────────────────

	pi.registerCommand("web", {
		description:
			"Enable/disable browser automation tools. " +
			"Usage: /web on | off | learn | status",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();
			const hasBrowserTools =
				getRegisteredIn(pi, BROWSER_TOOL_NAMES).length > 0;

			if (!hasBrowserTools) {
				ctx.ui.notify(
					"🌐 pi-lean-portal extension not detected. Nothing to toggle.",
					"warning",
				);
				return;
			}

			if (cmd === "on") {
				applyBrowserState(pi, true);
				applyLearnState(pi, false);
				persistState(pi, {
					browserToolsEnabled: true,
					learnToolsEnabled: false,
					defaultProfile: _conversationDefaultProfile ?? "none",
				});
				ctx.ui.setStatus("browser", ctx.ui.theme.fg("accent", "●") + " idle");

				setSearchSlot(pi, ctx, ctx.ui.theme.fg("accent", "●") + " searxng");

				ctx.ui.notify(
					"🌐 Browser tools enabled. /web learn to make web-learn available.",
					"info",
				);
			} else if (cmd === "learn") {
				applyBrowserState(pi, true);
				applyLearnState(pi, true);
				persistState(pi, {
					browserToolsEnabled: true,
					learnToolsEnabled: true,
					defaultProfile: _conversationDefaultProfile ?? "none",
				});
				ctx.ui.setStatus("browser", ctx.ui.theme.fg("success", "●") + " idle");

				setSearchSlot(pi, ctx, ctx.ui.theme.fg("accent", "●") + " searxng");

				ctx.ui.notify(
					"📖 web-learn tool is now available. Agent will save/update guides when asked.",
					"info",
				);
			} else if (cmd === "off") {
				applyBrowserState(pi, false);
				applyLearnState(pi, false);
				persistState(pi, {
					browserToolsEnabled: false,
					learnToolsEnabled: false,
					defaultProfile: _conversationDefaultProfile ?? "none",
				});
				ctx.ui.setStatus("browser", "○ web off");

				setSearchSlot(pi, ctx, "○ searxng");

				ctx.ui.notify(
					"🌐 Browser tools disabled. /web on to re-enable.",
					"info",
				);
			} else if (cmd === "profile" || cmd.startsWith("profile ")) {
				const sub = cmd.slice("profile".length).trim();
				await handleProfileSubcommand(sub, ctx, pi, (profile: string) => {
					setConversationDefaultProfile(pi, profile);
				});
			} else if (cmd === "cookies" || cmd.startsWith("cookies ")) {
				const sub = cmd.slice("cookies".length).trim();
				await handleCookiesSubcommand(sub, ctx);
			} else if (cmd === "status") {
				handleStatusSubcommand(ctx, isBrowserEnabled(pi), isLearnEnabled(pi));
			} else {
				// Default: show status
				const browserStatus = isBrowserEnabled(pi) ? "✅ on" : "❌ off";
				const learnStatus = isLearnEnabled(pi) ? "✅ on" : "❌ off";
				ctx.ui.notify(
					`🌐 Browser tools: ${browserStatus}\n` +
						`📖 Learn mode: ${learnStatus}\n` +
						`   /web profile     manage browser profiles\n` +
						`   /web cookies     inspect or clear session cookies\n` +
						`   /web off         disable all browser tools\n` +
						`   /web on          enable browsing only\n` +
						`   /web learn       enable browsing + guide-saving\n` +
						`   /web status      detailed runtime status (sessions, plugins, profiles)\n` +
						`   /web             show this status`,
					"info",
				);
			}
		},
	});

	// ── State restoration across session boundaries ────────────
	// Ensures the toggle survives /reload, /resume, /fork, and
	// /tree navigation without "forgetting" whether we're on or off.
	//
	// For fresh sessions (no branch state), falls back to the config
	// default from settings.json (`browserToggle.defaultEnabled`).

	pi.on("session_start", async (_event, ctx) => {
		const restored = restoreFromBranch(pi, ctx);
		if (!restored) {
			// No persisted state in this branch → apply config file default
			applyConfigDefault(pi);
		}

		// After state restoration, ensure the search slot reflects the actual
		// toggle state.  Without this, a race between portal's session_start
		// (async — restores/applies state) and search's session_start (probes
		// health) can leave the search glyph showing blue when tools are off.
		const hasSiblingTools = getRegisteredIn(pi, SIBLING_TOOL_NAMES).length > 0;
		if (hasSiblingTools && !isBrowserEnabled(pi)) {
			ctx.ui.setStatus("search", "○ searxng");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(pi, ctx);
	});
}
