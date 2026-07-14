#!/usr/bin/env node
/**
 * Runs the pure-logic pytest suite under
 * `packages/pi-lean-portal/backends/python-base/tests/`.
 *
 * These 243 tests cover the shared Python bridge library
 * (`pi_browser_bridge`): accessibility parsing, bot detection,
 * JSON-RPC transport, the chromium-py / firefox-py routing layers, and
 * the `PlaywrightBridge` stealth-quirk flags. They use fakes/mocks and
 * need **no Playwright browser binaries** — the `playwright` import in
 * `playwright_base.py` is lazily guarded (`HAS_PLAYWRIGHT`), so the only
 * runtime requirement is `pytest` itself.
 *
 * Python interpreter selection (first match wins):
 *   1. `packages/pi-lean-portal/backends/python-base/.venv/bin/python`
 *      — the dev venv (present on machines that run the Python bridges).
 *   2. `python3` — the system interpreter (CI installs `pytest` via the
 *      structural workflow step before invoking this script).
 *
 * If `pytest` is not importable in the chosen interpreter, the script
 * prints a clear hint and exits non-zero instead of producing a confusing
 * traceback.
 *
 * Usage: `npm run test:py-bridge`
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PY_BASE = join(
	REPO_ROOT,
	"packages",
	"pi-lean-portal",
	"backends",
	"python-base",
);
const VENV_PY = join(PY_BASE, ".venv", "bin", "python");

function pickPython() {
	if (existsSync(VENV_PY)) return VENV_PY;
	return "python3";
}

// Resolve the interpreter to an absolute path for clearer error output.
let resolved = pickPython();
try {
	resolved = execFileSync(
		resolved,
		["-c", "import sys; print(sys.executable)"],
		{
			encoding: "utf-8",
		},
	).trim();
} catch {
	// `python3` may not be on PATH; surface a clear error.
	console.error(
		`test:py-bridge: no Python interpreter found.\n` +
			`  Looked for venv: ${VENV_PY}\n` +
			`  Looked for system: python3\n` +
			`Install Python 3.10+ and \`pip install pytest\`, or create the venv:\n` +
			`  python3 -m venv ${PY_BASE}/.venv && ${PY_BASE}/.venv/bin/pip install pytest`,
	);
	process.exit(1);
}

// Verify pytest is importable before running, with a targeted hint.
try {
	execFileSync(resolved, ["-c", "import pytest"], {
		encoding: "utf-8",
		stdio: "pipe",
	});
} catch {
	console.error(
		`test:py-bridge: \`pytest\` is not installed for ${resolved}.\n` +
			`Install it with:\n` +
			`  ${resolved} -m pip install pytest`,
	);
	process.exit(1);
}

// Run pytest from the python-base dir so pyproject.toml's
// `testpaths = ["tests"]` and `pythonpath = ["pi_browser_bridge"]` apply.
const args = ["-m", "pytest", "tests/", "-q"];
try {
	execFileSync(resolved, args, {
		cwd: PY_BASE,
		stdio: "inherit",
	});
} catch (err) {
	// execFileSync throws on non-zero exit; pytest's own output already
	// streamed to the parent. Preserve the exit code.
	process.exitCode = err.status ?? 1;
}
