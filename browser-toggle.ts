import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Browser Toggle — integrated into pi-browser extension.
 *
 * Provides /web on, /web off, and /web status commands to enable / disable
 * all browser automation tools in the system prompt.
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

// ---- Constants -------------------------------------------------

/** Names of every tool registered by pi-browser's index.ts */
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
]);

/** Persisted state shape */
interface BrowserToggleState {
	enabled: boolean;
}

/** Last known toggle state — used by status bar */
let _lastToggleState = true;

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
function persistState(pi: ExtensionAPI, enabled: boolean): void {
	pi.appendEntry<BrowserToggleState>("browser-toggle-state", { enabled });
}

// ---- Branch-aware restoration ----------------------------------

function restoreFromBranch(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const registered = getRegisteredBrowserTools(pi);
	if (registered.length === 0) return;

	let savedState: BrowserToggleState | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type === "custom" &&
			entry.customType === "browser-toggle-state"
		) {
			savedState = entry.data as BrowserToggleState;
		}
	}

	if (savedState !== undefined) {
		applyBrowserState(pi, savedState.enabled);
	}
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

export {
	getRegisteredBrowserTools,
	isBrowserEnabled,
	applyBrowserState,
	persistState,
	restoreFromBranch,
};
export type { BrowserToggleState };

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
			"Usage: /web on | off | status",
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
				if (isBrowserEnabled(pi)) {
					ctx.ui.notify("🌐 Browser tools are already enabled", "info");
					return;
				}
				applyBrowserState(pi, true);
				persistState(pi, true);
				ctx.ui.setStatus("browser", "🌐 idle");
				ctx.ui.notify(
					"🌐 Browser tools enabled (saves ~1500–2000 tokens when off)",
					"info",
				);
			} else if (cmd === "off") {
				if (!isBrowserEnabled(pi)) {
					ctx.ui.notify("🌐 Browser tools are already disabled", "info");
					return;
				}
				applyBrowserState(pi, false);
				persistState(pi, false);
				ctx.ui.setStatus("browser", "○ web off");
				ctx.ui.notify(
					"🌐 Browser tools disabled. Use  /web on  to re-enable.",
					"info",
				);
			} else {
				// Default: show status
				const status = isBrowserEnabled(pi) ? "✅ on" : "❌ off";
				const count = getRegisteredBrowserTools(pi).length;
				ctx.ui.notify(
					`🌐 Browser tools: ${status}  (${count} tools registered)\n` +
						`   /web on   enable browser tools\n` +
						`   /web off  disable browser tools\n` +
						`   /web      show this status`,
					"info",
				);
			}
		},
	});

	// ── State restoration across session boundaries ────────────
	// Ensures the toggle survives /reload, /resume, /fork, and
	// /tree navigation without "forgetting" whether we're on or off.

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(pi, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(pi, ctx);
	});
}
