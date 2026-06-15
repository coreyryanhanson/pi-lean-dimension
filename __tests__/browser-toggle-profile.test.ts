/**
 * Tests for the /web profile management commands.
 *
 * Covers:
 * - listProfiles() enumerates profile directories
 * - formatProfileList() formats correctly
 * - profileStateSize() shows sizes
 * - isProfileLocked() detects active locks
 * - Command handler dispatch for profile sub-commands
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mock node:fs to control the filesystem for profile tests
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	readdirSync: vi.fn(),
	statSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: vi.fn(),
	writeFileSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

import browserToggle, {
	listProfiles,
	formatProfileList,
} from "../browser-toggle";

// ─── Helpers ─────────────────────────────────────────────────────

function mockPi(tools?: string[]): ExtensionAPI {
	const allTools = (tools ?? []).map((name) => ({ name }));
	// Return a full active set by default
	const active = tools ?? [];
	return {
		getAllTools: vi.fn(() => allTools as any),
		getActiveTools: vi.fn(() => active),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI;
}

/**
 * Capture the command handler from registerCommand.
 */
function captureHandler(
	pi: ExtensionAPI,
): (args: string, ctx: any) => Promise<void> {
	let capturedHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
	(pi.registerCommand as vi.Mock).mockImplementation(
		(_name: string, opts: any) => {
			capturedHandler = opts.handler;
		},
	);
	browserToggle(pi);
	if (!capturedHandler) throw new Error("Handler was not registered");
	return capturedHandler;
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ─── listProfiles ────────────────────────────────────────────────

describe("listProfiles()", () => {
	it("returns empty array when PROFILE_DIR does not exist", () => {
		(existsSync as vi.Mock).mockReturnValue(false);
		expect(listProfiles()).toEqual([]);
	});

	it("enumerates profile directories with state info", () => {
		(existsSync as vi.Mock).mockImplementation((path: string) => {
			// Check for lock directories first
			if (path.includes(".lock")) return false;
			// Profile state files: one exists, one doesn't
			if (path.includes("storage-state.json")) {
				return path.includes("default");
			}
			// PROFILE_DIR exists
			if (path.includes("browser-state")) return true;
			return false;
		});
		(readdirSync as vi.Mock).mockReturnValue([
			{ name: "default", isDirectory: () => true },
			{ name: "shopping", isDirectory: () => true },
			{ name: ".lock", isDirectory: () => true }, // hidden dir, should be excluded
		]);
		(statSync as vi.Mock).mockReturnValue({ size: 500 });

		const profiles = listProfiles();
		expect(profiles).toHaveLength(2);
		expect(profiles[0].name).toBe("default");
		expect(profiles[0].stateSize).toBe("500 B");
		expect(profiles[0].locked).toBe(false);
		expect(profiles[1].name).toBe("shopping");
		expect(profiles[1].stateSize).toBe("no state");
	});

	it("sorts profiles alphabetically", () => {
		(existsSync as vi.Mock).mockImplementation((path: string) => {
			if (path.includes("browser-state")) return true;
			if (path.includes("storage-state.json")) return true;
			return false;
		});
		(readdirSync as vi.Mock).mockReturnValue([
			{ name: "work", isDirectory: () => true },
			{ name: "default", isDirectory: () => true },
			{ name: "shopping", isDirectory: () => true },
		]);
		(statSync as vi.Mock).mockReturnValue({ size: 100 });

		const profiles = listProfiles();
		expect(profiles.map((p) => p.name)).toEqual([
			"default",
			"shopping",
			"work",
		]);
	});
});

// ─── formatProfileList ───────────────────────────────────────────

describe("formatProfileList()", () => {
	it("returns 'No profiles found' for empty list", () => {
		expect(formatProfileList([])).toBe("No profiles found on disk.");
	});

	it("formats profiles with state sizes", () => {
		const formatted = formatProfileList([
			{ name: "default", stateSize: "1.2 KB", locked: false },
			{ name: "shopping", stateSize: "no state", locked: false },
			{ name: "work", stateSize: "3.0 MB", locked: true },
		]);
		expect(formatted).toContain("Profiles (3):");
		expect(formatted).toContain("default  (1.2 KB)");
		expect(formatted).toContain("shopping  (no state)");
		expect(formatted).toContain("work  (3.0 MB) 🔒");
	});
});

// ─── Command handler: /web profile ───────────────────────────────

describe("/web profile command handler", () => {
	it("handles 'profile' — lists profiles", async () => {
		const pi = mockPi(["web-fetch", "browser-navigate"]);
		const handler = captureHandler(pi);

		// Mock filesystem to return some profiles
		(existsSync as vi.Mock).mockImplementation((path: string) => {
			if (path.includes("browser-state")) return true;
			if (path.includes("storage-state.json")) return true;
			return false;
		});
		(readdirSync as vi.Mock).mockReturnValue([
			{ name: "default", isDirectory: () => true },
		]);
		(statSync as vi.Mock).mockReturnValue({ size: 200 });

		const notify = vi.fn();
		await handler("profile", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Profiles (1):"),
			"info",
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("default"),
			"info",
		);
	});

	it("handles 'profile list' — same as 'profile'", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as vi.Mock).mockReturnValue(false);

		const notify = vi.fn();
		await handler("profile list", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith("No profiles found on disk.", "info");
	});

	it("handles 'profile clear <name>' — deletes state", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		// State file exists
		(existsSync as vi.Mock).mockReturnValue(true);
		// Also make readdirSync return something to avoid errors in listProfiles
		(readdirSync as vi.Mock).mockReturnValue([]);

		const notify = vi.fn();
		await handler("profile clear default", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			"Cleared profile 'default' state.",
			"info",
		);
	});

	it("handles 'profile clear <name>' with no state — shows message", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		// State file does NOT exist
		(existsSync as vi.Mock).mockReturnValue(false);

		const notify = vi.fn();
		await handler("profile clear default", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			"Profile 'default' has no saved state. Nothing to clear.",
			"info",
		);
	});

	it("handles 'profile clear' with no name — shows usage", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		const notify = vi.fn();
		await handler("profile clear", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Usage: /web profile clear <name>"),
			"warning",
		);
	});

	it("handles 'profile clear-all' — requires --confirm", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as vi.Mock).mockReturnValue(true);
		(readdirSync as vi.Mock).mockReturnValue([
			{ name: "default", isDirectory: () => true },
			{ name: "shopping", isDirectory: () => true },
			{ name: "work", isDirectory: () => true },
		]);
		(statSync as vi.Mock).mockReturnValue({ size: 100 });

		const notify = vi.fn();
		await handler("profile clear-all", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("clear-all --confirm"),
			"warning",
		);
	});

	it("handles 'profile clear-all --confirm' — clears all", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as vi.Mock).mockReturnValue(true);
		(readdirSync as vi.Mock).mockReturnValue([
			{ name: "default", isDirectory: () => true },
			{ name: "shopping", isDirectory: () => true },
		]);
		(statSync as vi.Mock).mockReturnValue({ size: 100 });

		const notify = vi.fn();
		await handler("profile clear-all --confirm", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith("Cleared 2 profile(s).", "info");
	});

	it("handles unknown profile sub-command — shows usage", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		const notify = vi.fn();
		await handler("profile unknown", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Unknown profile sub-command"),
			"warning",
		);
	});
});
