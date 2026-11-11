/**
 * Storage-state module tests — covers all exported functions from
 * `core/shared/storage-state.ts`.
 *
 * - sanitizeProfileName() — normal names, reserved names, session profiles
 * - profileDir() / profileFilePath() — path construction
 * - save/load round-trip — cookies, origins, version headers
 * - deleteStorageState() — removal and graceful missing-file handling
 *   (keeps the profile directory — it marks deliberate declaration)
 * - isSessionProfile() — prefix detection
 * - sessionProfileName() — generation and validation
 * - isSessionStale() — session-file existence checks
 * - pruneStaleSessionProfiles() — bulk stale-profile cleanup
 * - orphaned temp-file sweep on save — fresh tmp files survive (concurrent
 *   writer may be mid-save), stale ones are removed
 */

import { describe, it, expect, afterEach } from "vitest";
import {
	sanitizeProfileName,
	PROFILE_DIR,
	profileDir,
	profileFilePath,
	loadStorageState,
	saveStorageState,
	deleteStorageState,
	profileExists,
	isSessionProfile,
	sessionProfileName,
	isSessionStale,
	pruneStaleSessionProfiles,
	SESSIONS_DIR,
} from "../core/shared/storage-state.js";

import {
	existsSync,
	writeFileSync,
	unlinkSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import { uniqueName } from "./helpers/setup-temp-dir.js";

// ─── Helpers ────────────────────────────────────────────────

/**
 * Full cleanup: remove the state file *and* the profile directory.
 * `deleteStorageState` alone intentionally keeps the directory.
 */
function fullyRemoveProfile(name: string): void {
	try {
		deleteStorageState(name);
		rmSync(profileDir(name), { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

const TEST_STATE = {
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

// Create a real session tracking file so isSessionStale sees an active session.
function createSessionFile(sessionId: string): string {
	const sessionFile = join(SESSIONS_DIR, `${sessionId}.json`);
	mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, '{"id":"test"}', "utf-8");
	return sessionFile;
}

function removeSessionFile(sessionId: string): void {
	try {
		unlinkSync(join(SESSIONS_DIR, `${sessionId}.json`));
	} catch {
		/* ignore */
	}
}

// ═══════════════════════════════════════════════════════════
// sanitizeProfileName()
// ═══════════════════════════════════════════════════════════

describe("sanitizeProfileName()", () => {
	// ── Normal profile names ──────────────────────────

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

	it("rejects reserved names 'none', 'session', 'create', 'delete'", () => {
		expect(() => sanitizeProfileName("none")).toThrow("reserved");
		expect(() => sanitizeProfileName("session")).toThrow("reserved");
		expect(() => sanitizeProfileName("create")).toThrow("reserved");
		expect(() => sanitizeProfileName("delete")).toThrow("reserved");
	});

	it("rejects reserved names case-insensitively", () => {
		expect(() => sanitizeProfileName("None")).toThrow("reserved");
		expect(() => sanitizeProfileName("SESSION")).toThrow("reserved");
		expect(() => sanitizeProfileName("Create")).toThrow("reserved");
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

	// ── Session profile names ─────────────────────────

	it("accepts valid session profile names", () => {
		expect(sanitizeProfileName("_session-abc123")).toBe("_session-abc123");
		expect(sanitizeProfileName("_session-abc-def_123")).toBe(
			"_session-abc-def_123",
		);
	});

	it("accepts session profile with leading underscore in ID", () => {
		expect(sanitizeProfileName("_session-_internal")).toBe(
			"_session-_internal",
		);
	});

	it("rejects session profile with empty embedded session ID", () => {
		expect(() => sanitizeProfileName("_session-")).toThrow(
			"embedded session ID must be non-empty",
		);
	});

	it("rejects session profile with path traversal in embedded ID", () => {
		expect(() => sanitizeProfileName("_session-../etc")).toThrow(
			"path traversal",
		);
		expect(() => sanitizeProfileName("_session-..\\windows")).toThrow(
			"path traversal",
		);
	});

	it("rejects session profile with spaces in embedded ID", () => {
		expect(() => sanitizeProfileName("_session-abc def")).toThrow(
			"path traversal",
		);
	});
});

// ═══════════════════════════════════════════════════════════
// profileDir() / profileFilePath()
// ═══════════════════════════════════════════════════════════

describe("profileDir() / profileFilePath()", () => {
	it("returns expected path for valid name", () => {
		const dir = profileDir("test-profile");
		expect(dir).toContain(join(PROFILE_DIR, "test-profile"));
	});

	it("rejects invalid names", () => {
		expect(() => profileDir("../bad")).toThrow("Invalid profile name");
	});

	it("file path appends storage-state.json", () => {
		const fp = profileFilePath("test-profile");
		expect(fp).toContain("storage-state.json");
	});

	it("returns expected path for session profile", () => {
		const dir = profileDir("_session-abc123");
		expect(dir).toContain(join(PROFILE_DIR, "_session-abc123"));
	});
});

// ═══════════════════════════════════════════════════════════
// save / load round-trip
// ═══════════════════════════════════════════════════════════

describe("save / load round-trip", () => {
	const testProfile = uniqueName("_test_save_load");

	afterEach(() => {
		fullyRemoveProfile(testProfile);
	});

	it("saves and loads storage state", () => {
		const saved = saveStorageState(testProfile, TEST_STATE);
		expect(saved).toBe(true);

		const loaded = loadStorageState(testProfile);
		expect(loaded).not.toBeNull();
		expect(loaded!._piVersion).toBe(1);
		expect(loaded!._savedAt).toBeDefined();
		expect(loaded!.cookies).toHaveLength(1);
		expect(loaded!.cookies[0]!.name).toBe("session");
		expect(loaded!.cookies[0]!.value).toBe("abc123");
		expect(loaded!.origins).toHaveLength(1);
		expect(loaded!.origins[0]!.localStorage[0]!.value).toBe("xyz");
	});

	it("returns null for non-existent profile", () => {
		const loaded = loadStorageState(uniqueName("_nonexistent"));
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

	it("merges non-overlapping cookies on re-save (not wholesale replace)", () => {
		saveStorageState(testProfile, TEST_STATE);

		const newState = {
			cookies: [
				{
					name: "new-token",
					value: "xyz",
					domain: ".new.com",
					path: "/",
					expires: 9999999999,
					httpOnly: false,
					secure: false,
					sameSite: "Strict" as const,
				},
			],
			origins: [],
		};
		saveStorageState(testProfile, newState);

		const loaded = loadStorageState(testProfile);
		// Non-overlapping keys: both cookies survive under merge
		expect(loaded!.cookies).toHaveLength(2);
		expect(loaded!.cookies.map((c) => c.name).sort()).toEqual([
			"new-token",
			"session",
		]);
	});

	it("same-key cookie is last-writer-wins on re-save", () => {
		// Save with initial value
		saveStorageState(testProfile, TEST_STATE);

		// Re-save with SAME key (name+domain+path) but different value
		const overwriteState = {
			cookies: [
				{
					name: "session",
					value: "overwritten",
					domain: ".example.com",
					path: "/",
					expires: 9999999999,
					httpOnly: true,
					secure: true,
					sameSite: "Lax" as const,
				},
			],
			origins: [],
		};
		saveStorageState(testProfile, overwriteState);

		const loaded = loadStorageState(testProfile);
		// Same key: incoming wins, but still 1 cookie
		expect(loaded!.cookies).toHaveLength(1);
		expect(loaded!.cookies[0]!.value).toBe("overwritten");
	});

	it("merge preserves non-overlapping localStorage by origin+name", () => {
		const firstState = {
			cookies: [],
			origins: [
				{
					origin: "https://example.com",
					localStorage: [{ name: "theme", value: "dark" }],
				},
			],
		};
		const secondState = {
			cookies: [],
			origins: [
				{
					origin: "https://example.com",
					localStorage: [{ name: "token", value: "abc" }],
				},
			],
		};
		saveStorageState(testProfile, firstState);
		saveStorageState(testProfile, secondState);

		const loaded = loadStorageState(testProfile);
		expect(loaded!.origins).toHaveLength(1);
		expect(loaded!.origins[0]!.localStorage).toHaveLength(2);
		const names = loaded!.origins[0]!.localStorage.map((e) => e.name).sort();
		expect(names).toEqual(["theme", "token"]);
	});

	it("merge with multiple origins preserves non-overlapping ones", () => {
		const firstState = {
			cookies: [],
			origins: [
				{
					origin: "https://a.com",
					localStorage: [{ name: "a", value: "1" }],
				},
			],
		};
		const secondState = {
			cookies: [],
			origins: [
				{
					origin: "https://b.com",
					localStorage: [{ name: "b", value: "2" }],
				},
			],
		};
		saveStorageState(testProfile, firstState);
		saveStorageState(testProfile, secondState);

		const loaded = loadStorageState(testProfile);
		expect(loaded!.origins).toHaveLength(2);
	});

	it("merge with missing/corrupt disk file behaves as fresh write", () => {
		// Fresh save with no prior file — should work as normal
		const fresh = {
			cookies: [
				{
					name: "fresh",
					value: "ok",
					domain: ".fresh.com",
					path: "/",
					expires: 9999999999,
					httpOnly: false,
					secure: false,
					sameSite: "Lax" as const,
				},
			],
			origins: [],
		};
		expect(saveStorageState(testProfile, fresh)).toBe(true);
		const loaded = loadStorageState(testProfile);
		expect(loaded!.cookies).toHaveLength(1);
		expect(loaded!.cookies[0]!.name).toBe("fresh");
	});

	it("atomic write produces a valid file on disk", () => {
		saveStorageState(testProfile, TEST_STATE);
		const fp = profileFilePath(testProfile);
		expect(existsSync(fp)).toBe(true);
		// File should parse as valid JSON
		const raw = JSON.parse(readFileSync(fp, "utf-8"));
		expect(raw.cookies).toHaveLength(1);
		expect(raw._piVersion).toBe(1);
	});
});

// ═══════════════════════════════════════════════════════════
// deleteStorageState()
// ═══════════════════════════════════════════════════════════

describe("deleteStorageState()", () => {
	it("removes the stored state file", () => {
		const profile = uniqueName("_test_delete");
		saveStorageState(profile, { cookies: [], origins: [] });
		expect(existsSync(profileFilePath(profile))).toBe(true);

		deleteStorageState(profile);
		expect(existsSync(profileFilePath(profile))).toBe(false);

		// The dir is kept — remove it so it doesn't pollute the shared
		// browser-state dir (and the profile list other suites assert on).
		fullyRemoveProfile(profile);
	});

	it("does not throw for non-existent file", () => {
		expect(() =>
			deleteStorageState(uniqueName("_test_delete_nonexistent")),
		).not.toThrow();
	});

	it("keeps the profile directory when it becomes empty", () => {
		// The directory is the deliberate-declaration marker: clearing
		// state must not un-declare the profile.
		const profile = uniqueName("_test_delete_keeps_dir");
		saveStorageState(profile, { cookies: [], origins: [] });
		expect(existsSync(profileDir(profile))).toBe(true);

		deleteStorageState(profile);
		expect(existsSync(profileFilePath(profile))).toBe(false);
		expect(existsSync(profileDir(profile))).toBe(true);

		// Deleting again (no state file left) still keeps the directory.
		deleteStorageState(profile);
		expect(existsSync(profileDir(profile))).toBe(true);

		fullyRemoveProfile(profile);
	});
});

// ═══════════════════════════════════════════════════════════
// profileExists()
// ═══════════════════════════════════════════════════════════

describe("orphaned temp-file sweep on save", () => {
	const name = uniqueName("test-sweep");

	afterEach(() => {
		rmSync(profileDir(name), { recursive: true, force: true });
	});

	it("removes stale temp files but leaves fresh ones (a concurrent writer may be mid-save)", () => {
		mkdirSync(profileDir(name), { recursive: true, mode: 0o700 });
		const fresh = join(profileDir(name), ".storage-state.fresh.tmp");
		const stale = join(profileDir(name), ".storage-state.stale.tmp");
		writeFileSync(fresh, "{}");
		writeFileSync(stale, "{}");
		const old = new Date(Date.now() - 120_000);
		utimesSync(stale, old, old);

		expect(saveStorageState(name, { cookies: [], origins: [] })).toBe(true);

		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(stale)).toBe(false);
	});
});

describe("profileExists()", () => {
	const name = uniqueName("test-exists");

	afterEach(() => {
		rmSync(profileDir(name), { recursive: true, force: true });
	});

	it("returns true for an existing named profile dir", () => {
		mkdirSync(profileDir(name), { recursive: true });
		expect(profileExists(name)).toBe(true);
	});

	it("returns false for a missing dir and for session-prefixed names", () => {
		expect(profileExists(name)).toBe(false);
		expect(profileExists("_session-whatever")).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════
// isSessionProfile()
// ═══════════════════════════════════════════════════════════

describe("isSessionProfile()", () => {
	it("returns true for session-prefixed names", () => {
		expect(isSessionProfile("_session-abc")).toBe(true);
		expect(isSessionProfile("_session-abc-def_123")).toBe(true);
		expect(isSessionProfile("_session-")).toBe(true);
	});

	it("returns false for non-session names", () => {
		expect(isSessionProfile("work")).toBe(false);
		expect(isSessionProfile("new")).toBe(false);
		expect(isSessionProfile("")).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════
// sessionProfileName()
// ═══════════════════════════════════════════════════════════

describe("sessionProfileName()", () => {
	it("produces correct name from session ID", () => {
		expect(sessionProfileName("abc123")).toBe("_session-abc123");
		expect(sessionProfileName("sess-xyz-789")).toBe("_session-sess-xyz-789");
	});

	it("rejects empty piSessionId", () => {
		expect(() => sessionProfileName("")).toThrow("Invalid piSessionId");
	});

	it("rejects piSessionId with forward slash", () => {
		expect(() => sessionProfileName("abc/def")).toThrow("Invalid piSessionId");
	});

	it("rejects piSessionId with backward slash", () => {
		expect(() => sessionProfileName("abc\\def")).toThrow("Invalid piSessionId");
	});

	// Same embedded-ID rule sanitizeProfileName enforces — one validator, no drift.
	it("rejects piSessionId with whitespace", () => {
		expect(() => sessionProfileName("abc def")).toThrow("Invalid piSessionId");
	});

	it("rejects piSessionId with dotdot", () => {
		expect(() => sessionProfileName("../etc")).toThrow("Invalid piSessionId");
		expect(() => sessionProfileName("..\\windows")).toThrow(
			"Invalid piSessionId",
		);
	});
});

// ═══════════════════════════════════════════════════════════
// isSessionStale()
// ═══════════════════════════════════════════════════════════

describe("isSessionStale()", () => {
	it("returns false for non-session profiles", () => {
		expect(isSessionStale("work")).toBe(false);
		expect(isSessionStale("default")).toBe(false);
	});

	it("detects stale profile when session file is missing", () => {
		expect(isSessionStale("_session-nonexistent-session-xyz")).toBe(true);
	});

	it("detects non-stale profile when session file exists", () => {
		const sessionId = uniqueName("test-session-stale");
		const profileName = `_session-${sessionId}`;

		// Create a real session tracking file
		createSessionFile(sessionId);

		expect(isSessionStale(profileName)).toBe(false);

		// Remove the session tracking file -> profile becomes stale
		removeSessionFile(sessionId);
		expect(isSessionStale(profileName)).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════
// pruneStaleSessionProfiles()
// ═══════════════════════════════════════════════════════════

describe("pruneStaleSessionProfiles()", () => {
	it("returns empty result when profile dir has no session profiles", () => {
		const result = pruneStaleSessionProfiles();
		// May have kept profiles from prior tests, but no pruned unless stale
		expect(Array.isArray(result.pruned)).toBe(true);
		expect(Array.isArray(result.kept)).toBe(true);
	});

	it("prunes stale session profiles and keeps active ones", () => {
		const staleId = uniqueName("test-prune-stale");
		const activeId = uniqueName("test-prune-active");

		const staleProfile = `_session-${staleId}`;
		const activeProfile = `_session-${activeId}`;

		// Save state for both profiles
		saveStorageState(staleProfile, { cookies: [], origins: [] });
		saveStorageState(activeProfile, { cookies: [], origins: [] });

		// Create session tracking file for active profile only
		createSessionFile(activeId);

		const result = pruneStaleSessionProfiles();

		// Stale should be pruned
		expect(result.pruned).toContain(staleProfile);
		// Active should be kept
		expect(result.kept).toContain(activeProfile);

		// Verify stale profile's state file is gone
		expect(existsSync(profileFilePath(staleProfile))).toBe(false);
		// Active profile's state file should still exist
		expect(existsSync(profileFilePath(activeProfile))).toBe(true);

		// Cleanup
		fullyRemoveProfile(activeProfile);
		removeSessionFile(activeId);
	});

	it("skips non-session profiles during prune", () => {
		const namedProfile = uniqueName("_test-named-prune");
		saveStorageState(namedProfile, { cookies: [], origins: [] });

		const result = pruneStaleSessionProfiles();

		// Named profile should not appear in results
		expect(result.pruned).not.toContain(namedProfile);
		expect(result.kept).not.toContain(namedProfile);

		// State file should still exist
		expect(existsSync(profileFilePath(namedProfile))).toBe(true);

		fullyRemoveProfile(namedProfile);
	});
});
