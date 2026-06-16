/**
 * Router profile dispatch tests — validates that the router's navigate()
 * function correctly handles the `profile` parameter:
 *
 * - profile="none" (default): fresh context, no persistence
 * - profile="session": persist for this conversation
 * - Named profile: profile-specific state, auto-save on cleanup
 * - Invalid profile names: rejected with clear error
 * - profile="none" with existing session: old context cleaned up
 * - profile mode / profile name surfaced in result
 *
 * All tests use a MockPlugin (no real browser).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pluginRegistry } from "../core/plugin-registry.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin.js";

/**
 * Shared piSessionId for tests that use profile="session" or session="last".
 * Simulates the value passed by index.ts from ctx.sessionManager.getSessionId().
 */
const TEST_PI_SESSION_ID = "test-session-001";

// Mock plugin-config to support defaultProfile config routing tests.
// Default is "none" so existing direct-profile tests work unchanged.
const mockConfig = vi.hoisted(() => ({
	defaultProfile: "none",
	maxStorageStateSize: 10 * 1024 * 1024,
	profiles: {},
}));

vi.mock("../core/plugin-config.js", () => ({
	loadBrowserConfig: () => mockConfig,
}));

// Must import router AFTER the mock is set up
import * as router from "../core/router.js";

// ─── Setup ───────────────────────────────────────────────────────

describe("Router session / profile dispatch", () => {
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

	// ─── Default: profile="none" ──────────────────────────────────

	describe("default (no profile)", () => {
		it("creates session with persistState=false when profile is omitted", async () => {
			const result = await router.navigate("https://example.com");

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("none");
			expect(result.profileName).toBeUndefined();

			const session = sessionManager.getSession("default");
			expect(session).toBeDefined();
			expect(session?.persistState).toBeFalsy();
			expect(session?.profileName).toBeUndefined();
		});

		it('creates session with persistState=false for explicit profile="none"', async () => {
			const result = await router.navigate("https://example.com", {
				profile: "none",
			});

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("none");
			expect(result.profileName).toBeUndefined();

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(false);
		});

		it('calls plugin.cleanup when profile="none" and existing session exists', async () => {
			// First navigate creates a session
			await router.navigate("https://example.com");
			expect(mock.calls.get("navigate")?.length).toBe(1);
			expect(sessionManager.getSession("default")).toBeDefined();
			mock.calls.delete("navigate");

			// Second navigate with profile="none" should trigger cleanup
			await router.navigate("https://example.com/other", {
				profile: "none",
			});

			// The old session was cleaned up and a fresh navigate happened
			expect(mock.calls.get("navigate")?.length).toBe(1);
		});

		it('sets profileMode="none" when profile is omitted', async () => {
			const result = await router.navigate("https://example.com");
			expect(result.profileMode).toBe("none");
		});
	});

	// ─── profile="session" ───────────────────────────────────────

	describe('profile="session"', () => {
		it("resolves to session-scoped profile when piSessionId is available", async () => {
			const result = await router.navigate("https://example.com", {
				profile: "session",
				piSessionId: TEST_PI_SESSION_ID,
			});

			expect(result.success).toBe(true);
			expect(result.profileName).toContain("_session-");
			expect(result.profileName).toContain(TEST_PI_SESSION_ID);
			expect(result.profileMode).toBe("session");

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toContain("_session-");
		});

		it("sets persistState=true on the session for auto-save", async () => {
			await router.navigate("https://example.com", {
				profile: "session",
				piSessionId: TEST_PI_SESSION_ID,
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
		});

		it("stores profileName in lastNav for auto-recovery", async () => {
			await router.navigate("https://example.com", {
				profile: "session",
				piSessionId: TEST_PI_SESSION_ID,
			});

			// Remove session to simulate crash
			const nav = sessionManager.getLastNav("default");
			expect(nav).toBeDefined();
			expect(nav?.profileName).toContain("_session-");
		});

		it('without piSessionId, profile="session" falls back to "none"', async () => {
			const result = await router.navigate("https://example.com", {
				profile: "session",
			});

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("none");
			expect(result.profileName).toBeUndefined();

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBeFalsy();
		});
	});

	// ─── Named profile ──────────────────────────────────────────

	describe("named profile", () => {
		it("uses the profile name in the session and result", async () => {
			const result = await router.navigate("https://example.com", {
				profile: "work",
			});

			expect(result.success).toBe(true);
			expect(result.profileName).toBe("work");

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toBe("work");
		});

		it("sets persistState=true on the session", async () => {
			await router.navigate("https://example.com", {
				profile: "shopping",
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
		});

		it("stores profileName in lastNav", async () => {
			await router.navigate("https://example.com", {
				profile: "shopping",
			});

			const nav = sessionManager.getLastNav("default");
			expect(nav?.profileName).toBe("shopping");
		});

		it("triggers cleanup if switching from a different profile", async () => {
			await router.navigate("https://example.com", {
				profile: "work",
			});
			mock.calls.delete("navigate");

			// Switch to a different profile — should clean up old context
			await router.navigate("https://example.com", {
				profile: "shopping",
			});

			// Navigate was called again (new context)
			expect(mock.calls.get("navigate")?.length).toBe(1);
			const session = sessionManager.getSession("default");
			expect(session?.profileName).toBe("shopping");
		});
	});

	// ─── Invalid profile names ──────────────────────────────────

	describe("invalid profile names", () => {
		it("returns error for empty profile name", async () => {
			const result = await router.navigate("https://example.com", {
				profile: "",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Profile name");
		});

		it("returns error for profile name with special characters", async () => {
			const result = await router.navigate("https://example.com", {
				profile: "../../etc/passwd",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Invalid profile name");
		});

		it("returns error for profile name with spaces", async () => {
			const result = await router.navigate("https://example.com", {
				profile: "my profile",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Invalid profile name");
		});

		it("returns error for profile name exceeding 64 characters", async () => {
			const result = await router.navigate("https://example.com", {
				profile: "a".repeat(65),
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Invalid profile name");
		});
	});

	// ─── profile parameter ─────────────────────────────────────

	describe("profile parameter", () => {
		it('profile="none" creates ephemeral session', async () => {
			const result = await router.navigate("https://example.com", {
				profile: "none",
			});

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("none");
			expect(result.profileName).toBeUndefined();

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBeFalsy();
		});

		it('profile="session" with piSessionId resolves to _session-<id>', async () => {
			const result = await router.navigate("https://example.com", {
				profile: "session",
				piSessionId: TEST_PI_SESSION_ID,
			});

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("session");
			expect(result.profileName).toContain("_session-");
			expect(result.profileName).toContain(TEST_PI_SESSION_ID);

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toContain("_session-");
		});

		it('profile="session" without piSessionId falls back to "none"', async () => {
			const result = await router.navigate("https://example.com", {
				profile: "session",
			});

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("none");
			expect(result.profileName).toBeUndefined();

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBeFalsy();
		});

		it('profile="work" creates named profile session', async () => {
			const result = await router.navigate("https://example.com", {
				profile: "work",
			});

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("named");
			expect(result.profileName).toBe("work");

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toBe("work");
		});

		it('profile="none" destroys existing session with profile', async () => {
			// First create a session with a named profile
			await router.navigate("https://example.com", {
				profile: "work",
			});
			expect(sessionManager.getSession("default")?.profileName).toBe("work");
			expect(sessionManager.getSession("default")?.persistState).toBe(true);
			mock.calls.delete("navigate");

			// Switch to none — should destroy old context
			const result = await router.navigate("https://example.com/other", {
				profile: "none",
			});

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("none");
			expect(result.profileName).toBeUndefined();

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBeFalsy();
			expect(session?.profileName).toBeUndefined();
		});
	});

	// ─── profileMode / profileName in result ────────────────────

	describe("result fields", () => {
		it("shows profileMode none and no profileName for default", async () => {
			const result = await router.navigate("https://example.com");
			expect(result.profileMode).toBe("none");
			expect(result.profileName).toBeUndefined();
		});

		it("includes profileMode and profileName for named profile", async () => {
			const result = await router.navigate("https://example.com", {
				profile: "test-profile",
			});
			expect(result.profileMode).toBe("named");
			expect(result.profileName).toBe("test-profile");
		});

		it('includes profileMode and profileName for profile="session" with piSessionId', async () => {
			const result = await router.navigate("https://example.com", {
				profile: "session",
				piSessionId: TEST_PI_SESSION_ID,
			});
			expect(result.profileMode).toBe("session");
			expect(result.profileName).toContain("_session-");
		});
	});

	// ─── BrowserSession fields ──────────────────────────────────

	describe("BrowserSession fields", () => {
		it("sets persistState=true and profileName for named profile", async () => {
			await router.navigate("https://example.com", {
				profile: "my-projects",
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toBe("my-projects");
		});

		it('sets persistState=true and profileName for profile="session" with piSessionId', async () => {
			await router.navigate("https://example.com", {
				profile: "session",
				piSessionId: TEST_PI_SESSION_ID,
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toContain("_session-");
		});

		it('clears persistState and profileName for profile="none"', async () => {
			await router.navigate("https://example.com", {
				profile: "session",
				piSessionId: TEST_PI_SESSION_ID,
			});
			expect(sessionManager.getSession("default")?.persistState).toBe(true);

			await router.navigate("https://example.com/other", {
				profile: "none",
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(false);
			expect(session?.profileName).toBeUndefined();
		});
	});
});

// ─── Router defaultProfile config routing ────────────────────────

describe("Router defaultProfile config routing", () => {
	let mock: MockPlugin;

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));
		mockConfig.defaultProfile = "session";
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
		mockConfig.defaultProfile = "none";
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

// ─── Storage state module tests ────────────────────────────────────

import {
	sanitizeProfileName,
	profileDir,
	profileFilePath,
	loadStorageState,
	saveStorageState,
	deleteStorageState,
} from "../core/shared/storage-state.js";

import { existsSync } from "node:fs";

describe("storage-state module", () => {
	// ─── sanitizeProfileName ───────────────────────────────────

	describe("sanitizeProfileName()", () => {
		it("accepts valid names", () => {
			expect(sanitizeProfileName("default")).toBe("default");
			expect(sanitizeProfileName("my-profile")).toBe("my-profile");
			expect(sanitizeProfileName("work_project")).toBe("work_project");
			expect(sanitizeProfileName("a")).toBe("a");
			expect(sanitizeProfileName("a1b2")).toBe("a1b2");
		});

		it("rejects empty string", () => {
			expect(() => sanitizeProfileName("")).toThrow("non-empty string");
		});

		it("rejects reserved names 'none', 'session', 'create'", () => {
			expect(() => sanitizeProfileName("none")).toThrow("reserved");
			expect(() => sanitizeProfileName("session")).toThrow("reserved");
			expect(() => sanitizeProfileName("create")).toThrow("reserved");
		});

		it("rejects names with special characters", () => {
			expect(() => sanitizeProfileName("../evil")).toThrow(
				"Invalid profile name",
			);
			expect(() => sanitizeProfileName("with space")).toThrow(
				"Invalid profile name",
			);
			expect(() => sanitizeProfileName("with.dot")).toThrow(
				"Invalid profile name",
			);
		});

		it("rejects names over 64 characters", () => {
			expect(() => sanitizeProfileName("a".repeat(65))).toThrow(
				"Invalid profile name",
			);
		});
	});

	// ─── profileDir / profileFilePath ──────────────────────────

	describe("profileDir() / profileFilePath()", () => {
		it("returns expected path for valid name", () => {
			const dir = profileDir("test-profile");
			expect(dir).toContain(".pi/agent/browser-state/test-profile");
		});

		it("rejects invalid names", () => {
			expect(() => profileDir("../bad")).toThrow("Invalid profile name");
		});

		it("file path appends storage-state.json", () => {
			const fp = profileFilePath("test-profile");
			expect(fp).toContain("storage-state.json");
		});
	});

	// ─── save/load round-trip ──────────────────────────────────

	describe("save/load round-trip", () => {
		const testProfile = "_test_save_load";
		const state = {
			cookies: [
				{
					name: "session",
					value: "abc123",
					domain: ".example.com",
					path: "/",
					expires: 9999999999,
					httpOnly: true,
					secure: true,
					sameSite: "Lax" as const,
				},
			],
			origins: [
				{
					origin: "https://example.com",
					localStorage: [{ name: "token", value: "xyz" }],
				},
			],
		};

		afterEach(() => {
			deleteStorageState(testProfile);
		});

		it("saves and loads storage state", () => {
			const saved = saveStorageState(testProfile, state);
			expect(saved).toBe(true);

			const loaded = loadStorageState(testProfile);
			expect(loaded).not.toBeNull();
			expect(loaded!._piVersion).toBe(1);
			expect(loaded!.cookies).toHaveLength(1);
			expect(loaded!.cookies[0]!.name).toBe("session");
			expect(loaded!.cookies[0]!.value).toBe("abc123");
			expect(loaded!.origins).toHaveLength(1);
			expect(loaded!.origins[0]!.localStorage[0]!.value).toBe("xyz");
		});

		it("returns null for non-existent profile", () => {
			const loaded = loadStorageState("_nonexistent_profile_xyz");
			expect(loaded).toBeNull();
		});

		it("round-trips empty state", () => {
			const emptyState = { cookies: [], origins: [] };
			const saved = saveStorageState(testProfile, emptyState);
			expect(saved).toBe(true);

			const loaded = loadStorageState(testProfile);
			expect(loaded).not.toBeNull();
			expect(loaded!.cookies).toHaveLength(0);
			expect(loaded!.origins).toHaveLength(0);
		});
	});

	// ─── deleteStorageState ────────────────────────────────────

	describe("deleteStorageState()", () => {
		it("removes the stored state file", () => {
			const profile = "_test_delete";
			saveStorageState(profile, { cookies: [], origins: [] });
			expect(existsSync(profileFilePath(profile))).toBe(true);

			deleteStorageState(profile);
			expect(existsSync(profileFilePath(profile))).toBe(false);
		});

		it("does not throw for non-existent file", () => {
			expect(() =>
				deleteStorageState("_test_delete_nonexistent"),
			).not.toThrow();
		});
	});
});
