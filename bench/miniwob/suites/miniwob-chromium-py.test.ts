/**
 * MiniWoB++ trivial-solver suite — Chromium-Py (Python bridge) backend.
 *
 * Uses the `registerMiniwobSuite` API from `bench/miniwob/solvers/register-suite.js` with
 * the `PythonPluginAdapter` driving the chromium-py `bridge.py`. Proves
 * the plugin.evaluate episode lifecycle works end-to-end through the
 * Python bridge harness.
 *
 * For the task breakdown (13 puzzle-solved / 82 no-solver / 35 non-element),
 * see the `registerMiniwobBackend` doc comment in `miniwob-suite-helper.ts`.
 *
 * Prerequisites:
 *   - Python venv at backends/python-base/.venv with playwright installed
 *   - Playwright Chromium browsers installed (playwright install chromium)
 *
 * Run: npx vitest run bench/miniwob/suites/miniwob-chromium-py.test.ts
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PythonPluginAdapter } from "../../../packages/pi-lean-portal/backends/python-adapter.js";
import type { BrowserPlugin } from "../../../packages/pi-lean-portal/core/plugin-api.js";

import {
	probePythonBackend,
	registerMiniwobBackend,
} from "./miniwob-suite-helper.js";

// ─── Paths ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRIDGE_SCRIPT = resolve(
	__dirname,
	"../../../packages/pi-lean-portal/backends/chromium-py/bridge.py",
);

const VENV_PYTHON = resolve(
	__dirname,
	"../../../packages/pi-lean-portal/backends/python-base/.venv/bin/python3",
);

// ─── Environment check ───────────────────────────────────────────────

const { pythonAvailable, bridgeExists } = probePythonBackend(
	VENV_PYTHON,
	BRIDGE_SCRIPT,
);

const chromiumAvailable = (() => {
	try {
		const result = spawnSync(
			VENV_PYTHON,
			[
				"-c",
				"from playwright.sync_api import sync_playwright; " +
					"p = sync_playwright().start(); " +
					"import os; print(os.path.exists(p.chromium.executable_path)); " +
					"p.stop()",
			],
			{ stdio: "pipe", timeout: 10_000 },
		);
		return result.status === 0 && result.stdout.toString().trim() === "True";
	} catch {
		return false;
	}
})();

const CHROMIUM_PY_AVAILABLE =
	pythonAvailable && bridgeExists && chromiumAvailable;

// ─── Suite — register the chromium-py backend ─────────────────────

registerMiniwobBackend(
	"chromium-py",
	CHROMIUM_PY_AVAILABLE,
	async (): Promise<BrowserPlugin> => {
		const plugin = new PythonPluginAdapter("chromium-py", {
			bridgeScript: BRIDGE_SCRIPT,
			pythonPath: VENV_PYTHON,
			capabilities: {
				supportsFullPageScreenshot: true,
				supportsJavaScriptEvaluate: true,
				engine: "chromium",
			},
		});
		await plugin.init({});
		return plugin;
	},
);
