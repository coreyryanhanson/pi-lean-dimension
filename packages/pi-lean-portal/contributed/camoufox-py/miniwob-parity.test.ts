/**
 * Camoufox-Py MiniWoB++ parity-test template — **user-owned, docs-only**.
 *
 * This is a copy-pasteable template for running the full 130-task
 * MiniWoB++ suite against a user-installed Camoufox backend. It is
 * **not** run by `npm run test:miniwob` (it lives under
 * `packages/pi-lean-portal/docs/`, which is excluded from the portal
 * `package.json` `files` and is not under `bench/miniwob/suites/`). It
 * is also **not** in the npm tarball — the templates require the
 * source repo.
 *
 * How to use
 * ----------
 * 1. Install Camoufox under your user-backends tree:
 *      ~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/bridge.py
 *      (copy from this repo's
 *       `packages/pi-lean-portal/contributed/camoufox-py/bridge.py`)
 *    Create a venv at `user-backends/camoufox-py/.venv/`, install
 *    `cloverlabs-camoufox[geoip]` + `playwright`, and run
 *    `python -m camoufox fetch`. See
 *    `packages/pi-lean-portal/contributed/README.md` for the
 *    full install flow.
 * 2. Set up MiniWoB++ content once: `npm run setup:miniwob` (clones the
 *    pinned `miniwob-plusplus` repo). The content is reached one of two
 *    ways:
 *    - Point `MINIWOB_URL` at a static server you started yourself
 *      (any server — e.g. `python3 -m http.server` — the URL is used
 *      verbatim). This is the escape hatch for a server you already
 *      have running.
 *    - Or just leave `MINIWOB_URL` unset and ensure the on-disk clone is
 *      reachable via `MINIWOB_HTML_ROOT` (or its default
 *      `/tmp/miniwob-plusplus/miniwob/html`). The template then starts
 *      its own ephemeral static server via the shipped
 *      `startMiniwobServer()` (binds `listen(0, "127.0.0.1")` so the OS
 *      assigns a free port — no manual server, no fixed-port-8080
 *      conflict, safe for parallel runs) and tears it down in a
 *      file-level `afterAll`.
 * 3. **Opt in explicitly** by setting `CONTRIB_PARITY_RUN=1`, then run
 *    this file in-place from the cloned source repo (you need the repo
 *    to have copied the template in step 1), or copy it into your own
 *    test tree under the monorepo and run. Simplest (ephemeral server,
 *    no manual setup):
 *      CONTRIB_PARITY_RUN=1 \
 *        MINIWOB_HTML_ROOT=/tmp/miniwob-plusplus/miniwob/html \
 *        npx vitest run <this-file>
 *    Or point at a server you already have running:
 *      CONTRIB_PARITY_RUN=1 \
 *        MINIWOB_URL=http://localhost:8080 npx vitest run <this-file>
 *
 *    **Why the explicit `CONTRIB_PARITY_RUN=1` opt-in?** This file is
 *    a `.test.ts` under `packages/`, so the repo's default test sweep
 *    (`npm test` / `npm run test:ci`, whose include glob matches every
 *    `.test.ts` file anywhere under `packages/`) would otherwise load it
 *    on every run.
 *    On a machine that has Camoufox installed under `user-backends/`
 *    AND MiniWoB++ content on disk, a bare probe would mark the suite
 *    `available` and fire ~13 real Camoufox browser tasks (the template
 *    would even start its own ephemeral MiniWoB server) as a side effect
 *    of `npm test`, breaking `npm run test:ci` (Sprint 2 AC 2.5) with
 *    slow, real-browser work the dev never asked for. The
 *    env gate makes the template a no-op unless a dev explicitly opts
 *    in, so the default sweep stays green everywhere (bare CI sees no
 *    user-backends install and would auto-skip regardless; this gate
 *    protects dev machines that do have an install).
 *
 *    The imports below are relative paths into the monorepo source
 *    (`pi-lean-portal` internals + `bench/miniwob/` solvers) so the
 *    file typechecks cleanly from within the cloned repo. **These
 *    relative imports are the permanent form of this template** — they
 *    are not a workaround to be swapped for bare specifiers later. If
 *    you copy this file elsewhere under the monorepo (instead of
 *    running it in place from `contributed/camoufox-py/`),
 *    adjust the relative import depths to match your placement; do not
 *    rewrite them as package imports (`pi-lean-portal` does not export
 *    `python-adapter.js` or `core/plugin-api.js` as subpaths, and
 *    `bench/miniwob/` is not a published package at all).
 *
 * What it proves
 * --------------
 * The 13 trivial-solver tasks run end-to-end through the
 * `PythonPluginAdapter` → Camoufox bridge `plugin.evaluate` episode
 * lifecycle. The 3 confident tasks assert `rawReward > 0`; the 10
 * best-effort tasks are pipeline-smoke tests. The other 117 tasks skip
 * (82 need a goal-aware solver; 35 are non-element canvas/drag/hover/
 * select tasks with no matching `BrowserPlugin` tool).
 *
 * Why `capabilities.engine = "firefox"`
 * -------------------------------------
 * Camoufox is a patched Firefox binary. The shared contract suite's
 * identity test reads `plugin.capabilities.engine`; setting it to
 * `"firefox"` here makes that assertion read correctly. (The generic
 * `miniwob-user-backends.test.ts` runner omits `engine` and lets the
 * adapter default — that's fine for auto-skip/task-classification, but
 * a parity template that wants the identity test to pass must set it.)
 *
 * Prerequisites recap
 * -------------------
 *   - Camoufox installed under `user-backends/camoufox-py/` (bridge.py +
 *     .venv + fetched binary).
 *   - MiniWoB++ content available (`MINIWOB_URL` or `MINIWOB_HTML_ROOT`).
 *   - The `pi_browser_bridge` shared library made importable — the
 *     `PythonPluginAdapter` injects `backends/python-base/` onto
 *     `PYTHONPATH` automatically, so no `pip install` is needed.
 *
 * @module
 */

import { existsSync } from "node:fs";

import { afterAll } from "vitest";

import { PythonPluginAdapter } from "../../backends/python-adapter.js";
import type { BrowserPlugin } from "../../core/plugin-api.js";

import { probeUserBackend } from "../../__tests__/helpers/probe-user-backend.js";
import type { TestServer } from "../../__tests__/helpers/test-server.js";
import {
	registerMiniwobSuite,
	type MiniwobBackend,
} from "../../../../bench/miniwob/solvers/register-suite.js";
import { startMiniwobServer } from "../../../../bench/miniwob/scripts/miniwob-server.js";

// ─── Explicit opt-in gate ──────────────────────────────────────
//
// This template is a `.test.ts` under `packages/`, so the repo's default
// test sweep (`npm test` / `npm run test:ci`, whose include glob matches
// every `.test.ts` file anywhere under `packages/`) loads it on every
// run. Without a gate, a dev machine that has Camoufox installed +
// MiniWoB++ content on disk would fire ~13 real Camoufox tasks as a
// side effect of `npm test` and break `npm run test:ci` (AC 2.5). `CONTRIB_PARITY_RUN=1` is the
// explicit opt-in a dev sets when they actually want to run the parity
// suite. When unset, the file registers nothing — a visible no-op
// ("no tests") rather than 130 silent skips.
const PARITY_RUN = process.env.CONTRIB_PARITY_RUN === "1";

if (PARITY_RUN) {
	// ─── Availability probe ────────────────────────────────────
	//
	// `probeUserBackend("camoufox-py")` checks that
	// `${userBackendsDir()}/camoufox-py/bridge.py` exists and the venv at
	// `${userBackendsDir()}/camoufox-py/.venv/bin/python3` runs. It does
	// NOT check the Camoufox binary itself — if the binary fetch was
	// skipped, the bridge will fail at first navigate with the bridge's
	// `_install_hint` message. Override `PI_USER_BACKENDS_DIR` to point at
	// a non-default tree, or `PI_USER_BACKEND_CAMOUFOX-PY_PYTHON` to point
	// at a non-`user-backends` venv (note the hyphenated env name — set via
	// `settings.json` `env` or `env(1)`, not `export` in most shells).
	const probe = probeUserBackend("camoufox-py");

	// ─── Content availability ────────────────────────────────────
	//
	// Mirrors `miniwob-suite-helper.ts` — honors `MINIWOB_URL` or
	// `MINIWOB_HTML_ROOT` (default `/tmp/miniwob-plusplus/miniwob/html`).
	// Missing content auto-skips at the describe level.
	const HTML_ROOT =
		process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";
	const HAS_EXTERNAL_URL = Boolean(process.env.MINIWOB_URL);
	const HTML_ROOT_PRESENT = existsSync(HTML_ROOT);
	const CONTENT_AVAILABLE = HAS_EXTERNAL_URL || HTML_ROOT_PRESENT;

	const available = probe.available && CONTENT_AVAILABLE;

	// ─── MiniWoB static server (ephemeral fallback) ─────────────
	//
	// Honors `MINIWOB_URL` (used verbatim); otherwise lazily starts an
	// ephemeral `startMiniwobServer()` on a free port. Torn down in the
	// file-level `afterAll`. Mirrors `miniwob-suite-helper.ts`.
	let sharedServer: TestServer | null = null;

	async function ensureBaseUrl(): Promise<string> {
		if (process.env.MINIWOB_URL) return process.env.MINIWOB_URL;
		if (!sharedServer) {
			sharedServer = await startMiniwobServer(HTML_ROOT);
		}
		return sharedServer.url;
	}

	afterAll(async () => {
		if (sharedServer) {
			await sharedServer.stop().catch(() => {});
			sharedServer = null;
		}
	});

	// ─── Suite registration ─────────────────────────────────────
	const backend: MiniwobBackend = {
		name: "camoufox-py",
		available,
		initPlugin: async (): Promise<BrowserPlugin> => {
			const plugin = new PythonPluginAdapter("camoufox-py", {
				bridgeScript: probe.bridgePath,
				pythonPath: probe.venvPython,
				capabilities: {
					supportsFullPageScreenshot: true,
					supportsConsoleCapture: true,
					supportsJavaScriptEvaluate: true,
					supportsBotDetection: true,
					supportsDialogAutoDismissal: true,
					supportsAbortSignal: false,
					// Camoufox is a patched Firefox binary — set engine so the
					// contract suite's identity test reads it correctly.
					engine: "firefox",
				},
			});
			await plugin.init({});
			return plugin;
		},
	};

	// The caller owns the MiniWoB static server lifecycle per the
	// `registerMiniwobSuite` doc. `ensureBaseUrl` honors `MINIWOB_URL` when
	// set (a running server the caller started); otherwise it lazily starts
	// an ephemeral `startMiniwobServer()` and tears it down in the
	// `afterAll` above.
	registerMiniwobSuite(backend, ensureBaseUrl);
}
