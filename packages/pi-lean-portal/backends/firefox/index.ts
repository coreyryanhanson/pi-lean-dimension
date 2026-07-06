/**
 * Firefox Plugin — Native Node backend using Playwright Firefox.
 *
 * Thin subclass of PlaywrightPluginBase. All shared logic lives in
 * backends/playwright-base/playwright-plugin.ts.
 *
 * Uses probe-then-cache UA capture at first launch, with a hardcoded
 * fallback Firefox UA string. Launch args are empty — Firefox does
 * not accept Chromium sandbox flags.
 *
 */

import { firefox } from "playwright";
import type { Browser } from "playwright";
import { PlaywrightPluginBase } from "../playwright-base/playwright-plugin.js";
import {
	DEFAULT_CAPABILITIES,
	type PluginCapabilities,
} from "../../core/plugin-api.js";

// ─── Capabilities ──────────────────────────────────────────────────

const FIREFOX_CAPABILITIES: PluginCapabilities = {
	...DEFAULT_CAPABILITIES,
	engine: "firefox",
};

// ─── Hardcoded Firefox UA fallback (used when dynamic capture fails) ─

const FIREFOX_UA_FALLBACK =
	"Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0";

// ─── FirefoxPlugin ────────────────────────────────────────────────

export class FirefoxPlugin extends PlaywrightPluginBase {
	readonly name = "firefox";
	readonly capabilities = FIREFOX_CAPABILITIES;

	/** Opt into probe-then-cache UA capture at lazy browser init. */
	protected readonly captureUserAgent: boolean = true;

	/**
	 * Hardcoded fallback Firefox user-agent.
	 * Used only if the dynamic UA capture (about:blank probe) fails.
	 */
	protected get userAgent(): string {
		return FIREFOX_UA_FALLBACK;
	}

	protected async launchBrowser(): Promise<Browser> {
		return firefox.launch({
			headless: true,
		});
	}

	protected get installHint(): string {
		return "Browser not installed. Run: npx playwright install chromium firefox";
	}
}

export default FirefoxPlugin;
