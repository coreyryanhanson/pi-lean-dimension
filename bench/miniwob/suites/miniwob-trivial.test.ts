/** MiniWoB++ trivial-solver suite — Chromium (Node) backend. */

import { existsSync } from "node:fs";

import { chromium } from "playwright";
import { ChromiumPlugin } from "../../../packages/pi-lean-portal/backends/chromium/index.js";
import type { BrowserPlugin } from "../../../packages/pi-lean-portal/core/plugin-api.js";

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
