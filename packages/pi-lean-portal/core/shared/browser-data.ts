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

// ─── Validation ────────────────────────────────────────────────────────

const _data = _raw as BrowserDataFile;

function fail(msg: string): never {
	throw new Error(`[pi-lean-portal] browser-data.json: ${msg}`);
}

function isNonEmptyRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((e) => typeof e === "string");
}

// Top-level
if (typeof _data.version !== "number" || _data.version < 1) {
	fail(`invalid or missing version (got ${_data.version})`);
}
if (!isNonEmptyRecord(_data.botSignals))
	fail("missing or invalid 'botSignals' section");
if (!isNonEmptyRecord(_data.accessibility))
	fail("missing or invalid 'accessibility' section");
if (!isNonEmptyRecord(_data.navSettle))
	fail("missing or invalid 'navSettle' section");

// botSignals
for (const key of [
	"blockSignals",
	"bodyOnlySignals",
	"bodyOnlyPatterns",
	"htmlSignals",
] as const) {
	if (!isStringArray(_data.botSignals[key])) {
		fail(`'botSignals.${key}' must be a string array`);
	}
}

// accessibility
if (!isStringArray(_data.accessibility.interactiveRoles)) {
	fail("'accessibility.interactiveRoles' must be a string array");
}
if (!isStringArray(_data.accessibility.informationalRoles)) {
	fail("'accessibility.informationalRoles' must be a string array");
}
if (!isNonEmptyRecord(_data.accessibility.roleIcons)) {
	fail("'accessibility.roleIcons' must be a non-null object");
}

// navSettle
const ns = _data.navSettle;
if (typeof ns.navTimeoutMs !== "number")
	fail("'navSettle.navTimeoutMs' must be a number");
if (typeof ns.settleTimeoutMs !== "number")
	fail("'navSettle.settleTimeoutMs' must be a number");
if (typeof ns.settleRaceMs !== "number")
	fail("'navSettle.settleRaceMs' must be a number");
if (typeof ns.domStabilizationJs !== "string")
	fail("'navSettle.domStabilizationJs' must be a string");

// ─── Exports ───────────────────────────────────────────────────────────

export const BOT_SIGNALS: BotSignals = _data.botSignals;
export const ACCESSIBILITY: AccessibilityData = _data.accessibility;
export const NAV_SETTLE: NavSettleData = _data.navSettle;
