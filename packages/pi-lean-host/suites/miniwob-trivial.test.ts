/**
 * MiniWoB++ trivial-solver suite — pipeline smoke test for the shipped
 * BrowserPlugin backends.
 *
 * Phase 1: chromium Node backend (Mode A, plugin-owns-browser).
 * Phase 1.5 will add: firefox, chromium-py, firefox-py.
 *
 * Uses the public `registerMiniwobSuite` + `runMiniwobTask` API from
 * `pi-lean-host` — the same API a user-owned parity test file would
 * import. This proves the public API is the same code path the shipped
 * tests exercise.
 *
 * ── Task breakdown ────────────────────────────────────────────────
 * - 13 trivial-solver tasks run: 3 confident (reward > 0 asserted) +
 *   10 best-effort (pipeline smoke only)
 * - 77 element tasks skip with `needs goal-aware solver (Step 2 follow-up)`
 * - 35 non-element tasks skip with missing-tool reason
 * ── 13 + 77 + 35 = 125, matching the MiniWoB++ task count. ────────
 *
 * Run: npx vitest run packages/pi-lean-host/suites/miniwob-trivial.test.ts
 *
 * @module
 */

import { afterAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "playwright";
import { ChromiumPlugin } from "../../pi-lean-portal/backends/chromium/index.js";
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

const CHROMIUM_AVAILABLE = (() => {
	try {
		return existsSync(chromium.executablePath());
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
		name: "chromium",
		available: CONTENT_AVAILABLE && CHROMIUM_AVAILABLE,
		initPlugin: async (): Promise<BrowserPlugin> => {
			const plugin = new ChromiumPlugin();
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
