/**
 * MiniWoB++ task suite — Steps 2 & 3 of `miniwob-integration-plan.md`.
 *
 * Drives every MiniWoB++ task through **the four shipped BrowserPlugin
 * backends** via {@link registerMiniwobSuite} from `helpers/miniwob-suite.ts`
 * and asserts the plugin pipeline behaves.
 *
 * ── Shipped backends ────────────────────────────────────────────
 *
 *   - `chromium`      — Node/Playwright Chromium (reference)
 *   - `firefox`       — Node/Playwright Firefox
 *   - `chromium-py`   — Python/Playwright Chromium bridge
 *   - `firefox-py`    — Python/Playwright Firefox bridge
 *
 * User-installed backends (camoufox-py, invisible-py, or any future
 * custom plugin) are NOT hardcoded here. Instead,
 * {@link registerMiniwobSuite} + the solver/parsing toolkit are
 * exported from the helper so any user-owned parity test file can
 * register its own backend against the same 125-task suite — see
 * `helpers/miniwob-suite.ts` for an example.
 *
 * ── Auto-skip gate ─────────────────────────────────────────────
 *
 * Each backend gets its own `describe` block with an **auto-skip gate**
 * ported verbatim from the matching per-backend contract test file.
 * The whole file additionally skips when MiniWoB content is
 * unreachable (no `MINIWOB_HTML_ROOT`/default html root AND no
 * `MINIWOB_URL`). This keeps `npm test` / `npm run test:ci` green in
 * environments without the cloned MiniWoB++ tree.
 *
 * ── Attribution ───────────────────────────────────────────────
 *
 * MiniWoB++ © Farama-Foundation (Apache-2.0); BrowserGym © ServiceNow
 * (Apache-2.0). The setup JS and reward protocol are ported in
 * `helpers/miniwob.ts` with attribution; this file only consumes the
 * helpers. Tests aren't shipped in the published package.
 *
 * Run: npm run test:miniwob
 *      npx vitest run packages/pi-lean-portal/__tests__/miniwob.test.ts
 *
 * @module
 */

import { afterAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, firefox } from "playwright";

import { ChromiumPlugin } from "../backends/chromium/index.js";
import { FirefoxPlugin } from "../backends/firefox/index.js";
import { PythonPluginAdapter } from "../backends/python-adapter.js";
import {
	registerMiniwobSuite,
	type MiniwobBackend,
} from "./helpers/miniwob-suite.js";
import type { BrowserPlugin } from "../core/plugin-api.js";
import { startMiniwobServer } from "./helpers/miniwob.js";
import type { TestServer } from "./helpers/test-server.js";

// ─── Constants ───────────────────────────────────────────────────

const HTML_ROOT =
	process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";

// ─── Shared content availability gate ────────────────────────────

/** True when an external MiniWoB server is pointed at via MINIWOB_URL. */
const HAS_EXTERNAL_URL = Boolean(process.env.MINIWOB_URL);

/** True when the cloned MiniWoB++ html root is present on disk. */
const HTML_ROOT_PRESENT = existsSync(resolve(HTML_ROOT));

/**
 * True when MiniWoB content is reachable at all. When false, **every**
 * backend block skips (no point checking browser availability if
 * there's nothing to navigate to).
 */
const CONTENT_AVAILABLE = HAS_EXTERNAL_URL || HTML_ROOT_PRESENT;

// ─── Shared static server (started lazily, once per file) ────────

/**
 * Module-level shared MiniWoB server. Started by the first backend
 * whose `beforeAll` runs (when `MINIWOB_URL` isn't set) and stopped
 * once after every backend block completes. Avoids starting a
 * separate server for each backend's `describe`.
 */
let sharedServer: TestServer | null = null;

/**
 * Returns the base URL for MiniWoB content, starting the shared static
 * server on first call when `MINIWOB_URL` isn't set. Idempotent —
 * subsequent calls reuse the same server. Passed as the
 * `getBaseUrl` resolver to {@link registerMiniwobSuite}.
 */
async function ensureBaseUrl(): Promise<string> {
	if (process.env.MINIWOB_URL) return process.env.MINIWOB_URL;
	if (!sharedServer) {
		sharedServer = await startMiniwobServer(HTML_ROOT);
	}
	return sharedServer.url;
}

// ─── Backend availability gates (ported from per-backend tests) ──

/** True when Playwright Chromium is installed (mirrors firefox.test.ts). */
const CHROMIUM_AVAILABLE = (() => {
	try {
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
})();

/** True when Playwright Firefox is installed (mirrors firefox.test.ts). */
const FIREFOX_AVAILABLE = (() => {
	try {
		const ffPath = firefox.executablePath();
		return existsSync(ffPath);
	} catch {
		return false;
	}
})();

/** Path to the bundled Python backends' shared venv interpreter. */
const PY_VENV_PYTHON = resolve(
	__dirname,
	"../backends/python-base/.venv/bin/python3",
);

/** True when the shared Python venv + interpreter are functional. */
const PY_VENV_AVAILABLE = (() => {
	if (!existsSync(PY_VENV_PYTHON)) return false;
	const result = spawnSync(PY_VENV_PYTHON, ["--version"], {
		stdio: "ignore",
		timeout: 5_000,
	});
	return result.status === 0;
})();

/** Path to the bundled Chromium-Py bridge script. */
const CHROMIUM_PY_BRIDGE = resolve(
	__dirname,
	"../backends/chromium-py/bridge.py",
);

/** Path to the bundled Firefox-Py bridge script. */
const FIREFOX_PY_BRIDGE = resolve(
	__dirname,
	"../backends/firefox-py/bridge.py",
);

/**
 * True when Playwright Firefox is installed *from the Python venv*
 * (mirrors firefox-py.test.ts — checks the venv's playwright can
 * resolve the firefox binary, not just the Node playwright).
 */
const PY_FIREFOX_AVAILABLE = (() => {
	if (!PY_VENV_AVAILABLE) return false;
	try {
		const result = spawnSync(
			PY_VENV_PYTHON,
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

/**
 * True when Playwright Chromium is installed *from the Python venv*
 * (mirrors the firefox check above — the Python bridge uses the
 * venv's playwright, which keeps its own browser binaries separate
 * from Node's playwright. Checking Node's `chromium.executablePath()`
 * would be wrong here.)
 */
const PY_CHROMIUM_AVAILABLE = (() => {
	if (!PY_VENV_AVAILABLE) return false;
	try {
		const result = spawnSync(
			PY_VENV_PYTHON,
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

// ─── Backend registry ────────────────────────────────────────────

/**
 * The four shipped `BrowserPlugin` backends, each gated by its own
 * prerequisite check (ported verbatim from the matching per-backend
 * contract test file). User-installed backends (camoufox-py,
 * invisible-py, etc.) are tested via user-owned parity test files
 * that import {@link registerMiniwobSuite} from the helper — see
 * `helpers/miniwob-suite.ts` for the pattern.
 */
const BACKENDS: MiniwobBackend[] = [
	{
		name: "chromium",
		available: CONTENT_AVAILABLE && CHROMIUM_AVAILABLE,
		initPlugin: async (): Promise<BrowserPlugin> => {
			const plugin = new ChromiumPlugin();
			await plugin.init({});
			return plugin;
		},
	},
	{
		name: "firefox",
		available: CONTENT_AVAILABLE && FIREFOX_AVAILABLE,
		initPlugin: async (): Promise<BrowserPlugin> => {
			const plugin = new FirefoxPlugin();
			await plugin.init({});
			return plugin;
		},
	},
	{
		name: "chromium-py",
		available:
			CONTENT_AVAILABLE &&
			PY_VENV_AVAILABLE &&
			existsSync(CHROMIUM_PY_BRIDGE) &&
			PY_CHROMIUM_AVAILABLE,
		initPlugin: async (): Promise<BrowserPlugin> => {
			const plugin = new PythonPluginAdapter("chromium-py", {
				bridgeScript: CHROMIUM_PY_BRIDGE,
				pythonPath: PY_VENV_PYTHON,
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
			await plugin.init({});
			return plugin;
		},
	},
	{
		name: "firefox-py",
		available:
			CONTENT_AVAILABLE &&
			PY_VENV_AVAILABLE &&
			existsSync(FIREFOX_PY_BRIDGE) &&
			PY_FIREFOX_AVAILABLE,
		initPlugin: async (): Promise<BrowserPlugin> => {
			const plugin = new PythonPluginAdapter("firefox-py", {
				bridgeScript: FIREFOX_PY_BRIDGE,
				pythonPath: PY_VENV_PYTHON,
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
	},
];

// ─── Suite — register every shipped backend ──────────────────────

for (const backend of BACKENDS) {
	registerMiniwobSuite(backend, ensureBaseUrl);
}

// ─── File-level teardown: stop the shared server once ────────────

afterAll(async () => {
	if (sharedServer) {
		await sharedServer.stop().catch(() => {});
		sharedServer = null;
	}
});
