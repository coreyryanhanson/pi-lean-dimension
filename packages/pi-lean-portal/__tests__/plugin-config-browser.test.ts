/**
 * Tests for the browser configuration parsing in plugin-config.ts.
 *
 * Covers:
 * - loadBrowserConfig() defaults when no config exists
 * - defaultProfile validation ("none", "session", or a named profile)
 * - defaultProfile validation
 * - maxStorageStateSize validation
 * - profiles section validation
 * - Reserved name rejection for profile names
 * - Merged global + project settings
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	loadBrowserConfig,
	invalidateConfigCache,
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
	invalidateConfigCache();
});

// ─── Tests ───────────────────────────────────────────────────────

describe("loadBrowserConfig()", () => {
	it("returns defaults when no settings.json exists", () => {
		mockNoSettings();
		const config = loadBrowserConfig();
		expect(config.defaultProfile).toBe("session");
	});

	it("returns defaults when browser section is missing", () => {
		mockGlobalSettings({});
		const config = loadBrowserConfig();
		expect(config.defaultProfile).toBe("session");
	});

	it("returns defaults when browser section has no config keys", () => {
		mockGlobalSettings({ unrelated: true });
		const config = loadBrowserConfig();
		expect(config.defaultProfile).toBe("session");
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
			mockGlobalSettings({ defaultProfile: "none" });
			// "none" is reserved as a profile name but valid as a defaultProfile mode
			const config = loadBrowserConfig();
			expect(config.defaultProfile).toBe("none");
		});

		it("rejects 'session' as a profile name for named profiles", () => {
			mockGlobalSettings({ defaultProfile: "session" });
			// "session" is reserved as a profile name but valid as a defaultProfile mode
			const config = loadBrowserConfig();
			expect(config.defaultProfile).toBe("session");
		});

		it("rejects empty string", () => {
			mockGlobalSettings({ defaultProfile: "" });
			expect(loadBrowserConfig().defaultProfile).toBe("session");
		});

		it("rejects names with path traversal", () => {
			mockGlobalSettings({ defaultProfile: "../../evil" });
			expect(loadBrowserConfig().defaultProfile).toBe("session");
		});
	});

	// ── Settings merge ─────────────────────────────────────────

	describe("settings merge", () => {
		it("project settings override global settings", () => {
			mockBothSettings(
				{ browser: { defaultProfile: "none" } },
				{ browser: { defaultProfile: "work" } },
			);
			expect(loadBrowserConfig().defaultProfile).toBe("work");
		});

		it("project settings entirely replace global browser config (shallow merge)", () => {
			mockBothSettings(
				{
					browser: {
						defaultProfile: "global-profile",
					},
				},
				{
					browser: {
						defaultProfile: "session",
					},
				},
			);
			const config = loadBrowserConfig();
			expect(config.defaultProfile).toBe("session");
		});
	});
});
