/**
 * Chromium Plugin — Native Node backend using Playwright Chromium.
 *
 * Thin subclass of PlaywrightPluginBase. All shared logic lives in
 * backends/playwright-base/playwright-plugin.ts.
 *
 * Launches Chromium directly and drives its own page; the plugin is the
 * sole browser owner. No external-attach endpoint is exposed.
 */

import { chromium } from "playwright";
import type { Browser } from "playwright";
import { PlaywrightPluginBase } from "../playwright-base/playwright-plugin.js";
import { DEFAULT_CAPABILITIES } from "../../core/plugin-api.js";

export class ChromiumPlugin extends PlaywrightPluginBase {
	readonly name = "chromium";
	readonly capabilities = DEFAULT_CAPABILITIES;

	/** Hardcoded Chrome user-agent — no dynamic capture needed. */
	protected get userAgent(): string {
		return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
	}

	protected async launchBrowser(): Promise<Browser> {
		return chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
			],
		});
	}

	protected get installHint(): string {
		return "Browser not installed. Run: npx playwright install chromium firefox";
	}
}

export default ChromiumPlugin;
