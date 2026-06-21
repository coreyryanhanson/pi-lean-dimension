/**
 * Tests for dynamic plugin loading in the extension entry point.
 *
 * Verifies that the startup loop correctly detects and registers
 * Node-based (ChromiumPlugin) and Python-based (PythonPluginAdapter)
 * plugins using `detectPluginType()`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectPluginType, DEFAULT_BACKENDS_ROOT } from "../core/plugin-config";
import { PluginRegistry } from "../core/plugin-registry";
import type { PluginConfig } from "../core/plugin-config";

// ─── Helpers ─────────────────────────────────────────────────────

/** Create a temporary backends directory for test isolation */
function createTestBackendsRoot(
	structure: Record<string, Record<string, string>>,
): string {
	const root = mkdtempSync(join(tmpdir(), "pi-browser-test-"));
	for (const [dir, files] of Object.entries(structure)) {
		const dirPath = join(root, dir);
		mkdirSync(dirPath, { recursive: true });
		for (const [file, content] of Object.entries(files)) {
			writeFileSync(join(dirPath, file), content);
		}
	}
	return root;
}

/** Clean up a temporary backends directory */
function cleanupTestBackendsRoot(root: string): void {
	rmSync(root, { recursive: true, force: true });
}

// ─── detectPluginType ────────────────────────────────────────────

describe("detectPluginType", () => {
	let backendsRoot: string;

	afterEach(() => {
		try {
			cleanupTestBackendsRoot(backendsRoot);
		} catch {
			/* may not exist */
		}
	});

	it("detects a Node plugin (index.ts)", () => {
		backendsRoot = createTestBackendsRoot({
			"my-node-plugin": { "index.ts": "export class MyPlugin {}" },
		});
		const result = detectPluginType("my-node-plugin", backendsRoot);
		expect(result.type).toBe("node");
		expect(result.entryPoint).toBe(
			join(backendsRoot, "my-node-plugin", "index.ts"),
		);
	});

	it("detects a Python plugin (bridge.py)", () => {
		backendsRoot = createTestBackendsRoot({
			"my-py-plugin": { "bridge.py": "class MyBridge: pass" },
		});
		const result = detectPluginType("my-py-plugin", backendsRoot);
		expect(result.type).toBe("python");
		expect(result.entryPoint).toBe(
			join(backendsRoot, "my-py-plugin", "bridge.py"),
		);
	});

	it("throws for ambiguous dir (both index.ts and bridge.py)", () => {
		backendsRoot = createTestBackendsRoot({
			ambiguous: {
				"index.ts": "export class X {}",
				"bridge.py": "class X: pass",
			},
		});
		expect(() => detectPluginType("ambiguous", backendsRoot)).toThrow(
			/ambiguous/,
		);
	});

	it("throws for dir with no entry point", () => {
		backendsRoot = createTestBackendsRoot({
			"empty-plugin": { "readme.md": "# Nothing useful" },
		});
		expect(() => detectPluginType("empty-plugin", backendsRoot)).toThrow(
			/no entry point/i,
		);
	});

	it("throws for non-existent dir", () => {
		backendsRoot = createTestBackendsRoot({});
		expect(() => detectPluginType("nonexistent", backendsRoot)).toThrow(
			/no entry point/i,
		);
	});
});

// ─── Production backends detection ────────────────────────────────

describe("detectPluginType — production backends", () => {
	it("detects the chromium backend as a Node plugin", () => {
		// This tests the actual backends/chromium/ directory
		const result = detectPluginType("chromium", DEFAULT_BACKENDS_ROOT);
		expect(result.type).toBe("node");
		expect(result.entryPoint).toContain("chromium/index.ts");
	});

	it("detects the firefox backend as a Node plugin", () => {
		// This tests the actual backends/firefox/ directory
		const result = detectPluginType("firefox", DEFAULT_BACKENDS_ROOT);
		expect(result.type).toBe("node");
		expect(result.entryPoint).toContain("firefox/index.ts");
	});

	it("detects the chromium-py backend as a Python plugin", () => {
		// This tests the actual backends/chromium-py/ directory
		const result = detectPluginType("chromium-py", DEFAULT_BACKENDS_ROOT);
		expect(result.type).toBe("python");
		expect(result.entryPoint).toContain("chromium-py/bridge.py");
	});

	it("detects the firefox-py backend as a Python plugin", () => {
		// This tests the actual backends/firefox-py/ directory
		const result = detectPluginType("firefox-py", DEFAULT_BACKENDS_ROOT);
		expect(result.type).toBe("python");
		expect(result.entryPoint).toContain("firefox-py/bridge.py");
	});
});

// ─── Startup loop integration ────────────────────────────────────

describe("plugin startup loop integration", () => {
	/**
	 * Simulates the startup loop logic from index.ts:
	 * - Load plugin configs
	 * - Detect plugin type
	 * - Register with the appropriate class
	 *
	 * We don't test the actual ChromiumPlugin/PythonPluginAdapter
	 * instantiation here (those are tested in their own test files).
	 * Instead, we verify that the detection and routing logic works.
	 */
	let backendsRoot: string;
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	afterEach(() => {
		try {
			cleanupTestBackendsRoot(backendsRoot);
		} catch {
			/* may not exist */
		}
	});

	it("skips plugins with missing directories and logs error", () => {
		backendsRoot = createTestBackendsRoot({});
		const configs: PluginConfig[] = [
			{ name: "nonexistent", dir: "nonexistent", enabled: true, config: {} },
		];

		const errors: string[] = [];
		for (const config of configs) {
			try {
				detectPluginType(config.dir, backendsRoot);
			} catch (err) {
				errors.push(
					`Plugin '${config.name}' (dir: '${config.dir}'): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("nonexistent");
		expect(errors[0]).toContain("no entry point");
		expect(registry.size).toBe(0);
	});

	it("skips plugins with ambiguous directories and logs error", () => {
		backendsRoot = createTestBackendsRoot({
			ambiguous: {
				"index.ts": "export class X {}",
				"bridge.py": "class X: pass",
			},
		});
		const configs: PluginConfig[] = [
			{ name: "ambiguous", dir: "ambiguous", enabled: true, config: {} },
		];

		const errors: string[] = [];
		for (const config of configs) {
			try {
				detectPluginType(config.dir, backendsRoot);
			} catch (err) {
				errors.push(
					`Plugin '${config.name}' (dir: '${config.dir}'): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("ambiguous");
		expect(registry.size).toBe(0);
	});

	it("correctly classifies multiple plugins of different types", () => {
		backendsRoot = createTestBackendsRoot({
			"my-node": { "index.ts": "export class X {}" },
			"my-py": { "bridge.py": "class X: pass" },
		});
		const configs: PluginConfig[] = [
			{ name: "my-node", dir: "my-node", enabled: true, config: {} },
			{ name: "my-py", dir: "my-py", enabled: true, config: {} },
		];

		const detections = configs.map((config) => ({
			config,
			detection: detectPluginType(config.dir, backendsRoot),
		}));

		expect(detections[0]!.detection.type).toBe("node");
		expect(detections[1]!.detection.type).toBe("python");
	});

	it("detects disabled plugins correctly (type detection still works)", () => {
		backendsRoot = createTestBackendsRoot({
			"my-py": { "bridge.py": "class X: pass" },
		});
		const configs: PluginConfig[] = [
			{ name: "my-py", dir: "my-py", enabled: false, config: {} },
		];

		const detections = configs.map((config) => ({
			config,
			detection: detectPluginType(config.dir, backendsRoot),
		}));

		expect(detections[0]!.detection.type).toBe("python");
		// Even though disabled, detection works — the startup loop
		// would register it with enabled: false
	});
});

// ─── DEFAULT_BACKENDS_ROOT ────────────────────────────────────────

describe("DEFAULT_BACKENDS_ROOT", () => {
	it("is an absolute path ending in 'backends'", () => {
		expect(DEFAULT_BACKENDS_ROOT).toContain("backends");
		expect(DEFAULT_BACKENDS_ROOT).toMatch(/^\//);
	});
});
