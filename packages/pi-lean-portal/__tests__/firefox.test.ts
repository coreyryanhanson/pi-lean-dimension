/**
 * FirefoxPlugin contract tests.
 *
 * Runs the shared `runContractTests` suite against the Node Firefox backend.
 * Skips automatically when Playwright Firefox is unavailable (no browser installed).
 *
 * Phase 1.5 (`browsergym-migration-phase-1.5.md` §2.1): a second describe block
 * exercises the feature-flagged `launchServer` path
 * (`BROWSER_FIREFOX_LAUNCH_SERVER=1`). It verifies `getWsEndpoint()` returns a
 * connectable `ws://` URL and that a second `playwright.firefox.connect()`
 * (simulating the BrowserGym bridge) succeeds. The default-path contract
 * suite above runs the unchanged `firefox.launch()` path.
 */

import { existsSync } from "node:fs";
import { firefox } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runContractTests } from "./helpers/plugin-contract.js";
import { startTestServer, type TestServer } from "./helpers/test-server.js";
import { FirefoxPlugin } from "../backends/firefox/index.js";

function createFirefoxPlugin(): FirefoxPlugin {
	return new FirefoxPlugin();
}

// Whether Playwright Firefox is installed on disk. `executablePath()`
// returns a path even when the browser hasn't been installed, so we
// check the file exists. Shared by the default-path suite below and
// the Phase 1.5 launchServer suite.
const firefoxInstalled = (() => {
	try {
		const ffPath = firefox.executablePath();
		return existsSync(ffPath);
	} catch {
		return false;
	}
})();

const describeIfAvailable = firefoxInstalled ? describe : describe.skip;

describeIfAvailable(
	"FirefoxPlugin contract tests",
	() => {
		runContractTests("firefox", createFirefoxPlugin, {
			realBrowser: true,
			navigateTimeout: 30_000,
			navigationSettle: true,
		});
	},
	60_000,
);

// ─── Phase 1.5: launchServer path (getWsEndpoint + external attach) ─────
//
// Gated on BOTH Firefox being installed AND the host opting in via
// `BROWSER_FIREFOX_LAUNCH_SERVER=1`. The default-path contract suite
// above is unaffected by this flag.

const launchServerEnabled = process.env.BROWSER_FIREFOX_LAUNCH_SERVER === "1";
const describeIfLaunchServer =
	firefoxInstalled && launchServerEnabled ? describe : describe.skip;

describeIfLaunchServer(
	"FirefoxPlugin launchServer path (Phase 1.5)",
	() => {
		let plugin: FirefoxPlugin;
		let server: TestServer;
		// Captured from the navigate test so the cleanup test can assert a
		// stale connect fails after the server closes. Vitest runs `it`
		// blocks sequentially within a describe, so this is populated
		// before the cleanup test runs.
		let capturedWs: string | null = null;

		beforeAll(async () => {
			plugin = new FirefoxPlugin();
			await plugin.init();
			server = await startTestServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(
					"<!doctype html><html><head><title>ff-launch-server</title></head>" +
						"<body><h1>ok</h1></body></html>",
				);
			});
		}, 30_000);

		afterAll(async () => {
			if (server) await server.stop().catch(() => {});
			if (plugin) await plugin.cleanupAll().catch(() => {});
		}, 30_000);

		it("getWsEndpoint() returns null before the browser has launched", () => {
			expect(plugin.getWsEndpoint()).toBeNull();
		});

		it("launches via launchServer and exposes a ws:// endpoint after navigate", async () => {
			const result = await plugin.navigate(
				server.url,
				"ff-launch-server-1",
				30_000,
			);
			expect(result.success).toBe(true);

			const ws = plugin.getWsEndpoint();
			expect(ws).not.toBeNull();
			expect(typeof ws).toBe("string");
			expect(ws).toMatch(/^ws:\/\//);

			// Cache for the cleanup test's stale-connect assertion.
			capturedWs = ws;
		}, 60_000);

		it("a second playwright.firefox.connect() (BrowserGym bridge) can attach", async () => {
			const ws = plugin.getWsEndpoint();
			expect(ws).not.toBeNull();
			if (ws === null) throw new Error("ws endpoint not set");

			// Simulate the BrowserGym bridge attaching over the WebSocket
			// endpoint. The external client must be able to open its own
			// connection to the same browser server without disturbing the
			// plugin's driving connection.
			const external = await firefox.connect(ws);
			try {
				const ctx = await external.newContext();
				const page = await ctx.newPage();
				await page.goto(server.url, { waitUntil: "load" });
				const title = await page.title();
				expect(title).toBe("ff-launch-server");
				await ctx.close();
			} finally {
				await external.close().catch(() => {});
			}
		}, 60_000);

		it("cleanupAll() drops the wsEndpoint and closes the server", async () => {
			await plugin.cleanupAll();
			expect(plugin.getWsEndpoint()).toBeNull();

			// The server is closed — a fresh connect to the old endpoint
			// must fail. (Guarded because the navigate test may have been
			// skipped/failed before capturing the endpoint.)
			if (capturedWs) {
				await expect(firefox.connect(capturedWs)).rejects.toThrow();
			}
		}, 30_000);
	},
	120_000,
);
