/**
 * Chromium Plugin — Native Node backend using Playwright Chromium.
 *
 * Thin subclass of PlaywrightPluginBase. All shared logic lives in
 * backends/playwright-base/playwright-plugin.ts.
 *
 * Launches Chromium with `--remote-debugging-port=0` and discovers the
 * OS-assigned CDP port via `ss -tlnp` (Linux) / `CDP_PORT` env fallback,
 * exposing it through `getCdpEndpoint()` so an external CDP client can
 * attach. The debug port is harmless for normal portal use; it simply
 * allows an external CDP client to attach.
 */

import { chromium } from "playwright";
import type { Browser } from "playwright";
import { PlaywrightPluginBase } from "../playwright-base/playwright-plugin.js";
import { resolveCdpEndpoint } from "../../core/shared/cdp-endpoint.js";
import {
	DEFAULT_CAPABILITIES,
	type PluginCapabilities,
} from "../../core/plugin-api.js";

// ─── Capabilities ──────────────────────────────────────────────────

const CHROMIUM_CAPABILITIES: PluginCapabilities = {
	...DEFAULT_CAPABILITIES,
};

// ─── ChromiumPlugin ───────────────────────────────────────────────

export class ChromiumPlugin extends PlaywrightPluginBase {
	readonly name = "chromium";
	readonly capabilities = CHROMIUM_CAPABILITIES;

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
				// Expose a CDP endpoint for external attach. Port 0 → OS assigns
				// a free port; the actual port is discovered in onBrowserLaunched()
				// via `ss -tlnp` (Linux) or `CDP_PORT` env (non-Linux fallback).
				// Harmless for normal portal use — just opens a debug port.
				"--remote-debugging-port=0",
				// Bind the debug endpoint to loopback only — never expose it
				// on a network interface. (Chrome's default for port 0 is
				// already loopback, but be explicit for defense-in-depth.)
				"--remote-debugging-address=127.0.0.1",
			],
		});
	}

	protected get installHint(): string {
		return "Browser not installed. Run: npx playwright install chromium firefox";
	}

	/**
	 * Post-launch: discover the CDP endpoint and cache it in
	 * `_cdpEndpoint` so `getCdpEndpoint()` can return it synchronously.
	 *
	 * Both candidate process names are passed to a single
	 * `resolveCdpEndpoint` call so one `ss` pass checks either name —
	 * avoids up to 15s of dead polling when the process is named
	 * `chromium` rather than `chrome-headless`.
	 *
	 * Swallowed errors leave `_cdpEndpoint` null — Mode A attach is
	 * unavailable for that session but normal browsing is unaffected.
	 * The base class also catches and logs, but we swallow here too so
	 * a missing `ss` binary (e.g. macOS dev) never even logs a warning
	 * during normal browsing — only when a `CDP_PORT` isn't set AND the
	 * caller actually tries to use `getCdpEndpoint()`.
	 */
	protected async onBrowserLaunched(): Promise<void> {
		// `chrome-headless` is Playwright's bundled Chromium executable name
		// on Linux; `chromium` covers system-Chromium. Both are checked in
		// one `ss` pass. `resolveCdpEndpoint` tries `CDP_PORT` env first,
		// then scans.
		const endpoint = await resolveCdpEndpoint({
			processNames: ["chrome-headless", "chromium"],
		});
		if (endpoint) {
			this._cdpEndpoint = endpoint;
		}
		// No endpoint found — leave _cdpEndpoint null. getCdpEndpoint()
		// will return null and Mode A callers will fall back to Mode B
		// or skip. Normal portal use is unaffected.
	}

	/**
	 * CDP endpoint for external attach.
	 * Returns `http://127.0.0.1:<port>` once the browser has launched
	 * and the port has been discovered, or `null` before launch / on
	 * platforms where discovery failed and no `CDP_PORT` was set.
	 */
	getCdpEndpoint(): string | null {
		return this._cdpEndpoint;
	}
}

export default ChromiumPlugin;
