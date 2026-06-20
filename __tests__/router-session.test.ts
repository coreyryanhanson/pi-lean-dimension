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

import {
	describe,
	it,
	expect,
	beforeAll,
	afterAll,
	beforeEach,
	afterEach,
	vi,
} from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRegistry } from "../core/plugin-registry.js";
import { sessionManager } from "../core/shared/session-manager.js";
import {
	saveStorageState,
	deleteStorageState,
	profileDir,
} from "../core/shared/storage-state.js";
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

// ─── Profile storage state load from disk ──────────────────────

describe("profile storage state load from disk", () => {
	const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const SAVED_PROFILE = `test-persistence-saved-${uid}`;
	const FRESH_PROFILE = `test-persistence-fresh-${uid}`;
	const CORRUPT_PROFILE = `test-persistence-corrupt-${uid}`;
	const LASTNAV_PROFILE = `test-persistence-lastnav-${uid}`;

	const TEST_STATE = {
		cookies: [
			{
				name: "consent",
				value: "accepted",
				domain: ".example.com",
				path: "/",
				expires: Date.now() / 1000 + 3600,
				httpOnly: false,
				secure: false,
				sameSite: "Lax" as const,
			},
		],
		origins: [],
	};

	beforeAll(() => {
		// Write known state for SAVED_PROFILE
		saveStorageState(SAVED_PROFILE, TEST_STATE);
		// Write known state for LASTNAV_PROFILE
		saveStorageState(LASTNAV_PROFILE, TEST_STATE);
		// Write corrupt JSON for CORRUPT_PROFILE
		try {
			const dir = profileDir(CORRUPT_PROFILE);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "storage-state.json"), "not valid json");
		} catch {
			/* ok */
		}
	});

	afterAll(() => {
		deleteStorageState(SAVED_PROFILE);
		deleteStorageState(FRESH_PROFILE);
		deleteStorageState(CORRUPT_PROFILE);
		deleteStorageState(LASTNAV_PROFILE);
	});

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

	it("passes storageState when named profile has saved state on disk", async () => {
		const result = await router.navigate("https://example.com", {
			profile: SAVED_PROFILE,
		});
		expect(result.success).toBe(true);

		const navCalls = mock.calls.get("navigate");
		expect(navCalls).toHaveLength(1);
		const [, , , options] = navCalls![0] as [
			string,
			string,
			number,
			Record<string, unknown>,
		];
		expect(options.storageState).toBeDefined();
		const state = options.storageState as { cookies: Array<{ name: string }> };
		expect(state.cookies).toHaveLength(1);
		expect(state.cookies[0]!.name).toBe("consent");
	});

	it("does not pass storageState when named profile has no saved state (first use)", async () => {
		const result = await router.navigate("https://example.com", {
			profile: FRESH_PROFILE,
		});
		expect(result.success).toBe(true);

		const navCalls = mock.calls.get("navigate");
		expect(navCalls).toHaveLength(1);
		const [, , , options] = navCalls![0] as [
			string,
			string,
			number,
			Record<string, unknown>,
		];
		expect(options.storageState).toBeUndefined();
	});

	it('does not pass storageState for profile="none"', async () => {
		const result = await router.navigate("https://example.com", {
			profile: "none",
		});
		expect(result.success).toBe(true);

		const navCalls = mock.calls.get("navigate");
		expect(navCalls).toHaveLength(1);
		const [, , , options] = navCalls![0] as [
			string,
			string,
			number,
			Record<string, unknown>,
		];
		expect(options.storageState).toBeUndefined();
	});

	it("gracefully handles corrupt storage state file on disk", async () => {
		const result = await router.navigate("https://example.com", {
			profile: CORRUPT_PROFILE,
		});
		expect(result.success).toBe(true);

		const navCalls = mock.calls.get("navigate");
		expect(navCalls).toHaveLength(1);
		const [, , , options] = navCalls![0] as [
			string,
			string,
			number,
			Record<string, unknown>,
		];
		expect(options.storageState).toBeUndefined();
	});

	it("passes storageState when restoring from lastNav with profileName", async () => {
		// Set up lastNav with a named profile (simulating a prior navigation)
		sessionManager.setLastNav(
			"default",
			"https://example.com",
			"Mock",
			"mock",
			LASTNAV_PROFILE,
		);

		// Call snapshot → requireInteractiveSession should auto-create from lastNav
		const result = await router.snapshot("default");
		expect(result.success).toBe(true);

		// Should have navigated with storageState from LASTNAV_PROFILE
		const navCalls = mock.calls.get("navigate");
		expect(navCalls).toHaveLength(1);
		const [, , , options] = navCalls![0] as [
			string,
			string,
			number,
			Record<string, unknown>,
		];
		expect(options.storageState).toBeDefined();
		const state = options.storageState as { cookies: Array<{ name: string }> };
		expect(state.cookies).toHaveLength(1);
		expect(state.cookies[0]!.name).toBe("consent");
	});

	it("does not pass storageState when lastNav has no profileName", async () => {
		sessionManager.setLastNav("default", "https://example.com", "Mock", "mock");

		const result = await router.snapshot("default");
		expect(result.success).toBe(true);

		const navCalls = mock.calls.get("navigate");
		expect(navCalls).toHaveLength(1);
		const [, , , options] = navCalls![0] as [
			string,
			string,
			number,
			Record<string, unknown>,
		];
		expect(options.storageState).toBeUndefined();
	});
});
