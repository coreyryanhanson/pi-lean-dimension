/**
 * Shared harness for `browser-inspect` smoke suites.
 *
 * Two suite files (`inspect-eval-smoke`, `inspect-csp-smoke`) share
 * ~80 lines of identical scaffolding per file: per-backend plugin
 * lifecycle (create+init, cleanup), availability gating (it.skip when
 * prerequisites are missing), and the describe/it structure.
 *
 * This harness extracts that scaffolding into a single
 * `registerBackendSuite` call per backend. Each smoke file keeps only
 * its backend list (with availability probes), the server-ensure
 * closure, and the test body function(s) — all scaffolding is here.
 *
 * @module
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import type { BrowserPlugin } from "../../../packages/pi-lean-portal/core/plugin-api.js";

// ─── Types ────────────────────────────────────────────────────────

/** One test to run inside a per-backend describe block. */
export interface SmokeTest {
	/** Display label shown in vitest output when the test runs. */
	label: string;
	/**
	 * The test body. Receives the initialized plugin and the base URL
	 * from the registered `ensureBaseUrl` function.
	 */
	run: (plugin: BrowserPlugin, baseUrl: string) => Promise<void>;
}

/**
 * Configuration for one backend in an inspect-smoke suite.
 *
 * The caller owns availability probing (backend-specific binary/venv
 * checks) and the plugin factory. The harness owns the lifecycle
 * (beforeAll init, afterAll cleanup) and gating (it.skip).
 */
export interface BackendConfig {
	/** Display name (e.g. "chromium", "camoufox-py"). */
	name: string;
	/** Whether this backend is available for testing. */
	available: boolean;
	/** Human-readable reason shown when not available. */
	missingReason: string;
	/**
	 * Factory to create a fresh plugin instance. Called inside
	 * `beforeAll` when `available` is true; `init` is called
	 * immediately after creation.
	 */
	createPlugin: () => BrowserPlugin | Promise<BrowserPlugin>;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Register one `describe` block for a backend, including:
 * - plugin creation + `init` in `beforeAll` (when available)
 * - `cleanupAll` in `afterAll`
 * - availability gating via `it.skip` when prerequisites are missing
 * - one or more `SmokeTest` it() blocks
 *
 * Example — a chromium backend with one test:
 *
 * ```ts
 * registerBackendSuite("inspect-eval-smoke", {
 *   name: "chromium",
 *   available: true,
 *   missingReason: "Chromium binary",
 *   createPlugin: () => new ChromiumPlugin(),
 * }, ensureBaseUrl, [
 *   { label: "navigate works", run: runTest },
 * ], 60_000);
 * ```
 *
 * @param suiteLabel  - Label prefix for the describe block (e.g.
 *   `"inspect-eval-smoke"` → `"inspect-eval-smoke — chromium"`).
 * @param backend     - Backend configuration (availability, factory).
 * @param ensureBaseUrl - Async function returning the test server
 *   base URL. Called inside each it() block before `run`.
 * @param tests       - One or more test definitions.
 * @param timeout     - Per-test timeout in ms (default 60s).
 */
export function registerBackendSuite(
	suiteLabel: string,
	backend: BackendConfig,
	ensureBaseUrl: () => Promise<string>,
	tests: SmokeTest[],
	timeout: number = 60_000,
): void {
	describe(`${suiteLabel} — ${backend.name}`, () => {
		let plugin: BrowserPlugin | undefined;
		const SHOULD_RUN = backend.available;

		beforeAll(async () => {
			if (!SHOULD_RUN) return;
			plugin = await backend.createPlugin();
			await plugin.init?.({});
		});

		afterAll(async () => {
			if (plugin) await plugin.cleanupAll().catch(() => {});
		});

		const itFn = SHOULD_RUN ? it : it.skip;
		for (const test of tests) {
			itFn(
				SHOULD_RUN
					? test.label
					: `prerequisites missing: ${backend.missingReason}`,
				async () => {
					const baseUrl = await ensureBaseUrl();
					await test.run(plugin!, baseUrl);
				},
				timeout,
			);
		}
	});
}
