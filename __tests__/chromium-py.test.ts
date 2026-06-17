/**
 * Contract tests for the Chromium-Py backend — validates that the
 * PythonPluginAdapter + Chromium-Py bridge satisfies the BrowserPlugin
 * contract against a real browser.
 *
 * Phase B6: Test Chromium-Py against the contract harness.
 *
 * This test file instantiates a PythonPluginAdapter pointing at the
 * Chromium-Py bridge script and runs both structural and behavioral
 * contract tests.  The Python subprocess is managed by the adapter;
 * no manual setup is needed beyond having Playwright Chromium installed
 * in the Python virtual environment.
 *
 * Prerequisites:
 *   - Python venv at backends/python-base/.venv with playwright installed
 *   - Playwright Chromium browsers installed (playwright install chromium)
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { PythonPluginAdapter } from "../backends/python-adapter.js";
import { runContractTests } from "./helpers/plugin-contract.js";

// ─── Paths ──────────────────────────────────────────────────────────

const BRIDGE_SCRIPT = resolve(__dirname, "../backends/chromium-py/bridge.py");

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

// ─── Plugin factory ─────────────────────────────────────────────────

/**
 * Create a PythonPluginAdapter that drives the Chromium-Py bridge.
 *
 * The adapter is lazy — the Python subprocess won't start until the
 * first operation.  We pass the venv Python path so the bridge has
 * access to playwright and the shared pi_browser_bridge library.
 */
function createChromiumPyPlugin(): PythonPluginAdapter {
	return new PythonPluginAdapter("chromium-py", {
		bridgeScript: BRIDGE_SCRIPT,
		pythonPath: PYTHON_PATH,
		// Chromium-Py supports everything except AbortSignal
		capabilities: {
			supportsFullPageScreenshot: true,
			supportsConsoleCapture: true,
			supportsJavaScriptEvaluate: true,
			supportsBotDetection: true,
			supportsDialogAutoDismissal: true,
			supportsAbortSignal: false,
			engine: "chromium",
		},
	});
}

// ─── Run contract tests ──────────────────────────────────────────────

// Skip the entire suite if prerequisites aren't met (CI without
// Playwright installed, local dev without venv, etc.)
const describeIfAvailable =
	pythonAvailable && bridgeExists ? describe : describe.skip;

describeIfAvailable("Chromium-Py contract tests", () => {
	runContractTests("chromium-py", createChromiumPyPlugin, {
		realBrowser: true,
		navigateTimeout: 30_000,
	});
});
