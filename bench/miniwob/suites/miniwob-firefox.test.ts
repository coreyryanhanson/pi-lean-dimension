/**
 * MiniWoB++ trivial-solver suite — Firefox (Node) backend.
 *
 * Uses the `registerMiniwobSuite` API from `bench/miniwob/solvers/register-suite.js` with
 * the shipped `FirefoxPlugin`. Proves the plugin.evaluate episode
 * lifecycle works end-to-end through the MiniWoB harness with the
 * Firefox engine.
 *
 * For the task breakdown (13 puzzle-solved / 82 no-solver / 35 non-element),
 * see the `registerMiniwobBackend` doc comment in `miniwob-suite-helper.ts`.
 *
 * Run: npx vitest run bench/miniwob/suites/miniwob-firefox.test.ts
 *
 * @module
 */

import { existsSync } from "node:fs";

import { firefox } from "playwright";
import { FirefoxPlugin } from "../../../packages/pi-lean-portal/backends/firefox/index.js";
import type { BrowserPlugin } from "../../../packages/pi-lean-portal/core/plugin-api.js";

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
