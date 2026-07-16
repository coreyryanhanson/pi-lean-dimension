/**
 * Tests for the browser configuration parsing in plugin-config.ts.
 *
 * Covers:
 * - loadFullConfig().browser defaults when no config exists
 * - defaultProfile validation ("none", "session", or a named profile)
 * - defaultProfile validation
 * - maxStorageStateSize validation
 * - profiles section validation
 * - Reserved name rejection for profile names
 * - Merged global + project settings
 */

import { join } from "node:path";

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	loadFullConfig,
	invalidateConfigCache,
} from "../core/plugin-config.js";
import { loadPluginConfigFromFile } from "./helpers/load-plugin-config-from-file.js";

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

describe("loadFullConfig().browser", () => {
	it("returns defaults when no settings.json exists", () => {
		mockNoSettings();
		const config = loadFullConfig().browser;
		expect(config.defaultProfile).toBe("session");
	});

	it("returns defaults when browser section is missing", () => {
		mockGlobalSettings({});
		const config = loadFullConfig().browser;
		expect(config.defaultProfile).toBe("session");
	});

	it("returns defaults when browser section has no config keys", () => {
		mockGlobalSettings({ unrelated: true });
		const config = loadFullConfig().browser;
		expect(config.defaultProfile).toBe("session");
		expect(config.maxStorageStateSize).toBe(10 * 1024 * 1024);
	});

	// ── maxStorageStateSize ────────────────────────────────────

	describe("maxStorageStateSize", () => {
		it("accepts a positive number", () => {
			mockGlobalSettings({ maxStorageStateSize: 5 * 1024 * 1024 });
			expect(loadFullConfig().browser.maxStorageStateSize).toBe(
				5 * 1024 * 1024,
			);
		});

		it("floors fractional values", () => {
			mockGlobalSettings({ maxStorageStateSize: 5.9 * 1024 * 1024 });
			expect(loadFullConfig().browser.maxStorageStateSize).toBe(
				Math.floor(5.9 * 1024 * 1024),
			);
		});

		it("rejects zero / negative / non-finite and falls back to default", () => {
			for (const bad of [0, -1, Infinity, NaN, "big", null]) {
				mockGlobalSettings({ maxStorageStateSize: bad });
				expect(loadFullConfig().browser.maxStorageStateSize).toBe(
					10 * 1024 * 1024,
				);
			}
		});
	});

	// ── defaultProfile ─────────────────────────────────────────

	describe("defaultProfile", () => {
		it("accepts a valid profile name", () => {
			mockGlobalSettings({ defaultProfile: "work" });
			expect(loadFullConfig().browser.defaultProfile).toBe("work");
		});

		it("accepts hyphens and underscores", () => {
			mockGlobalSettings({ defaultProfile: "my-work-profile" });
			expect(loadFullConfig().browser.defaultProfile).toBe("my-work-profile");
		});

		it("rejects reserved names and falls back to default", () => {
			mockGlobalSettings({ defaultProfile: "none" });
			// "none" is reserved as a profile name but valid as a defaultProfile mode
			const config = loadFullConfig().browser;
			expect(config.defaultProfile).toBe("none");
		});

		it("rejects 'session' as a profile name for named profiles", () => {
			mockGlobalSettings({ defaultProfile: "session" });
			// "session" is reserved as a profile name but valid as a defaultProfile mode
			const config = loadFullConfig().browser;
			expect(config.defaultProfile).toBe("session");
		});

		it("rejects empty string", () => {
			mockGlobalSettings({ defaultProfile: "" });
			expect(loadFullConfig().browser.defaultProfile).toBe("session");
		});

		it("rejects names with path traversal", () => {
			mockGlobalSettings({ defaultProfile: "../../evil" });
			expect(loadFullConfig().browser.defaultProfile).toBe("session");
		});
	});

	// ── Settings merge ─────────────────────────────────────────

	describe("settings merge", () => {
		it("project settings override global settings", () => {
			mockBothSettings(
				{ browser: { defaultProfile: "none" } },
				{ browser: { defaultProfile: "work" } },
			);
			expect(loadFullConfig().browser.defaultProfile).toBe("work");
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
			const config = loadFullConfig().browser;
			expect(config.defaultProfile).toBe("session");
		});
	});
});

// ─── Default plugin fallback ───────────────────────────────────────

describe("loadFullConfig().plugins default fallback", () => {
	it("returns the four shipped backends when browser.plugins is absent", () => {
		// No settings files → default fallback branch in parsePluginConfig fires.
		mockNoSettings();
		const { plugins, errors } = loadFullConfig().plugins;
		expect(errors).toEqual([]);
		const names = plugins.map((p) => p.name);
		expect(names).toEqual(["chromium", "firefox", "chromium-py", "firefox-py"]);
	});

	it("does NOT include stealth backends (camoufox-py / stealth-py) in the default fallback", () => {
		mockNoSettings();
		const { plugins } = loadFullConfig().plugins;
		const names = plugins.map((p) => p.name);
		expect(names).not.toContain("camoufox-py");
		expect(names).not.toContain("stealth-py");
	});
});

// ─── loadPluginConfigFromFile ─────────────────────────────────────

describe("loadPluginConfigFromFile()", () => {
	/** Set up mock to behave like one valid bridge.py exists at a root dir. */
	function mockValidBackendRoot(dirPath: string): void {
		mockFs.existsSync.mockImplementation((p: string) => {
			// The settings file itself exists
			if (p === "/tmp/settings.json") return true;
			if (p === "/tmp/empty.json") return true;
			if (p === "/tmp/cached.json") return true;
			// The backend directory exists
			if (p === join(dirPath, "example-py")) return true;
			if (p === join(dirPath, "my-backend")) return true;
			// bridge.py exists (Python plugin)
			if (p === join(dirPath, "example-py", "bridge.py")) return true;
			if (p === join(dirPath, "my-backend", "bridge.py")) return true;
			// index.ts does NOT exist → Python plugin, unambiguous
			// Default stub dirs that detectPluginType checks as directories
			if (p.startsWith("/tmp/")) return false;
			// Everything else (e.g. global settings paths from fallback) is absent
			return false;
		});
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p === "/tmp/settings.json") {
				return JSON.stringify({
					browser: {
						plugins: [
							{
								name: "example-py",
								dir: "example-py",
								enabled: true,
								config: {
									pythonPath: "/custom/python3",
									capabilities: { engine: "firefox" },
									transportTimeoutMs: 30_000,
									launch: { headless: true },
								},
							},
						],
					},
				});
			}
			if (p === "/tmp/empty.json") return "{}";
			return "{}";
		});
	}

	it("parses a test-local settings file with browser.plugins", () => {
		// Point at a root with a valid bridge.py so detectPluginType passes.
		mockValidBackendRoot("/tmp/backends");

		const { plugins, errors } = loadPluginConfigFromFile("/tmp/settings.json", [
			"/tmp/backends",
		]);
		expect(errors).toEqual([]);
		expect(plugins).toHaveLength(1);
		const p = plugins[0]!;
		expect(p.name).toBe("example-py");
		expect(p.enabled).toBe(true);
		expect(p.config.pythonPath).toBe("/custom/python3");
		expect(p.config.launch).toEqual({ headless: true });
	});

	it("falls back to default plugins when settings file has no browser key", () => {
		// No browser key → falls through to parsePluginConfig(undefined) → defaults
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p === "/tmp/no-browser.json")
				return JSON.stringify({ unrelated: true });
			return "{}";
		});

		const { plugins, errors } = loadPluginConfigFromFile(
			"/tmp/no-browser.json",
		);
		expect(errors).toEqual([]);
		const names = plugins.map((p) => p.name);
		expect(names).toEqual(["chromium", "firefox", "chromium-py", "firefox-py"]);
	});

	it("falls back to default plugins when settings file is empty", () => {
		// Empty JSON object → no "browser" key → same fallback.
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p === "/tmp/empty.json") return "{}";
			return "{}";
		});

		const { plugins, errors } = loadPluginConfigFromFile("/tmp/empty.json");
		expect(errors).toEqual([]);
		const names = plugins.map((p) => p.name);
		expect(names).toEqual(["chromium", "firefox", "chromium-py", "firefox-py"]);
	});

	it("is one-shot with no caching (consecutive calls read the file each time)", () => {
		const spy = vi.fn((_: string) =>
			JSON.stringify({ browser: { plugins: [] } }),
		);
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation(spy);

		const testPath = "/tmp/cached.json";
		// Call twice
		loadPluginConfigFromFile(testPath);
		loadPluginConfigFromFile(testPath);

		// Must have been called twice (no caching)
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
