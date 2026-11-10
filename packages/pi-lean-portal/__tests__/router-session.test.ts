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
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pluginRegistry } from "../core/plugin-registry.js";
import { sessionManager } from "../core/shared/session-manager.js";
import {
	saveStorageState,
	deleteStorageState,
	profileDir,
	ensureProfileDir,
} from "../core/shared/storage-state.js";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin.js";
import { uniqueName } from "./helpers/setup-temp-dir.js";

/** Extract the options object from the single navigate call `mock` recorded. */
function navOptions(mock: MockPlugin): Record<string, unknown> {
	const navCalls = mock.calls.get("navigate");
	expect(navCalls).toHaveLength(1);
	const [, , , options] = navCalls![0] as [
		string,
		string,
		number,
		Record<string, unknown>,
	];
	return options;
}

// Partial mock: ensureProfileDir delegates to the real implementation
// (real fs); the mkdir-failure test overrides it via vi.mocked().
vi.mock("../core/shared/storage-state.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../core/shared/storage-state.js")>();
	return { ...actual, ensureProfileDir: vi.fn(actual.ensureProfileDir) };
});

/**
 * Shared piSessionId for tests that use profile="session".
 * Simulates the value passed by tools/browser-navigate.ts from
 * ctx.sessionManager.getSessionId().
 */
const TEST_PI_SESSION_ID = "test-session-001";

// Mock plugin-config to support defaultProfile config routing tests.
// Default is "none" so existing direct-profile tests work unchanged.
const mockConfig = vi.hoisted(() => ({
	defaultProfile: "none",
}));

vi.mock("../core/plugin-config.js", () => ({
	loadFullConfig: () => ({
		browser: mockConfig,
		plugins: { plugins: [], errors: [] },
	}),
}));

// Must import router AFTER the mock is set up
import * as router from "../core/router.js";

// ─── Setup ───────────────────────────────────────────────────────

describe("Router session / profile dispatch", () => {
	let mock: MockPlugin;

	// Explicitly-passed named profiles must exist on disk — materialize
	// the names these tests navigate with.
	beforeAll(() => {
		mkdirSync(profileDir("work"), { recursive: true });
		mkdirSync(profileDir("shopping"), { recursive: true });
	});

	afterAll(() => {
		rmSync(profileDir("work"), { recursive: true, force: true });
		rmSync(profileDir("shopping"), { recursive: true, force: true });
	});

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));
	});

	afterEach(async () => {
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	// ─── Backend errorKind passthrough ────────────────────────────

	describe("backend errorKind passthrough", () => {
		it("forwards errorKind=not-installed from the plugin failure to the NavResult", async () => {
			mock.navResult = {
				success: false,
				error: "Browser not installed. Run /web install to install it.",
				errorKind: "not-installed",
			};

			const result = await router.navigate("https://example.com");

			expect(result.success).toBe(false);
			expect(result.errorKind).toBe("not-installed");
		});
	});

	// ─── Default: profile="none" ──────────────────────────────

	describe("default (no profile)", () => {
		const noneCases: Array<{ label: string; opts: { profile?: "none" } }> = [
			{ label: "omitted", opts: {} },
			{ label: 'explicit "none"', opts: { profile: "none" } },
		];
		it.each(noneCases)(
			"creates session with persistState=false when profile is $label",
			async ({ opts }) => {
				const result = await router.navigate("https://example.com", opts);

				expect(result.success).toBe(true);
				expect(result.profileMode).toBe("none");
				expect(result.profileName).toBeUndefined();

				const session = sessionManager.getSession("default");
				expect(session).toBeDefined();
				expect(session?.persistState).toBe(false);
				expect(session?.profileName).toBeUndefined();
			},
		);

		// Switching to none tears down the old context for any persistent
		// starting profile (named or session-scoped).
		it.each(['work', 'session'] as const)('profile="none" destroys an existing %s session', async (start) => {
			await router.navigate("https://example.com", {
				profile: start,
				...(start === "session" ? { piSessionId: TEST_PI_SESSION_ID } : {}),
			});
			expect(sessionManager.getSession("default")?.persistState).toBe(true);
			mock.calls.delete("navigate");

			const result = await router.navigate("https://example.com/other", {
				profile: "none",
			});

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("none");
			expect(result.profileName).toBeUndefined();

			// Switching to none retires the old context: cleanup runs (with its
			// state save under the old profile) before the session is flipped.
			expect(mock.calls.get("cleanup")?.length).toBe(1);

			const session = sessionManager.getSession("default");
			expect(session?.persistState).toBe(false);
			expect(session?.profileName).toBeUndefined();
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
			// The fallback warns — the agent asked for persistence and got none.
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const result = await router.navigate("https://example.com", {
					profile: "session",
				});

				expect(result.success).toBe(true);
				expect(result.profileMode).toBe("none");
				expect(result.profileName).toBeUndefined();
				expect(warnSpy).toHaveBeenCalled();

				const session = sessionManager.getSession("default");
				expect(session?.persistState).toBe(false);
			} finally {
				warnSpy.mockRestore();
			}
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
			mock.calls.delete("cleanup");

			// cleanup (and its state save) must run while the session record
			// still names the OLD profile, before it flips to the new one.
			let sawProfileAtCleanup: string | null | undefined;
			const realCleanup = mock.cleanup.bind(mock);
			vi.spyOn(mock, "cleanup").mockImplementation(async (tid) => {
				sawProfileAtCleanup = sessionManager.getSession(tid)?.profileName;
				return realCleanup(tid);
			});

			// Switch to a different profile — should clean up old context
			await router.navigate("https://example.com", {
				profile: "shopping",
			});

			// Old context retired before the session flipped to "shopping",
			// so its cookies persist under "work"
			expect(mock.calls.get("cleanup")?.length).toBe(1);
			expect(sawProfileAtCleanup).toBe("work");

			// Navigate was called again (new context), tagged with the new profile
			const navArgs = mock.calls.get("navigate")?.[0] as unknown[];
			expect(navArgs[3]).toMatchObject({ profile: "shopping" });
			const session = sessionManager.getSession("default");
			expect(session?.profileName).toBe("shopping");
		});

		// The old backend owns the context, so cleanup — and its state save —
		// must go to the old plugin, not the newly resolved one. With the
		// profile unchanged, only the pluginName check triggers retirement.
		it.each([
			{ label: "a profile switch", nextProfile: "shopping" },
			{ label: "the SAME profile", nextProfile: "work" },
		])(
			"triggers cleanup on the PRIOR plugin when switching backends with $label",
			async ({ nextProfile }) => {
				const other = new MockPlugin("other");
				pluginRegistry.register(other, makeConfig({ name: "other" }));

				await router.navigate("https://example.com", {
					strategy: "mock",
					profile: "work",
				});
				mock.calls.delete("cleanup");
				other.calls.delete("cleanup");

				await router.navigate("https://example.com", {
					strategy: "other",
					profile: nextProfile,
				});

				expect(mock.calls.get("cleanup")?.length).toBe(1);
				expect(other.calls.get("cleanup")).toBeUndefined();
				const session = sessionManager.getSession("default");
				expect(session?.pluginName).toBe("other");
				expect(session?.profileName).toBe(nextProfile);
			},
		);
	});

	// ─── Invalid profile names ──────────────────────────────────

	describe("invalid profile names", () => {
		// Validation rules themselves are pinned in storage-state.test.ts
		// (sanitizeProfileName); this pins only how a bad name surfaces
		// through router.navigate.
		it("refuses an invalid profile name as profile-refusal", async () => {
			const result = await router.navigate("https://example.com", {
				profile: "",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Profile name must be a non-empty string");
			expect(result.errorKind).toBe("profile-refusal");
		});
	});

	// ─── Explicit named-profile existence ──────────────────

	describe("explicit named-profile existence", () => {
		it("refuses a nonexistent explicitly-passed named profile without creating it", async () => {
			const name = uniqueName("refused");
			const result = await router.navigate("https://example.com", {
				profile: name,
			});

			expect(result.success).toBe(false);
			expect(result.errorKind).toBe("profile-refusal");
			expect(result.error).toContain(`Profile '${name}' does not exist.`);
			// Existing named profiles are listed for near-miss self-correction —
			// the wording/cap/fallback shape is covered by the pure
			// formatProfileRefusal tests.
			expect(result.error).toContain("work");

			// The absence is the contract — no lazy-create
			expect(existsSync(profileDir(name))).toBe(false);
		});

		// Own/foreign _session-* acceptance and refusal are pinned at the unit
		// level in profile-resolution.test.ts; the invalid-name describe below
		// pins how a refusal surfaces through router.navigate.
	});
});

// ─── Non-agent default profile materialization ─────────────────
// A conversation default (conversationDefault) and a settings default
// (browser.defaultProfile) take the identical non-agent branch in
// resolveNavigateProfile, so each behavior is tested once per source.

describe("non-agent default profile materialization", () => {
	let mock: MockPlugin;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	// How each source delivers the nonexistent profile name to navigate().
	const sources: Array<
		[label: string, opts: (name: string) => { conversationDefault?: string }]
	> = [
		[
			"conversation default",
			(name) => ({ conversationDefault: name }),
		],
		[
			"settings default",
			(name) => {
				mockConfig.defaultProfile = name;
				return {};
			},
		],
	];

	beforeEach(() => {
		pluginRegistry.clear();
		mock = new MockPlugin("mock");
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));
		warnSpy = vi.spyOn(console, "warn");
		warnSpy.mockImplementation(() => {});
	});

	afterEach(async () => {
		warnSpy.mockRestore();
		vi.mocked(ensureProfileDir).mockReset();
		mockConfig.defaultProfile = "none";
		await sessionManager.removeAll();
		pluginRegistry.clear();
	});

	it.each(sources)("materializes a nonexistent %s named profile", async (_label, opts) => {
		const name = uniqueName("default-materialize");
		try {
			const result = await router.navigate("https://example.com", opts(name));

			expect(result.success).toBe(true);
			expect(result.profileMode).toBe("named");
			expect(result.profileName).toBe(name);
			// The user decision stands — the dir is created, not refused.
			expect(existsSync(profileDir(name))).toBe(true);
		} finally {
			rmSync(profileDir(name), { recursive: true, force: true });
		}
	});

	it.each(sources)("falls back to session with a warning when the %s cannot be created", async (_label, opts) => {
		const name = uniqueName("default-uncreatable");
		vi.mocked(ensureProfileDir).mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});

		const result = await router.navigate("https://example.com", {
			...opts(name),
			piSessionId: TEST_PI_SESSION_ID,
		});

		// The fallback mirrors the one used when profile='session' can't
		// resolve — the request never lands on a different named profile.
		expect(result.success).toBe(true);
		expect(result.profileMode).toBe("session");
		expect(result.profileName).toContain(TEST_PI_SESSION_ID);
		expect(warnSpy).toHaveBeenCalled();
	});
});

// ─── Router defaultProfile config routing ────────────────────────

describe("Router defaultProfile config routing", () => {
	let mock: MockPlugin;

	// "shopping" is used as an explicit named profile in these tests and must
	// exist on disk.
	beforeAll(() => {
		mkdirSync(profileDir("shopping"), { recursive: true });
	});

	afterAll(() => {
		rmSync(profileDir("shopping"), { recursive: true, force: true });
	});

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

	it("uses explicit profile='none' even when config says 'session'", async () => {
		const result = await router.navigate("https://example.com", {
			taskId: "custom-task",
			profile: "none",
		});

		expect(result.success).toBe(true);
		expect(result.profileMode).toBe("none");
		expect(result.profileName).toBeUndefined();

		const session = sessionManager.getSession("custom-task");
		expect(session?.persistState).toBe(false);
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

	it("navigates when the settings default already exists", async () => {
		mockConfig.defaultProfile = "shopping";

		const result = await router.navigate("https://example.com");

		expect(result.success).toBe(true);
		expect(result.profileMode).toBe("named");
		expect(result.profileName).toBe("shopping");
	});

	it("conversation default 'none' beats a named settings default", async () => {
		mockConfig.defaultProfile = "shopping";

		const result = await router.navigate("https://example.com", {
			conversationDefault: "none",
		});

		expect(result.success).toBe(true);
		expect(result.profileMode).toBe("none");
		expect(result.profileName).toBeUndefined();
	});
});

// ─── Profile storage state load from disk ──────────────────────

describe("profile storage state load from disk", () => {
	const SAVED_PROFILE = uniqueName("test-persistence-saved");
	const FRESH_PROFILE = uniqueName("test-persistence-fresh");
	const CORRUPT_PROFILE = uniqueName("test-persistence-corrupt");
	const LASTNAV_PROFILE = uniqueName("test-persistence-lastnav");

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
		// FRESH_PROFILE has an existing but empty dir — literal first use of an
		// explicitly-passed named profile is a refusal, so "no saved state"
		// is tested against an existing dir.
		mkdirSync(profileDir(FRESH_PROFILE), { recursive: true });
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

		const options = navOptions(mock);
		const state = options.storageState as { cookies: Array<{ name: string }> };
		expect(state.cookies).toHaveLength(1);
		expect(state.cookies[0]!.name).toBe("consent");
	});

	// `loadStorageState` yields no state for all three: no profile requested,
	// an existing-but-empty dir, and an unreadable state file.
	it.each([
		{ label: 'profile="none"', profile: "none" },
		{ label: "empty profile dir", profile: FRESH_PROFILE },
		{ label: "corrupt storage-state file", profile: CORRUPT_PROFILE },
	])("does not pass storageState for $label", async ({ profile }) => {
		const result = await router.navigate("https://example.com", { profile });
		expect(result.success).toBe(true);

		const options = navOptions(mock);
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
		const options = navOptions(mock);
		expect(options.storageState).toBeDefined();
		const state = options.storageState as { cookies: Array<{ name: string }> };
		expect(state.cookies).toHaveLength(1);
		expect(state.cookies[0]!.name).toBe("consent");
	});

	it("does not pass storageState when lastNav has no profileName", async () => {
		sessionManager.setLastNav("default", "https://example.com", "Mock", "mock");

		const result = await router.snapshot("default");
		expect(result.success).toBe(true);

		const options = navOptions(mock);
		expect(options.storageState).toBeUndefined();
	});

	it("failed auto-recovery suppresses the auto-save", async () => {
		sessionManager.setLastNav(
			"default",
			"https://example.com",
			"Mock",
			"mock",
			LASTNAV_PROFILE,
		);
		mock.navResult = { success: false, error: "boom" };

		// A failed recovery nav never validated, so cleanup must run with the
		// auto-save already suppressed — same policy as the fresh-navigate
		// failure paths.
		let persistAtCleanup: boolean | undefined;
		const realCleanup = mock.cleanup.bind(mock);
		vi.spyOn(mock, "cleanup").mockImplementation(async (tid) => {
			persistAtCleanup = sessionManager.getSession(tid)?.persistState;
			return realCleanup(tid);
		});

		const result = await router.snapshot("default");
		expect(result.success).toBe(false);
		expect(mock.calls.get("cleanup")).toHaveLength(1);
		expect(persistAtCleanup).toBe(false);
		expect(sessionManager.getSession("default")).toBeUndefined();
	});
});
