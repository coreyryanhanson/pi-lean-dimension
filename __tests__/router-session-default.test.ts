/**
 * Tests for the sessionDefault config option in the router.
 *
 * Verifies that when browser.sessionDefault is set to "last" in settings,
 * the router uses it as the default session mode when the agent omits
 * the `session` parameter on browser-navigate.
 *
 * These tests mock the plugin-config module to control the return value
 * of loadBrowserConfig() without hitting the real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pluginRegistry } from "../core/plugin-registry";
import { sessionManager } from "../core/shared/session-manager";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin";

// Mock plugin-config to return custom sessionDefault
const mockConfig = vi.hoisted(() => ({
	sessionDefault: "last" as "new" | "last",
	defaultProfile: "default",
	maxStorageStateSize: 10 * 1024 * 1024,
	profiles: {},
}));

vi.mock("../core/plugin-config", () => ({
	loadBrowserConfig: () => mockConfig,
}));

// Must import router AFTER the mock is set up
import * as router from "../core/router";

describe("Router sessionDefault config routing", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));
		// Reset mock config to defaults before each test
		mockConfig.sessionDefault = "last";
		mockConfig.defaultProfile = "default";
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	it("defaults to 'last' when sessionDefault config is 'last' and session param omitted", async () => {
		const result = await router.navigate("https://example.com");

		expect(result.success).toBe(true);
		expect(result.profileName).toBe("default");
		// No state file exists on disk, so mode is "new" but profile is set
		// for future saves
		expect(result.sessionMode).toBe("new");

		const session = sessionManager.getSession("default");
		expect(session?.profileName).toBe("default");
		expect(session?.persistState).toBe(true);
	});

	it("uses explicit session='new' even when config says 'last'", async () => {
		const result = await router.navigate("https://example.com", {
			taskId: "custom-task",
			session: "new",
		});

		expect(result.success).toBe(true);
		expect(result.sessionMode).toBe("new");
		expect(result.profileName).toBeUndefined();

		const session = sessionManager.getSession("custom-task");
		expect(session?.persistState).toBeFalsy();
	});

	it("uses custom defaultProfile from config when session='last'", async () => {
		mockConfig.defaultProfile = "work-custom";

		const result = await router.navigate("https://example.com");

		expect(result.success).toBe(true);
		expect(result.profileName).toBe("work-custom");

		const session = sessionManager.getSession("default");
		expect(session?.profileName).toBe("work-custom");
	});

	it("uses explicit session='last' and uses config's defaultProfile", async () => {
		mockConfig.defaultProfile = "my-profile";

		const result = await router.navigate("https://example.com", {
			session: "last",
		});

		expect(result.success).toBe(true);
		expect(result.profileName).toBe("my-profile");
	});

	it("still accepts explicit named profile over config default", async () => {
		const result = await router.navigate("https://example.com", {
			session: "shopping",
		});

		expect(result.success).toBe(true);
		expect(result.profileName).toBe("shopping");

		const session = sessionManager.getSession("default");
		expect(session?.profileName).toBe("shopping");
		expect(session?.persistState).toBe(true);
	});
});
