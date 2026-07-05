/**
 * Structural tests for the BrowserGym adapter bridge.
 *
 * Validates that the Python bridge subprocess can be spawned, responds
 * to RPC calls, and returns the expected task listing — WITHOUT a
 * browser. Proves the adapter plumbing (JSON-RPC transport, bridge
 * lifecycle) is functional before the browser-driven suite runs.
 *
 * Auto-skips when the BrowserGym venv is unavailable (keeps test:ci green).
 *
 * Run: npx vitest run packages/pi-lean-host/suites/miniwob-helper.test.ts
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BridgeClient } from "../adapter/browsergym-adapter.js";

// --- Paths ---------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const HOST_PKG_DIR = resolve(__dirname, "..");
const VENV_PYTHON = resolve(HOST_PKG_DIR, "venv", "bin", "python3");
const BRIDGE_SCRIPT = resolve(HOST_PKG_DIR, "adapter", "browsergym-bridge.py");

// --- Availability gates --------------------------------------------

const VENV_AVAILABLE = existsSync(VENV_PYTHON);

const BROWSERGYM_AVAILABLE = (() => {
	if (!VENV_AVAILABLE) return false;
	try {
		const res = spawnSync(
			VENV_PYTHON,
			["-c", "import browsergym.miniwob; print('ok')"],
			{ stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
		);
		return res.status === 0 && res.stdout.toString().trim() === "ok";
	} catch {
		return false;
	}
})();

const SHOULD_RUN = VENV_AVAILABLE && BROWSERGYM_AVAILABLE;

function skipReason(): string {
	if (!VENV_AVAILABLE)
		return "BrowserGym venv missing (npm run setup:venv -w pi-lean-host)";
	return "browsergym.miniwob not importable from the venv";
}

// --- Suite ---------------------------------------------------------

describe("BrowserGym adapter — bridge protocol", () => {
	const itFn = SHOULD_RUN ? it : it.skip;

	itFn(
		SHOULD_RUN
			? "BridgeClient listTasks returns 125 tasks"
			: `prerequisites missing: ${skipReason()}`,
		async () => {
			const bridge = new BridgeClient(VENV_PYTHON, BRIDGE_SCRIPT);
			try {
				await bridge.start();
				const result = await bridge.call<{
					tasks: Array<{ name: string; subdomain: string }>;
					count: number;
				}>("miniwob.listTasks", {});
				expect(Array.isArray(result.tasks)).toBe(true);
				expect(result.count).toBe(125);
				expect(result.tasks.length).toBe(125);
			} finally {
				await bridge.stop().catch(() => {});
			}
		},
		30_000,
	);

	itFn(
		SHOULD_RUN ? "BridgeClient ping responds pong" : "skip: ping test",
		async () => {
			const bridge = new BridgeClient(VENV_PYTHON, BRIDGE_SCRIPT);
			try {
				await bridge.start();
				const pong = await bridge.call<string>("ping", {});
				expect(pong).toBe("pong");
			} finally {
				await bridge.stop().catch(() => {});
			}
		},
		15_000,
	);

	itFn(
		SHOULD_RUN
			? "BridgeClient shutdown responds cleanly"
			: "skip: shutdown test",
		async () => {
			const bridge = new BridgeClient(VENV_PYTHON, BRIDGE_SCRIPT);
			await bridge.start();
			await expect(bridge.stop()).resolves.toBeUndefined();
		},
		15_000,
	);
});
