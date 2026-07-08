/**
 * MiniWoB++ trivial-solver suite — Chromium (Node) backend.
 *
 * Phase 1: chromium Node backend (plugin-owns-browser, plugin.evaluate
 * episode lifecycle — no cross-process attach).
 * Phase 2: chromium-py, firefox-py (Python bridge backends) — see
 * miniwob-chromium-py.test.ts and miniwob-firefox-py.test.ts.
 * Phase 3: CI cross-engine setup.
 *
 * Uses the public `registerMiniwobSuite` + `runMiniwobTask` API from
 * `pi-lean-host` — the same API a user-owned parity test file would
 * import. This proves the public API is the same code path the shipped
 * tests exercise.
 *
 * ── Task breakdown ────────────────────────────────────────────────
 * - 13 trivial-solver tasks run: 3 confident (reward > 0 asserted) +
 *   10 best-effort (pipeline smoke only)
 * - 82 element tasks skip with `needs goal-aware solver (Step 2 follow-up)`
 * - 35 non-element tasks skip with missing-tool reason
 * ── 13 + 82 + 35 = 130, matching the MiniWoB++ task count (the older
 *     generator only picked up 125; regenerating from the pinned commit
 *     now correctly reads all 130 task HTML files). ────────────────
 *
 * Run: npx vitest run packages/pi-lean-host/suites/miniwob-trivial.test.ts
 *
 * @module
 */

import { existsSync } from "node:fs";

import { chromium } from "playwright";
import { ChromiumPlugin } from "../../pi-lean-portal/backends/chromium/index.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";

import { registerMiniwobBackend } from "./miniwob-suite-helper.js";

// ─── Browser availability ────────────────────────────────────────

const CHROMIUM_AVAILABLE = (() => {
	try {
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
})();

// ─── Suite — register the chromium backend ───────────────────────

registerMiniwobBackend(
	"chromium",
	CHROMIUM_AVAILABLE,
	async (): Promise<BrowserPlugin> => {
		const plugin = new ChromiumPlugin();
		await plugin.init({});
		return plugin;
	},
);
