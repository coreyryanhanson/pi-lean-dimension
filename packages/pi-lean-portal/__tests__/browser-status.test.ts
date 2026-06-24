/**
 * Tests for browser-status.ts — /web status subcommand handler.
 *
 * Covers the handleStatusSubcommand function, which combines toggle state,
 * runtime state, backend info, active sessions, and profile display.
 *
 * Profile display is the focus of these tests because it has the most
 * branching logic: named profiles vs session profiles, mixed scenarios,
 * active-profile markers, and the collapsed session-profile summary line.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserSession } from "../core/shared/session-manager.js";
import { handleStatusSubcommand } from "../browser-status.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { listProfiles } from "../browser-profile.js";

// ─── Mock dependencies ──────────────────────────────────────────

vi.mock("../core/shared/session-manager.js", () => ({
	sessionManager: {
		getStatus: vi.fn(() => "idle"),
		getActiveSessions: vi.fn(() => []),
		pluginSymbol: vi.fn(() => "?"),
	},
}));

vi.mock("../core/plugin-registry.js", () => ({
	pluginRegistry: {
		availableAll: vi.fn(() => [
			{ name: "chromium", enabled: true },
			{ name: "firefox", enabled: true },
			{ name: "chromium-py", enabled: false },
		]),
	},
}));

vi.mock("../browser-profile.js", () => ({
	listProfiles: vi.fn(() => []),
}));

vi.mock("../core/shared/storage-state.js", () => ({
	isSessionProfile: vi.fn((name: string) => name.startsWith("_session-")),
}));

// ─── Type shortcuts ─────────────────────────────────────────────

type MockSession = {
	taskId: string;
	pluginName: string;
	currentUrl?: string;
	currentTitle?: string;
	currentSnapshotFingerprint?: string;
	cachePopulatedAt?: number;
	lastInteractionAt?: number;
	lastActive: number;
	crashed: boolean;
	persistState?: boolean;
	profileName?: string;
	piSessionId?: string;
};

type Profile = ReturnType<typeof listProfiles>[number];

// ─── Helpers ────────────────────────────────────────────────────

function mockCtx(): ExtensionContext {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
		// Minimal shape required by ExtensionContext
		sessionManager: {},
	} as unknown as ExtensionContext;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("handleStatusSubcommand", () => {
	let ctx: ExtensionContext;
	let notifySpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		ctx = mockCtx();
		notifySpy = ctx.ui.notify as ReturnType<typeof vi.fn>;
		// Default: empty session-manager state, idle status
		vi.mocked(sessionManager.getStatus).mockReturnValue("idle");
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue([]);
		vi.mocked(sessionManager.pluginSymbol).mockReturnValue("?");
	});

	// ── Toggle state lines ─────────────────────────────────────

	it("shows browser and learn toggle states", () => {
		handleStatusSubcommand(ctx, true, false);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("🌐 Browser tools: ✅ on");
		expect(msg).toContain("📖 Learn mode: ❌ off");
	});

	it("shows both toggles off", () => {
		handleStatusSubcommand(ctx, false, false);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("🌐 Browser tools: ❌ off");
		expect(msg).toContain("📖 Learn mode: ❌ off");
	});

	// ── Plugin listing ─────────────────────────────────────────

	it("lists plugins with enabled/disabled state", () => {
		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("chromium");
		expect(msg).toContain("firefox");
		expect(msg).toContain("chromium-py (disabled)");
		expect(msg).toContain("Use web-fetch for stateless HTTP fetches.");
	});

	// ── Status line ────────────────────────────────────────────

	it("includes the status string from sessionManager", () => {
		vi.mocked(sessionManager.getStatus).mockReturnValue(
			"🍊 chromium: example.com",
		);
		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("Status: 🍊 chromium: example.com");
	});

	// ── Active sessions section ────────────────────────────────

	it("shows active sessions with plugin symbol, URL, title, and profile", () => {
		const sessions: MockSession[] = [
			{
				taskId: "browser-1",
				pluginName: "chromium",
				currentUrl: "https://example.com/page1",
				currentTitle: "Page One",
				lastActive: Date.now(),
				crashed: false,
				profileName: "shopping",
			},
		];
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue(
			sessions as unknown as BrowserSession[],
		);
		vi.mocked(sessionManager.pluginSymbol).mockReturnValue("🍊");

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("Active sessions: 1");
		expect(msg).toContain("🍊 [chromium] https://example.com/page1 — Page One");
		expect(msg).toContain("[profile: shopping]");
	});

	it("shows multiple active sessions", () => {
		const sessions: MockSession[] = [
			{
				taskId: "browser-1",
				pluginName: "chromium",
				currentUrl: "https://example.com/a",
				currentTitle: "Page A",
				lastActive: Date.now(),
				crashed: false,
			},
			{
				taskId: "browser-2",
				pluginName: "firefox",
				currentUrl: "https://other.com/b",
				currentTitle: "Page B",
				lastActive: Date.now(),
				crashed: false,
				profileName: "work",
			},
		];
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue(
			sessions as unknown as BrowserSession[],
		);
		vi.mocked(sessionManager.pluginSymbol).mockReturnValue("🍊");

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("Active sessions: 2");
		expect(msg).toContain("[profile: work]");
	});

	it("shows pending URL when session has no currentUrl", () => {
		const sessions: MockSession[] = [
			{
				taskId: "browser-1",
				pluginName: "chromium",
				lastActive: Date.now(),
				crashed: false,
			},
		];
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue(
			sessions as unknown as BrowserSession[],
		);
		vi.mocked(sessionManager.pluginSymbol).mockReturnValue("🍊");

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("(pending)");
	});

	it("omits active sessions section when there are none", () => {
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue([]);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).not.toContain("Active sessions");
	});

	// ── Profile section — no profiles ──────────────────────────

	it('shows "Profiles: none" when no profiles exist on disk', () => {
		vi.mocked(listProfiles).mockReturnValue([]);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("Profiles: none");
		expect(msg).not.toContain("Session profiles:");
	});

	// ── Profile section — named only ───────────────────────────

	it("shows only named profiles when only named profiles exist", () => {
		const profiles: Profile[] = [
			{ name: "shopping", stateSize: "1.2 KB" },
			{ name: "work", stateSize: "480 B" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("Profiles: 2 on disk (named)");
		expect(msg).toContain("shopping  (1.2 KB)");
		expect(msg).toContain("work  (480 B)");
		expect(msg).not.toContain("Session profiles:");
	});

	it("marks the active named profile with ← active", () => {
		const profiles: Profile[] = [
			{ name: "shopping", stateSize: "1.2 KB" },
			{ name: "work", stateSize: "480 B" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);

		const sessions: MockSession[] = [
			{
				taskId: "browser-1",
				pluginName: "chromium",
				currentUrl: "https://example.com",
				currentTitle: "Example",
				lastActive: Date.now(),
				crashed: false,
				profileName: "work",
			},
		];
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue(
			sessions as unknown as BrowserSession[],
		);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("work  (480 B) ← active");
		expect(msg).not.toContain("shopping  (1.2 KB) ← active");
	});

	it("preserves the order returned by listProfiles (sorted by browser-profile.ts)", () => {
		const profiles: Profile[] = [
			{ name: "alpha", stateSize: "0 B" },
			{ name: "beta", stateSize: "0 B" },
			{ name: "zebra", stateSize: "0 B" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		const alpha = msg.indexOf("alpha");
		const beta = msg.indexOf("beta");
		const zebra = msg.indexOf("zebra");
		expect(alpha).toBeGreaterThan(-1);
		expect(beta).toBeGreaterThan(alpha);
		expect(zebra).toBeGreaterThan(beta);
	});

	// ── Profile section — session only ─────────────────────────

	it("collapses session profiles into a summary line when only session profiles exist", () => {
		const profiles: Profile[] = [
			{ name: "_session-abc123", stateSize: "2.1 KB" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		// No named section
		expect(msg).not.toContain("on disk (named)");
		expect(msg).not.toContain("Profiles: none");
		// Collapsed session line
		expect(msg).toContain("Session profiles: 1 (manage with /web profile)");
		// Raw session profile name should not appear
		expect(msg).not.toContain("_session-abc123");
		expect(msg).not.toContain("2.1 KB");
	});

	it("shows multiple session profiles collapsed into one count line", () => {
		const profiles: Profile[] = [
			{ name: "_session-abc", stateSize: "1.0 KB" },
			{ name: "_session-def", stateSize: "500 B" },
			{ name: "_session-ghi", stateSize: "2 B" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("Session profiles: 3 (manage with /web profile)");
	});

	it('marks session summary as "(active)" when an active session uses a session profile', () => {
		const profiles: Profile[] = [
			{ name: "_session-abc123", stateSize: "2.1 KB" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);

		const sessions: MockSession[] = [
			{
				taskId: "browser-1",
				pluginName: "chromium",
				currentUrl: "https://example.com",
				currentTitle: "Example",
				lastActive: Date.now(),
				crashed: false,
				profileName: "_session-abc123",
			},
		];
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue(
			sessions as unknown as BrowserSession[],
		);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("Session profiles: 1 (active)");
	});

	// ── Profile section — mixed named + session ────────────────

	it("shows named profiles in full rows and session profiles collapsed when both exist", () => {
		const profiles: Profile[] = [
			{ name: "_session-abc123", stateSize: "2.1 KB" },
			{ name: "shopping", stateSize: "1.2 KB" },
			{ name: "work", stateSize: "480 B" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		// Named section
		expect(msg).toContain("Profiles: 2 on disk (named)");
		expect(msg).toContain("shopping  (1.2 KB)");
		expect(msg).toContain("work  (480 B)");
		// Session collapse
		expect(msg).toContain("Session profiles: 1 (manage with /web profile)");
		// Raw session name hidden
		expect(msg).not.toContain("_session-abc123");
		expect(msg).not.toContain("2.1 KB");
	});

	it("marks named active and session active independently", () => {
		const profiles: Profile[] = [
			{ name: "_session-abc123", stateSize: "2.1 KB" },
			{ name: "shopping", stateSize: "1.2 KB" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);

		const sessions: MockSession[] = [
			{
				taskId: "browser-1",
				pluginName: "chromium",
				currentUrl: "https://example.com",
				currentTitle: "Example",
				lastActive: Date.now(),
				crashed: false,
				profileName: "_session-abc123",
			},
		];
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue(
			sessions as unknown as BrowserSession[],
		);

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		// Named section: shopping is NOT active
		expect(msg).toContain("shopping  (1.2 KB)");
		expect(msg).not.toContain("← active");
		// Session line says active
		expect(msg).toContain("Session profiles: 1 (active)");
	});

	// ── Full message structure ─────────────────────────────────

	it("produces a well-structured multi-line message with all pieces", () => {
		const profiles: Profile[] = [
			{ name: "_session-abc", stateSize: "2.1 KB" },
			{ name: "work", stateSize: "480 B" },
		];
		vi.mocked(listProfiles).mockReturnValue(profiles);
		vi.mocked(sessionManager.getStatus).mockReturnValue(
			"🍊 chromium: example.com",
		);

		const sessions: MockSession[] = [
			{
				taskId: "browser-1",
				pluginName: "chromium",
				currentUrl: "https://example.com/page1",
				currentTitle: "Page One",
				lastActive: Date.now(),
				crashed: false,
				profileName: "work",
			},
		];
		vi.mocked(sessionManager.getActiveSessions).mockReturnValue(
			sessions as unknown as BrowserSession[],
		);
		vi.mocked(sessionManager.pluginSymbol).mockReturnValue("🍊");

		handleStatusSubcommand(ctx, true, true);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		// Toggle line
		expect(msg).toContain("🌐 Browser tools: ✅ on");
		expect(msg).toContain("📖 Learn mode: ✅ on");
		// Status
		expect(msg).toContain("Status: 🍊 chromium: example.com");
		// Plugins
		expect(msg).toContain("chromium");
		expect(msg).toContain("firefox");
		// Active sessions
		expect(msg).toContain("Active sessions: 1");
		expect(msg).toContain("[profile: work]");
		// Named profiles
		expect(msg).toContain("Profiles: 1 on disk (named)");
		expect(msg).toContain("work  (480 B) ← active");
		// Session profiles collapsed
		expect(msg).toContain("Session profiles: 1 (manage with /web profile)");
	});

	// ── Edge: no profiles but named/session filter weirdness ───

	it('shows "Profiles: none" when listProfiles returns an empty array', () => {
		vi.mocked(listProfiles).mockReturnValue([]);

		handleStatusSubcommand(ctx, false, false);

		const msg = notifySpy.mock.lastCall?.[0] as string;
		expect(msg).toContain("Profiles: none");
	});
});
