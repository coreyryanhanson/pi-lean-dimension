/**
 * MiniWoB++ suite — **generic user-backends runner** (repo/dev artifact).
 *
 * Discovers any user-managed Python stealth backend installed under
 * `~/.pi/agent/pi-lean-portal/user-backends/` (or `PI_USER_BACKENDS_DIR`)
 * and registers the full 130-task MiniWoB++ suite against it via the
 * public `probeUserBackend` + `registerMiniwobSuite` APIs.
 *
 * This file lives under `suites/`, which is **not** in
 * `packages/pi-lean-host/package.json` `files` — so it is a repo/dev
 * artifact, **not** in the npm tarball. It runs under
 * `npm run test:miniwob` (the only script that runs `suites/`);
 * `npm run test:ci` excludes `pi-lean-host/**` and would not exercise
 * this file.
 *
 * Behavior:
 * - At load time, read the user-backends root via the vendored
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
 * (e.g. the shipped `camoufox-py/miniwob-parity.test.ts` template)
 * should set `capabilities.engine` explicitly in its own factory.
 *
 * **Why `userBackendsDir()` is imported from `pi-lean-host`'s own
 * `src/`** (not from `pi-lean-portal/core/shared/paths.js`): this file
 * lives in `suites/`, which is not shipped, so a runtime import from
 * the portal's unexported internals would technically work in the
 * monorepo. We still use the vendored helper for two reasons: (1)
 * consistency with `probeUserBackend`, which also vendors the path, and
 * (2) the `PI_USER_BACKENDS_DIR` env override that the portal constant
 * does not offer — handy for pointing this runner at a scratch tree.
 *
 * Run: `npm run test:miniwob` (this file is included via `suites/`).
 * Point at a non-default tree: `PI_USER_BACKENDS_DIR=/path vitest run
 * packages/pi-lean-host/suites/miniwob-user-backends.test.ts`.
 *
 * @module
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { PythonPluginAdapter } from "../../pi-lean-portal/backends/python-adapter.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";

import {
	probeUserBackend,
	userBackendsDir,
} from "../src/probe-user-backend.js";
import {
	registerMiniwobSuite,
	type MiniwobBackend,
} from "../solvers/register-suite.js";

// ─── Content availability ────────────────────────────────────────
//
// Mirrors the gate in `miniwob-suite-helper.ts` so a discovered backend
// without MiniWoB++ content still auto-skips at the describe level
// instead of registering 130 failing tasks.

const HTML_ROOT =
	process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";
const HAS_EXTERNAL_URL = Boolean(process.env.MINIWOB_URL);
const HTML_ROOT_PRESENT = existsSync(HTML_ROOT);
const CONTENT_AVAILABLE = HAS_EXTERNAL_URL || HTML_ROOT_PRESENT;

// ─── Backend discovery ───────────────────────────────────────────
//
// Scan the user-backends root for `<name>-py/` directories that contain
// a `bridge.py`. `<name>-py` is the conventional suffix for Python
// bridge backends (mirrors the shipped `chromium-py` / `firefox-py`
// naming); we match it loosely so a future non-`-py` user backend
// doesn't get picked up by accident (it would need its own runner —
// this one assumes the PythonPluginAdapter JSON-RPC shape).

/**
 * Discover user-managed Python backends under the user-backends root.
 *
 * Returns the list of `<name>` such that `${root}/<name>/bridge.py`
 * exists and `${root}/<name>` is a directory whose basename ends with
 * `-py`. Sorted for deterministic registration order. Empty when the
 * root is missing or contains no matching directory (the normal
 * bare-CI state — the caller treats this as a no-op).
 */
function discoverUserBackends(root: string): string[] {
	if (!existsSync(root) || !statSync(root).isDirectory()) return [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith("-py")) continue;
		const dir = join(root, entry);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		if (existsSync(join(dir, "bridge.py"))) {
			found.push(entry);
		}
	}
	return found.sort();
}

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
					// `camoufox-py/miniwob-parity.test.ts` template.
					capabilities: {
						supportsFullPageScreenshot: true,
						supportsConsoleCapture: true,
						supportsJavaScriptEvaluate: true,
						supportsBotDetection: true,
						supportsDialogAutoDismissal: true,
						supportsAbortSignal: false,
					},
				});
				await plugin.init({});
				return plugin;
			},
		};

		// The MiniWoB static server lifecycle is owned by the caller per
		// the `registerMiniwobSuite` doc — but this runner does NOT start
		// its own server. The `getBaseUrl` getter honors `MINIWOB_URL` when
		// set (the Sprint 5 CI workflow sets this), and otherwise falls
		// back to `http://localhost:8080` (the default the Sprint 5
		// workflow's static server binds). The shipped per-backend suite
		// files use the shared server from `miniwob-suite-helper.ts`; this
		// runner is intentionally standalone and does not import that
		// helper, so it does not share its server. A dev running this file
		// by hand should either set `MINIWOB_URL` or start the static
		// server themselves (see
		// `packages/pi-lean-host/scripts/miniwob-server.ts`).
		registerMiniwobSuite(backend, async () => {
			return process.env.MINIWOB_URL ?? "http://localhost:8080";
		});
	}
}
