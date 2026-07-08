/**
 * MiniWoB++ trivial-solver suite — Firefox-Py (Python bridge) backend.
 *
 * Uses the public `registerMiniwobSuite` API from `pi-lean-host` with
 * the `PythonPluginAdapter` driving the firefox-py `bridge.py`. Proves
 * the plugin.evaluate episode lifecycle works end-to-end through the
 * Python bridge harness.
 *
 * For the task breakdown (13 puzzle-solved / 82 no-solver / 35 non-element),
 * see the `registerMiniwobBackend` doc comment in `miniwob-suite-helper.ts`.
 *
 * Prerequisites:
 *   - Python venv at backends/python-base/.venv with playwright installed
 *   - Playwright Firefox browsers installed (playwright install firefox)
 *
 * Run: npx vitest run packages/pi-lean-host/suites/miniwob-firefox-py.test.ts
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PythonPluginAdapter } from "../../pi-lean-portal/backends/python-adapter.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";

import {
	probePythonBackend,
	registerMiniwobBackend,
} from "./miniwob-suite-helper.js";

// ─── Paths ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRIDGE_SCRIPT = resolve(
	__dirname,
	"../../pi-lean-portal/backends/firefox-py/bridge.py",
);

const VENV_PYTHON = resolve(
	__dirname,
	"../../pi-lean-portal/backends/python-base/.venv/bin/python3",
);

// ─── Environment check ───────────────────────────────────────────────

const { pythonAvailable, bridgeExists } = probePythonBackend(
	VENV_PYTHON,
	BRIDGE_SCRIPT,
);

const firefoxAvailable = (() => {
	try {
		const result = spawnSync(
			VENV_PYTHON,
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

const FIREFOX_PY_AVAILABLE =
	pythonAvailable && bridgeExists && firefoxAvailable;

// ─── Suite — register the firefox-py backend ──────────────────────

registerMiniwobBackend(
	"firefox-py",
	FIREFOX_PY_AVAILABLE,
	async (): Promise<BrowserPlugin> => {
		const plugin = new PythonPluginAdapter("firefox-py", {
			bridgeScript: BRIDGE_SCRIPT,
			pythonPath: VENV_PYTHON,
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
		await plugin.init({});
		return plugin;
	},
);
