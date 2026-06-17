/**
 * Shared helpers for the pi-browser tool definitions.
 *
 * Extracted from index.ts to avoid duplication across ~14 tool files.
 * Includes taskId resolution, status bar updates, and profile line formatting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getToggleState } from "../browser-toggle.js";
import { sessionManager } from "../core/shared/session-manager.js";

// ─── Status bar ─────────────────────────────────────────────────

/**
 * Retained reference to the most recent extension context for use by
 * the browser.profile event listener (which fires asynchronously from
 * tool execution contexts). Updated on session_start and cleared on
 * session_shutdown.
 */
let _lastCtx: {
	ui: { setStatus: (key: string, label: string) => void };
} | null = null;

/**
 * Update the TUI status bar with the current browser state.
 */
export function updateFooterStatus(ctx: {
	ui: { setStatus: (key: string, label: string) => void };
}): void {
	_lastCtx = ctx;
	const toggleState = getToggleState();
	if (toggleState === false) {
		ctx.ui.setStatus("browser", "○ web off");
	} else {
		ctx.ui.setStatus("browser", sessionManager.getStatus());
	}
}

/** @internal — used by index.ts's profile event listener */
export function getLastCtx(): typeof _lastCtx {
	return _lastCtx;
}

/** @internal — set by index.ts on startup/shutdown */
export function setLastCtx(ctx: typeof _lastCtx): void {
	_lastCtx = ctx;
}

// ─── Profile line formatting ────────────────────────────────────

/**
 * Format the profile line for browser-navigate output.
 *
 * Examples:
 *   Profile: none
 *   Profile: session (this conversation)
 *   Profile: work (shared)
 */
export function profileLine(result: {
	profileMode?: string;
	profileName?: string;
}): string {
	const mode = result.profileMode;
	if (mode === "none") {
		return "Profile: none";
	}
	if (mode === "session") {
		return "Profile: session (this conversation)";
	}
	// Named profile
	return `Profile: ${result.profileName ?? "unnamed"} (shared)`;
}

export type { ExtensionAPI };
