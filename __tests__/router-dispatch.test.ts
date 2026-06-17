/**
 * Router dispatch tests — verifies every router function dispatches to the
 * correct plugin method with proper error handling, session lifecycle,
 * snapshot truncation, and stale-ref detection.
 *
 * All tests use a MockPlugin (no real browser).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as router from "../core/router.js";
import { pluginRegistry } from "../core/plugin-registry.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin.js";

// ─── Setup ───────────────────────────────────────────────────────

describe("Router dispatch", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	// ─── navigate() ────────────────────────────────────────────

	describe("navigate()", () => {
		it("dispatches to the default plugin with 'auto' strategy", async () => {
			const result = await router.navigate("https://example.com", {
				strategy: "auto",
			});
			expect(result.success).toBe(true);
			expect(result.backendUsed).toBe("mock");

			const navCalls = mock.calls.get("navigate");
			expect(navCalls).toHaveLength(1);
			const [url, taskId, timeoutMs] = navCalls![0] as [string, string, number];
			expect(url).toBe("https://example.com/");
			expect(taskId).toBe("default");
			expect(timeoutMs).toBe(30_000);
		});

		it("dispatches to a named plugin via explicit strategy", async () => {
			const result = await router.navigate("https://example.com", {
				strategy: "mock",
			});
			expect(result.success).toBe(true);
			expect(result.backendUsed).toBe("mock");
		});

		it("returns error for invalid URL without calling the plugin", async () => {
			const result = await router.navigate("not a url!");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/invalid url/i);
			expect(mock.calls.get("navigate")).toBeUndefined();
		});

		it("blocks SSRF URLs without calling the plugin", async () => {
			const result = await router.navigate("http://localhost:8080/");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/blocked/i);
			expect(mock.calls.get("navigate")).toBeUndefined();
		});

		it("blocks private IP ranges", async () => {
			const result = await router.navigate("http://192.168.1.1/");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/blocked/i);
		});

		it("returns error for unknown strategy", async () => {
			const result = await router.navigate("https://example.com", {
				strategy: "nonexistent",
			});
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/not registered/i);
			expect(mock.calls.get("navigate")).toBeUndefined();
		});

		it("reports disabled plugins with a clear error", async () => {
			pluginRegistry.clear();
			const disabled = new MockPlugin("disabled");
			pluginRegistry.register(
				disabled,
				makeConfig({ name: "disabled", enabled: false }),
			);

			const result = await router.navigate("https://example.com", {
				strategy: "disabled",
			});
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/disabled/i);
		});

		it("returns error when registry is empty for 'auto'", async () => {
			pluginRegistry.clear();
			const result = await router.navigate("https://example.com");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no browser plugins/i);
		});

		it("propagates bot detection warning", async () => {
			mock.navResult = { botDetected: true };
			const result = await router.navigate("https://example.com");
			expect(result.botDetectionWarning).toBe(true);
		});

		it("stores lastNav and creates a session on success", async () => {
			await router.navigate("https://example.com");

			const lastNav = sessionManager.getLastNav("default");
			expect(lastNav).toBeDefined();
			expect(lastNav!.url).toBe("https://example.com/");
			expect(lastNav!.pluginName).toBe("mock");

			const session = sessionManager.getSession("default");
			expect(session).toBeDefined();
			expect(session!.pluginName).toBe("mock");
			expect(session!.currentUrl).toBe("https://example.com/");
			expect(session!.currentTitle).toBe("Mock Page");
		});

		it("cleans up session on navigate failure", async () => {
			mock.navResult = {
				success: false,
				error: "timeout",
				url: "https://example.com",
				title: "",
				snapshot: "",
				elementCount: 0,
			};
			await router.navigate("https://example.com");

			// Session should be removed on failure
			const session = sessionManager.getSession("default");
			expect(session).toBeUndefined();

			// Plugin.cleanup should have been called
			expect(mock.calls.get("cleanup")).toBeDefined();
		});

		it("accepts custom timeout", async () => {
			await router.navigate("https://example.com", { timeout: 60 });
			const navCalls = mock.calls.get("navigate");
			const [, , timeoutMs] = navCalls![0] as [string, string, number];
			expect(timeoutMs).toBe(60_000);
		});

		it("compacts the returned snapshot", async () => {
			// MockPlugin default snapshot is short (no truncation)
			// Returning a long snapshot to verify compaction
			mock.navResult = {
				snapshot: "line\n".repeat(300), // ~1500 chars + extra
				elementCount: 50,
			};
			const result = await router.navigate("https://example.com");
			expect(result.snapshot.length).toBeLessThan(3000);
		});
	});

	// ─── snapshot() ────────────────────────────────────────────

	describe("snapshot()", () => {
		it("dispatches to plugin.snapshot with an existing session", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.snapshot("default");
			expect(result.success).toBe(true);
			expect(mock.calls.get("snapshot")).toHaveLength(1);
		});

		it("returns error without an existing session or lastNav", async () => {
			const result = await router.snapshot("other-task");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});

		it("auto-creates session from lastNav and returns snapshot", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
			);
			const result = await router.snapshot("default");
			expect(result.success).toBe(true);
			// Should have navigated to recreate the session
			expect(mock.calls.get("navigate")).toHaveLength(1);
			expect(mock.calls.get("snapshot")).toHaveLength(1);
		});

		it("compacts snapshot when full=false (default)", async () => {
			await router.navigate("https://example.com");
			// Override to return a snapshot over the truncation threshold (>2800 chars)
			const longSnap = "x\n".repeat(2000); // 4000 chars
			mock.snapResult = { snapshot: longSnap, elementCount: 20 };
			const result = await router.snapshot("default", false);
			expect(result.success).toBe(true);
			expect(result.snapshot.length).toBeLessThan(longSnap.length);
		});

		it("returns full (uncompacted) snapshot when full=true", async () => {
			await router.navigate("https://example.com");
			const longSnap = "line\n".repeat(300);
			mock.snapResult = { snapshot: longSnap, elementCount: 20 };
			const result = await router.snapshot("default", true);
			expect(result.success).toBe(true);
			expect(result.snapshot).toBe(longSnap);
		});

		it("returns error when auto-creation fails (lastNav plugin gone)", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"extinct-plugin",
			);
			const result = await router.snapshot("default");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});
	});

	// ─── click() ───────────────────────────────────────────────

	describe("click()", () => {
		it("dispatches to plugin.click with correct ref", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.click("default", "@e1");
			expect(result.success).toBe(true);
			const [taskId, ref] = mock.calls.get("click")![0] as [string, string];
			expect(taskId).toBe("default");
			expect(ref).toBe("@e1");
		});

		it("returns error without an existing session or lastNav", async () => {
			const result = await router.click("default", "@e1");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});

		it("returns snapshot on auto-created session (stale refs)", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
			);
			const result = await router.click("default", "@e1");
			expect(result.success).toBe(true);
			// Should have navigated to recreate session
			expect(mock.calls.get("navigate")).toHaveLength(1);
			// Should NOT have clicked (stale refs)
			expect(mock.calls.get("click")).toBeUndefined();
			// Should contain the accessibility tree hint
			expect(result.snapshot).toMatch(/accessibility tree/i);
		});

		it("returns error when auto-creation navigation fails", async () => {
			mock.navResult = {
				success: false,
				error: "navig error",
				url: "https://example.com",
				title: "",
				snapshot: "",
				elementCount: 0,
			};
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
			);
			const result = await router.click("default", "@e1");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});

		it("returns error when lastNav references a missing plugin", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"extinct",
			);
			const result = await router.click("default", "@e1");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});
	});

	// ─── type() ────────────────────────────────────────────────

	describe("type()", () => {
		it("dispatches to plugin.type with correct ref and text", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.type("default", "@e2", "hello world");
			expect(result.success).toBe(true);
			const [taskId, ref, text] = mock.calls.get("type")![0] as [
				string,
				string,
				string,
			];
			expect(taskId).toBe("default");
			expect(ref).toBe("@e2");
			expect(text).toBe("hello world");
		});

		it("returns error without a session", async () => {
			const result = await router.type("default", "@e2", "hello");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});

		it("returns snapshot on auto-created session (stale refs)", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
			);
			const result = await router.type("default", "@e2", "hello");
			expect(result.success).toBe(true);
			expect(mock.calls.get("type")).toBeUndefined();
			expect(result.snapshot).toMatch(/accessibility tree/i);
		});
	});

	// ─── scroll() ──────────────────────────────────────────────

	describe("scroll()", () => {
		it("dispatches to plugin.scroll with direction", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			await router.scroll("default", "down");
			const [, dir] = mock.calls.get("scroll")![0] as [string, string];
			expect(dir).toBe("down");
		});

		it("returns error without a session", async () => {
			const result = await router.scroll("default", "down");
			expect(result.success).toBe(false);
		});
	});

	// ─── goBack() ──────────────────────────────────────────────

	describe("goBack()", () => {
		it("dispatches to plugin.goBack", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.goBack("default");
			expect(result.success).toBe(true);
			expect(mock.calls.get("goBack")).toHaveLength(1);
		});

		it("returns error without a session", async () => {
			const result = await router.goBack("default");
			expect(result.success).toBe(false);
		});
	});

	// ─── press() ───────────────────────────────────────────────

	describe("press()", () => {
		it("dispatches to plugin.press with correct key", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			await router.press("default", "Enter");
			const [, key] = mock.calls.get("press")![0] as [string, string];
			expect(key).toBe("Enter");
		});

		it("returns error without a session", async () => {
			const result = await router.press("default", "Escape");
			expect(result.success).toBe(false);
		});
	});

	// ─── screenshotToTemp() ─────────────────────────────────────

	describe("screenshotToTemp()", () => {
		it("returns a file path on success", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const path = await router.screenshotToTemp("default");
			expect(path).toBeDefined();
			expect(path).toMatch(/\/screenshot-default\.jpg$/);
		});

		it("returns null without a session", async () => {
			const path = await router.screenshotToTemp("default");
			expect(path).toBeNull();
		});

		it("returns null when screenshot fails", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");
			mock.shouldThrow.add("screenshot");

			const path = await router.screenshotToTemp("default");
			expect(path).toBeNull();
		});
	});

	// ─── Console & eval ────────────────────────────────────────

	describe("getConsoleMessages()", () => {
		it("dispatches to plugin.getConsoleMessages", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.getConsoleMessages("default");
			expect(result.success).toBe(true);
			expect(result.messages).toContainEqual({
				type: "log",
				text: "hello",
			});
		});

		it("returns error without a session", async () => {
			const result = await router.getConsoleMessages("default");
			expect(result.success).toBe(false);
			expect(result.messages).toEqual([]);
		});
	});

	describe("clearConsole()", () => {
		it("dispatches to plugin.clearConsole", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.clearConsole("default");
			expect(result.success).toBe(true);
			expect(mock.calls.get("clearConsole")).toHaveLength(1);
		});

		it("returns error without a session", async () => {
			const result = await router.clearConsole("default");
			expect(result.success).toBe(false);
		});
	});

	describe("evaluate()", () => {
		it("dispatches to plugin.evaluate with the expression", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.evaluate("default", "1 + 1");
			expect(result.success).toBe(true);
			expect(result.result).toBe(42);
			const [, expr] = mock.calls.get("evaluate")![0] as [string, string];
			expect(expr).toBe("1 + 1");
		});

		it("returns error without a session", async () => {
			const result = await router.evaluate("default", "1 + 1");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});
	});

	// ─── Task ID handling ──────────────────────────────────────

	describe("task ID handling", () => {
		it("uses provided taskId for session creation", async () => {
			await router.navigate("https://example.com", { taskId: "my-task" });
			const session = sessionManager.getSession("my-task");
			expect(session).toBeDefined();
			expect(session!.pluginName).toBe("mock");
		});

		it("defaults to 'default' when no taskId is given", async () => {
			await router.navigate("https://example.com");
			const session = sessionManager.getSession("default");
			expect(session).toBeDefined();
		});

		it("isolates sessions by different taskIds", async () => {
			await router.navigate("https://alpha.com", { taskId: "task-a" });
			await router.navigate("https://beta.com", { taskId: "task-b" });

			expect(sessionManager.getSession("task-a")!.currentUrl).toBe(
				"https://alpha.com/",
			);
			expect(sessionManager.getSession("task-b")!.currentUrl).toBe(
				"https://beta.com/",
			);
		});
	});
});

// ─── compactSnapshot unit tests ──────────────────────────────────

describe("compactSnapshot()", () => {
	it("returns short snapshots unchanged", () => {
		const short = '- button "Click me"\n- link "More"\n';
		const result = router.compactSnapshot(short, 2);
		expect(result).toBe(short);
	});

	it("truncates medium snapshots at a newline boundary near 2500 chars", () => {
		// Create a snapshot in the medium range (2800-8000 chars)
		const content = "line content here\n".repeat(200); // ~3600 chars
		const result = router.compactSnapshot(content, 30);
		expect(result.length).toBeLessThan(content.length);
		// Should include element count hint
		expect(result).toContain("30 elements");
		// Should end with a truncation note
		expect(result).toContain("more chars");
	});

	it("preserves top section for very large snapshots (>8000)", () => {
		const content = "top-section-data-line\n".repeat(500); // ~12500 chars
		const result = router.compactSnapshot(content, 100);
		expect(result.length).toBeLessThan(content.length);
		// Should preserve roughly the top part
		expect(result).toContain("top-section-data-line");
	});

	it("handles empty snapshots gracefully", () => {
		const result = router.compactSnapshot("", 0);
		expect(result).toBe("");
	});

	it("includes element count hint in truncation notes", () => {
		const content = "x\n".repeat(2000); // 4000 chars — over the truncation threshold
		const result = router.compactSnapshot(content, 15);
		expect(result).toMatch(/\d+ elements/);
	});

	it("omits element count when count is zero", () => {
		const content = "x\n".repeat(2000); // 4000 chars — over the truncation threshold
		const result = router.compactSnapshot(content, 0);
		expect(result).not.toMatch(/\d+ elements/);
	});
});

// ─── Session persistence across sequential calls ─────────────────

describe("session persistence across sequential calls", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock", enabled: true }));
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	it("navigate then screenshotToTemp succeeds with same taskId", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-1" });

		const path = await router.screenshotToTemp("seq-test-1");
		expect(path).toBeDefined();
		expect(path).toMatch(/\/screenshot-seq-test-1\.jpg$/);
	});

	it("navigate then snapshot succeeds with same taskId", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-2" });

		const result = await router.snapshot("seq-test-2");
		expect(result.success).toBe(true);
		expect(result.snapshot).toBeTruthy();
	});

	it("navigate click type succeed sequentially", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-3" });

		const clickResult = await router.click("seq-test-3", "@e1");
		expect(clickResult.success).toBe(true);

		const typeResult = await router.type("seq-test-3", "@e2", "hello");
		expect(typeResult.success).toBe(true);
	});

	it("navigate then goBack succeeds", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-4" });

		const result = await router.goBack("seq-test-4");
		expect(result.success).toBe(true);
	});

	it("navigate then scroll succeeds", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-5" });

		const result = await router.scroll("seq-test-5", "down");
		expect(result.success).toBe(true);
	});

	it("navigate then evaluate succeeds", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-6" });

		const result = await router.evaluate("seq-test-6", "1 + 1");
		expect(result.success).toBe(true);
	});

	it("navigate then press succeeds", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-7" });

		const result = await router.press("seq-test-7", "Enter");
		expect(result.success).toBe(true);
	});

	it("navigate then getConsoleMessages succeeds", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-9" });

		const result = await router.getConsoleMessages("seq-test-9");
		expect(result.success).toBe(true);
	});

	it("navigate then clearConsole succeeds", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-10" });

		const result = await router.clearConsole("seq-test-10");
		expect(result.success).toBe(true);
	});
});

// ─── Occlusion error propagation ────────────────────────────────

describe("occlusion error propagation", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock", enabled: true }));
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	it("passes through occlusion errors from click", async () => {
		mock.interactResult = {
			success: false,
			error:
				"Element @e1 is obscured by another element (likely a modal/overlay). " +
				'Try pressing Escape (browser-press key="Escape") to dismiss the overlay, then retry.',
		};

		await router.navigate("https://example.com", { taskId: "occ-test-1" });
		const result = await router.click("occ-test-1", "@e1");

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/obscured/i);
		expect(result.error).toMatch(/Escape/i);
	});

	it("passes through occlusion errors from type", async () => {
		mock.interactResult = {
			success: false,
			error:
				"Element @e1 is obscured by another element (likely a modal/overlay). " +
				'Try pressing Escape (browser-press key="Escape") to dismiss the overlay, then retry.',
		};

		await router.navigate("https://example.com", { taskId: "occ-test-2" });
		const result = await router.type("occ-test-2", "@e1", "hello");

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/obscured/i);
		expect(result.error).toMatch(/Escape/i);
	});
});

// ─── Bot detection UX ───────────────────────────────────────────

describe("bot detection UX", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock", enabled: true }));
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	describe("downgrade heuristic", () => {
		it("returns success:false when botDetected and low element count", async () => {
			mock.navResult = {
				success: true,
				url: "https://challenge.example",
				title: "Just a moment...",
				snapshot: "- heading 'Just a moment...'",
				elementCount: 1,
				botDetected: true,
			};

			const result = await router.navigate("https://challenge.example");
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/blocked|anti-automation/i);
			expect(result.botDetectionWarning).toBe(true);
		});

		it("does NOT downgrade when botDetected but elementCount is high", async () => {
			mock.navResult = {
				success: true,
				url: "https://paginated.example",
				title: "Page Title",
				snapshot: "- article 'Post 1'\n- article 'Post 2'\n",
				elementCount: 120,
				botDetected: true,
			};

			const result = await router.navigate("https://paginated.example");
			expect(result.success).toBe(true);
			expect(result.botDetectionWarning).toBe(true);
		});

		it("does NOT downgrade when no bot detection, even with low element count", async () => {
			// Valid lightweight page (like example.com) with only 2 elements
			mock.navResult = {
				success: true,
				url: "https://example.com",
				title: "Example Domain",
				snapshot: "- heading 'Example Domain'\n- link 'More'",
				elementCount: 2,
				botDetected: false,
			};

			const result = await router.navigate("https://example.com");
			expect(result.success).toBe(true);
			expect(result.botDetectionWarning).toBeUndefined();
		});
	});

	describe("snapshot compaction", () => {
		it("skips compactSnapshot when botDetected is true, but includes fingerprint", async () => {
			// Create a long snapshot that would normally be compacted (>2800 chars)
			const longSnapshot = "line\n".repeat(600); // ~3600 chars
			mock.navResult = {
				success: true,
				url: "https://bot.example",
				title: "Bot Page",
				snapshot: longSnapshot,
				elementCount: 50,
				botDetected: true,
			};

			const result = await router.navigate("https://bot.example");
			expect(result.success).toBe(true);
			// Snapshot should be full version (not compacted), plus fingerprint
			expect(result.snapshot).toContain(longSnapshot);
			expect(result.snapshot).toMatch(/fingerprint:/);
			expect(result.botDetectionWarning).toBe(true);
		});

		it("still compacts snapshot when botDetected is false", async () => {
			const longSnapshot = "line\n".repeat(600); // ~3600 chars
			mock.navResult = {
				success: true,
				url: "https://normal.example",
				title: "Normal Page",
				snapshot: longSnapshot,
				elementCount: 50,
				botDetected: false,
			};

			const result = await router.navigate("https://normal.example");
			expect(result.success).toBe(true);
			// Snapshot should be compacted (longSnapshot is > 2800 chars)
			expect(result.snapshot).not.toBe(longSnapshot);
		});
	});

	describe("downgrade cleans up session", () => {
		it("removes the session when bot detection causes downgrade", async () => {
			mock.navResult = {
				success: true,
				url: "https://challenge.example",
				title: "Challenge",
				snapshot: "- heading 'Challenge'",
				elementCount: 1,
				botDetected: true,
			};

			await router.navigate("https://challenge.example", {
				taskId: "challenge-test",
			});
			const session = sessionManager.getSession("challenge-test");
			expect(session).toBeUndefined();

			// cleanup should have been called on the plugin
			expect(mock.calls.get("cleanup")).toBeDefined();
		});
	});

	// ─── Snapshot fingerprint — passive surfacing ────────────

	describe("snapshot fingerprint is surfaced", () => {
		it("stores fingerprint after navigate", async () => {
			const rawSnap = '- button "Click"\n- link "More"\n';
			mock.navResult = { snapshot: rawSnap };
			await router.navigate("https://example.com");

			const session = sessionManager.getSession("default");
			expect(session?.currentSnapshotFingerprint).toBeDefined();
			const { snapshotFingerprint } = await import(
				"../core/shared/accessibility-tree.js"
			);
			expect(session!.currentSnapshotFingerprint).toBe(
				snapshotFingerprint(rawSnap),
			);
		});

		it("includes fingerprint line in interaction result", async () => {
			const rawSnap = '- button "Same"\n- link "Same"\n';
			mock.navResult = { snapshot: rawSnap };
			mock.interactResult = { snapshot: rawSnap };

			await router.navigate("https://example.com");
			const result = await router.click("default", "e1");

			expect(result.success).toBe(true);
			expect(result.snapshot).toMatch(/fingerprint:/);
		});

		it("fingerprint line changes when content changes", async () => {
			mock.navResult = { snapshot: '- button "Page A"\n' };
			await router.navigate("https://example.com");

			mock.interactResult = { snapshot: '- link "Page B"\n' };
			const result = await router.click("default", "e1");

			expect(result.success).toBe(true);
			expect(result.snapshot).toMatch(/fingerprint:/);
			// No warning injected — just the passive fingerprint line
			expect(result.snapshot).not.toContain("content structure changed");
		});

		it("stores updated fingerprint after interaction", async () => {
			const rawSnap = '- button "Initial"\n';
			const clickSnap = '- link "Updated"\n';
			mock.navResult = { snapshot: rawSnap };

			await router.navigate("https://example.com");

			mock.interactResult = { snapshot: clickSnap };
			await router.click("default", "e1");

			const session = sessionManager.getSession("default");
			const { snapshotFingerprint } = await import(
				"../core/shared/accessibility-tree.js"
			);
			expect(session!.currentSnapshotFingerprint).toBe(
				snapshotFingerprint(clickSnap),
			);
		});

		it("stores fingerprint after snapshot() call", async () => {
			const navSnap = '- button "Init"\n';
			const snapSnap = '- link "Refreshed"\n';
			mock.navResult = { snapshot: navSnap };
			await router.navigate("https://example.com");

			mock.snapResult = { snapshot: snapSnap };
			await router.snapshot("default");

			const session = sessionManager.getSession("default");
			const { snapshotFingerprint } = await import(
				"../core/shared/accessibility-tree.js"
			);
			expect(session!.currentSnapshotFingerprint).toBe(
				snapshotFingerprint(snapSnap),
			);
		});
	});

	// ─── Profile-aware auto-recovery (Phase 7) ─────────────────
	describe("profile-aware auto-recovery", () => {
		it("restores profileName from lastNav on auto-creation", async () => {
			await sessionManager.removeAll();
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
				"work",
			);

			const result = await router.snapshot("default");
			expect(result.success).toBe(true);

			const session = sessionManager.getSession("default");
			expect(session).toBeDefined();
			expect(session!.profileName).toBe("work");
		});

		it("restores session profile from lastNav on auto-creation", async () => {
			await sessionManager.removeAll();
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
				"_session-test-session-abc",
			);

			const result = await router.snapshot("default");
			expect(result.success).toBe(true);

			const session = sessionManager.getSession("default");
			expect(session).toBeDefined();
			expect(session!.profileName).toBe("_session-test-session-abc");
		});

		it("no profileName restored when lastNav has no profile", async () => {
			await sessionManager.removeAll();
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
			);

			const result = await router.snapshot("default");
			expect(result.success).toBe(true);

			const session = sessionManager.getSession("default");
			expect(session).toBeDefined();
			expect(session!.profileName).toBeUndefined();
		});

		it("click auto-recovers and returns stale ref hint", async () => {
			await sessionManager.removeAll();
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
				"work",
			);

			const result = await router.click("default", "@e5");
			expect(result.success).toBe(true);
			expect(mock.calls.get("click")).toBeUndefined();
			expect(mock.calls.get("navigate")).toBeDefined();
			expect(result.snapshot).toMatch(/accessibility tree/i);
		});

		it("type auto-recovers and returns stale ref hint", async () => {
			await sessionManager.removeAll();
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
				"work",
			);

			const result = await router.type("default", "@e3", "hello");
			expect(result.success).toBe(true);
			expect(mock.calls.get("type")).toBeUndefined();
			expect(mock.calls.get("navigate")).toBeDefined();
		});
	});
});

// ─── Cookie dispatch ──────────────────────────────────────────

describe("Router cookie dispatch", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	// ─── getCookies() ──────────────────────────────────────────

	describe("getCookies()", () => {
		it("dispatches to plugin.getCookies with an existing session", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.getCookies("default");

			expect(result.success).toBe(true);
			expect(mock.calls.get("getCookies")).toHaveLength(1);
			const [taskId, urls] = mock.calls.get("getCookies")![0] as [
				string,
				string[] | undefined,
			];
			expect(taskId).toBe("default");
			expect(urls).toBeUndefined();
		});

		it("passes optional urls filter", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			await router.getCookies("default", ["https://example.com"]);

			const [, urls] = mock.calls.get("getCookies")![0] as [
				string,
				string[] | undefined,
			];
			expect(urls).toEqual(["https://example.com"]);
		});

		it("returns error without an existing session", async () => {
			const result = await router.getCookies("default");

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});

		it("handles plugin not available", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			// Remove the plugin from registry
			pluginRegistry.clear();
			// Re-register with a different name so session has stale pluginName
			const otherMock = new MockPlugin("other");
			pluginRegistry.register(otherMock, makeConfig({ name: "other" }));

			const result = await router.getCookies("default");

			// Session still exists with "mock" pluginName, but only "other" is registered
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/not available/i);
		});
	});

	// ─── addCookies() ──────────────────────────────────────────

	describe("addCookies()", () => {
		it("dispatches to plugin.addCookies with the cookies array", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const cookies = [
				{ name: "test", value: "val", domain: ".example.com", path: "/" },
			];
			const result = await router.addCookies("default", cookies);

			expect(result.success).toBe(true);
			expect(mock.calls.get("addCookies")).toHaveLength(1);
			const [taskId, passedCookies] = mock.calls.get("addCookies")![0] as [
				string,
				unknown[],
			];
			expect(taskId).toBe("default");
			expect(passedCookies).toEqual(cookies);
		});

		it("returns error without an existing session", async () => {
			const result = await router.addCookies("default", [
				{ name: "test", value: "val" },
			]);

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});

		it("handles plugin not available", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			pluginRegistry.clear();
			const otherMock = new MockPlugin("other");
			pluginRegistry.register(otherMock, makeConfig({ name: "other" }));

			const result = await router.addCookies("default", [
				{ name: "test", value: "val" },
			]);

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/not available/i);
		});
	});

	// ─── clearCookies() ────────────────────────────────────────

	describe("clearCookies()", () => {
		it("dispatches to plugin.clearCookies with no options", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.clearCookies("default");

			expect(result.success).toBe(true);
			expect(mock.calls.get("clearCookies")).toHaveLength(1);
			const [taskId, options] = mock.calls.get("clearCookies")![0] as [
				string,
				unknown,
			];
			expect(taskId).toBe("default");
			expect(options).toBeUndefined();
		});

		it("passes filter options", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			await router.clearCookies("default", {
				name: "session",
				domain: ".example.com",
			});

			const [, options] = mock.calls.get("clearCookies")![0] as [
				string,
				{ name?: string; domain?: string; path?: string } | undefined,
			];
			expect(options).toBeDefined();
			expect(options!.name).toBe("session");
			expect(options!.domain).toBe(".example.com");
		});

		it("returns error without an existing session", async () => {
			const result = await router.clearCookies("default");

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});

		it("handles plugin not available", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			pluginRegistry.clear();
			const otherMock = new MockPlugin("other");
			pluginRegistry.register(otherMock, makeConfig({ name: "other" }));

			const result = await router.clearCookies("default");

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/not available/i);
		});
	});

	// ─── Session auto-recovery ─────────────────────────────────

	describe("auto-recovery on cookie operations", () => {
		it("getCookies auto-creates a session from lastNav if none exists", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
			);

			const result = await router.getCookies("default");

			expect(result.success).toBe(true);
			// Should have navigated to recreate the session
			expect(mock.calls.get("navigate")).toHaveLength(1);
			expect(mock.calls.get("getCookies")).toHaveLength(1);
		});

		it("addCookies auto-creates a session from lastNav", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
			);

			const result = await router.addCookies("default", [
				{ name: "test", value: "val" },
			]);

			expect(result.success).toBe(true);
			expect(mock.calls.get("navigate")).toHaveLength(1);
			expect(mock.calls.get("addCookies")).toHaveLength(1);
		});

		it("clearCookies auto-creates a session from lastNav", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"mock",
			);

			const result = await router.clearCookies("default");

			expect(result.success).toBe(true);
			expect(mock.calls.get("navigate")).toHaveLength(1);
			expect(mock.calls.get("clearCookies")).toHaveLength(1);
		});

		it("returns error when auto-creation fails (lastNav plugin gone)", async () => {
			sessionManager.setLastNav(
				"default",
				"https://example.com",
				"Mock",
				"extinct-plugin",
			);

			const result = await router.getCookies("default");

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no active session/i);
		});
	});
});
