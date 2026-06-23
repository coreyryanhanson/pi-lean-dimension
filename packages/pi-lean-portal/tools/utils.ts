/**
 * Shared helpers for the pi-lean-portal tool definitions.
 *
 * Extracted from index.ts to avoid duplication across ~14 tool files.
 * Includes taskId resolution, status bar updates, and profile line formatting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getToggleState, getLearnState } from "../browser-toggle.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { taskId } from "../core/shared/task-id.js";

// ─── Status bar ─────────────────────────────────────────────────

/**
 * Retained reference to the most recent extension context for use by
 * the browser.profile event listener (which fires asynchronously from
 * tool execution contexts). Updated on session_start and cleared on
 * session_shutdown.
 */
let _lastCtx: {
	ui: {
		setStatus: (key: string, label: string) => void;
		theme: { fg: (c: string, t: string) => string };
	};
} | null = null;

/**
 * Update the TUI status bar with the current browser state.
 */
export function updateFooterStatus(ctx: {
	ui: {
		setStatus: (key: string, label: string) => void;
		theme: { fg: (c: string, t: string) => string };
	};
}): void {
	_lastCtx = ctx;
	const toggleState = getToggleState();
	if (toggleState === false) {
		ctx.ui.setStatus("browser", "○ web off");
		return;
	}
	const body = sessionManager.getStatus();
	const learn = getLearnState();
	const dot = ctx.ui.theme.fg(learn ? "success" : "accent", "●");
	ctx.ui.setStatus("browser", `${dot} ${body}`);
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

/**
 * Execute an interaction tool with standard boilerplate handling.
 *
 * Handles:
 * - taskId resolution from context
 * - Footer status update
 * - Error formatting with consistent pattern
 * - Snapshot and elementCount appending
 *
 * Each tool provides its router call and a formatSuccess callback that
 * returns the success message and details object.
 *
 * @param ctx - Extension tool execution context
 * @param actionName - Human-readable action name (e.g. "Click", "Type")
 * @param action - Async function that performs the router call with a resolved taskId
 * @param formatSuccess - Callback to produce the success message and details from the result
 */
export async function executeInteractionTool<
	T extends {
		success: boolean;
		error?: string;
		snapshot?: string;
		elementCount?: number;
	},
>(
	ctx: {
		ui: {
			setStatus: (key: string, label: string) => void;
			theme: { fg: (c: string, t: string) => string };
		};
		sessionManager?: { getSessionId?(): string };
	},
	actionName: string,
	action: (tid: string) => Promise<T>,
	formatSuccess: (result: T) => {
		message: string;
		details: Record<string, unknown>;
	},
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}> {
	const tid = taskId(ctx);
	const result = await action(tid);
	updateFooterStatus(ctx);

	if (!result.success) {
		return {
			content: [
				{
					type: "text",
					text: `${actionName} failed: ${result.error ?? "unknown"}`,
				},
			],
			details: { error: true },
		};
	}

	const { message, details } = formatSuccess(result);
	let content = message;
	if (result.snapshot) {
		content += `\n\n${result.snapshot}`;
	}
	if (result.elementCount !== undefined) {
		content += `\n\nInteractive elements: ${result.elementCount}`;
	}

	return {
		content: [{ type: "text", text: content }],
		details,
	};
}

export type { ExtensionAPI };
