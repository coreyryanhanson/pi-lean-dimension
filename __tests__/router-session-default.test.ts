/**
 * Tests for the defaultProfile config option in the router.
 *
 * Verifies that when browser.defaultProfile is set in settings,
 * the router uses it as the default profile when the agent omits
 * the `profile` parameter on browser-navigate.
 *
 * These tests mock the plugin-config module to control the return value
 * of loadBrowserConfig() without hitting the real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pluginRegistry } from "../core/plugin-registry";
import { sessionManager } from "../core/shared/session-manager";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin";

/**
 * Shared piSessionId for tests that need session-scoped profiles.
 * Simulates the value passed by index.ts from ctx.sessionManager.getSessionId().
 */
const TEST_PI_SESSION_ID = "test-session-001";

// Mock plugin-config to return custom defaultProfile
const mockConfig = vi.hoisted(() => ({
	defaultProfile: "session",
	legacyDefaultProfile: "default",
	maxStorageStateSize: 10 * 1024 * 1024,
	profiles: {},
}));

vi.mock("../core/plugin-config", () => ({
	loadBrowserConfig: () => mockConfig,
}));

// Must import router AFTER the mock is set up
import * as router from "../core/router";

describe("Router defaultProfile config routing", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));
		// Reset mock config to defaults before each test
		mockConfig.defaultProfile = "session";
		mockConfig.legacyDefaultProfile = "default";
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	it('defaults to session profile when config defaultProfile="session" and piSessionId available', async () => {
		const result = await router.navigate("https://example.com", {
			piSessionId: TEST_PI_SESSION_ID,
		});

		expect(result.success).toBe(true);
		expect(result.profileName).toContain("_session-");
		expect(result.profileMode).toBe("session");

		const session = sessionManager.getSession("default");
		expect(session?.profileName).toContain("_session-");
		expect(session?.persistState).toBe(true);
	});

	it('defaults to "none" profile when config defaultProfile="session" but piSessionId unavailable', async () => {
		const result = await router.navigate("https://example.com");

		expect(result.success).toBe(true);
		expect(result.profileMode).toBe("none");
		expect(result.profileName).toBeUndefined();

		const session = sessionManager.getSession("default");
		expect(session?.persistState).toBeFalsy();
		expect(session?.profileName).toBeUndefined();
	});

	it("uses explicit profile='none' even when config says 'session'", async () => {
		const result = await router.navigate("https://example.com", {
			taskId: "custom-task",
			profile: "none",
		});

		expect(result.success).toBe(true);
		expect(result.profileMode).toBe("none");
		expect(result.profileName).toBeUndefined();

		const session = sessionManager.getSession("custom-task");
		expect(session?.persistState).toBeFalsy();
	});

	it("uses config defaultProfile with custom piSessionId from index.ts", async () => {
		// In production, index.ts always passes piSessionId when available.
		// This simulates that flow: config says defaultProfile="session" and
		// the tool handler provides piSessionId.
		const result = await router.navigate("https://example.com", {
			piSessionId: "custom-session",
		});

		expect(result.success).toBe(true);
		expect(result.profileName).toContain("_session-");
		expect(result.profileName).toContain("custom-session");

		const session = sessionManager.getSession("default");
		expect(session?.persistState).toBe(true);
		expect(session?.profileName).toContain("_session-");
	});

	it("uses explicit profile='session' with piSessionId", async () => {
		const result = await router.navigate("https://example.com", {
			profile: "session",
			piSessionId: TEST_PI_SESSION_ID,
		});

		expect(result.success).toBe(true);
		expect(result.profileName).toContain("_session-");
		expect(result.profileMode).toBe("session");
	});

	it("still accepts explicit named profile over config default", async () => {
		const result = await router.navigate("https://example.com", {
			profile: "shopping",
		});

		expect(result.success).toBe(true);
		expect(result.profileName).toBe("shopping");
		expect(result.profileMode).toBe("named");

		const session = sessionManager.getSession("default");
		expect(session?.profileName).toBe("shopping");
		expect(session?.persistState).toBe(true);
	});

	it("explicit profile='none' overrides defaultProfile config", async () => {
		const result = await router.navigate("https://example.com", {
			profile: "none",
		});

		expect(result.success).toBe(true);
		expect(result.profileMode).toBe("none");
		expect(result.profileName).toBeUndefined();

		const session = sessionManager.getSession("default");
		expect(session?.persistState).toBeFalsy();
	});
});
