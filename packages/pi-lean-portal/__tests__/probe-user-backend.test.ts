/**
 * Unit tests for `probeUserBackend` (Sprint 1, AC 1.2).
 *
 * Structural — no real browser, no MiniWoB content. Uses a temp
 * directory as `PI_USER_BACKENDS_DIR` so nothing is written to the
 * real `~/.pi/agent/pi-lean-portal/user-backends/`. The "venv runs"
 * case uses a tiny `#!/bin/sh\nexit 0` stub executable so the test is
 * self-contained and does not depend on python3 being installed at a
 * known path; the "non-runnable" case uses an exit-1 stub.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	probeUserBackend,
	userBackendsDir,
} from "./helpers/probe-user-backend.js";

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Create a stub "python3" executable at `<dir>/.venv/bin/python3` that
 * exits with `exitCode`. Mimics a runnable (exit 0) or broken (exit 1)
 * venv interpreter for the probe's `spawnSync(…, ["--version"])` check.
 */
function makeStubPython(dir: string, exitCode: number): string {
	const binDir = join(dir, ".venv", "bin");
	mkdirSync(binDir, { recursive: true });
	const pyPath = join(binDir, "python3");
	writeFileSync(pyPath, `#!/bin/sh\nexit ${exitCode}\n`);
	chmodSync(pyPath, 0o755);
	return pyPath;
}

/** Write a stub `bridge.py` at `<dir>/bridge.py`. */
function makeStubBridge(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const bridgePath = join(dir, "bridge.py");
	writeFileSync(bridgePath, "# stub bridge\n");
	return bridgePath;
}

// ─── Test env snapshot / restore ──────────────────────────────────

let tempRoot: string;
let savedDir: string | undefined;
/** Per-name `PI_USER_BACKEND_<UPPERNAME>_PYTHON` keys set during a test. */
let touchedPythonKeys: string[] = [];
/** Saved values of per-name python env overrides, for afterEach restore. */
const savedEnv = new Map<string, string | undefined>();

function setPythonOverride(name: string, value: string): void {
	const key = `PI_USER_BACKEND_${name.toUpperCase()}_PYTHON`;
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	touchedPythonKeys.push(key);
	process.env[key] = value;
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "probe-user-backend-"));
	savedDir = process.env.PI_USER_BACKENDS_DIR;
	savedEnv.clear();
	touchedPythonKeys = [];
	process.env.PI_USER_BACKENDS_DIR = tempRoot;
});

afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
	// Restore PI_USER_BACKENDS_DIR.
	if (savedDir === undefined)
		Reflect.deleteProperty(process.env, "PI_USER_BACKENDS_DIR");
	else process.env.PI_USER_BACKENDS_DIR = savedDir;
	// Restore (or delete) any per-name python overrides set during the test.
	for (const key of touchedPythonKeys) {
		const saved = savedEnv.get(key);
		if (saved === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = saved;
	}
	touchedPythonKeys = [];
});

// ─── userBackendsDir ──────────────────────────────────────────────

describe("userBackendsDir", () => {
	it("honors PI_USER_BACKENDS_DIR when set", () => {
		expect(userBackendsDir()).toBe(tempRoot);
	});

	it("falls back to ~/.pi/agent/pi-lean-portal/user-backends when unset", () => {
		Reflect.deleteProperty(process.env, "PI_USER_BACKENDS_DIR");
		const expected = join(
			homedir(),
			".pi",
			"agent",
			"pi-lean-portal",
			"user-backends",
		);
		expect(userBackendsDir()).toBe(expected);
	});

	it("treats an empty PI_USER_BACKENDS_DIR as unset", () => {
		process.env.PI_USER_BACKENDS_DIR = "   ";
		const expected = join(
			homedir(),
			".pi",
			"agent",
			"pi-lean-portal",
			"user-backends",
		);
		expect(userBackendsDir()).toBe(expected);
	});
});

// ─── probeUserBackend ─────────────────────────────────────────────

describe("probeUserBackend", () => {
	it("returns available=true with correct paths when bridge + venv present", () => {
		const name = "camoufox-py";
		const backendDir = join(tempRoot, name);
		const bridge = makeStubBridge(backendDir);
		const py = makeStubPython(backendDir, 0);

		const result = probeUserBackend(name);

		expect(result.available).toBe(true);
		expect(result.reason).toBeUndefined();
		expect(result.bridgePath).toBe(bridge);
		expect(result.venvPython).toBe(py);
	});

	it("returns available=false with a bridge-mentioning reason when bridge.py is missing", () => {
		const name = "camoufox-py";
		// venv present but no bridge.py
		const py = makeStubPython(join(tempRoot, name), 0);
		const expectedBridge = join(tempRoot, name, "bridge.py");

		const result = probeUserBackend(name);

		expect(result.available).toBe(false);
		expect(result.reason).toMatch(/bridge/i);
		expect(result.reason).toContain(expectedBridge);
		expect(result.bridgePath).toBe(expectedBridge);
		expect(result.venvPython).toBe(py);
	});

	it("returns available=false with a venv-mentioning reason when venv python is missing", () => {
		const name = "stealth-py";
		const backendDir = join(tempRoot, name);
		makeStubBridge(backendDir);
		const expectedPy = join(backendDir, ".venv", "bin", "python3");

		const result = probeUserBackend(name);

		expect(result.available).toBe(false);
		expect(result.reason).toMatch(/venv|python/i);
		expect(result.reason).toContain(expectedPy);
		expect(result.venvPython).toBe(expectedPy);
	});

	it("returns available=false with a venv-mentioning reason when venv python exists but does not run", () => {
		const name = "stealth-py";
		const backendDir = join(tempRoot, name);
		makeStubBridge(backendDir);
		const py = makeStubPython(backendDir, 1); // exits non-zero

		const result = probeUserBackend(name);

		expect(result.available).toBe(false);
		expect(result.reason).toMatch(/venv|python/i);
		expect(result.reason).toContain(py);
		expect(result.venvPython).toBe(py);
	});

	it("respects PI_USER_BACKEND_<UPPERNAME>_PYTHON env override for venvPython", () => {
		const name = "camoufox-py";
		const backendDir = join(tempRoot, name);
		makeStubBridge(backendDir);
		// Do NOT create the default .venv; instead point the env override at a
		// stub python that lives outside the default venv path (but still under
		// tempRoot so afterEach cleans it up).
		const overrideDir = join(tempRoot, "override-venv");
		const overridePy = makeStubPython(overrideDir, 0);
		setPythonOverride(name, overridePy);

		const result = probeUserBackend(name);

		expect(result.available).toBe(true);
		expect(result.venvPython).toBe(overridePy);
		expect(existsSync(join(backendDir, ".venv", "bin", "python3"))).toBe(false);
	});

	it("respects opts.bridgePath absolute override for bridgePath", () => {
		const name = "camoufox-py";
		// Create a bridge.py at an arbitrary absolute location outside the
		// default user-backends/<name>/ tree (but still under tempRoot so
		// afterEach cleans it up).
		const externalDir = join(tempRoot, "override-bridge");
		const externalBridge = makeStubBridge(externalDir);
		// Also provide a working venv under the default path so the only thing
		// being overridden is the bridge location.
		makeStubPython(join(tempRoot, name), 0);

		const result = probeUserBackend(name, { bridgePath: externalBridge });

		expect(result.available).toBe(true);
		expect(result.bridgePath).toBe(externalBridge);
		// The default bridge path is NOT used.
		expect(result.bridgePath).not.toBe(join(tempRoot, name, "bridge.py"));
	});

	it("ignores a non-absolute opts.bridgePath and falls back to default resolution", () => {
		const name = "camoufox-py";
		const backendDir = join(tempRoot, name);
		const bridge = makeStubBridge(backendDir);
		makeStubPython(backendDir, 0);

		// A relative bridgePath must not short-circuit (mirrors detectPluginType,
		// which only short-circuits on isAbsolute(dir)).
		const result = probeUserBackend(name, { bridgePath: "relative/bridge.py" });

		expect(result.available).toBe(true);
		expect(result.bridgePath).toBe(bridge);
	});
});
