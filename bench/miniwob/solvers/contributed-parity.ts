/**
 * Shared MiniWoB++ parity helper for contributed (user-managed) backend
 * templates — a single source of truth for the opt-in gate, content
 * availability check, ephemeral static-server lifecycle, and
 * `registerMiniwobSuite` call.
 *
 * Each contributed `<name>-py/miniwob-parity.test.ts` becomes a ~10-line
 * caller that probes and delegates, instead of duplicating the 216-line
 * template body.
 *
 * The helper is generic — no backend names hardcoded.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll } from "vitest";

import {
	DEFAULT_CAPABILITIES,
	type BrowserPlugin,
	type PluginCapabilities,
} from "../../../packages/pi-lean-portal/core/plugin-api.js";
import type { ProbeUserBackendResult } from "../../../packages/pi-lean-portal/__tests__/helpers/probe-user-backend.js";
import type { TestServer } from "../../../packages/pi-lean-portal/__tests__/helpers/test-server.js";

import { registerMiniwobSuite, type MiniwobBackend } from "./register-suite.js";
import { startMiniwobServer } from "../scripts/miniwob-server.js";

// ─── Opt-in gate ──────────────────────────────────────────────────

/**
 * The single env var that gates all contributed opt-in surface.
 * Used by both the MiniWoB parity helper (Sprint 2) and the generic
 * contributed runner (Sprint 3) so both shared suites answer to the
 * same knob.
 */
const CONTRIB_RUN = process.env.CONTRIB_RUN === "1";

// ─── Options ──────────────────────────────────────────────────────

export interface ContributedParitySuiteOptions {
	/**
	 * Backend name (used for `registerMiniwobSuite` attribution
	 * throughout the 130-task suite output).
	 */
	name: string;

	/**
	 * Result of `probeUserBackend("<name>")`. The helper reads
	 * `.available`, `.bridgePath`, and `.venvPython` to build the
	 * adapter and decide whether to skip.
	 */
	probe: ProbeUserBackendResult;

	/**
	 * Optional capabilities partial override for the plugin adapter.
	 *
	 * Backends based on a known engine (e.g. a patched Firefox binary)
	 * should pass `{ engine: "firefox" }` so the contract suite's
	 * identity test reads the engine correctly. When omitted, the
	 * adapter uses defaults (engine-agnostic).
	 *
	 * Only the fields you need to override need to be supplied —
	 * the helper fills in safe defaults for the rest.
	 */
	capabilities?: Partial<PluginCapabilities>;

	/**
	 * The backend's full `config` block (the same object the runner
	 * forwards to the persistence suite's `init(cfg)`). When provided,
	 * `initPlugin` calls `plugin.init(config)` instead of `plugin.init({})`,
	 * so the parity suite exercises the configured `launch` path —
	 * stealth behavior (headless mode, OS target, humanize, geoip) is
	 * actually under test, not defaults.
	 */
	config?: Record<string, unknown>;

	/**
	 * When provided, skip the helper's own MiniWoB server lifecycle and
	 * use this thunk instead. Makes it possible for the discovery runner
	 * to share one MiniWoB server across all discovered backends instead
	 * of starting N servers (one per backend).
	 *
	 * Called once per suite registration to resolve the base URL.
	 */
	getBaseUrl?: () => Promise<string>;
}

// ─── Helper ───────────────────────────────────────────────────────

/**
 * Register a contributed backend against the full 130-task MiniWoB++
 * suite.
 *
 * Owns the `CONTRIB_RUN` opt-in gate, the content-availability check
 * (`MINIWOB_URL` or `MINIWOB_HTML_ROOT`), the ephemeral static-server
 * lifecycle (file-level `afterAll` teardown), and the
 * `registerMiniwobSuite` call.
 *
 * **No-op when `CONTRIB_RUN` is not `"1"`:** registers nothing — a
 * visible "no tests" rather than 130 silent skips. This protects the
 * default `npm test` / `npm run test:ci` sweep from firing real-browser
 * tasks on a dev machine that happens to have a stealth backend and
 * MiniWoB content installed.
 *
 * **Auto-skips at the describe level** when the probe reports the
 * backend is unavailable OR MiniWoB content is missing from both
 * `MINIWOB_URL` and the default `/tmp/miniwob-plusplus/miniwob/html`
 * (or `MINIWOB_HTML_ROOT`) path.
 *
 * The caller is responsible for the probe; the helper stays agnostic to
 * how the backend was discovered (shipped venv vs `probeUserBackend`).
 *
 * @param opts  Configuration — see {@link ContributedParitySuiteOptions}.
 */
export function registerContributedParitySuite(
	opts: ContributedParitySuiteOptions,
): void {
	if (!CONTRIB_RUN) return;

	const { name, probe, capabilities, config, getBaseUrl } = opts;

	// ─── Content availability ──────────────────────────────────
	//
	// Mirrors `miniwob-suite-helper.ts`: honor `MINIWOB_URL` when set
	// (pre-existing server, used verbatim), otherwise check the on-disk
	// clone at `MINIWOB_HTML_ROOT` (or the default
	// `/tmp/miniwob-plusplus/miniwob/html`). Missing content auto-skips
	// at the describe level.
	const HTML_ROOT =
		process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";
	const HAS_EXTERNAL_URL = Boolean(process.env.MINIWOB_URL);
	const HTML_ROOT_PRESENT = existsSync(resolve(HTML_ROOT));
	const CONTENT_AVAILABLE = HAS_EXTERNAL_URL || HTML_ROOT_PRESENT;

	const available = probe.available && CONTENT_AVAILABLE;

	// ─── MiniWoB static server (ephemeral fallback) ─────────────
	//
	// Lazily starts an ephemeral `startMiniwobServer()` on a free port
	// when no `MINIWOB_URL` is set and no `getBaseUrl` thunk was provided.
	// Torn down in the file-level `afterAll` below.
	// Mirrors `createSharedMiniwobServer()` from `miniwob-suite-helper.ts`.
	let sharedServer: TestServer | null = null;

	async function ensureBaseUrl(): Promise<string> {
		// When the caller provides a thunk (e.g. the discovery runner sharing
		// one server across all backends), use that instead of our own server.
		if (getBaseUrl) return getBaseUrl();

		if (process.env.MINIWOB_URL) return process.env.MINIWOB_URL;
		if (!sharedServer) {
			sharedServer = await startMiniwobServer(HTML_ROOT);
		}
		return sharedServer.url;
	}

	// Only register afterAll for our own server — when the caller provides
	// a getBaseUrl thunk, the caller owns the lifecycle.
	const ownsServer = !getBaseUrl && !process.env.MINIWOB_URL;
	if (ownsServer) {
		afterAll(async () => {
			if (sharedServer) {
				await sharedServer.stop().catch(() => {});
				sharedServer = null;
			}
		});
	}

	// ─── Suite registration ───────────────────────────────────
	//
	// Build the MiniwobBackend that `registerMiniwobSuite` expects.
	// The adapter is constructed lazily inside `initPlugin` so the
	// import is not eagerly triggered at module load.
	const backend: MiniwobBackend = {
		name,
		available,
		initPlugin: async (): Promise<BrowserPlugin> => {
			const { PythonPluginAdapter } = await import(
				"../../../packages/pi-lean-portal/backends/python-adapter.js"
			);
			const plugin = new PythonPluginAdapter(name, {
				bridgeScript: probe.bridgePath,
				pythonPath: probe.venvPython,
				capabilities: {
					...DEFAULT_CAPABILITIES,
					...capabilities,
				},
			});
			// Forward config (the launch object) to init, so the parity
			// suite exercises the configured launch path, not defaults.
			await plugin.init(config ?? {});
			return plugin;
		},
	};

	registerMiniwobSuite(backend, ensureBaseUrl);
}
