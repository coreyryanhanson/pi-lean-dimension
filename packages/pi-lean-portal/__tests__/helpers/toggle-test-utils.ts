/**
 * Test utilities for browser-toggle.ts.
 *
 * Re-exports internal functions for isolated unit testing without
 * polluting browser-toggle.ts's public API surface.
 *
 * ── Usage ─────────────────────────────────────────────
 *
 *   import browserToggle from "../browser-toggle";
 *   import { getRegisteredBrowserTools, ... } from "./helpers/toggle-test-utils";
 *
 * These are NOT part of the production API — do not import
 * from this file in production code.
 */

export {
	getRegisteredBrowserTools,
	isBrowserEnabled,
	applyBrowserState,
	persistState,
	restoreFromBranch,
	readBrowserToggleConfig,
	applyConfigDefault,
	getRegisteredLearnTools,
	getRegisteredSiblingTools,
	isLearnEnabled,
	applyLearnState,
	_resetToggleStateForTest,
} from "../../browser-toggle.js";

export type { BrowserToggleState } from "../../browser-toggle.js";
