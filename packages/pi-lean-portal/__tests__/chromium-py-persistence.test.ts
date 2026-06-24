/**
 * Chromium-Py Cookie Persistence Integration Test — end-to-end validation
 * of Bug A (router loads storage state) and Bug B (plugin saves state on
 * re-navigate) for the Python adapter / chromium-py bridge.
 *
 * Uses a live Chromium browser via the Chromium-Py bridge against a local
 * HTTP test server that serves a page with a cookie-based consent dialog.
 *
 * The test:
 * 1. Navigates with a named profile — dialog visible
 * 2. Clicks "Accept All" — sets a consent cookie
 * 3. Navigates again with the same profile — dialog should NOT reappear
 *    because the bridge reuses the BrowserContext (so cookies survive), and
 *    `_persistState` saves the state to disk for cross-session persistence.
 *
 * Auto-skips the entire suite when Python/chromium-py prerequisites are
 * unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { PythonPluginAdapter } from "../backends/python-adapter.js";
import {
	startTestServer,
	COOKIE_PERSISTENCE_HTML,
} from "./helpers/test-server.js";
import {
	loadStorageState,
	deleteStorageState,
} from "../core/shared/storage-state.js";
import { sessionManager } from "../core/shared/session-manager.js";

// ─── Paths ──────────────────────────────────────────────────────────

const BRIDGE_SCRIPT = resolve(__dirname, "../backends/chromium-py/bridge.py");
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

	// Quick check: can we import playwright?
	const check = spawnSync(
		PYTHON_PATH,
		["-c", "import playwright; print('ok')"],
		{ stdio: "pipe", timeout: 5_000 },
	);
	return check.status === 0 && check.stdout.toString().trim() === "ok";
})();

const describeIfAvailable = prerequisitesMet ? describe : describe.skip;

// ─── Test fixture HTML (imported from shared helper) ───────────────
// See ``COOKIE_PERSISTENCE_HTML`` in ``helpers/test-server.ts``.

// ─── Test Server Setup (always runs, server is cheap to start/stop) ─

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

const NAV_TIMEOUT = 30_000;
const TASK_ID = "chromium-py-persistence";

// ═════════════════════════════════════════════════════════════════
// Tests — only run if Chromium + Python prerequisites are met
// ═════════════════════════════════════════════════════════════════

describeIfAvailable(
	"Chromium-Py cookie persistence across navigations",
	() => {
		const TEST_PROFILE = `chromium-py-persist-${Date.now()}`;

		let plugin: PythonPluginAdapter;

		beforeAll(async () => {
			plugin = new PythonPluginAdapter("chromium-py-persist", {
				bridgeScript: BRIDGE_SCRIPT,
				pythonPath: PYTHON_PATH,
			});
			await plugin.init();
		});

		afterAll(async () => {
			await plugin.cleanupAll().catch(() => {});
			deleteStorageState(TEST_PROFILE);
		});

		it("navigates with a named profile — consent dialog is visible", async () => {
			const nav = await plugin.navigate(serverUrl, TASK_ID, NAV_TIMEOUT, {
				profileName: TEST_PROFILE,
				profileMode: "named",
			});
			expect(nav.success).toBe(true);
			expect(nav.title).toContain("Cookie Persistence Test");
			expect(nav.snapshot).toContain("Consent");
			expect(nav.snapshot).toContain("Accept All");
		});

		it("clicks Accept All — cookie set, consent dialog closes", async () => {
			const snap = await plugin.snapshot(TASK_ID);
			expect(snap.success).toBe(true);

			// Find "Accept All" button in the snapshot and extract its @e ref
			const btnMatch = snap.snapshot.match(/@(e\d+)\b.*?button.*?Accept All/);
			expect(btnMatch).toBeTruthy();
			if (!btnMatch) return;

			const ref = `@${btnMatch[1]!}`;
			const clickResult = await plugin.click(TASK_ID, ref);
			expect(clickResult.success).toBe(true);

			// Verify dialog is gone from snapshot
			if (clickResult.snapshot) {
				expect(clickResult.snapshot).not.toContain("Consent");
			}
		});

		it("creates session and sets persistState (simulating the router's setup)", async () => {
			sessionManager.createSession(TASK_ID, "chromium-py-persist");
			const session = sessionManager.getSession(TASK_ID);
			expect(session).toBeDefined();
			if (session) {
				session.persistState = true;
				session.profileName = TEST_PROFILE;
			}
		});

		it("navigates again with same profile — consent dialog does NOT reappear", async () => {
			// This navigate triggers navigate() which:
			//   1. Detects re-navigate (task already in _pages)
			//   2. Calls _persistState → saves cookies to disk via getStorageState RPC
			//   3. Sends browser.navigate RPC → bridge reuses existing context
			// The cookie set during the previous click is still present in the
			// reused BrowserContext, so the dialog should not reappear.
			const nav = await plugin.navigate(serverUrl, TASK_ID, NAV_TIMEOUT, {
				profileName: TEST_PROFILE,
				profileMode: "named",
			});
			expect(nav.success).toBe(true);

			// Consent dialog should NOT be present — cookies survived in-context
			expect(nav.snapshot).not.toContain("Consent");
			expect(nav.snapshot).not.toContain("Accept All");
		});

		it("storage-state.json exists on disk with the consent cookie", async () => {
			const state = loadStorageState(TEST_PROFILE);
			expect(state).not.toBeNull();
			expect(state!.cookies.length).toBeGreaterThan(0);

			const consentCookie = state!.cookies.find(
				(c: { name: string; value: string }) =>
					c.name === "consent" && c.value === "accepted",
			);
			expect(consentCookie).toBeDefined();
		});

		it("third navigate also has no consent dialog (persistence confirmed)", async () => {
			const nav = await plugin.navigate(serverUrl, TASK_ID, NAV_TIMEOUT, {
				profileName: TEST_PROFILE,
				profileMode: "named",
			});
			expect(nav.success).toBe(true);

			// Dialog should still be absent
			expect(nav.snapshot).not.toContain("Consent");
			expect(nav.snapshot).not.toContain("Accept All");
		});
	},
	120_000,
);
