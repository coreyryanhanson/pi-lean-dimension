/**
 * Tests for the browser configuration parsing in plugin-config.ts.
 *
 * Covers:
 * - loadBrowserConfig() defaults when no config exists
 * - sessionDefault validation ("new" | "last")
 * - defaultProfile validation
 * - maxStorageStateSize validation
 * - profiles section validation
 * - Reserved name rejection for profile names
 * - Merged global + project settings
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	loadBrowserConfig,
	DEFAULT_MAX_STORAGE_STATE_SIZE,
} from "../core/plugin-config";

// ─── Mock fs to intercept settings.json reads ────────────────────

const mockFs = vi.hoisted(() => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => mockFs);

// ─── Helpers ─────────────────────────────────────────────────────

/** Set up a mock settings.json payload for the global path. */
function mockGlobalSettings(browserSection: Record<string, unknown>): void {
	const payload = browserSection ? { browser: browserSection } : {};
	mockFs.existsSync.mockReturnValue(true);
	mockFs.readFileSync.mockImplementation((path: string) => {
		if (path.includes(".pi/agent/settings.json")) {
			return JSON.stringify(payload);
		}
		if (path.includes(".pi/settings.json")) {
			return "{}";
		}
		return "{}";
	});
}

/** Set up both global and project settings files. */
function mockBothSettings(
	global: Record<string, unknown>,
	project: Record<string, unknown>,
): void {
	mockFs.existsSync.mockReturnValue(true);
	mockFs.readFileSync.mockImplementation((path: string) => {
		if (path.includes(".pi/agent/settings.json")) {
			return JSON.stringify(global);
		}
		if (path.includes(".pi/settings.json")) {
			return JSON.stringify(project);
		}
		return "{}";
	});
}

/** Set up mock to return no settings files. */
function mockNoSettings(): void {
	mockFs.existsSync.mockReturnValue(false);
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────

describe("loadBrowserConfig()", () => {
	it("returns defaults when no settings.json exists", () => {
		mockNoSettings();
		const config = loadBrowserConfig();
		expect(config.sessionDefault).toBe("new");
		expect(config.defaultProfile).toBe("default");
		expect(config.maxStorageStateSize).toBe(DEFAULT_MAX_STORAGE_STATE_SIZE);
		expect(config.profiles).toEqual({});
	});

	it("returns defaults when browser section is missing", () => {
		mockGlobalSettings({});
		const config = loadBrowserConfig();
		expect(config.sessionDefault).toBe("new");
		expect(config.defaultProfile).toBe("default");
	});

	it("returns defaults when browser section has no config keys", () => {
		mockGlobalSettings({ unrelated: true });
		const config = loadBrowserConfig();
		expect(config.sessionDefault).toBe("new");
		expect(config.profiles).toEqual({});
	});

	// ── sessionDefault ─────────────────────────────────────────

	describe("sessionDefault", () => {
		it('accepts "new"', () => {
			mockGlobalSettings({ sessionDefault: "new" });
			expect(loadBrowserConfig().sessionDefault).toBe("new");
		});

		it('accepts "last"', () => {
			mockGlobalSettings({ sessionDefault: "last" });
			expect(loadBrowserConfig().sessionDefault).toBe("last");
		});

		it("rejects invalid values and falls back to default", () => {
			mockGlobalSettings({ sessionDefault: "maybe" });
			// Falls back to default
			expect(loadBrowserConfig().sessionDefault).toBe("new");
		});

		it("rejects non-string values", () => {
			mockGlobalSettings({ sessionDefault: 42 });
			expect(loadBrowserConfig().sessionDefault).toBe("new");
		});
	});

	// ── defaultProfile ─────────────────────────────────────────

	describe("defaultProfile", () => {
		it("accepts a valid profile name", () => {
			mockGlobalSettings({ defaultProfile: "work" });
			expect(loadBrowserConfig().defaultProfile).toBe("work");
		});

		it("accepts hyphens and underscores", () => {
			mockGlobalSettings({ defaultProfile: "my-work-profile" });
			expect(loadBrowserConfig().defaultProfile).toBe("my-work-profile");
		});

		it("rejects reserved names and falls back to default", () => {
			mockGlobalSettings({ defaultProfile: "new" });
			const config = loadBrowserConfig();
			expect(config.defaultProfile).toBe("default");
		});

		it("rejects 'last' as a profile name", () => {
			mockGlobalSettings({ defaultProfile: "last" });
			const config = loadBrowserConfig();
			expect(config.defaultProfile).toBe("default");
		});

		it("rejects empty string", () => {
			mockGlobalSettings({ defaultProfile: "" });
			expect(loadBrowserConfig().defaultProfile).toBe("default");
		});

		it("rejects names with path traversal", () => {
			mockGlobalSettings({ defaultProfile: "../../evil" });
			expect(loadBrowserConfig().defaultProfile).toBe("default");
		});
	});

	// ── maxStorageStateSize ────────────────────────────────────

	describe("maxStorageStateSize", () => {
		it("accepts a positive number", () => {
			mockGlobalSettings({ maxStorageStateSize: 5 * 1024 * 1024 });
			expect(loadBrowserConfig().maxStorageStateSize).toBe(5 * 1024 * 1024);
		});

		it("falls back to default for zero", () => {
			mockGlobalSettings({ maxStorageStateSize: 0 });
			expect(loadBrowserConfig().maxStorageStateSize).toBe(
				DEFAULT_MAX_STORAGE_STATE_SIZE,
			);
		});

		it("falls back to default for negative numbers", () => {
			mockGlobalSettings({ maxStorageStateSize: -1 });
			expect(loadBrowserConfig().maxStorageStateSize).toBe(
				DEFAULT_MAX_STORAGE_STATE_SIZE,
			);
		});

		it("falls back to default for Infinity", () => {
			mockGlobalSettings({ maxStorageStateSize: Infinity });
			expect(loadBrowserConfig().maxStorageStateSize).toBe(
				DEFAULT_MAX_STORAGE_STATE_SIZE,
			);
		});

		it("falls back to default for non-number", () => {
			mockGlobalSettings({ maxStorageStateSize: "10MB" });
			expect(loadBrowserConfig().maxStorageStateSize).toBe(
				DEFAULT_MAX_STORAGE_STATE_SIZE,
			);
		});
	});

	// ── profiles ───────────────────────────────────────────────

	describe("profiles", () => {
		it("accepts a valid profiles object", () => {
			mockGlobalSettings({
				profiles: {
					default: { persist: true },
					shopping: { persist: false },
				},
			});
			const config = loadBrowserConfig();
			expect(config.profiles.default).toEqual({ persist: true });
			expect(config.profiles.shopping).toEqual({ persist: false });
		});

		it("defaults persist to true when omitted", () => {
			mockGlobalSettings({
				profiles: {
					work: {},
				},
			});
			expect(loadBrowserConfig().profiles.work).toEqual({ persist: true });
		});

		it("skips entries with reserved names", () => {
			mockGlobalSettings({
				profiles: {
					new: { persist: true },
					valid: { persist: true },
				},
			});
			const config = loadBrowserConfig();
			expect(config.profiles.new).toBeUndefined();
			expect(config.profiles.valid).toBeDefined();
		});

		it("skips entries with invalid profile names", () => {
			mockGlobalSettings({
				profiles: {
					"has space": { persist: true },
					"../escape": { persist: true },
					"valid-name": { persist: true },
				},
			});
			const config = loadBrowserConfig();
			expect(config.profiles["has space"]).toBeUndefined();
			expect(config.profiles["../escape"]).toBeUndefined();
			expect(config.profiles["valid-name"]).toBeDefined();
		});

		it("rejects non-object profiles value", () => {
			mockGlobalSettings({
				profiles: "not-an-object",
			});
			expect(loadBrowserConfig().profiles).toEqual({});
		});

		it("rejects array profiles value", () => {
			mockGlobalSettings({
				profiles: ["default", "shopping"],
			});
			expect(loadBrowserConfig().profiles).toEqual({});
		});
	});

	// ── Settings merge ─────────────────────────────────────────

	describe("settings merge", () => {
		it("project settings override global settings", () => {
			mockBothSettings(
				{ browser: { sessionDefault: "new" } },
				{ browser: { sessionDefault: "last" } },
			);
			expect(loadBrowserConfig().sessionDefault).toBe("last");
		});

		it("project settings entirely replace global browser config (shallow merge)", () => {
			mockBothSettings(
				{
					browser: {
						sessionDefault: "last",
						defaultProfile: "global-profile",
					},
				},
				{
					browser: {
						sessionDefault: "new",
					},
					// project doesn't set defaultProfile or maxStorageStateSize
					// but since browser is shallow-merged, global's browser is entirely replaced
				},
			);
			const config = loadBrowserConfig();
			expect(config.sessionDefault).toBe("new");
			// Global's defaultProfile is lost because project replaced browser entirely
			expect(config.defaultProfile).toBe("default");
			expect(config.maxStorageStateSize).toBe(DEFAULT_MAX_STORAGE_STATE_SIZE);
		});
	});
});
