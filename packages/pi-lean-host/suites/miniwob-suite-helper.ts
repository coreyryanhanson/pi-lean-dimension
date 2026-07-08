/**
 * Shared infrastructure for the shipped MiniWoB++ suite files.
 *
 * Owns the pieces that are identical across every shipped backend
 * suite file:
 * - The `HTML_ROOT` default + `CONTENT_AVAILABLE` gate (external URL
 *   or cloned html root).
 * - The shared MiniWoB static server lifecycle (`ensureBaseUrl` +
 *   file-level `afterAll` teardown).
 * - The `available` AND of content + backend-specific browser
 *   availability, and the `registerMiniwobSuite` dispatch.
 *
 * The caller supplies only the three things that actually differ per
 * backend: a name, a browser-availability flag, and a plugin factory.
 * User-owned parity test files do **not** use this helper — they own
 * their own server lifecycle per the `registerMiniwobSuite` doc.
 *
 * @module
 */

import { afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";
import type { TestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";

import {
	registerMiniwobSuite,
	type MiniwobBackend,
} from "../solvers/register-suite.js";
import { startMiniwobServer } from "../scripts/miniwob-server.js";

// ─── Content availability ────────────────────────────────────────

const HTML_ROOT =
	process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";

const HAS_EXTERNAL_URL = Boolean(process.env.MINIWOB_URL);
const HTML_ROOT_PRESENT = existsSync(resolve(HTML_ROOT));
const CONTENT_AVAILABLE = HAS_EXTERNAL_URL || HTML_ROOT_PRESENT;

// ─── Shared server ────────────────────────────────────────────────

let sharedServer: TestServer | null = null;

async function ensureBaseUrl(): Promise<string> {
	if (process.env.MINIWOB_URL) return process.env.MINIWOB_URL;
	if (!sharedServer) {
		sharedServer = await startMiniwobServer(HTML_ROOT);
	}
	return sharedServer.url;
}

afterAll(async () => {
	if (sharedServer) {
		await sharedServer.stop().catch(() => {});
		sharedServer = null;
	}
});

// ─── Backend registration ─────────────────────────────────────────

/**
 * Probe the Python backend availability: whether the venv's Python
 * interpreter works and the bridge script exists on disk.
 *
 * This is shared between `chromium-py` and `firefox-py` suite files
 * to avoid duplicating the same spawnSync + existsSync checks.
 */
export function probePythonBackend(
	venvPython: string,
	bridgeScript: string,
): { pythonAvailable: boolean; bridgeExists: boolean } {
	const pythonAvailable = (() => {
		if (!existsSync(venvPython)) return false;
		const result = spawnSync(venvPython, ["--version"], {
			stdio: "ignore",
			timeout: 5_000,
		});
		return result.status === 0;
	})();
	const bridgeExists = existsSync(bridgeScript);
	return { pythonAvailable, bridgeExists };
}

/**
 * Register one shipped backend against the full 130-task MiniWoB++
 * suite, gated on `CONTENT_AVAILABLE && browserAvailable`.
 *
 * The caller owns the browser-availability probe (it is
 * engine-specific: `chromium.executablePath()` vs
 * `firefox.executablePath()` vs a Python+binary probe for the py
 * bridges) and the plugin factory. Everything else — the content
 * gate, the shared static server, the file-level teardown — is shared
 * here so adding a new shipped backend suite file is a ~15-line file.
 */
export function registerMiniwobBackend(
	name: string,
	browserAvailable: boolean,
	initPlugin: () => Promise<BrowserPlugin>,
): void {
	const backend: MiniwobBackend = {
		name,
		available: CONTENT_AVAILABLE && browserAvailable,
		initPlugin,
	};
	registerMiniwobSuite(backend, ensureBaseUrl);
}
