/**
 * MiniWoB++ trivial-solver suite — Chromium (Node) backend.
 *
 * Uses the public `registerMiniwobSuite` API from `pi-lean-host` with
 * the shipped `ChromiumPlugin`. Proves the plugin.evaluate episode
 * lifecycle works end-to-end through the MiniWoB harness with the
 * Chromium engine.
 *
 * For the task breakdown (13 puzzle-solved / 82 no-solver / 35 non-element),
 * see the `registerMiniwobBackend` doc comment in `miniwob-suite-helper.ts`.
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
