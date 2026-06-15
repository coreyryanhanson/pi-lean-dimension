/**
 * Router cookie dispatch tests — validates that the router's getCookies,
 * addCookies, and clearCookies functions dispatch to the correct plugin
 * methods with proper error handling and session lifecycle.
 *
 * All tests use a MockPlugin (no real browser).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as router from "../core/router.js";
import { pluginRegistry } from "../core/plugin-registry.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin.js";

// ─── Setup ───────────────────────────────────────────────────────

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
