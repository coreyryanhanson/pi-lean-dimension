/**
 * MiniWoB++ suite — **generic user-backends runner** (repo/dev artifact).
 *
 * Discovers any user-managed Python stealth backend installed under
 * `~/.pi/agent/pi-lean-portal/user-backends/` (or `PI_USER_BACKENDS_DIR`)
 * and registers the full 130-task MiniWoB++ suite against it via the
 * public `probeUserBackend` + `registerMiniwobSuite` APIs.
 *
 * This file lives under `bench/miniwob/suites/`, which is not a
 * published package — so it is a repo/dev artifact, **not** in any
 * npm tarball. It runs under `npm run test:miniwob` (the only script
 * that runs `bench/miniwob/suites/`); `npm run test:ci` excludes
 * `bench/**` and would not exercise this file.
 *
 * Behavior:
 * - At load time, read the user-backends root via the
 *   `userBackendsDir()` helper (honors `PI_USER_BACKENDS_DIR` else
 *   defaults to `~/.pi/agent/pi-lean-portal/user-backends/`).
 * - If the root is absent or contains no `<name>-py/` directory with a
 *   `bridge.py`, the file is a **no-op** (the normal bare-CI state — no
 *   describe block is registered at all, so nothing is reported as
 *   failed or skipped).
 * - For each discovered `<name>-py/` with a `bridge.py`, probe it with
 *   `probeUserBackend(name)` and register a MiniWoB suite via
 *   `registerMiniwobSuite`. The `available` flag is the AND of the
 *   probe result and MiniWoB content availability — so a backend whose
 *   venv is missing, or a run without MiniWoB++ content, auto-skips at
 *   the describe level rather than failing.
 *
 * No stealth engine is **named** in this file. Discovery is purely
 * runtime — whatever the user has installed under `user-backends/` is
 * what runs. The shipped `PythonPluginAdapter` defaults
 * `capabilities.engine` (chromium) when no override is supplied, which
 * is wrong for a Firefox-based backend but is engine-agnostic for the
 * purposes of the auto-skip + task-classification logic (the
 * `supports*` set is what the suite actually consults). A user-owned
 * parity template that cares about the identity test's engine read
 * (e.g. see the contributed parity suite at
 * `packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts`)
 * should set `capabilities.engine` explicitly in its own factory.
 *
 * **Why `userBackendsDir()` is imported from `pi-lean-portal/__tests__/helpers/`**
 * (not from `pi-lean-portal/core/shared/paths.js`): the env override
 * (`PI_USER_BACKENDS_DIR`) that the portal constant does not offer is
 * handy for pointing this runner at a scratch tree. The helper lives in
 * `__tests__/helpers/` because it is only ever called from tests (and the
 * user-backends parity template).
 *
 * Run: `npm run test:miniwob` (this file is collected via `bench/miniwob/suites/`).
 * Point at a non-default tree: `PI_USER_BACKENDS_DIR=/path vitest run
 * bench/miniwob/suites/miniwob-user-backends.test.ts`.
 *
 * @module
 */

import { existsSync } from "node:fs";

import { PythonPluginAdapter } from "../../../packages/pi-lean-portal/backends/python-adapter.js";
import type { BrowserPlugin } from "../../../packages/pi-lean-portal/core/plugin-api.js";

import {
	probeUserBackend,
	discoverUserBackends,
	userBackendsDir,
} from "../../../packages/pi-lean-portal/__tests__/helpers/probe-user-backend.js";
import {
	registerMiniwobSuite,
	type MiniwobBackend,
} from "../solvers/register-suite.js";
import { createSharedMiniwobServer } from "./miniwob-suite-helper.js";

// ─── Content availability ────────────────────────────────────────
//
// A run is content-ready when either `MINIWOB_URL` is set (a running
// static server the caller started) or the on-disk MiniWoB++ clone is
// reachable via `MINIWOB_HTML_ROOT` (or its default).  The static
// server lifecycle is handled by `createSharedMiniwobServer()` below,
// mirroring `miniwob-suite-helper.ts`.

const HTML_ROOT =
	process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";
const HAS_EXTERNAL_URL = Boolean(process.env.MINIWOB_URL);
const HTML_ROOT_PRESENT = existsSync(HTML_ROOT);
const CONTENT_AVAILABLE = HAS_EXTERNAL_URL || HTML_ROOT_PRESENT;

// ─── MiniWoB static server (ephemeral fallback) ──────────────────
//
// One shared server across all discovered backends, mirroring the
// pattern in `miniwob-suite-helper.ts`. The factory registers a
// file-level `afterAll` for teardown.
const ensureBaseUrl: () => Promise<string> = createSharedMiniwobServer();

// ─── Backend discovery ───────────────────────────────────────────
//
// `discoverUserBackends` (imported from the shared probe helper) scans
// the user-backends root for `<name>-py/` dirs containing a `bridge.py`.
// `<name>-py` is the conventional suffix for Python bridge backends
// (mirrors the shipped `chromium-py` / `firefox-py` naming); we match
// it loosely so a future non-`-py` user backend doesn't get picked up
// by accident (it would need its own runner — this one assumes the
// PythonPluginAdapter JSON-RPC shape).

// ─── Registration ────────────────────────────────────────────────

const root = userBackendsDir();
const discovered = discoverUserBackends(root);

// The normal bare-CI state: no user-backends root, or an empty one.
// Register nothing — the file is a no-op so `npm run test:miniwob`
// reports zero tests from this file rather than a spurious skip.
if (discovered.length > 0) {
	for (const name of discovered) {
		const probe = probeUserBackend(name);
		const available = probe.available && CONTENT_AVAILABLE;

		const backend: MiniwobBackend = {
			name,
			available,
			initPlugin: async (): Promise<BrowserPlugin> => {
				// `probeUserBackend` guarantees `bridgePath` + `venvPython`
				// resolve to existing files when `available` is true. The
				// adapter constructor also validates the bridge script
				// exists (and throws a clear error if not) — so if a venv
				// was removed between probe and init, the failure surfaces
				// here with a useful message.
				const plugin = new PythonPluginAdapter(name, {
					bridgeScript: probe.bridgePath,
					pythonPath: probe.venvPython,
					// `engine` is intentionally omitted — let the adapter
					// default. The `supports*` set is what the suite
					// actually consults and is engine-independent. A
					// user-owned template that needs the identity test to
					// read a specific engine (e.g. Camoufox → "firefox")
					// should set `capabilities.engine` explicitly in its
					// own factory — see the shipped
					// `run-contributed-suites.test.ts`.
					capabilities: {
						supportsFullPageScreenshot: true,
						supportsJavaScriptEvaluate: true,
					},
				});
				await plugin.init({ launch: { humanize: false } });
				return plugin;
			},
		};

		// The MiniWoB static server lifecycle is owned by the caller per
		// the `registerMiniwobSuite` doc. `ensureBaseUrl` (defined above)
		// honors `MINIWOB_URL` when set (the contributed CI workflow sets
		// this); otherwise it lazily starts an ephemeral
		// `startMiniwobServer()` and tears it down in the file-level
		// `afterAll`. All discovered backends share the one server.
		registerMiniwobSuite(backend, ensureBaseUrl);
	}
}
