/**
 * Firefox Plugin — Native Node backend using Playwright Firefox.
 *
 * Thin subclass of PlaywrightPluginBase. All shared logic lives in
 * backends/playwright-base/playwright-plugin.ts.
 *
 * Uses `firefox.launchServer()` + `firefox.connect(wsEndpoint)` so an
 * external client (`pi-lean-host`'s MiniWoB++ driver) can attach over
 * the WebSocket endpoint (Mode A — plugin-owns-browser, ws variant).
 * The `launchServer` path is the default — `firefox.connect(wsEndpoint)`
 * returns a normal Browser that works identically to `firefox.launch()`,
 * so portal browsing is unaffected.
 *
 * Uses probe-then-cache UA capture at first launch, with a hardcoded
 * fallback Firefox UA string.
 */

import { firefox } from "playwright";
import type { Browser, BrowserServer } from "playwright";
import { PlaywrightPluginBase } from "../playwright-base/playwright-plugin.js";
import {
	DEFAULT_CAPABILITIES,
	type PluginCapabilities,
	type AttachEndpoint,
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
		const server: BrowserServer = await firefox.launchServer({
			headless: true,
		});
		this._browserServer = server;
		this._wsEndpoint = server.wsEndpoint();
		return firefox.connect(this._wsEndpoint);
	}

	/**
	 * Reconnect to the launchServer after the connected Browser
	 * disconnects. The server stays up across Browser disconnects, so a
	 * fresh `connect(wsEndpoint)` recovers without relaunching. Only
	 * called by the base when `_browserServer` is non-null.
	 */
	protected async _reconnectBrowser(): Promise<Browser> {
		if (!this._wsEndpoint) {
			throw new Error(
				"firefox: cannot reconnect — no wsEndpoint cached " +
					"(launchServer not active)",
			);
		}
		return firefox.connect(this._wsEndpoint);
	}

	/**
	 * Attach endpoint for external clients (firefox-ws, firefox family).
	 * Returns `{ kind: "firefox-ws", endpoint: "ws://..." }` once the
	 * launchServer has started, or `null` before launch.
	 */
	getAttachEndpoint(): AttachEndpoint | null {
		return this._wsEndpoint
			? { kind: "firefox-ws", endpoint: this._wsEndpoint }
			: null;
	}

	protected get installHint(): string {
		return "Browser not installed. Run: npx playwright install chromium firefox";
	}
}

export default FirefoxPlugin;
