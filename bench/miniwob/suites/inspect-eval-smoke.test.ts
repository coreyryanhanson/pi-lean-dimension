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
 * covered by the Phase 2 split quirk tests.
 *
 * One `describe` per backend, modeled on `adapter-smoke.test.ts`
 * (single focused test, not the 130-task `registerMiniwobSuite`):
 *   - `chromium`    — Node/Playwright, the cheap always-available canary
 *   - `firefox-py`  — Python bridge, same-engine sanity check
 *   - `camoufox-py` — user-backends, auto-skip when absent (bug-bearing)
 *
 * Auto-skip gates mirror `adapter-smoke.test.ts`: backend binary
 * present + MiniWoB++ content present. Camoufox additionally gates on
 * `probeUserBackend("camoufox-py")`.
 *
 * Run: npx vitest run bench/miniwob/suites/inspect-eval-smoke.test.ts
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

// ─── Paths ---------------------------------------------------------

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

// ─── Content availability -----------------------------------------

const CONTENT_AVAILABLE =
	Boolean(process.env.MINIWOB_URL) || existsSync(resolve(HTML_ROOT));

// One shared MiniWoB server across all three backends (file-level
// afterAll teardown is registered by createSharedMiniwobServer).
const ensureBaseUrl = createSharedMiniwobServer();

// ─── Backend availability probes ----------------------------------

const CHROMIUM_AVAILABLE = (() => {
	try {
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
})();

const { pythonAvailable: firefoxPyPython, bridgeExists: firefoxPyBridge } =
	probePythonBackend(FIREFOX_PY_VENV, FIREFOX_PY_BRIDGE);

const FIREFOX_BINARY_AVAILABLE = (() => {
	if (!firefoxPyPython) return false;
	try {
		const result = spawnSync(
			FIREFOX_PY_VENV,
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
	firefoxPyPython && firefoxPyBridge && FIREFOX_BINARY_AVAILABLE;

const CAMOUFOX_PROBE = probeUserBackend("camoufox-py");
const CAMOUFOX_AVAILABLE = CAMOUFOX_PROBE.available;

// ─── Shared test body ---------------------------------------------
//
// One focused test per backend. The invariant: navigate + snapshot
// populate the a11y tree, then the real EXTRACTOR_SCRIPT IIFE runs
// through plugin.evaluate and returns a parseable ExtractResult.

const TASK_NAME = "click-test";
const TASK_ID = `inspect-smoke-${TASK_NAME}`;

async function runInspectEvalSmoke(plugin: BrowserPlugin, baseUrl: string) {
	const url = `${baseUrl.replace(/\/$/, "")}/miniwob/${TASK_NAME}.html`;

	// 1. Navigate — must succeed and populate the a11y tree.
	const nav = await plugin.navigate(url, TASK_ID, 30_000);
	expect(nav.success, `navigate failed: ${nav.error ?? "<no error>"}`).toBe(
		true,
	);
	expect(
		nav.elementCount,
		`navigate returned empty a11y tree (elementCount=0)`,
	).toBeGreaterThan(0);

	// 2. Snapshot — proves the page loaded and the a11y API works
	//    (the bug report's "navigate works" half).
	const snap = await plugin.snapshot(TASK_ID);
	expect(snap.success, `snapshot failed: ${snap.error ?? "<no error>"}`).toBe(
		true,
	);
	expect(snap.elementCount).toBeGreaterThan(0);

	// 3. Evaluate the real EXTRACTOR_SCRIPT — the RED assertion on
	//    camoufox-py if the mw: wrapping breaks the multi-statement
	//    IIFE. Must succeed and return a parseable ExtractResult.
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

// ─── chromium (Node) — always-available canary --------------------

describe("inspect-eval-smoke — chromium", () => {
	let plugin: BrowserPlugin | undefined;
	const SHOULD_RUN = CHROMIUM_AVAILABLE && CONTENT_AVAILABLE;

	beforeAll(async () => {
		if (!SHOULD_RUN) return;
		plugin = new ChromiumPlugin();
		await plugin.init?.({});
	});

	afterAll(async () => {
		if (plugin) await plugin.cleanupAll().catch(() => {});
	});

	const itFn = SHOULD_RUN ? it : it.skip;
	itFn(
		SHOULD_RUN
			? "navigate→snapshot→evaluate EXTRACTOR_SCRIPT coupling holds"
			: `prerequisites missing: ${CHROMIUM_AVAILABLE ? "MiniWoB content" : "Chromium binary"}`,
		async () => {
			const baseUrl = await ensureBaseUrl();
			await runInspectEvalSmoke(plugin!, baseUrl);
		},
		60_000,
	);
});

// ─── firefox-py (Python bridge) — same-engine sanity --------------

describe("inspect-eval-smoke — firefox-py", () => {
	let plugin: BrowserPlugin | undefined;
	const SHOULD_RUN = FIREFOX_PY_AVAILABLE && CONTENT_AVAILABLE;

	beforeAll(async () => {
		if (!SHOULD_RUN) return;
		plugin = new PythonPluginAdapter("firefox-py", {
			bridgeScript: FIREFOX_PY_BRIDGE,
			pythonPath: FIREFOX_PY_VENV,
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
		await plugin.init?.({});
	});

	afterAll(async () => {
		if (plugin) await plugin.cleanupAll().catch(() => {});
	});

	const itFn = SHOULD_RUN ? it : it.skip;
	itFn(
		SHOULD_RUN
			? "navigate→snapshot→evaluate EXTRACTOR_SCRIPT coupling holds"
			: `prerequisites missing: ${FIREFOX_PY_AVAILABLE ? "MiniWoB content" : "firefox-py venv/binary"}`,
		async () => {
			const baseUrl = await ensureBaseUrl();
			await runInspectEvalSmoke(plugin!, baseUrl);
		},
		60_000,
	);
});

// ─── camoufox-py (user-backends) — bug-bearing backend ------------

describe("inspect-eval-smoke — camoufox-py", () => {
	let plugin: BrowserPlugin | undefined;
	const SHOULD_RUN = CAMOUFOX_AVAILABLE && CONTENT_AVAILABLE;

	beforeAll(async () => {
		if (!SHOULD_RUN) return;
		plugin = new PythonPluginAdapter("camoufox-py", {
			bridgeScript: CAMOUFOX_PROBE.bridgePath,
			pythonPath: CAMOUFOX_PROBE.venvPython,
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
		await plugin.init?.({});
	});

	afterAll(async () => {
		if (plugin) await plugin.cleanupAll().catch(() => {});
	});

	const itFn = SHOULD_RUN ? it : it.skip;
	itFn(
		SHOULD_RUN
			? "navigate→snapshot→evaluate EXTRACTOR_SCRIPT coupling holds"
			: `prerequisites missing: ${CAMOUFOX_AVAILABLE ? "MiniWoB content" : "camoufox-py user-backend not installed"}`,
		async () => {
			const baseUrl = await ensureBaseUrl();
			await runInspectEvalSmoke(plugin!, baseUrl);
		},
		60_000,
	);
});
