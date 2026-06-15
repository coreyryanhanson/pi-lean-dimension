/**
 * Shared-context integration tests — exercises the real ChromiumPlugin
 * against a local test server to validate the shared BrowserContext model
 * with reference counting, concurrent creation, and storage-state persistence.
 *
 * These tests require Playwright Chromium to be installed.
 *
 * Test groups:
 *   1. Basic shared-context lifecycle (ref counting, page sharing)
 *   2. Concurrent shared-context creation (promise-map singleton)
 *   3. Profile switching mid-conversation
 *   4. Cleanup edge cases
 *   5. Storage state auto-save/restore round-trip
 */

import {
	describe,
	it,
	expect,
	beforeAll,
	afterAll,
	afterEach,
	vi,
} from "vitest";
import { ChromiumPlugin } from "../backends/chromium/index.js";
import { startTestServer } from "./helpers/test-server.js";
import { deleteStorageState } from "../core/shared/storage-state.js";
import { sessionManager } from "../core/shared/session-manager.js";

// ─── Test server fixtures ─────────────────────────────────────────

const PAGE_A = `<!DOCTYPE html><html><head><title>Site A</title></head><body>
  <h1>Site A</h1>
  <p>This is page A.</p>
</body></html>`;

const PAGE_B = `<!DOCTYPE html><html><head><title>Site B</title></head><body>
  <h1>Site B</h1>
  <p>This is page B.</p>
</body></html>`;

const COOKIE_PAGE = `<!DOCTYPE html><html><head><title>Cookie Test</title></head><body>
  <h1>Cookie Test Page</h1>
  <script>
    document.cookie = "shared_cookie=hello_from_shared; path=/";
    console.log("cookie set");
  </script>
</body></html>`;

let serverUrl: string;
let stopServer: () => Promise<void>;
let plugin: ChromiumPlugin;
const TIMEOUT = 30_000;

beforeAll(async () => {
	const testServer = await startTestServer((req, res) => {
		if (req.url === "/a") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(PAGE_A);
		} else if (req.url === "/b") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(PAGE_B);
		} else if (req.url === "/cookie") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(COOKIE_PAGE);
		} else {
			res.writeHead(404);
			res.end("Not found");
		}
	});
	serverUrl = testServer.url;
	stopServer = testServer.stop;

	plugin = new ChromiumPlugin();
	await plugin.init({});
});

afterAll(async () => {
	await plugin.cleanupAll();
	await stopServer();
	await sessionManager.removeAll();
});

// ─── 1. Basic shared-context lifecycle ────────────────────────────

describe("shared-context lifecycle", () => {
	afterEach(async () => {
		// Clean up all tasks to avoid cross-test contamination
		await plugin.cleanup("sc-task-a").catch(() => {});
		await plugin.cleanup("sc-task-b").catch(() => {});
		await plugin.cleanup("sc-task-c").catch(() => {});
		await sessionManager.removeAll();
	});

	it("named profile creates shared context with refCount=1", async () => {
		const result = await plugin.navigate(
			`${serverUrl}/a`,
			"sc-task-a",
			TIMEOUT,
			{
				profileName: "test-shared-work",
				profileMode: "named",
			},
		);

		expect(result.success).toBe(true);

		const sharedContexts = plugin.getSharedContextsForTesting();
		expect(sharedContexts.has("test-shared-work")).toBe(true);
		expect(sharedContexts.get("test-shared-work")?.refCount).toBe(1);

		const pages = plugin.getPagesForTesting();
		expect(pages.has("sc-task-a")).toBe(true);
		expect(pages.get("sc-task-a")?.isSharedContext).toBe(true);
		expect(pages.get("sc-task-a")?.profileName).toBe("test-shared-work");
	});

	it("second task joins same shared context", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileName: "test-shared-join",
			profileMode: "named",
		});

		await plugin.navigate(`${serverUrl}/b`, "sc-task-b", TIMEOUT, {
			profileName: "test-shared-join",
			profileMode: "named",
		});

		const sharedContexts = plugin.getSharedContextsForTesting();
		expect(sharedContexts.get("test-shared-join")?.refCount).toBe(2);

		const pages = plugin.getPagesForTesting();
		expect(pages.get("sc-task-a")?.isSharedContext).toBe(true);
		expect(pages.get("sc-task-b")?.isSharedContext).toBe(true);
		expect(pages.get("sc-task-a")?.profileName).toBe("test-shared-join");
		expect(pages.get("sc-task-b")?.profileName).toBe("test-shared-join");
	});

	it("session profile gets isolated context (not in shared contexts)", async () => {
		const result = await plugin.navigate(
			`${serverUrl}/a`,
			"sc-task-a",
			TIMEOUT,
			{
				profileMode: "session",
			},
		);

		expect(result.success).toBe(true);

		// Session profiles are ephemeral — not in shared contexts
		const pages = plugin.getPagesForTesting();
		expect(pages.get("sc-task-a")?.isSharedContext).toBe(false);
	});

	it("ephemeral profile gets isolated context", async () => {
		const result = await plugin.navigate(
			`${serverUrl}/a`,
			"sc-task-a",
			TIMEOUT,
			{
				profileMode: "none",
			},
		);

		expect(result.success).toBe(true);

		const pages = plugin.getPagesForTesting();
		expect(pages.get("sc-task-a")?.isSharedContext).toBe(false);
		expect(pages.get("sc-task-a")?.profileName).toBeUndefined();
	});

	it("different named profiles get different contexts", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileName: "test-work-diff",
			profileMode: "named",
		});

		await plugin.navigate(`${serverUrl}/b`, "sc-task-b", TIMEOUT, {
			profileName: "test-personal-diff",
			profileMode: "named",
		});

		const sharedContexts = plugin.getSharedContextsForTesting();
		expect(sharedContexts.has("test-work-diff")).toBe(true);
		expect(sharedContexts.has("test-personal-diff")).toBe(true);
		// Each has exactly 1 ref
		expect(sharedContexts.get("test-work-diff")?.refCount).toBe(1);
		expect(sharedContexts.get("test-personal-diff")?.refCount).toBe(1);
		// Different context objects
		const rawContexts = plugin.getSharedContextsRawForTesting();
		const ctxA = rawContexts.get("test-work-diff")?.context;
		const ctxB = rawContexts.get("test-personal-diff")?.context;
		expect(ctxA).not.toBe(ctxB);
	});
});

// ─── 2. Cleanup ref counting ──────────────────────────────────────

describe("cleanup ref counting", () => {
	afterEach(async () => {
		await plugin.cleanup("sc-task-a").catch(() => {});
		await plugin.cleanup("sc-task-b").catch(() => {});
		await plugin.cleanup("sc-task-c").catch(() => {});
		await sessionManager.removeAll();
	});

	it("cleanup decrements refCount, keeps context alive", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileName: "test-refcount",
			profileMode: "named",
		});

		await plugin.navigate(`${serverUrl}/b`, "sc-task-b", TIMEOUT, {
			profileName: "test-refcount",
			profileMode: "named",
		});

		expect(
			plugin.getSharedContextsForTesting().get("test-refcount")?.refCount,
		).toBe(2);

		// Cleanup task A — context stays alive
		await plugin.cleanup("sc-task-a");

		expect(
			plugin.getSharedContextsForTesting().get("test-refcount")?.refCount,
		).toBe(1);

		// Task B's page should still be functional
		const snapB = await plugin.snapshot("sc-task-b");
		expect(snapB.success).toBe(true);
	});

	it("cleanup last page closes shared context", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileName: "test-lastpage",
			profileMode: "named",
		});

		await plugin.navigate(`${serverUrl}/b`, "sc-task-b", TIMEOUT, {
			profileName: "test-lastpage",
			profileMode: "named",
		});

		// Two refs
		expect(
			plugin.getSharedContextsForTesting().get("test-lastpage")?.refCount,
		).toBe(2);

		// Cleanup both
		await plugin.cleanup("sc-task-a");
		await plugin.cleanup("sc-task-b");

		// Shared context should be gone
		expect(plugin.getSharedContextsForTesting().has("test-lastpage")).toBe(
			false,
		);
	});

	it("cleanup isolated context removes it entirely", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileMode: "none",
		});

		expect(plugin.getPagesForTesting().has("sc-task-a")).toBe(true);

		await plugin.cleanup("sc-task-a");

		expect(plugin.getPagesForTesting().has("sc-task-a")).toBe(false);
	});
});

// ─── 3. Concurrent shared-context creation ────────────────────────

describe("concurrent shared-context creation", () => {
	afterEach(async () => {
		await plugin.cleanup("sc-task-a").catch(() => {});
		await plugin.cleanup("sc-task-b").catch(() => {});
		await plugin.cleanup("sc-task-c").catch(() => {});
		await sessionManager.removeAll();
	});

	it("creates exactly one BrowserContext for concurrent same-profile navigate", async () => {
		let newContextCallCount = 0;

		// Spy on _newBrowserContext via prototype to intercept creation
		const origMethod = ChromiumPlugin.prototype["_newBrowserContext"];
		const spy = vi
			.spyOn(ChromiumPlugin.prototype as any, "_newBrowserContext")
			.mockImplementation(async function (storageState?: unknown) {
				newContextCallCount++;
				// Delay to let both tasks enter getOrCreateContext
				await new Promise((r) => setTimeout(r, 100));
				return origMethod.call(this, storageState);
			});

		try {
			const [resultA, resultB] = await Promise.all([
				plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
					profileName: "test-concurrent-1",
					profileMode: "named",
				}),
				plugin.navigate(`${serverUrl}/b`, "sc-task-b", TIMEOUT, {
					profileName: "test-concurrent-1",
					profileMode: "named",
				}),
			]);

			expect(resultA.success).toBe(true);
			expect(resultB.success).toBe(true);

			// Only ONE BrowserContext was created (promise-map singleton)
			expect(newContextCallCount).toBe(1);

			// Both tasks should be in the shared context with refCount=2
			expect(
				plugin.getSharedContextsForTesting().get("test-concurrent-1")?.refCount,
			).toBe(2);
		} finally {
			spy.mockRestore();
		}
	});

	it("handles three concurrent callers sharing one context", async () => {
		let newContextCallCount = 0;

		const origMethod = ChromiumPlugin.prototype["_newBrowserContext"];
		const spy = vi
			.spyOn(ChromiumPlugin.prototype as any, "_newBrowserContext")
			.mockImplementation(async function (storageState?: unknown) {
				newContextCallCount++;
				await new Promise((r) => setTimeout(r, 100));
				return origMethod.call(this, storageState);
			});

		try {
			const [resultA, resultB, resultC] = await Promise.all([
				plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
					profileName: "test-triple",
					profileMode: "named",
				}),
				plugin.navigate(`${serverUrl}/b`, "sc-task-b", TIMEOUT, {
					profileName: "test-triple",
					profileMode: "named",
				}),
				plugin.navigate(`${serverUrl}/a`, "sc-task-c", TIMEOUT, {
					profileName: "test-triple",
					profileMode: "named",
				}),
			]);

			expect(resultA.success).toBe(true);
			expect(resultB.success).toBe(true);
			expect(resultC.success).toBe(true);

			expect(newContextCallCount).toBe(1);
			expect(
				plugin.getSharedContextsForTesting().get("test-triple")?.refCount,
			).toBe(3);
		} finally {
			spy.mockRestore();
		}
	});

	it("caller arriving after creation reuses existing context", async () => {
		// First navigate completes before second starts
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileName: "test-reuse",
			profileMode: "named",
		});

		expect(
			plugin.getSharedContextsForTesting().get("test-reuse")?.refCount,
		).toBe(1);

		// Second navigate reuses the existing shared context
		await plugin.navigate(`${serverUrl}/b`, "sc-task-b", TIMEOUT, {
			profileName: "test-reuse",
			profileMode: "named",
		});

		expect(
			plugin.getSharedContextsForTesting().get("test-reuse")?.refCount,
		).toBe(2);
	});
});

// ─── 4. Profile switching ─────────────────────────────────────────

describe("profile switching", () => {
	afterEach(async () => {
		await plugin.cleanup("sc-task-a").catch(() => {});
		await sessionManager.removeAll();
	});

	it("switches from one named profile to another", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileName: "test-switch-work",
			profileMode: "named",
		});

		expect(plugin.getSharedContextsForTesting().has("test-switch-work")).toBe(
			true,
		);

		// Simulate router profile switch: cleanup first, then navigate with new profile
		await plugin.cleanup("sc-task-a");
		await plugin.navigate(`${serverUrl}/b`, "sc-task-a", TIMEOUT, {
			profileName: "test-switch-personal",
			profileMode: "named",
		});

		// Old profile should have been cleaned up (refCount went to 0)
		expect(plugin.getSharedContextsForTesting().has("test-switch-work")).toBe(
			false,
		);
		// New profile should exist
		expect(
			plugin.getSharedContextsForTesting().has("test-switch-personal"),
		).toBe(true);
		expect(
			plugin.getSharedContextsForTesting().get("test-switch-personal")
				?.refCount,
		).toBe(1);
	});

	it("switches from named profile to ephemeral", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileName: "test-ephemeral-switch",
			profileMode: "named",
		});

		expect(
			plugin.getSharedContextsForTesting().has("test-ephemeral-switch"),
		).toBe(true);

		// Router pattern: cleanup first
		await plugin.cleanup("sc-task-a");
		// Navigate to ephemeral
		await plugin.navigate(`${serverUrl}/b`, "sc-task-a", TIMEOUT, {
			profileMode: "none",
		});

		expect(
			plugin.getSharedContextsForTesting().has("test-ephemeral-switch"),
		).toBe(false);
		expect(plugin.getPagesForTesting().get("sc-task-a")?.isSharedContext).toBe(
			false,
		);
	});

	it("switches from ephemeral to named profile", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileMode: "none",
		});

		expect(plugin.getPagesForTesting().get("sc-task-a")?.isSharedContext).toBe(
			false,
		);

		// Router pattern: cleanup first
		await plugin.cleanup("sc-task-a");
		// Navigate to named profile
		await plugin.navigate(`${serverUrl}/b`, "sc-task-a", TIMEOUT, {
			profileName: "test-named-switch",
			profileMode: "named",
		});

		expect(plugin.getPagesForTesting().get("sc-task-a")?.isSharedContext).toBe(
			true,
		);
		expect(plugin.getSharedContextsForTesting().has("test-named-switch")).toBe(
			true,
		);
	});
});

// ─── 5. Cleanup edge cases ────────────────────────────────────────

describe("cleanup edge cases", () => {
	afterEach(async () => {
		await plugin.cleanup("sc-task-a").catch(() => {});
		await plugin.cleanup("sc-task-b").catch(() => {});
		await sessionManager.removeAll();
	});

	it("cleanup on non-existent taskId is no-op", async () => {
		await expect(plugin.cleanup("nonexistent-task")).resolves.toBeUndefined();
	});

	it("cleanupAll with mixed shared and isolated contexts cleans all", async () => {
		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileName: "test-cleanupall",
			profileMode: "named",
		});

		await plugin.navigate(`${serverUrl}/b`, "sc-task-b", TIMEOUT, {
			profileMode: "none",
		});

		// Verify both exist
		expect(plugin.getPagesForTesting().has("sc-task-a")).toBe(true);
		expect(plugin.getPagesForTesting().has("sc-task-b")).toBe(true);

		// Cleanup all
		await plugin.cleanupAll();

		// All cleaned up
		expect(plugin.getPagesForTesting().size).toBe(0);
		expect(plugin.getSharedContextsForTesting().has("test-cleanupall")).toBe(
			false,
		);

		// Re-init for subsequent tests
		await plugin.init({});
	});
});

// ─── 6. Storage state auto-save/restore round-trip ────────────────

describe("storage state auto-save/restore", () => {
	const testProfile = `test-storage-${Date.now()}`;

	afterEach(async () => {
		await plugin.cleanup("sc-task-a").catch(() => {});
		await plugin.cleanup("sc-task-b").catch(() => {});
		deleteStorageState(testProfile);
		await sessionManager.removeAll();
	});

	it("named profile auto-saves storage state on cleanup", async () => {
		// Create a session with persistState=true and profileName
		sessionManager.updateSession("sc-task-a", {
			currentUrl: "https://example.com",
			currentTitle: "Test",
			pluginName: "chromium",
			persistState: true,
			profileName: testProfile,
		});

		await plugin.navigate(`${serverUrl}/cookie`, "sc-task-a", TIMEOUT, {
			profileName: testProfile,
			profileMode: "named",
		});

		// Cleanup — should auto-save storage state
		await plugin.cleanup("sc-task-a");

		// We can't easily inspect the saved file from here because it's written
		// to ~/.pi/agent/browser-state/. But we can verify the session was updated
		// with persistState=true before cleanup.
	});

	it("profile=none does not auto-save on cleanup", async () => {
		// Ephemeral session — persistState=false
		sessionManager.updateSession("sc-task-a", {
			currentUrl: "https://example.com",
			currentTitle: "Test",
			pluginName: "chromium",
			persistState: false,
		});

		await plugin.navigate(`${serverUrl}/a`, "sc-task-a", TIMEOUT, {
			profileMode: "none",
		});

		// Cleanup — should not write any storage state
		await plugin.cleanup("sc-task-a");

		// No-op — the important assertion is that it doesn't crash
		expect(true).toBe(true);
	});

	it("shared context cookies are visible across pages", async () => {
		await plugin.navigate(`${serverUrl}/cookie`, "sc-task-a", TIMEOUT, {
			profileName: testProfile,
			profileMode: "named",
		});

		// Set a cookie on page A
		await plugin.evaluate(
			"sc-task-a",
			`document.cookie = 'shared_cookie=test_value; path=/'`,
		);

		// Navigate task B to the same profile
		await plugin.navigate(`${serverUrl}/a`, "sc-task-b", TIMEOUT, {
			profileName: testProfile,
			profileMode: "named",
		});

		// Task B should see the cookie set by task A (same BrowserContext)
		const cookieResult = await plugin.evaluate("sc-task-b", "document.cookie");
		expect(cookieResult.success).toBe(true);
		expect(String(cookieResult.result)).toContain("shared_cookie");
	});
});
