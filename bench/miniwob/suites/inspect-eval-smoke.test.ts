/**
 * `browser-inspect` eval-coupling smoke — proves the invariant from
 * BUGREPORT-browser-inspect.md Hole 2:
 *
 *   If `plugin.navigate` succeeded and `plugin.snapshot` populated an
 *   N-element accessibility tree, then `plugin.evaluate(taskId,
 *   EXTRACTOR_SCRIPT)` must succeed and return a parseable
 *   `ExtractResult` with `title` and at least one non-empty content
 *   array.
 *
 * Today this coupling is asserted nowhere. The bug is precisely that
 * it breaks on Camoufox challenge pages (navigate works, eval fails
 * with "Execution context was destroyed"). MiniWoB pages are benign
 * HTML — no challenge cycle — so this is a **regression net for the
 * eval wrapping + the real eval pipeline**, not a faithful repro of
 * the challenge-page class. The genuine context-destruction class is
 * covered by the Python bridge quirks tests.
 *
 * One describe per backend, each handled by the shared
 * `registerBackendSuite` harness:
 *   - `chromium`    — Node/Playwright, the cheap always-available canary
 *   - `firefox-py`  — Python bridge, same-engine sanity check
 *   - `camoufox-py` — user-backends, auto-skip when absent (bug-bearing)
 *
 * Run: npx vitest run bench/miniwob/suites/inspect-eval-smoke.test.ts
 *
 * @module
 */

import { expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { ChromiumPlugin } from "../../../packages/pi-lean-portal/backends/chromium/index.js";
import { PythonPluginAdapter } from "../../../packages/pi-lean-portal/backends/python-adapter.js";
import type { BrowserPlugin } from "../../../packages/pi-lean-portal/core/plugin-api.js";
import {
	EXTRACTOR_SCRIPT,
	type ExtractResult,
} from "../../../packages/pi-lean-portal/core/shared/dom-extractor.js";
import { probeUserBackend } from "../../../packages/pi-lean-portal/__tests__/helpers/probe-user-backend.js";
import {
	probePythonBackend,
	createSharedMiniwobServer,
} from "./miniwob-suite-helper.js";
import {
	registerBackendSuite,
	type SmokeTest,
} from "./inspect-smoke-harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_ROOT =
	process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";
const FIREFOX_PY_BRIDGE = resolve(
	__dirname,
	"../../../packages/pi-lean-portal/backends/firefox-py/bridge.py",
);
const FIREFOX_PY_VENV = resolve(
	__dirname,
	"../../../packages/pi-lean-portal/backends/python-base/.venv/bin/python3",
);
const CONTENT_AVAILABLE =
	Boolean(process.env.MINIWOB_URL) || existsSync(resolve(HTML_ROOT));
const ensureBaseUrl = createSharedMiniwobServer();

const CHROMIUM_AVAILABLE = (() => {
	try {
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
})();
const { pythonAvailable: ffPyPython, bridgeExists: ffPyBridge } =
	probePythonBackend(FIREFOX_PY_VENV, FIREFOX_PY_BRIDGE);
const FIREFOX_BINARY_AVAILABLE = (() => {
	if (!ffPyPython) return false;
	try {
		const r = spawnSync(
			FIREFOX_PY_VENV,
			[
				"-c",
				"from playwright.sync_api import sync_playwright; p=sync_playwright().start(); import os; print(os.path.exists(p.firefox.executable_path)); p.stop()",
			],
			{ stdio: "pipe", timeout: 10_000 },
		);
		return r.status === 0 && r.stdout.toString().trim() === "True";
	} catch {
		return false;
	}
})();
const FIREFOX_PY_AVAILABLE =
	ffPyPython && ffPyBridge && FIREFOX_BINARY_AVAILABLE;
const CAMOUFOX_PROBE = probeUserBackend("camoufox-py");

const TASK_NAME = "click-test";
const TASK_ID = `inspect-smoke-${TASK_NAME}`;

async function runInspectEvalSmoke(plugin: BrowserPlugin, baseUrl: string) {
	const url = `${baseUrl.replace(/\/$/, "")}/miniwob/${TASK_NAME}.html`;
	const nav = await plugin.navigate(url, TASK_ID, 30_000);
	expect(nav.success, `navigate failed: ${nav.error ?? "<no error>"}`).toBe(
		true,
	);
	expect(nav.elementCount, "navigate returned empty a11y tree").toBeGreaterThan(
		0,
	);
	const snap = await plugin.snapshot(TASK_ID);
	expect(snap.success, `snapshot failed: ${snap.error ?? "<no error>"}`).toBe(
		true,
	);
	expect(snap.elementCount).toBeGreaterThan(0);
	const evalResult = await plugin.evaluate(TASK_ID, EXTRACTOR_SCRIPT, true);
	expect(
		evalResult.success,
		`evaluate EXTRACTOR_SCRIPT failed: ${evalResult.error ?? "<no error>"}`,
	).toBe(true);
	const rawJson =
		typeof evalResult.result === "string"
			? evalResult.result
			: JSON.stringify(evalResult.result);
	let parsed: ExtractResult;
	try {
		parsed = JSON.parse(rawJson) as ExtractResult;
	} catch {
		throw new Error(
			`EXTRACTOR_SCRIPT returned unparseable JSON: ${rawJson.slice(0, 200)}`,
		);
	}
	expect(typeof parsed.title, "ExtractResult.title missing").toBe("string");
	const contentCount =
		parsed.headings.length +
		parsed.paragraphs.length +
		parsed.links.length +
		parsed.images.length +
		parsed.interactive.length;
	expect(
		contentCount,
		"ExtractResult had no populated content arrays",
	).toBeGreaterThan(0);
}

const evalTest: SmokeTest = {
	label: "navigate→snapshot→evaluate EXTRACTOR_SCRIPT coupling holds",
	run: runInspectEvalSmoke,
};

registerBackendSuite(
	"inspect-eval-smoke",
	{
		name: "chromium",
		available: CHROMIUM_AVAILABLE && CONTENT_AVAILABLE,
		missingReason: CHROMIUM_AVAILABLE ? "MiniWoB content" : "Chromium binary",
		createPlugin: () => new ChromiumPlugin(),
	},
	ensureBaseUrl,
	[evalTest],
	60_000,
);

registerBackendSuite(
	"inspect-eval-smoke",
	{
		name: "firefox-py",
		available: FIREFOX_PY_AVAILABLE && CONTENT_AVAILABLE,
		missingReason: FIREFOX_PY_AVAILABLE
			? "MiniWoB content"
			: "firefox-py venv/binary",
		createPlugin: () =>
			new PythonPluginAdapter("firefox-py", {
				bridgeScript: FIREFOX_PY_BRIDGE,
				pythonPath: FIREFOX_PY_VENV,
				capabilities: {
					supportsFullPageScreenshot: true,
					supportsJavaScriptEvaluate: true,
					engine: "firefox",
				},
			}),
	},
	ensureBaseUrl,
	[evalTest],
	60_000,
);

registerBackendSuite(
	"inspect-eval-smoke",
	{
		name: "camoufox-py",
		available: CAMOUFOX_PROBE.available && CONTENT_AVAILABLE,
		missingReason: CAMOUFOX_PROBE.available
			? "MiniWoB content"
			: "camoufox-py user-backend",
		createPlugin: () =>
			new PythonPluginAdapter("camoufox-py", {
				bridgeScript: CAMOUFOX_PROBE.bridgePath,
				pythonPath: CAMOUFOX_PROBE.venvPython,
				capabilities: {
					supportsFullPageScreenshot: true,
					supportsJavaScriptEvaluate: true,
					engine: "firefox",
				},
			}),
	},
	ensureBaseUrl,
	[evalTest],
	60_000,
);
