/**
 * Typed loader for shared browser data (bot-detection signals,
 * accessibility roles/icons, nav-settle constants).
 *
 * Imports from the sibling JSON file so the same source of truth is
 * available to both TypeScript and Python consumers.  The import
 * assertion ensures the JSON is loaded directly — no runtime path
 * resolution needed, which keeps vitest and the pi runtime happy.
 *
 * @module
 */

import _raw from "./browser-data.json" with { type: "json" };

// ─── Types ─────────────────────────────────────────────────────────────

export interface BotSignals {
	blockSignals: string[];
	bodyOnlySignals: string[];
	bodyOnlyPatterns: string[];
	htmlSignals: string[];
}

export interface AccessibilityData {
	interactiveRoles: string[];
	informationalRoles: string[];
	roleIcons: Record<string, string>;
}

export interface NavSettleData {
	navTimeoutMs: number;
	settleTimeoutMs: number;
	settleRaceMs: number;
	domStabilizationJs: string;
}

export interface BrowserDataFile {
	version: number;
	botSignals: BotSignals;
	accessibility: AccessibilityData;
	navSettle: NavSettleData;
}

const _data = _raw as BrowserDataFile;

// ─── Exports ───────────────────────────────────────────────────────────

export const BOT_SIGNALS: BotSignals = _data.botSignals;
export const ACCESSIBILITY: AccessibilityData = _data.accessibility;
export const NAV_SETTLE: NavSettleData = _data.navSettle;
