/**
 * Tests for the /web profile management commands.
 *
 * Covers:
 * - listProfiles() enumerates profile directories
 * - formatProfileList() formats correctly
 * - profileStateSize() shows sizes
 * - Command handler dispatch for profile sub-commands
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, EventBus } from "@earendil-works/pi-coding-agent";

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

import browserToggle from "../browser-toggle.js";
import { listProfiles, formatProfileList } from "../browser-profile.js";
import { captureWebHandler } from "./helpers/mock-pi.js";

// ─── Helpers ─────────────────────────────────────────────────────

function mockPi(tools?: string[]): ExtensionAPI {
	const emitter = new EventEmitter();
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
		get events() {
			return {
				emit: (channel: string, data: unknown) => emitter.emit(channel, data),
				on: (channel: string, handler: (data: unknown) => void) => {
					emitter.on(channel, handler);
					return () => emitter.off(channel, handler);
				},
			} as EventBus;
		},
	} as unknown as ExtensionAPI;
}

/**
 * Register the /web command and capture its handler.
 */
function captureHandler(
	pi: ExtensionAPI,
): (args: string, ctx: any) => Promise<void> {
	browserToggle(pi);
	return captureWebHandler(pi);
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ─── listProfiles ────────────────────────────────────────────────

describe("listProfiles()", () => {
	it("returns empty array when PROFILE_DIR does not exist", () => {
		(existsSync as Mock).mockReturnValue(false);
		expect(listProfiles()).toEqual([]);
	});

	it("enumerates profile directories with state info", () => {
		(existsSync as Mock).mockImplementation((path: string) => {
			// Profile state files: one exists, one doesn't
			if (path.includes("storage-state.json")) {
				return path.includes("default");
			}
			// PROFILE_DIR exists
			if (path.includes("browser-state")) return true;
			return false;
		});
		(readdirSync as Mock).mockReturnValue([
			{ name: "default", isDirectory: () => true },
			{ name: "shopping", isDirectory: () => true },
		]);
		(statSync as Mock).mockReturnValue({ size: 500 });

		const profiles = listProfiles();
		expect(profiles).toHaveLength(2);
		expect(profiles[0]!.name).toBe("default");
		expect(profiles[0]!.stateSize).toBe("500 B");
		expect(profiles[1]!.name).toBe("shopping");
		expect(profiles[1]!.stateSize).toBe("no state");
	});

	it("sorts profiles alphabetically", () => {
		(existsSync as Mock).mockImplementation((path: string) => {
			if (path.includes("browser-state")) return true;
			if (path.includes("storage-state.json")) return true;
			return false;
		});
		(readdirSync as Mock).mockReturnValue([
			{ name: "work", isDirectory: () => true },
			{ name: "default", isDirectory: () => true },
			{ name: "shopping", isDirectory: () => true },
		]);
		(statSync as Mock).mockReturnValue({ size: 100 });

		const profiles = listProfiles();
		expect(profiles.map((p: { name: string }) => p.name)).toEqual([
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
			{ name: "default", stateSize: "1.2 KB" },
			{ name: "shopping", stateSize: "no state" },
			{ name: "work", stateSize: "3.0 MB" },
		]);
		expect(formatted).toContain("Profiles (3):");
		expect(formatted).toContain("default  (1.2 KB)");
		expect(formatted).toContain("shopping  (no state)");
		expect(formatted).toContain("work  (3.0 MB)");
	});

	test("adds 📋 badge for session profiles", () => {
		const formatted = formatProfileList([
			{ name: "_session-abc123", stateSize: "512 B" },
			{ name: "work", stateSize: "1.2 KB" },
		]);
		expect(formatted).toContain("📋 session  (512 B)\n");
	});
});

// ─── Command handler: /web profile ───────────────────────────────

describe("/web profile command handler", () => {
	it("handles 'profile' — lists profiles", async () => {
		const pi = mockPi(["web-fetch", "browser-navigate"]);
		const handler = captureHandler(pi);

		// Mock filesystem to return some profiles
		(existsSync as Mock).mockImplementation((path: string) => {
			if (path.includes("browser-state")) return true;
			if (path.includes("storage-state.json")) return true;
			return false;
		});
		(readdirSync as Mock).mockReturnValue([
			{ name: "default", isDirectory: () => true },
		]);
		(statSync as Mock).mockReturnValue({ size: 200 });

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

		(existsSync as Mock).mockReturnValue(false);

		const notify = vi.fn();
		await handler("profile list", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith("No profiles found on disk.", "info");
	});

	it("handles 'profile clear <name>' — deletes state", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		// State file exists
		(existsSync as Mock).mockReturnValue(true);
		// Also make readdirSync return something to avoid errors in listProfiles
		(readdirSync as Mock).mockReturnValue([]);

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
		(existsSync as Mock).mockReturnValue(false);

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

	it("handles 'profile clear' with an invalid name — notifies instead of throwing", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		const notify = vi.fn();
		await handler("profile clear my profile", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Invalid profile name"),
			"warning",
		);
	});

	it("handles 'profile clear-all' — requires --confirm", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(true);
		(readdirSync as Mock).mockReturnValue([
			{ name: "default", isDirectory: () => true },
			{ name: "shopping", isDirectory: () => true },
			{ name: "work", isDirectory: () => true },
		]);
		(statSync as Mock).mockReturnValue({ size: 100 });

		const notify = vi.fn();
		await handler("profile clear-all", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("clear-all --confirm"),
			"warning",
		);
	});

	it("handles 'profile clear-all --confirm' — clears named profiles only, not sessions", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(true);
		(readdirSync as Mock).mockReturnValue([
			{ name: "default", isDirectory: () => true },
			{ name: "shopping", isDirectory: () => true },
			{ name: "_session-abc123", isDirectory: () => true },
		]);
		(statSync as Mock).mockReturnValue({ size: 100 });

		const notify = vi.fn();
		await handler("profile clear-all --confirm", { ui: { notify } } as any);

		// Session profiles are GC'd by prune, not bulk-cleared
		expect(notify).toHaveBeenCalledWith("Cleared 2 profile(s).", "info");
	});

	it("handles nonexistent profile name — suggests create", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(false);

		const notify = vi.fn();
		await handler("profile unknown", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("does not exist"),
			"warning",
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Create it first with /web profile create"),
			"warning",
		);
	});

	it("handles 'profile delete' with no name — shows usage", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		const notify = vi.fn();
		await handler("profile delete", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Usage: /web profile delete <name>"),
			"warning",
		);
		expect(rmSync as Mock).not.toHaveBeenCalled();
	});

	it("handles 'profile delete <name>' — removes the directory", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(true);
		(readdirSync as Mock).mockReturnValue([
			{ name: "shopping", isDirectory: () => true },
		]);

		const notify = vi.fn();
		await handler("profile delete shopping", { ui: { notify } } as any);

		expect(rmSync as Mock).toHaveBeenCalledWith(
			expect.stringContaining("shopping"),
			{ recursive: true, force: true },
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Existing sessions using it will re-create it on save"),
			"info",
		);
	});

	it("handles 'profile delete <name>' with no directory — nothing to delete", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(false);

		const notify = vi.fn();
		await handler("profile delete shopping", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			"Profile 'shopping' does not exist. Nothing to delete.",
			"info",
		);
		expect(rmSync as Mock).not.toHaveBeenCalled();
	});

	it("handles 'profile delete _session-*' — refuses, points at prune", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(true);

		const notify = vi.fn();
		await handler("profile delete _session-abc123", {
			ui: { notify },
		} as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("/web profile prune"),
			"warning",
		);
		expect(rmSync as Mock).not.toHaveBeenCalled();
	});

	it("handles 'profile create _session-*' — refuses, points at profile=session", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		const notify = vi.fn();
		await handler("profile create _session-abc123", {
			ui: { notify },
		} as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Use profile="session" instead.'),
			"warning",
		);
		expect(mkdirSync as Mock).not.toHaveBeenCalled();
	});

	it("handles 'profile delete <reserved>' — invalid name", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		const notify = vi.fn();
		await handler("profile delete session", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("reserved profile name"),
			"warning",
		);
		expect(rmSync as Mock).not.toHaveBeenCalled();
	});

	it("handles 'profile delete <name>' matching the conversation default — resets to 'session'", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(true);
		(readdirSync as Mock).mockReturnValue([
			{ name: "shopping", isDirectory: () => true },
		]);

		const notify = vi.fn();
		// Set the conversation default first via the switch subcommand.
		await handler("profile shopping", { ui: { notify } } as any);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Default profile set to 'shopping'"),
			"info",
		);

		await handler("profile delete shopping", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Conversation default reset to 'session'"),
			"info",
		);
		expect(pi.appendEntry as unknown as Mock).toHaveBeenCalledWith(
			"portal-conversation-state",
			expect.objectContaining({ defaultProfile: "session" }),
		);
	});

	it("handles 'profile delete <name>' — warns when removal fails", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(true);
		(readdirSync as Mock).mockReturnValue([
			{ name: "shopping", isDirectory: () => true },
		]);
		(rmSync as Mock).mockImplementationOnce(() => {
			throw new Error("EBUSY: resource busy");
		});

		const notify = vi.fn();
		await handler("profile delete shopping", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Failed to delete profile 'shopping'"),
			"warning",
		);
		expect(notify).not.toHaveBeenCalledWith(
			expect.stringContaining("Existing sessions using it will re-create it on save"),
			"info",
		);
	});

	it("handles 'profile delete <name>' not matching the conversation default — no reset", async () => {
		const pi = mockPi(["web-fetch"]);
		const handler = captureHandler(pi);

		(existsSync as Mock).mockReturnValue(true);
		(readdirSync as Mock).mockReturnValue([
			{ name: "shopping", isDirectory: () => true },
			{ name: "work", isDirectory: () => true },
		]);

		const notify = vi.fn();
		await handler("profile shopping", { ui: { notify } } as any);
		await handler("profile delete work", { ui: { notify } } as any);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Existing sessions using it will re-create it on save"),
			"info",
		);
		// Only the switch persisted once; no 'session' reset entry.
		const entries = (pi.appendEntry as unknown as Mock).mock.calls.map(
			(call) => (call[1] as { defaultProfile?: string }).defaultProfile,
		);
		expect(entries).not.toContain("session");
	});
});
