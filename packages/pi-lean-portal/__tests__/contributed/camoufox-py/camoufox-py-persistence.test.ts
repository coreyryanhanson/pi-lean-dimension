/**
 * Camoufox-Py Cookie Persistence Integration Test — end-to-end validation
 * of cross-process storage-state flow for the Python adapter / Camoufox
 * bridge.
 *
 * Uses a live Camoufox browser via the Camoufox user-backends bridge
 * against a local HTTP test server that serves a page with a cookie-based
 * consent dialog.
 *
 * Mirrors `chromium-py-persistence.test.ts` / `firefox-py-persistence.test.ts`
 * in structure.  Auto-skips the entire suite when Camoufox prerequisites
 * are unavailable.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { PythonPluginAdapter } from "../../../backends/python-adapter.js";
import {
	startTestServer,
	COOKIE_PERSISTENCE_HTML,
} from "../../helpers/test-server.js";
import {
	loadStorageState,
	deleteStorageState,
} from "../../../core/shared/storage-state.js";
import { sessionManager } from "../../../core/shared/session-manager.js";

import { probeUserBackend } from "../../helpers/probe-user-backend.js";

// ─── Prerequisites check via probeUserBackend ──────────────────────

const probe = probeUserBackend("camoufox-py");

const camoufoxAvailable = probe.available;

const describeIfAvailable = camoufoxAvailable ? describe : describe.skip;

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
const TASK_ID = "camoufox-py-persistence";

// ═════════════════════════════════════════════════════════════════
// Tests — only run if Camoufox prerequisites are met
// ═════════════════════════════════════════════════════════════════

describeIfAvailable(
	"Camoufox-Py cookie persistence across navigations",
	() => {
		const TEST_PROFILE = `camoufox-py-persist-${Date.now()}`;

		let plugin: PythonPluginAdapter;

		beforeAll(async () => {
			plugin = new PythonPluginAdapter("camoufox-py-persist", {
				bridgeScript: probe.bridgePath,
				pythonPath: probe.venvPython,
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
			sessionManager.createSession(TASK_ID, "camoufox-py-persist");
			const session = sessionManager.getSession(TASK_ID);
			expect(session).toBeDefined();
			if (session) {
				session.persistState = true;
				session.profileName = TEST_PROFILE;
			}
		});

		it("navigates again with same profile — consent dialog does NOT reappear", async () => {
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
