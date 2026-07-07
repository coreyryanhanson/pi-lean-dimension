/**
 * MiniWoB++ trivial-solver suite — Firefox (Node) backend.
 *
 * Uses the public `registerMiniwobSuite` API from `pi-lean-host` with
 * the shipped FirefoxPlugin. Proves the firefox-ws attach kind works
 * end-to-end through the MiniWoB harness.
 *
 * ── Task breakdown ────────────────────────────────────────────────
 * Same as the chromium suite:
 * - 13 trivial-solver tasks run: 3 confident (reward > 0 asserted) +
 *   10 best-effort (pipeline smoke only)
 * - 77 element tasks skip with `needs goal-aware solver`
 * - 35 non-element tasks skip with missing-tool reason
 *
 * Run: npx vitest run packages/pi-lean-host/suites/miniwob-firefox.test.ts
 *
 * @module
 */

import { existsSync } from "node:fs";

import { firefox } from "playwright";
import { FirefoxPlugin } from "../../pi-lean-portal/backends/firefox/index.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";

import { registerMiniwobBackend } from "./miniwob-suite-helper.js";

// ─── Browser availability ────────────────────────────────────────

const FIREFOX_AVAILABLE = (() => {
	try {
		return existsSync(firefox.executablePath());
	} catch {
		return false;
	}
})();

// ─── Suite — register the firefox backend ────────────────────────

registerMiniwobBackend(
	"firefox",
	FIREFOX_AVAILABLE,
	async (): Promise<BrowserPlugin> => {
		const plugin = new FirefoxPlugin();
		await plugin.init({});
		return plugin;
	},
);
