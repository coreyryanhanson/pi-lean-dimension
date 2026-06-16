import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
// fs functions used by profile/cookies handlers are in their respective modules

/**
 * Browser Toggle — integrated into pi-browser extension.
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

/** Names of every browser browsing tool registered by pi-browser's index.ts (excludes learn tools). */
const BROWSER_TOOL_NAMES = new Set([
	"web-fetch",
	"browser-navigate",
	"browser-snapshot",
	"browser-click",
	"browser-type",
	"browser-scroll",
	"browser-screenshot",
	"browser-get-images",
	"browser-back",
	"browser-press",
	"browser-console",
	"browser-inspect",
	"web-guide",
]);

/** Names of learn tools (web-learn) that require /web learn to be active. */
const LEARN_TOOL_NAMES = new Set(["web-learn"]);

/** Persisted state shape — two independent booleans plus conversation-scoped default profile. */
interface BrowserToggleState {
	browserToolsEnabled: boolean;
	learnToolsEnabled: boolean;
	/** Default profile for the current conversation. "none" means no override. */
	defaultProfile: string;
}

/** Last known toggle state — used by status bar */
let _lastToggleState = true;

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

/**
 * Return the subset of BROWSER_TOOL_NAMES that are actually registered.
 * This safely handles the case where pi-browser is not installed.
 * (With the toggle integrated into pi-browser, this is always non-empty
 *  when pi-browser is loaded, but the helper remains for robustness.)
 */
function getRegisteredBrowserTools(pi: ExtensionAPI): string[] {
	return pi
		.getAllTools()
		.map((t) => t.name)
		.filter((n) => BROWSER_TOOL_NAMES.has(n));
}

/**
 * Check whether browser tools are currently active in the system prompt.
 * Returns true when no browser tools exist (nothing to toggle).
 */
function isBrowserEnabled(pi: ExtensionAPI): boolean {
	const registered = getRegisteredBrowserTools(pi);
	if (registered.length === 0) return true; // nothing registered → vacuously "enabled"

	const active = new Set(pi.getActiveTools());
	return registered.some((name) => active.has(name));
}

/**
 * Apply a browser-tool state without persisting.
 * @param pi       ExtensionAPI
 * @param enable   true = add browser tools to the active set, false = remove them
 */
function applyBrowserState(pi: ExtensionAPI, enable: boolean): void {
	const registered = new Set(getRegisteredBrowserTools(pi));
	if (registered.size === 0) return;
	_lastToggleState = enable;

	if (enable) {
		// Merge browser tools back into whatever is currently active
		const current = pi.getActiveTools();
		pi.setActiveTools([...new Set([...current, ...registered])]);
	} else {
		// Keep everything that is NOT a browser tool
		const all = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(all.filter((name) => !registered.has(name)));
	}
}

/**
 * Persist the current toggle state into the session for branch-aware
 * restoration across /reload, /resume, /fork, and /tree navigation.
 */
function persistState(pi: ExtensionAPI, state: BrowserToggleState): void {
	pi.appendEntry<BrowserToggleState>("browser-toggle-state", state);
}

// ---- Branch-aware restoration ----------------------------------

/**
 * Migrate a legacy {enabled: boolean} state to the new three-field schema.
 */
function migrateLegacyState(data: unknown): BrowserToggleState | null {
	if (data && typeof data === "object" && "enabled" in data) {
		const enabled = (data as Record<string, unknown>).enabled === true;
		return {
			browserToolsEnabled: enabled,
			learnToolsEnabled: enabled,
			defaultProfile: "none",
		};
	}
	// Also handle the two-boolean schema (missing defaultProfile)
	if (
		data &&
		typeof data === "object" &&
		typeof (data as Record<string, unknown>).browserToolsEnabled === "boolean"
	) {
		return {
			browserToolsEnabled: (data as Record<string, unknown>)
				.browserToolsEnabled as boolean,
			learnToolsEnabled:
				((data as Record<string, unknown>).learnToolsEnabled as boolean) ??
				false,
			defaultProfile:
				((data as Record<string, unknown>).defaultProfile as string) ?? "none",
		};
	}
	return null;
}

function restoreFromBranch(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	const registered = getRegisteredBrowserTools(pi);
	if (registered.length === 0) return false;

	let savedState: BrowserToggleState | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type === "custom" &&
			entry.customType === "browser-toggle-state"
		) {
			const data = entry.data as Record<string, unknown>;
			// Try new schema first, then legacy
			if (data && typeof data.browserToolsEnabled === "boolean") {
				savedState = data as unknown as BrowserToggleState;
			} else {
				savedState = migrateLegacyState(data) ?? undefined;
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
// wires the toggle into pi-browser's runtime.

/**
 * Return the last known toggle state (true = enabled, false = disabled).
 * Returns true initially at startup (browser tools start enabled).
 */
export function getToggleState(): boolean {
	return _lastToggleState;
}

/** @internal Exported for testing only: reset the toggle tracker to its default */
export function _resetToggleStateForTest(): void {
	_lastToggleState = true;
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
 * Return the subset of LEARN_TOOL_NAMES that are actually registered.
 */
function getRegisteredLearnTools(pi: ExtensionAPI): string[] {
	return pi
		.getAllTools()
		.map((t) => t.name)
		.filter((n) => LEARN_TOOL_NAMES.has(n));
}

/**
 * Check whether learn tools are currently active.
 * Returns true when no learn tools exist (vacuously enabled).
 */
function isLearnEnabled(pi: ExtensionAPI): boolean {
	const registered = getRegisteredLearnTools(pi);
	if (registered.length === 0) return true;
	const active = new Set(pi.getActiveTools());
	return registered.some((name) => active.has(name));
}

/**
 * Apply a learn-tool state without persisting.
 * Uses getActiveTools() (not getAllTools()) to avoid accidentally activating
 * learn tools that are not currently registered.
 */
function applyLearnState(pi: ExtensionAPI, enable: boolean): void {
	const registered = new Set(getRegisteredLearnTools(pi));
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

export {
	getRegisteredBrowserTools,
	isBrowserEnabled,
	applyBrowserState,
	persistState,
	restoreFromBranch,
	readBrowserToggleConfig,
	applyConfigDefault,
	getRegisteredLearnTools,
	isLearnEnabled,
	applyLearnState,
	migrateLegacyState,
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
 * Called from pi-browser's index.ts entry point.
 */
export default function initBrowserToggle(pi: ExtensionAPI) {
	// ── Commands ──────────────────────────────────────────────

	pi.registerCommand("web", {
		description:
			"Enable/disable browser automation tools. " +
			"Usage: /web on | off | learn | status",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();
			const hasBrowserTools = getRegisteredBrowserTools(pi).length > 0;

			if (!hasBrowserTools) {
				ctx.ui.notify(
					"🌐 pi-browser extension not detected. Nothing to toggle.",
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
				ctx.ui.setStatus("browser", "🌐 idle");
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
				ctx.ui.setStatus("browser", "🌐 idle");
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
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(pi, ctx);
	});
}
