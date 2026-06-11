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

	describe("dialog-aware truncation", () => {
		const DIALOG_LINES = [
			'💬 dialog "Let us know your cookie preferences"',
			'  @e742 🔘 button "Accept all cookies"',
			'  @e743 🔘 button "Reject all"',
			'  @e744 🔘 button "Customize settings"',
		];
		const DIALOG_BLOCK = DIALOG_LINES.join("\n");

		it("includes hidden dialog blocks in very large snapshots", () => {
			// Build a snapshot with ~3000 chars of content before the dialog block
			const content = "line content here padding\n".repeat(120); // ~3000 chars
			const snap = content + "\n" + DIALOG_BLOCK;
			const result = router.compactSnapshot(snap, 200);

			// Dialog block should appear in the compacted output
			expect(result).toContain("Let us know your cookie preferences");
			expect(result).toContain("Accept all cookies");
			expect(result).toContain("Reject all");
			expect(result).toContain("Customize settings");
			// Should still include the truncation hint
			expect(result).toMatch(/more chars/);
		});

		it("does NOT duplicate dialog blocks already in the visible top section", () => {
			// Dialog near the top (within first 2000 chars) — should NOT be duplicated
			const header = "top content\n".repeat(20); // ~300 chars
			const snap = header + DIALOG_BLOCK + "\n" + "footer\n".repeat(200); // ~3000 chars beyond
			const result = router.compactSnapshot(snap, 100);

			// Dialog should appear only once
			const matches = result.match(/Let us know your cookie preferences/g);
			expect(matches).toHaveLength(1);
		});

		it("includes hidden dialog blocks in medium snapshots (2800-8000 chars)", () => {
			// Build content that's ~3000 chars with a dialog at the end
			const content = "line content here\n".repeat(120); // ~2160 chars
			const snap = content + "\n" + DIALOG_BLOCK;
			const result = router.compactSnapshot(snap, 50);

			// Dialog should be visible
			expect(result).toContain("Customize settings");
		});

		it("handles multiple hidden dialog blocks", () => {
			const dialog2 = ['💬 dialog "Second dialog"', '  @e800 🔘 button "OK"'];
			const content = "line content\n".repeat(150); // ~2250 chars
			const snap = content + "\n" + DIALOG_BLOCK + "\n" + dialog2.join("\n");
			const result = router.compactSnapshot(snap, 300);

			expect(result).toContain("Let us know your cookie preferences");
			expect(result).toContain("Second dialog");
			expect(result).toContain("OK");
		});

		it("handles alertdialog headers too", () => {
			const alertDialog = [
				'⚠ alertdialog "Important alert"',
				'  @e50 🔘 button "Acknowledge"',
			];
			const content = "line content\n".repeat(150); // ~2250 chars
			const snap = content + "\n" + alertDialog.join("\n");
			const result = router.compactSnapshot(snap, 50);

			expect(result).toContain("Important alert");
			expect(result).toContain("Acknowledge");
		});

		it("caps very large dialog blocks", () => {
			// Build a dialog with many children
			const largeDialogHeader = '💬 dialog "Large dialog"';
			const largeDialogLines = [largeDialogHeader];
			for (let i = 0; i < 100; i++) {
				largeDialogLines.push(`  @e${i + 100} 🔘 button "Option ${i}"`);
			}
			const largeDialogBlock = largeDialogLines.join("\n");

			const content = "line content\n".repeat(150); // ~2250 chars
			const snap = content + "\n" + largeDialogBlock;
			const result = router.compactSnapshot(snap, 200);

			// Dialog header should always be visible
			expect(result).toContain("Large dialog");
			// First few children should be visible
			expect(result).toContain("Option 0");
			// But the whole block should be capped (not all 100 children)
			expect(result).toContain("more dialog elements");
		});

		it("no dialogs in snapshot — unchanged behavior", () => {
			const content = "line content with longer text here\n".repeat(200); // ~5600 chars
			const result = router.compactSnapshot(content, 30);
			expect(result.length).toBeLessThan(content.length);
			expect(result).toContain("30 elements");
			// No dialog content should appear
			expect(result).not.toContain("dialog");
		});

		it("nested dialog (indented) is still detected", () => {
			// Dialog can be at any indent level, not just top-level
			const nestedDialogLines = [
				"  " + DIALOG_LINES[0]!,
				"    " + DIALOG_LINES[1]!.trim(),
				"    " + DIALOG_LINES[2]!.trim(),
			];
			const nestedBlock = nestedDialogLines.join("\n");

			const content = "line content\n".repeat(150); // ~2250 chars
			const snap = content + "\n" + nestedBlock;
			const result = router.compactSnapshot(snap, 50);

			expect(result).toContain("Let us know your cookie preferences");
			// Nested children should also be visible
			expect(result).toContain("Accept all cookies");
			expect(result).toContain("Reject all");
		});
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

	it("navigate then screenshot succeeds with same taskId", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-1" });

		const result = await router.screenshot("seq-test-1");
		expect(result.success).toBe(true);
		expect(result.dataUri).toMatch(/^data:image\/jpeg;base64,/);
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

	it("navigate then getImages succeeds", async () => {
		await router.navigate("https://example.com", { taskId: "seq-test-8" });

		const result = await router.getImages("seq-test-8");
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
		it("skips compactSnapshot when botDetected is true", async () => {
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
			// Snapshot should be the full version, not compacted
			expect(result.snapshot).toBe(longSnapshot);
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

	// ─── Snapshot fingerprint — DOM-change detection ────────────

	describe("snapshot fingerprint for DOM-change detection", () => {
		it("stores fingerprint after navigate", async () => {
			const rawSnap = '- button "Click"\n- link "More"\n';
			mock.navResult = { snapshot: rawSnap };
			await router.navigate("https://example.com");

			const session = sessionManager.getSession("default");
			expect(session?.currentSnapshotFingerprint).toBeDefined();
			// Fingerprint should be the hash of the raw snapshot
			const { snapshotFingerprint } = await import(
				"../core/shared/accessibility-tree.js"
			);
			expect(session!.currentSnapshotFingerprint).toBe(
				snapshotFingerprint(rawSnap),
			);
		});

		it("does not warn when snapshot content is unchanged", async () => {
			const rawSnap = '- button "Same"\n- link "Same"\n';
			mock.navResult = { snapshot: rawSnap };
			// Make click return the same snapshot content as navigate
			mock.interactResult = { snapshot: rawSnap };

			await router.navigate("https://example.com");
			const result = await router.click("default", "e1");

			expect(result.success).toBe(true);
			expect(result.snapshot).not.toContain("content structure changed");
			expect(result.snapshot).toContain("Same");
		});

		it("warns when snapshot content changes (simulating DOM change)", async () => {
			mock.navResult = { snapshot: '- button "Page A"\n' };

			await router.navigate("https://example.com");

			// Click returns a different snapshot, simulating DOM change
			mock.interactResult = { snapshot: '- link "Page B"\n' };
			const result = await router.click("default", "e1");

			expect(result.success).toBe(true);
			expect(result.snapshot).toContain("content structure changed");
			expect(result.snapshot).toContain(
				"@e references may point to different elements",
			);
		});

		it("stores updated fingerprint after interaction", async () => {
			const rawSnap = '- button "Initial"\n';
			const clickSnap = '- link "Updated"\n';
			mock.navResult = { snapshot: rawSnap };

			await router.navigate("https://example.com");

			// After click with different content, fingerprint should be updated
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

		it("only warns once — second same interaction does not re-warn", async () => {
			const snap = '- button "Stable"\n';
			mock.navResult = { snapshot: '- root "Page"\n' };

			await router.navigate("https://example.com");

			// First interaction with different content → warning
			mock.interactResult = { snapshot: snap };
			const first = await router.click("default", "e1");
			expect(first.snapshot).toContain("content structure changed");

			// Second interaction with same content → no warning (fingerprint matches)
			mock.interactResult = { snapshot: snap };
			const second = await router.click("default", "e2");
			expect(second.snapshot).not.toContain("content structure changed");
			expect(second.snapshot).toContain("Stable");
		});

		it("warns again when fingerprint changes again after stabilising", async () => {
			mock.navResult = { snapshot: '- root "Page"\n' };

			await router.navigate("https://example.com");

			// First change
			mock.interactResult = { snapshot: '- button "First"\n' };
			const first = await router.click("default", "e1");
			expect(first.snapshot).toContain("content structure changed");

			// Same → no warning
			mock.interactResult = { snapshot: '- button "First"\n' };
			await router.click("default", "e2");

			// Different again → warning re-appears
			mock.interactResult = { snapshot: '- link "Second"\n' };
			const third = await router.click("default", "e3");
			expect(third.snapshot).toContain("content structure changed");
		});

		it("stores fingerprint after snapshot() call", async () => {
			const navSnap = '- button "Init"\n';
			const snapSnap = '- link "Refreshed"\n';
			mock.navResult = { snapshot: navSnap };
			await router.navigate("https://example.com");

			// Override snapshot plugin response
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

		it("no warning on first interaction if navigate fingerprint matches interaction snapshot", async () => {
			// Navigate to a page with button content
			const snap = '- button "Consistent"\n- link "More"\n';
			mock.navResult = { snapshot: snap };
			// First click returns the SAME snapshot content (DOM didn't change)
			mock.interactResult = { snapshot: snap };

			await router.navigate("https://example.com");
			const result = await router.click("default", "e1");

			expect(result.success).toBe(true);
			expect(result.snapshot).not.toContain("content structure changed");
			expect(result.snapshot).toContain("Consistent");
		});
	});
});
