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
 * Phase 1.5 (`browsergym-migration-phase-1.5.md` §2.1): optionally
 * launches Firefox via `firefox.launchServer()` + `firefox.connect(ws)`
 * so an external client (`pi-lean-host`'s BrowserGym bridge) can attach
 * over the WebSocket endpoint (Mode A — plugin-owns-browser, ws
 * variant). The launchServer path is feature-flagged behind
 * `BROWSER_FIREFOX_LAUNCH_SERVER=1` (default off) — existing firefox
 * usage runs the unchanged `firefox.launch()` path. When the flag is
 * set, `getWsEndpoint()` returns the server's `ws://` URL for external
 * attach; otherwise it returns null.
 */

import { firefox } from "playwright";
import type { Browser, BrowserServer } from "playwright";
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
		// Feature-flagged launchServer path (Phase 1.5). Default off →
		// existing firefox usage runs the unchanged `firefox.launch()`
		// path. The host opts in via `BROWSER_FIREFOX_LAUNCH_SERVER=1`
		// when running the MiniWoB bench so the BrowserGym bridge can
		// attach over the WebSocket endpoint.
		if (process.env.BROWSER_FIREFOX_LAUNCH_SERVER !== "1") {
			return firefox.launch({ headless: true });
		}

		const server: BrowserServer = await firefox.launchServer({
			headless: true,
		});
		// Cache the server + wsEndpoint on the base so cleanupAll closes
		// the server and the disconnected handler reconnects instead of
		// relaunching. The base wires the server `close` handler in
		// `_newBrowserContext` once it sees `_browserServer` non-null.
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
	 * WebSocket endpoint for BrowserGym / external attach (Mode A, ws
	 * variant). Returns the server's `ws://` URL once the launchServer
	 * path is active and the browser has launched, or `null` otherwise
	 * (default `firefox.launch()` path, or before launch). External
	 * callers must guard with `typeof plugin.getWsEndpoint === "function"`.
	 */
	getWsEndpoint(): string | null {
		return this._wsEndpoint;
	}

	protected get installHint(): string {
		return "Browser not installed. Run: npx playwright install chromium firefox";
	}
}

export default FirefoxPlugin;
