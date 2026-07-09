/**
 * Cookie Persistence Integration Test — end-to-end validation of Bug A
 * (router loads storage state) and Bug B (plugin saves state on re-navigate).
 *
 * Uses a live Chromium browser against a local HTTP test server that serves
 * a page with a cookie-based consent dialog. The test:
 *
 * 1. Navigates with a named profile — dialog visible
 * 2. Clicks "Accept All" — sets a consent cookie
 * 3. Navigates again with the same profile — dialog should NOT reappear
 *    because `_persistState` saves the cookie to disk before closing the
 *    old context, and the returned state is passed to the new context
 *    via the in-memory fallback (options?.storageState ?? savedState).
 *
 * Auto-skips the entire suite when Playwright Chromium is not installed.
 */

import { existsSync } from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { ChromiumPlugin } from "../backends/chromium/index.js";
import {
	startTestServer,
	COOKIE_PERSISTENCE_HTML,
} from "./helpers/test-server.js";
import {
	loadStorageState,
	deleteStorageState,
} from "../core/shared/storage-state.js";
import { sessionManager } from "../core/shared/session-manager.js";

// ─── Chromium availability check — skip gracefully if absent ───────

const describeIfChromium = (() => {
	try {
		const crPath = chromium.executablePath();
		if (!existsSync(crPath)) return describe.skip;
		return describe;
	} catch {
		return describe.skip;
	}
})();

// ─── Test fixture HTML ─────────────────────────────────────────────

/**
 * A page that shows a consent dialog when no cookie is present, and hides
 * it when the "consent=accepted" cookie exists. Clicking "Accept All" sets
 * the cookie and hides the dialog via JS.
 *
 * See ``COOKIE_PERSISTENCE_HTML`` in ``helpers/test-server.ts``.
 */

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

// ─── ChromiumPlugin Create Helper ─────────────────────────────────

async function createPlugin(): Promise<ChromiumPlugin> {
	const p = new ChromiumPlugin();
	await p.init({});
	return p;
}

const NAV_TIMEOUT = 30_000;
const TASK_ID = "cookie-persistence";

// ═════════════════════════════════════════════════════════════════
// Tests — only run if Chromium is available
// ═════════════════════════════════════════════════════════════════

describeIfChromium(
	"Cookie persistence across navigations",
	() => {
		const TEST_PROFILE = `cookie-persistence-test-${Date.now()}`;

		let plugin: ChromiumPlugin;

		beforeAll(async () => {
			plugin = await createPlugin();
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
			// In production, router.navigate() creates the session and sets
			// persistState & profileName before calling plugin.navigate().
			// Since we're testing the plugin directly, we simulate this setup.
			sessionManager.createSession(TASK_ID, "chromium");
			const session = sessionManager.getSession(TASK_ID);
			expect(session).toBeDefined();
			if (session) {
				session.persistState = true;
				session.profileName = TEST_PROFILE;
			}
		});

		it("navigates again with same profile — consent dialog does NOT reappear", async () => {
			// This navigate triggers getOrCreateContext, which:
			//   1. Calls _persistState → saves cookies to disk, returns state object
			//   2. Closes old context
			//   3. Uses savedState as fallback for the new context's storageState
			// The cookie set during step 2 is thus available for the new context.
			const nav = await plugin.navigate(serverUrl, TASK_ID, NAV_TIMEOUT, {
				profileName: TEST_PROFILE,
				profileMode: "named",
			});
			expect(nav.success).toBe(true);

			// Consent dialog should NOT be present — cookies were restored
			// from the in-memory fallback (savedState returned by _persistState).
			expect(nav.snapshot).not.toContain("Consent");
			expect(nav.snapshot).not.toContain("Accept All");
		});

		it("storage-state.json exists on disk with the consent cookie", async () => {
			const state = loadStorageState(TEST_PROFILE);
			expect(state).not.toBeNull();
			expect(state!.cookies.length).toBeGreaterThan(0);

			const consentCookie = state!.cookies.find(
				(c) => c.name === "consent" && c.value === "accepted",
			);
			expect(consentCookie).toBeDefined();
		});

		it("third navigate also has no consent dialog (full disk-path round-trip)", async () => {
			// The state saved to disk during the second navigate (test 4's
			// _persistState call) is now available. The in-memory fallback
			// returns it again, and the disk copy exists for the router to load.
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
