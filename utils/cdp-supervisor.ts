/**
 * CDP Supervisor — handles JavaScript dialogs and browser events.
 *
 * Automatically dismisses alert/confirm/prompt dialogs and logs them
 * for the user to see. Also handles page crash and unresponsive events.
 *
 * Works with both Playwright (Chromium) and stealth (Firefox) backends.
 */

import type { Page, BrowserContext } from "playwright";

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
  type: "log" | "warn" | "error" | "info" | "debug" | "dir" | "trace" | "assert";
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

/** Clear dialog log for a task */
export function clearDialogLog(taskId: string): void {
  _dialogLog.delete(taskId);
}

/** Get console messages for a task */
export function getConsoleLog(taskId: string): ConsoleEvent[] {
  return _consoleLog.get(taskId) ?? [];
}

/** Clear console log for a task */
export function clearConsoleLog(taskId: string): void {
  _consoleLog.delete(taskId);
}

/** Clear all logs for a task (dialogs + console) */
export function clearAllLogs(taskId: string): void {
  _dialogLog.delete(taskId);
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

/**
 * Install dialog handlers on a BrowserContext (for contexts where we
 * want to catch dialogs on any page in the context).
 */
export function installContextDialogHandlers(taskId: string, context: BrowserContext): void {
  context.on("page", (page) => {
    installDialogHandlers(taskId, page);
  });
}

/**
 * Format dialog log entries for display to the user.
 */
export function formatDialogLog(taskId: string): string {
  const log = getDialogLog(taskId);
  if (log.length === 0) return "";

  return log
    .map((d) => {
      const prefix = d.type === "alert" ? "📢" : d.type === "confirm" ? "❓" : "💬";
      return `${prefix} [${d.type}] ${d.message} (auto-${d.handledAs})`;
    })
    .join("\n");
}

/**
 * Format console log entries for display in tool output.
 * Returns the most recent messages (up to `max`), oldest first.
 */
export function formatConsoleLog(taskId: string, max: number = 50): string {
  const log = getConsoleLog(taskId);
  if (log.length === 0) return "";

  const recent = log.slice(-max);
  return recent
    .map((c) => {
      const icon = c.type === "error" ? "❌" : c.type === "warn" ? "⚠️" : c.type === "info" ? "ℹ️" : "📋";
      return `${icon} [${c.type}] ${c.text}`;
    })
    .join("\n");
}
