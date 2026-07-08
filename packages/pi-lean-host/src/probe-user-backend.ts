/**
 * `probeUserBackend` — availability probe for a user-managed stealth
 * Python backend under `~/.pi/agent/pi-lean-portal/user-backends/`.
 *
 * Lets a user-managed stealth backend be exercised through the 130-task
 * MiniWoB++ harness (and the shipped parity-test template) without
 * forking the repo. The probe is engine-agnostic — it checks only that
 * the backend's `bridge.py` exists on disk and the backend's venv
 * python interpreter runs. No engine-specific binary probing; a
 * template that needs a binary probe (e.g. Camoufox's
 * `python -m camoufox fetch` check) can layer that on top.
 *
 * Resolution mirrors `detectPluginType` in
 * `pi-lean-portal/core/plugin-config.ts` so this probe and the runtime
 * loader agree on where a backend lives:
 * - `bridgePath` defaults to `${userBackendsDir()}/${name}/bridge.py`;
 *   an absolute `opts.bridgePath` short-circuits (the power-user escape
 *   hatch, mirroring the absolute-`dir` short-circuit).
 * - `venvPython` defaults to
 *   `${userBackendsDir()}/${name}/.venv/bin/python3`; overridable via
 *   `PI_USER_BACKEND_<UPPERNAME>_PYTHON` so a user can point at a
 *   non-`user-backends` venv without editing the test/template.
 *
 * **Why `userBackendsDir()` is vendored here** rather than imported from
 * `pi-lean-portal/core/shared/paths.js`: `pi-lean-host` declares
 * `pi-lean-portal` as an **optional** peer dependency (host is usable
 * standalone), and the portal's `package.json` `exports` exposes only
 * `.` with no subpath for `./core/shared/paths.js`. A runtime
 * value-import would break for any consumer installing `pi-lean-host`
 * as a standalone tarball without monorepo source colocation. The
 * cross-package precedent is `import type` (erased at runtime — see
 * `adapter/miniwob-adapter.ts`) or imports in `suites/` (not in
 * `pi-lean-host` `files` → not shipped). This module duplicates one
 * stable path string (documented stable in
 * `pi-lean-portal/core/shared/paths.ts`); the env override is also
 * genuinely useful for non-standard installs, which the portal constant
 * does not offer.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// ─── User-backends root ───────────────────────────────────────────

/**
 * Resolve the user-backends root directory.
 *
 * Honors `PI_USER_BACKENDS_DIR` (an absolute path override) when set
 * and non-empty; otherwise defaults to
 * `~/.pi/agent/pi-lean-portal/user-backends/`.
 *
 * Vendored locally — see the module doc for the rationale. Sprint 2's
 * generic runner reuses this same helper for consistency.
 */
export function userBackendsDir(): string {
	const env = process.env.PI_USER_BACKENDS_DIR;
	if (env !== undefined && env.trim() !== "") return env;
	return join(homedir(), ".pi", "agent", "pi-lean-portal", "user-backends");
}

// ─── Types ────────────────────────────────────────────────────────

/** Options for {@link probeUserBackend}. */
export interface ProbeUserBackendOptions {
	/**
	 * Absolute path to the backend's `bridge.py`, overriding the default
	 * `${userBackendsDir()}/${name}/bridge.py` resolution. Mirrors the
	 * absolute-`dir` short-circuit in `detectPluginType`: when this is an
	 * absolute path it wins; any other value is ignored in favor of the
	 * default resolution.
	 */
	bridgePath?: string;
}

/** Result of {@link probeUserBackend}. */
export interface ProbeUserBackendResult {
	/**
	 * `true` iff the bridge file exists AND the venv python interpreter
	 * runs (`python3 --version` exits 0).
	 */
	available: boolean;
	/** Resolved path to the backend's `bridge.py`. */
	bridgePath: string;
	/** Resolved path to the backend's venv python interpreter. */
	venvPython: string;
	/**
	 * When `available` is `false`, explains the first missing piece so a
	 * skip message is useful. `undefined` when `available` is `true`.
	 */
	reason?: string;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Probe a user-managed Python backend for availability.
 *
 * Checks, in order:
 *   1. The `bridge.py` exists at the resolved `bridgePath`.
 *   2. The venv python interpreter runs (`--version` exits 0).
 *
 * Returns a plain object (synchronous — one `spawnSync` for the venv
 * check, mirroring the existing `probePythonBackend` in
 * `suites/miniwob-suite-helper.ts`). Runs once at suite-load, so
 * blocking briefly is acceptable.
 *
 * @param name  Backend directory name under `user-backends/`
 *               (e.g. `"camoufox-py"`).
 * @param opts  Optional overrides; see {@link ProbeUserBackendOptions}.
 *
 * @note The `PI_USER_BACKEND_<UPPERNAME>_PYTHON` override uppercases
 *       `name` verbatim. For names containing `-` (e.g. `camoufox-py`)
 *       the env var contains a hyphen (`PI_USER_BACKEND_CAMOUFOX-PY_PYTHON`);
 *       shells that forbid hyphens in `export`ed names must set it via
 *       `settings.json` `env` or another Node-respected channel.
 */
export function probeUserBackend(
	name: string,
	opts?: ProbeUserBackendOptions,
): ProbeUserBackendResult {
	const root = userBackendsDir();

	const bridgePath =
		opts?.bridgePath !== undefined && isAbsolute(opts.bridgePath)
			? opts.bridgePath
			: join(root, name, "bridge.py");

	const envPython = process.env[`PI_USER_BACKEND_${name.toUpperCase()}_PYTHON`];
	const venvPython =
		envPython !== undefined && envPython.trim() !== ""
			? envPython
			: join(root, name, ".venv", "bin", "python3");

	if (!existsSync(bridgePath)) {
		return {
			available: false,
			bridgePath,
			venvPython,
			reason: `bridge script not found: ${bridgePath}`,
		};
	}

	const pythonRuns = (() => {
		if (!existsSync(venvPython)) return false;
		try {
			const result = spawnSync(venvPython, ["--version"], {
				stdio: "ignore",
				timeout: 5_000,
			});
			return result.status === 0;
		} catch {
			return false;
		}
	})();

	if (!pythonRuns) {
		return {
			available: false,
			bridgePath,
			venvPython,
			reason: `venv python not runnable: ${venvPython}`,
		};
	}

	return { available: true, bridgePath, venvPython };
}
