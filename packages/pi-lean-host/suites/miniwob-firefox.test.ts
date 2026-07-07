/**
 * MiniWoB++ trivial-solver suite — Firefox (Node) backend.
 *
 * Uses the public `registerMiniwobSuite` API from `pi-lean-host` with
 * the shipped FirefoxPlugin. Proves the firefox-ws attach kind works
 * end-to-end through the MiniWoB harness.
 *
 * ── Task breakdown ────────────────────────────────────────────────
 * Same as the chromium suite:
 * - 13 trivial-solver tasks run: 3 confident (reward > 0 asserted) +
 *   10 best-effort (pipeline smoke only)
 * - 77 element tasks skip with `needs goal-aware solver`
 * - 35 non-element tasks skip with missing-tool reason
 *
 * Run: npx vitest run packages/pi-lean-host/suites/miniwob-firefox.test.ts
 *
 * @module
 */

import { afterAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { firefox } from "playwright";
import { FirefoxPlugin } from "../../pi-lean-portal/backends/firefox/index.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";
import type { TestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";

import {
	registerMiniwobSuite,
	type MiniwobBackend,
} from "../solvers/register-suite.js";
import { startMiniwobServer } from "../scripts/miniwob-server.js";

// ─── Constants ────────────────────────────────────────────────────

const HTML_ROOT =
	process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";

// ─── Shared content availability ──────────────────────────────────

const HAS_EXTERNAL_URL = Boolean(process.env.MINIWOB_URL);
const HTML_ROOT_PRESENT = existsSync(resolve(HTML_ROOT));
const CONTENT_AVAILABLE = HAS_EXTERNAL_URL || HTML_ROOT_PRESENT;

// ─── Browser availability ────────────────────────────────────────

const FIREFOX_AVAILABLE = (() => {
	try {
		return existsSync(firefox.executablePath());
	} catch {
		return false;
	}
})();

// ─── Shared server ────────────────────────────────────────────────

let sharedServer: TestServer | null = null;

async function ensureBaseUrl(): Promise<string> {
	if (process.env.MINIWOB_URL) return process.env.MINIWOB_URL;
	if (!sharedServer) {
		sharedServer = await startMiniwobServer(HTML_ROOT);
	}
	return sharedServer.url;
}

// ─── Backend registry ─────────────────────────────────────────────

const BACKENDS: MiniwobBackend[] = [
	{
		name: "firefox",
		available: CONTENT_AVAILABLE && FIREFOX_AVAILABLE,
		initPlugin: async (): Promise<BrowserPlugin> => {
			const plugin = new FirefoxPlugin();
			await plugin.init({});
			return plugin;
		},
	},
];

// ─── Suite — register every shipped backend ──────────────────────

for (const backend of BACKENDS) {
	registerMiniwobSuite(backend, ensureBaseUrl);
}

// ─── File-level teardown ──────────────────────────────────────────

afterAll(async () => {
	if (sharedServer) {
		await sharedServer.stop().catch(() => {});
		sharedServer = null;
	}
});
