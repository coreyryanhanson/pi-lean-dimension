/**
 * Contract tests for the Firefox-Py backend — validates that the
 * PythonPluginAdapter + Firefox-Py bridge satisfies the BrowserPlugin
 * contract against a real browser.
 *
 * This test file instantiates a PythonPluginAdapter pointing at the
 * Firefox-Py bridge script and runs both structural and behavioral
 * contract tests.  The Python subprocess is managed by the adapter;
 * no manual setup is needed beyond having Playwright Firefox installed
 * in the Python virtual environment.
 *
 * Prerequisites:
 *   - Python venv at backends/python-base/.venv with playwright installed
 *   - Playwright Firefox browsers installed (playwright install firefox)
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { PythonPluginAdapter } from "../backends/python-adapter.js";
import { runContractTests } from "./helpers/plugin-contract.js";

// ─── Paths ──────────────────────────────────────────────────────────

const BRIDGE_SCRIPT = resolve(__dirname, "../backends/firefox-py/bridge.py");

const PYTHON_PATH = resolve(
	__dirname,
	"../backends/python-base/.venv/bin/python3",
);

// ─── Environment check ───────────────────────────────────────────────

const pythonAvailable = (() => {
	if (!existsSync(PYTHON_PATH)) return false;
	const result = spawnSync(PYTHON_PATH, ["--version"], {
		stdio: "ignore",
		timeout: 5_000,
	});
	return result.status === 0;
})();

const bridgeExists = existsSync(BRIDGE_SCRIPT);

const firefoxAvailable = (() => {
	if (!PYTHON_PATH) return false;
	try {
		const result = spawnSync(
			PYTHON_PATH,
			[
				"-c",
				"from playwright.sync_api import sync_playwright; " +
					"p = sync_playwright().start(); " +
					"import os; print(os.path.exists(p.firefox.executable_path)); " +
					"p.stop()",
			],
			{ stdio: "pipe", timeout: 10_000 },
		);
		return result.status === 0 && result.stdout.toString().trim() === "True";
	} catch {
		return false;
	}
})();

// ─── Plugin factory ─────────────────────────────────────────────────

/**
 * Create a PythonPluginAdapter that drives the Firefox-Py bridge.
 *
 * The adapter is lazy — the Python subprocess won't start until the
 * first operation.  We pass the venv Python path so the bridge has
 * access to playwright and the shared pi_browser_bridge library.
 */
function createFirefoxPyPlugin(): PythonPluginAdapter {
	return new PythonPluginAdapter("firefox-py", {
		bridgeScript: BRIDGE_SCRIPT,
		pythonPath: PYTHON_PATH,
		// Firefox-Py supports everything except AbortSignal
		capabilities: {
			supportsFullPageScreenshot: true,
			supportsJavaScriptEvaluate: true,
			engine: "firefox",
		},
	});
}

// ─── Run contract tests ──────────────────────────────────────────────

// Skip the entire suite if prerequisites aren't met (CI without
// Playwright installed, local dev without venv, etc.)
const describeIfAvailable =
	pythonAvailable && bridgeExists && firefoxAvailable
		? describe
		: describe.skip;

describeIfAvailable("Firefox-Py contract tests", () => {
	runContractTests("firefox-py", createFirefoxPyPlugin, {
		realBrowser: true,
		navigateTimeout: 30_000,
		navigationSettle: true,
	});
});
