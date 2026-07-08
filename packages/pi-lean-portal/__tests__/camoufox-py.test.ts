/**
 * Contract tests for the Camoufox-Py backend (user-backends stealth
 * engine) — validates that the PythonPluginAdapter + Camoufox bridge
 * satisfies the BrowserPlugin contract against a real Camoufox browser.
 *
 * Prerequisites (all auto-detected via probeUserBackend):
 *   - `~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/bridge.py`
 *     exists on disk.
 *   - `.venv/bin/python3` runs and has playwright + camoufox installed.
 *   - Camoufox browser binary has been fetched (`python -m camoufox fetch`).
 *
 * Auto-skips the entire suite when prerequisites are absent.
 *
 * Camoufox-specific assertions beyond the shared contract suite:
 *   - `scroll()` works via wheel events (exercises the `_scroll_via_wheel`
 *     quirks flag — Camoufox does not support Playwright's built-in
 *     `page.mouse.wheel` and relies on a JS-based wheel scroll).
 *   - `evaluate("() => 1 + 1")` returns `2` (exercises the `mw:`-prefix /
 *     `_eval_prefix` quirk — Camoufox evaluates in the main world via
 *     `mainWorldEval` rather than Playwright's default execution context).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { PythonPluginAdapter } from "../backends/python-adapter.js";
import { runContractTests } from "./helpers/plugin-contract.js";
import { startTestServer } from "./helpers/test-server.js";

// Import the vendored probe from pi-lean-host (monorepo sibling).
// This avoids duplicating the user-backends path resolution logic
// while keeping the probe consistent with the rest of the toolchain.
import { probeUserBackend } from "../../pi-lean-host/src/index.js";

// ─── Prerequisites check via probeUserBackend ──────────────────────

const probe = probeUserBackend("camoufox-py");

const camoufoxAvailable = probe.available;

// ─── Plugin factory ─────────────────────────────────────────────────

/**
 * Create a PythonPluginAdapter that drives the Camoufox-Py bridge
 * from the user-backends directory.
 *
 * The adapter is lazy — the Python subprocess won't start until the
 * first operation.  Capabilities advertise `engine: "firefox"` because
 * Camoufox is Firefox-based.
 */
function createCamoufoxPyPlugin(): PythonPluginAdapter {
	return new PythonPluginAdapter("camoufox-py", {
		bridgeScript: probe.bridgePath,
		pythonPath: probe.venvPython,
		// Camoufox supports everything except AbortSignal (JSON-RPC limit).
		capabilities: {
			supportsFullPageScreenshot: true,
			supportsConsoleCapture: true,
			supportsJavaScriptEvaluate: true,
			supportsBotDetection: true,
			supportsDialogAutoDismissal: true,
			supportsAbortSignal: false,
			engine: "firefox",
		},
	});
}

// ─── Test Server Setup (used for Camoufox-specific tests) ────────────

const SCROLL_HTML = `<!DOCTYPE html>
<html><head><title>Camoufox Scroll Test</title></head>
<body>
  <h1>Scroll Test</h1>
  ${Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i + 1}: content to make the page scrollable.</p>`).join("\n  ")}
  <p id="bottom-marker">You reached the bottom!</p>
</body></html>`;

let serverUrl: string;
let stopServer: () => Promise<void>;

beforeAll(async () => {
	const server = await startTestServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/scroll") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(SCROLL_HTML);
		} else if (url.pathname === "/simple") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				"<!DOCTYPE html><html><head><title>Simple Page</title></head><body><h1>Simple</h1></body></html>",
			);
		} else {
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end("404");
		}
	});
	serverUrl = server.url;
	stopServer = server.stop;
});

afterAll(async () => {
	await stopServer();
});

// ─── Run contract tests ──────────────────────────────────────────────

const describeIfAvailable = camoufoxAvailable ? describe : describe.skip;

describeIfAvailable("Camoufox-Py contract tests", () => {
	// ── Shared contract suite (structural + behavioral) ─────────
	runContractTests("camoufox-py", createCamoufoxPyPlugin, {
		realBrowser: true,
		navigateTimeout: 30_000,
		navigationSettle: true,
	});

	// ── Camoufox-specific assertions ────────────────────────────
	//
	// These go beyond the generic contract suite to exercise quirks
	// that are unique to the Camoufox bridge.

	describe("Camoufox-specific behaviors", () => {
		let plugin: PythonPluginAdapter;

		beforeAll(async () => {
			plugin = createCamoufoxPyPlugin();
			await plugin.init();
		});

		afterAll(async () => {
			await plugin.cleanupAll().catch(() => {});
		});

		it("scrolls via wheel (exercises _scroll_via_wheel quirk)", async () => {
			const nav = await plugin.navigate(
				`${serverUrl}/scroll`,
				"camoufox-scroll",
				30_000,
			);
			expect(nav.success).toBe(true);

			// Check initial scroll position is 0
			const beforeScroll = await plugin.evaluate(
				"camoufox-scroll",
				"window.scrollY",
			);
			expect(beforeScroll.success).toBe(true);
			expect(beforeScroll.result).toBe(0);

			const scrollResult = await plugin.scroll("camoufox-scroll", "down");
			expect(scrollResult.success).toBe(true);

			// Verify that wheel-based scrolling actually moved the page.
			// We check scrollY > 0 rather than bottom-marker visibility
			// because a single wheel scroll step may not bring the bottom
			// of a long page into view.
			const afterScroll = await plugin.evaluate(
				"camoufox-scroll",
				"window.scrollY",
			);
			expect(afterScroll.success).toBe(true);
			expect(typeof afterScroll.result).toBe("number");
			expect((afterScroll.result as number) > 0).toBe(true);
		});

		it("evaluates arithmetic via main-world eval (exercises _eval_prefix / mw: quirk)", async () => {
			await plugin.navigate(`${serverUrl}/simple`, "camoufox-eval", 30_000);

			const result = await plugin.evaluate("camoufox-eval", "1 + 1");
			expect(result.success).toBe(true);
			expect(result.result).toBe(2);
		});
	});
});
