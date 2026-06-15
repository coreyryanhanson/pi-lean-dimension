/**
 * Router session dispatch tests — validates that the router's navigate()
 * function correctly handles the `session` parameter:
 *
 * - session="new" (default): fresh context, no persistence
 * - session="last": "default" profile, auto-save on cleanup
 * - Named profile: profile-specific state, auto-save on cleanup
 * - Invalid profile names: rejected with clear error
 * - session="new" with existing session: old context cleaned up
 * - session mode / profile name surfaced in result
 *
 * All tests use a MockPlugin (no real browser).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as router from "../core/router.js";
import { pluginRegistry } from "../core/plugin-registry.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin.js";

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

	// ─── Default: session="new" ─────────────────────────────────

	describe("default session (new)", () => {
		it("creates session with persistState=false when session is omitted", async () => {
			const result = await router.navigate("https://example.com");

			expect(result.success).toBe(true);
			expect(result.sessionMode).toBe("new");
			expect(result.profileName).toBeUndefined();

			const session = sessionManager.getSession("default");
			expect(session).toBeDefined();
			expect(session?.persistState).toBeFalsy();
			expect(session?.profileName).toBeUndefined();
		});

		it('creates session with persistState=false for explicit session="new"', async () => {
			const result = await router.navigate("https://example.com", {
				session: "new",
			});

			expect(result.success).toBe(true);
			expect(result.sessionMode).toBe("new");
			expect(result.profileName).toBeUndefined();

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(false);
		});

		it('calls plugin.cleanup when session="new" and existing session exists', async () => {
			// First navigate creates a session
			await router.navigate("https://example.com");
			expect(mock.calls.get("navigate")?.length).toBe(1);
			expect(sessionManager.getSession("default")).toBeDefined();
			mock.calls.delete("navigate");

			// Second navigate with session="new" should trigger cleanup
			await router.navigate("https://example.com/other", {
				session: "new",
			});

			// The old session was cleaned up and a fresh navigate happened
			expect(mock.calls.get("navigate")?.length).toBe(1);
		});

		it('sets sessionMode="new" on navigate result', async () => {
			const result = await router.navigate("https://example.com", {
				session: "new",
			});
			expect(result.sessionMode).toBe("new");
		});
	});

	// ─── session="last" ─────────────────────────────────────────

	describe('session="last"', () => {
		it('resolves to "default" profile', async () => {
			const result = await router.navigate("https://example.com", {
				session: "last",
			});

			expect(result.success).toBe(true);
			expect(result.sessionMode).toBe("new"); // first use, no state file
			expect(result.profileName).toBe("default");

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toBe("default");
		});

		it("sets persistState=true on the session for auto-save", async () => {
			await router.navigate("https://example.com", {
				session: "last",
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
		});

		it("stores profileName in lastNav for auto-recovery", async () => {
			await router.navigate("https://example.com", {
				session: "last",
			});

			// Remove session to simulate crash
			const nav = sessionManager.getLastNav("default");
			expect(nav).toBeDefined();
			expect(nav?.profileName).toBe("default");
		});
	});

	// ─── Named profile ──────────────────────────────────────────

	describe("named profile", () => {
		it("uses the profile name in the session and result", async () => {
			const result = await router.navigate("https://example.com", {
				session: "work",
			});

			expect(result.success).toBe(true);
			expect(result.profileName).toBe("work");
			expect(result.sessionMode).toBe("new"); // first use, no state file

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toBe("work");
		});

		it("sets persistState=true on the session", async () => {
			await router.navigate("https://example.com", {
				session: "shopping",
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
		});

		it("stores profileName in lastNav", async () => {
			await router.navigate("https://example.com", {
				session: "shopping",
			});

			const nav = sessionManager.getLastNav("default");
			expect(nav?.profileName).toBe("shopping");
		});

		it("triggers cleanup if switching from a different profile", async () => {
			await router.navigate("https://example.com", {
				session: "work",
			});
			mock.calls.delete("navigate");

			// Switch to a different profile — should clean up old context
			await router.navigate("https://example.com", {
				session: "shopping",
			});

			// Navigate was called again (new context)
			expect(mock.calls.get("navigate")?.length).toBe(1);
			const session = sessionManager.getSession("default");
			expect(session?.profileName).toBe("shopping");
		});
	});

	// ─── Invalid profile names ──────────────────────────────────

	describe("invalid profile names", () => {
		it('treats "new" as session mode, not a profile name', async () => {
			const result = await router.navigate("https://example.com", {
				session: "new",
			});
			expect(result.success).toBe(true);
			// Should be treated as fresh session, not a profile lookup
			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(false);
		});

		it('treats "last" as session mode, not a profile name', async () => {
			const result = await router.navigate("https://example.com", {
				session: "last",
			});
			expect(result.success).toBe(true);
			// Should be treated as default profile, not an error
			const session = sessionManager.getSession("default");
			expect(session?.profileName).toBe("default");
		});

		it("returns error for empty profile name", async () => {
			const result = await router.navigate("https://example.com", {
				session: "",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Profile name");
		});

		it("returns error for profile name with special characters", async () => {
			const result = await router.navigate("https://example.com", {
				session: "../../etc/passwd",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Invalid profile name");
		});

		it("returns error for profile name with spaces", async () => {
			const result = await router.navigate("https://example.com", {
				session: "my profile",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Invalid profile name");
		});

		it("returns error for profile name exceeding 64 characters", async () => {
			const result = await router.navigate("https://example.com", {
				session: "a".repeat(65),
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Invalid profile name");
		});
	});

	// ─── sessionMode / profileName in result ────────────────────

	describe("result fields", () => {
		it("shows sessionMode new and no profileName for default session=new", async () => {
			const result = await router.navigate("https://example.com");
			expect(result.sessionMode).toBe("new");
			expect(result.profileName).toBeUndefined();
		});

		it("includes sessionMode and profileName for named profile", async () => {
			const result = await router.navigate("https://example.com", {
				session: "test-profile",
			});
			expect(result.sessionMode).toBe("new");
			expect(result.profileName).toBe("test-profile");
		});

		it('includes sessionMode and profileName for session="last"', async () => {
			const result = await router.navigate("https://example.com", {
				session: "last",
			});
			expect(result.sessionMode).toBe("new");
			expect(result.profileName).toBe("default");
		});
	});

	// ─── BrowserSession fields ──────────────────────────────────

	describe("BrowserSession fields", () => {
		it("sets persistState=true and profileName for named profile", async () => {
			await router.navigate("https://example.com", {
				session: "my-projects",
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toBe("my-projects");
		});

		it('sets persistState=true and profileName=default for "last"', async () => {
			await router.navigate("https://example.com", {
				session: "last",
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(true);
			expect(session?.profileName).toBe("default");
		});

		it('clears persistState and profileName for session="new"', async () => {
			await router.navigate("https://example.com", {
				session: "last",
			});
			expect(sessionManager.getSession("default")?.persistState).toBe(true);

			await router.navigate("https://example.com/other", {
				session: "new",
			});

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(false);
			expect(session?.profileName).toBeUndefined();
		});
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
import {
	acquireProfileLock,
	releaseProfileLock,
} from "../core/shared/profile-lock.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

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

		it("rejects reserved names 'new' and 'last'", () => {
			expect(() => sanitizeProfileName("new")).toThrow("reserved");
			expect(() => sanitizeProfileName("last")).toThrow("reserved");
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

// ─── Profile lock tests ───────────────────────────────────────────

describe("profile-lock module", () => {
	let tmpLockDir: string;

	beforeEach(() => {
		tmpLockDir = mkdtempSync(join(tmpdir(), "pi-browser-lock-test-"));
	});

	afterEach(() => {
		try {
			releaseProfileLock(tmpLockDir, "test-task");
		} catch {
			// clean up
		}
	});

	it("acquires a lock", () => {
		const acquired = acquireProfileLock(tmpLockDir, "test-task");
		expect(acquired).toBe(true);
	});

	it("releases a lock", () => {
		acquireProfileLock(tmpLockDir, "test-task");
		releaseProfileLock(tmpLockDir, "test-task");

		// Re-acquire after release
		const reacquired = acquireProfileLock(tmpLockDir, "test-task-2");
		expect(reacquired).toBe(true);
	});

	it("blocks concurrent acquisition from different taskId", () => {
		acquireProfileLock(tmpLockDir, "task-a");
		const blocked = acquireProfileLock(tmpLockDir, "task-b");
		expect(blocked).toBe(false);
	});

	it("same taskId can re-acquire (re-entrant)", () => {
		acquireProfileLock(tmpLockDir, "task-a");
		const reacquired = acquireProfileLock(tmpLockDir, "task-a");
		expect(reacquired).toBe(true);
	});

	it("releases only when taskId matches", () => {
		acquireProfileLock(tmpLockDir, "task-a");

		// Try to release with wrong taskId — should not release
		releaseProfileLock(tmpLockDir, "task-b");

		// task-b should still be blocked
		const blocked = acquireProfileLock(tmpLockDir, "task-b");
		expect(blocked).toBe(false);

		// Release with correct taskId
		releaseProfileLock(tmpLockDir, "task-a");

		// Now task-b can acquire
		const acquired = acquireProfileLock(tmpLockDir, "task-b");
		expect(acquired).toBe(true);
	});
});
