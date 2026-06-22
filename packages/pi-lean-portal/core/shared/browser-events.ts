/**
 * Browser Event Supervisor — handles JavaScript dialogs and browser events.
 *
 * Automatically dismisses alert/confirm/prompt dialogs and logs them
 * for the user to see. Also handles page crash and unresponsive events.
 *
 * Playwright-generic — lives in core/shared so all Playwright-based
 * backends (chromium, firefox, etc.) share the same handler logic.
 */

import type { Page } from "playwright";

export interface DialogEvent {
	type: "alert" | "confirm" | "prompt" | "beforeunload";
	message: string;
	/** Default value for prompt dialogs */
	defaultValue?: string;
	/** How the dialog was handled */
	handledAs: "accepted" | "dismissed";
	timestamp: number;
}

export interface ConsoleEvent {
	type:
		| "log"
		| "warn"
		| "error"
		| "info"
		| "debug"
		| "dir"
		| "trace"
		| "assert";
	text: string;
	timestamp: number;
}

/** Dialogs logged per task, for reporting to user */
const _dialogLog = new Map<string, DialogEvent[]>();

/** Console messages logged per task */
const _consoleLog = new Map<string, ConsoleEvent[]>();

/** Get logged dialogs for a task */
export function getDialogLog(taskId: string): DialogEvent[] {
	return _dialogLog.get(taskId) ?? [];
}

/** Get console messages for a task */
export function getConsoleLog(taskId: string): ConsoleEvent[] {
	return _consoleLog.get(taskId) ?? [];
}

/** Clear console log for a task */
export function clearConsoleLog(taskId: string): void {
	_consoleLog.delete(taskId);
}

/**
 * Install dialog and console handlers on a Playwright page.
 * Automatically accepts all dialogs (alert, confirm, prompt) and logs them.
 * Captures console messages (log, warn, error, info, debug) for retrieval.
 */
export function installDialogHandlers(taskId: string, page: Page): void {
	const dialogLog: DialogEvent[] = [];
	_dialogLog.set(taskId, dialogLog);

	const consoleLog: ConsoleEvent[] = [];
	_consoleLog.set(taskId, consoleLog);

	// Auto-accept JavaScript dialogs
	page.on("dialog", async (dialog) => {
		const entry: DialogEvent = {
			type: dialog.type() as DialogEvent["type"],
			message: dialog.message(),
			defaultValue: dialog.defaultValue(),
			handledAs: "accepted",
			timestamp: Date.now(),
		};

		try {
			await dialog.accept();
		} catch {
			entry.handledAs = "dismissed";
		}

		dialogLog.push(entry);
	});

	// Capture console messages
	page.on("console", (msg) => {
		const type = msg.type() as ConsoleEvent["type"];
		if (consoleLog.length >= 500) {
			consoleLog.shift(); // Ring buffer: keep latest 500
		}
		consoleLog.push({
			type,
			text: msg.text(),
			timestamp: Date.now(),
		});
	});

	// Handle page crashes
	page.on("crash", () => {
		dialogLog.push({
			type: "alert",
			message: "⚠ Page crashed",
			handledAs: "dismissed",
			timestamp: Date.now(),
		});
	});
}
