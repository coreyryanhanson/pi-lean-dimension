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

	// ─── screenshot() ──────────────────────────────────────────

	describe("screenshot()", () => {
		it("dispatches to plugin.screenshot", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.screenshot("default");
			expect(result.success).toBe(true);
			expect(result.dataUri).toBe("data:image/jpeg;base64,mockdata");
		});

		it("returns error without a session", async () => {
			const result = await router.screenshot("default");
			expect(result.success).toBe(false);
			expect(result.dataUri).toBe("");
		});

		it("passes fullPage option when capabilities support it", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			await router.screenshot("default", true);
			const [, opts] = mock.calls.get("screenshot")![0] as [
				string,
				{ fullPage?: boolean } | undefined,
			];
			expect(opts).toEqual({ fullPage: true });
		});

		it("omits fullPage option when plugin does not support it", async () => {
			// Register a limited-capability plugin
			const limited = new MockPlugin("limited", {
				supportsFullPageScreenshot: false,
			});
			await pluginRegistry.register(limited, makeConfig({ name: "limited" }));

			// Navigate with the limited plugin
			await router.navigate("https://example.com", { strategy: "limited" });

			limited.calls.delete("navigate");
			await router.screenshot("default", true);
			const [, opts] = limited.calls.get("screenshot")![0] as [
				string,
				{ fullPage?: boolean } | undefined,
			];
			// fullPage should NOT be passed since capability is false
			expect(opts).toEqual({});
		});
	});

	// ─── getImages() ───────────────────────────────────────────

	describe("getImages()", () => {
		it("dispatches to plugin.getImages", async () => {
			await router.navigate("https://example.com");
			mock.calls.delete("navigate");

			const result = await router.getImages("default");
			expect(result.success).toBe(true);
			expect(result.images).toHaveLength(1);
			expect(result.images[0]!.src).toBe("https://example.com/img.png");
		});

		it("returns error without a session", async () => {
			const result = await router.getImages("default");
			expect(result.success).toBe(false);
			expect(result.images).toEqual([]);
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
