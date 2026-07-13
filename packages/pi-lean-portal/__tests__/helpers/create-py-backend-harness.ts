/**
 * Availability probe + path resolver for shipped Python bridge backends.
 *
 * Returns resolved paths and a `describeIfAvailable` gate so every
 * Python backend test file collapses to ~15 lines.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "vitest";

/** Optional engine-binary check for Python backends. */
export interface PyBackendHarnessOptions {
	/** When "firefox", also probes that the Firefox browser binary exists. */
	engine?: "chromium" | "firefox";
}

/** Result of {@link createPyBackendTestHarness}. */
export interface PyBackendTestHarnessResult {
	/** Resolved path to `<bridgeName>/bridge.py`. */
	bridgeScript: string;
	/** Resolved path to the Python venv interpreter. */
	pythonPath: string;
	/** True when all prerequisites are met (python + bridge + optional engine). */
	prerequisitesMet: boolean;
	/**
	 * `describe` when prerequisites are met, `describe.skip` otherwise.
	 * Drop-in for the `describeIfAvailable` gate pattern.
	 */
	describeIfAvailable: typeof describe | typeof describe.skip;
}

/**
 * Probe a shipped Python bridge backend and return resolved paths +
 * a ready-to-use `describeIfAvailable` gate.
 *
 * The test caller destructures what it needs:
 * ```
 * const { bridgeScript, pythonPath, describeIfAvailable } = createPyBackendTestHarness("chromium-py");
 * ```
 *
 * Paths resolve relative to `__tests__/helpers/` using the conventional
 * monorepo layout: `backends/<name>/bridge.py`, `backends/python-base/.venv/bin/python3`.
 *
 * @param bridgeName  Backend directory name (e.g. `"chromium-py"`, `"firefox-py"`).
 * @param options     Optional engine check.
 */
export function createPyBackendTestHarness(
	bridgeName: string,
	options?: PyBackendHarnessOptions,
): PyBackendTestHarnessResult {
	const bridgeScript = resolve(
		__dirname,
		`../../backends/${bridgeName}/bridge.py`,
	);
	const pythonPath = resolve(
		__dirname,
		"../../backends/python-base/.venv/bin/python3",
	);

	const pythonAvailable = (() => {
		if (!existsSync(pythonPath)) return false;
		const result = spawnSync(pythonPath, ["--version"], {
			stdio: "ignore",
			timeout: 5_000,
		});
		return result.status === 0;
	})();

	const bridgeExists = existsSync(bridgeScript);

	let browserAvailable = true;
	if (options?.engine === "firefox" && pythonAvailable) {
		browserAvailable = (() => {
			try {
				const result = spawnSync(
					pythonPath,
					[
						"-c",
						"from playwright.sync_api import sync_playwright; " +
							"p = sync_playwright().start(); " +
							"import os; print(os.path.exists(p.firefox.executable_path)); " +
							"p.stop()",
					],
					{ stdio: "pipe", timeout: 10_000 },
				);
				return (
					result.status === 0 && result.stdout.toString().trim() === "True"
				);
			} catch {
				return false;
			}
		})();
	}

	const prerequisitesMet = pythonAvailable && bridgeExists && browserAvailable;

	return {
		bridgeScript,
		pythonPath,
		prerequisitesMet,
		describeIfAvailable: prerequisitesMet ? describe : describe.skip,
	};
}
