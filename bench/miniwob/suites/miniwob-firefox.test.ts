/** MiniWoB++ trivial-solver suite — Firefox (Node) backend. */

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
