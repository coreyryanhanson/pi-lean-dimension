/**
 * Firefox-Py Cookie Persistence Integration Test — end-to-end validation
 * of cross-process storage-state flow for the Python adapter / firefox-py
 * bridge.
 *
 * Auto-skips the entire suite when Python/firefox-py prerequisites are
 * unavailable.
 *
 * @module
 */

import { describe, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { PythonPluginAdapter } from "../backends/python-adapter.js";
import {
	startTestServer,
	COOKIE_PERSISTENCE_HTML,
} from "./helpers/test-server.js";
import { runPersistenceSuite } from "./helpers/persistence-suite.js";

// ─── Paths ──────────────────────────────────────────────────────────

const BRIDGE_SCRIPT = resolve(__dirname, "../backends/firefox-py/bridge.py");
const PYTHON_PATH = resolve(
	__dirname,
	"../backends/python-base/.venv/bin/python3",
);

// ─── Prerequisites check — skip gracefully if absent ────────────────

const prerequisitesMet = (() => {
	if (!existsSync(PYTHON_PATH)) return false;
	if (!existsSync(BRIDGE_SCRIPT)) return false;
	const result = spawnSync(PYTHON_PATH, ["--version"], {
		stdio: "ignore",
		timeout: 5_000,
	});
	if (result.status !== 0) return false;

	// Quick check: can we import playwright AND is Firefox installed?
	const check = spawnSync(
		PYTHON_PATH,
		[
			"-c",
			"from playwright.sync_api import sync_playwright; " +
				"p = sync_playwright().start(); " +
				"import os; ok = os.path.exists(p.firefox.executable_path); " +
				"p.stop(); print('ok' if ok else 'no')",
		],
		{ stdio: "pipe", timeout: 10_000 },
	);
	return check.status === 0 && check.stdout.toString().trim() === "ok";
})();

// ─── Test Server Setup (server is cheap to start/stop) ──────────────

let serverUrl: string;
let stopServer: () => Promise<void>;

beforeAll(async () => {
	const server = await startTestServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(COOKIE_PERSISTENCE_HTML);
		} else {
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end("404");
		}
	});
	serverUrl = server.url;
	stopServer = server.stop;
});

afterAll(async () => {
	await stopServer();
});

// ─── Shared Persistence Suite ───────────────────────────────────────

runPersistenceSuite(prerequisitesMet ? describe : describe.skip, {
	name: "firefox-py",
	getServerUrl: () => serverUrl,
	createPlugin: async () => {
		const p = new PythonPluginAdapter("firefox-py-persist", {
			bridgeScript: BRIDGE_SCRIPT,
			pythonPath: PYTHON_PATH,
		});
		await p.init();
		return p;
	},
});
