/**
 * Generic contributed-backend runner (tracked) — discovers every
 * user-managed Python backend installed under `user-backends/` and runs
 * the **shared contract suite + shared persistence suite + shared
 * MiniWoB parity suite + quirks introspection suite** against each.
 *
 * The quirks suite reads the bridge's declared quirks flags via the
 * ``browser.describeQuirks`` RPC and runs parametrized ``it`` blocks
 * that only activate when the corresponding quirk is declared.
 * Backends with behavioural tests beyond the quirk flags (e.g.
 * invisible-py's lifecycle/deadlock tests) keep a hand-authored
 * file under ``__tests__/contributed/<name>-py/``.
 *
 * Gated by `CONTRIB_RUN === "1"` (the same env var the contributed MiniWoB parity helper established).  No-op in bare CI (no
 * user-backends installed → discovered list empty → registers nothing)
 * and also no-op when `CONTRIB_RUN` is unset, so `npm run test:ci`
 * stays green with the file present even on a machine that has
 * user-backends installed.
 *
 * No stealth engine is **named** in this file.  Discovery is purely
 * runtime — whatever the user has installed under `user-backends/` is
 * what runs.  The shared suites own parametrized `it` titles so a helper
 * regression is attributable per-backend.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
	DEFAULT_CAPABILITIES,
	type PluginCapabilities,
} from "../core/plugin-api.js";
import {
	PythonPluginAdapter,
	type QuirksDescriptor,
} from "../backends/python-adapter.js";
import { loadPluginConfigFromFile } from "./helpers/load-plugin-config-from-file.js";
import type { PluginConfigLoadResult } from "../core/plugin-config.js";
import { runContractTests } from "./helpers/plugin-contract.js";
import { runPersistenceSuite } from "./helpers/persistence-suite.js";
import {
	probeUserBackend,
	discoverUserBackends,
	userBackendsDir,
} from "./helpers/probe-user-backend.js";
import {
	startTestServer,
	COOKIE_PERSISTENCE_HTML,
} from "./helpers/test-server.js";
import { registerContributedParitySuite } from "../../../bench/miniwob/solvers/contributed-parity.js";
import { startMiniwobServer } from "../../../bench/miniwob/scripts/miniwob-server.js";

// ─── Opt-in gate ─────────────────────────────────────────────────────

const CONTRIB_RUN = process.env.CONTRIB_RUN === "1";

/** Path to the test-local settings file. Override via CONTRIB_SETTINGS env. */
const SETTINGS_PATH =
	process.env.CONTRIB_SETTINGS ??
	join(__dirname, "contributed", "settings.json");

// ─── Backend discovery ──────────────────────────────────────────────
// `discoverUserBackends` (imported from the shared probe helper) scans
// the user-backends root for `<name>-py/` dirs containing a `bridge.py`.

// ─── Capabilities merge helper ──────────────────────────────────────

/**
 * Merge a user-authored capabilities override onto DEFAULT_CAPABILITIES.
 *
 * User entries in the test-local settings file may omit fields;
 * PluginCapabilities is non-optional. This helper fills in the gaps.
 * When the override is absent or malformed (not a plain object), returns
 * the full synthetic set — the same fallback as the pre-enhancement
 * runner.
 */
function mergeCapabilities(override: unknown): PluginCapabilities {
	if (!override || typeof override !== "object" || Array.isArray(override)) {
		return DEFAULT_CAPABILITIES;
	}
	return {
		...DEFAULT_CAPABILITIES,
		...(override as Partial<PluginCapabilities>),
	};
}

// ─── Entry ───────────────────────────────────────────────────────────
//
// Gated by CONTRIB_RUN.  No-op when the env var is unset OR when
// user-backends/ is absent/empty.

if (CONTRIB_RUN) {
	const root = userBackendsDir();
	const discovered = discoverUserBackends(root);

	if (discovered.length > 0) {
		// ── Test-local config ──────────────────────────────────────
		//
		// Load the settings file once (index by name for lookup inside the
		// per-backend loop). When absent, all discovered backends get the
		// synthetic fallback (pre-enhancement behaviour).
		let pluginCfg: PluginConfigLoadResult | null = null;
		if (existsSync(SETTINGS_PATH)) {
			pluginCfg = loadPluginConfigFromFile(SETTINGS_PATH);
		}

		// ── Shared servers ────────────────────────────────────────
		//
		// One persistence HTTP server (consent-dialog page) and one MiniWoB
		// static server per file, shared across ALL discovered backends.
		// Torn down at file level via afterAll.
		let serverUrl: string;
		let stopServer: () => Promise<void>;
		let miniwobBaseUrl: string;
		let stopMiniwob: () => Promise<void>;

		beforeAll(async () => {
			// Persistence suite HTTP server
			const server = await startTestServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");
				if (url.pathname === "/") {
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
					});
					res.end(COOKIE_PERSISTENCE_HTML);
				} else if (url.pathname === "/simple") {
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
					});
					res.end(
						"<!DOCTYPE html><html><head><title>Simple Page</title></head><body><h1>Simple</h1></body></html>",
					);
				} else if (url.pathname === "/scroll") {
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
					});
					res.end(`<!DOCTYPE html>
<html><head><title>Scroll Test</title></head>
<body>
<h1>Scroll Test</h1>
${Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i + 1}: content to make the page scrollable.</p>`).join("\n")}
<p id="bottom-marker">You reached the bottom!</p>
</body></html>`);
				} else {
					res.writeHead(404, {
						"Content-Type": "text/html; charset=utf-8",
					});
					res.end("404");
				}
			});
			serverUrl = server.url;
			stopServer = server.stop;

			// MiniWoB static server (shared across all parity registrations).
			// Check content availability before starting — mirrors the check
			// in the parity helper so we never fail beforeAll (which would
			// block contract + persistence tests). When content is absent,
			// the parity helper independently detects this via its own
			// CONTENT_AVAILABLE check and describe.skips internally.
			const miniwobHtmlRoot =
				process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";
			const miniwobContentAvailable =
				Boolean(process.env.MINIWOB_URL) || existsSync(miniwobHtmlRoot);
			if (miniwobContentAvailable) {
				const miniwobServer = await startMiniwobServer();
				miniwobBaseUrl = miniwobServer.url;
				stopMiniwob = miniwobServer.stop;
			} else {
				miniwobBaseUrl = "";
				stopMiniwob = async () => {};
			}
		});

		afterAll(async () => {
			await stopServer();
			await stopMiniwob();
		});

		for (const name of discovered) {
			const probe = probeUserBackend(name);

			// Look up the backend in the test-local config.  When the file is
			// absent or has no matching entry, cfg stays {} (synthetic fallback).
			const entry = pluginCfg?.plugins.find((p) => p.name === name);
			const cfg = entry?.config ?? {};
			// Camoufox ``152.0.4-beta.27+`` humanized-click motion makes
			// ``locator.click(timeout=5s)`` flake/timeout and eats MiniWoB
			// task budgets (~1.5s/click vs 10s task timers).  The contributed
			// suite exercises the backend *contract*, not human-emulation
			// stealth, so force ``launch.humanize=false`` for every discovered
			// backend.  Real users keep the humanize=True default for
			// evasion-sensitive browsing; see
			// ``docs/decisions/camoufox-ci-drift.md`` Step 2.
			const launchOverride = {
				...((cfg.launch as Record<string, unknown> | undefined) ?? {}),
				humanize: false,
			};
			const testCfg: Record<string, unknown> = {
				...cfg,
				launch: launchOverride,
			};
			if (!entry) {
				console.warn(
					`[contributed-runner] ${name}: no settings entry — synthetic config`,
				);
			}

			// Adapter factory — picks up configured pythonPath, capabilities,
			// and transportTimeoutMs from the test-local settings when available.
			// With exactOptionalPropertyTypes, undefined values must be omitted
			// from the config object rather than set explicitly.
			const buildAdapter = (idSuffix: string): PythonPluginAdapter =>
				new PythonPluginAdapter(`${name}-${idSuffix}`, {
					bridgeScript: probe.bridgePath,
					pythonPath:
						typeof testCfg.pythonPath === "string"
							? testCfg.pythonPath
							: probe.venvPython,
					capabilities: mergeCapabilities(testCfg.capabilities),
					...(typeof testCfg.transportTimeoutMs === "number"
						? { transportTimeoutMs: testCfg.transportTimeoutMs }
						: {}),
				});

			const describeFn = probe.available ? describe : describe.skip;

			describeFn(`contributed: ${name}`, () => {
				// 1. Shared contract suite — built with the configured adapter
				//    so the pipeline exercises the backend's real capabilities,
				//    not a synthetic stand-in.
				runContractTests(name, () => buildAdapter("contract"), {
					realBrowser: true,
					navigateTimeout: 30_000,
					navigationSettle: true,
					testTimeout: 60_000,
				});

				// 2. Shared persistence suite — forwards cfg (the launch
				//    object) via init(cfg) so the bridge receives the configured
				//    launch options, not the default {}.
				runPersistenceSuite(describeFn, {
					name,
					getServerUrl: () => serverUrl,
					createPlugin: async () => {
						const p = buildAdapter("persist");
						await p.init(testCfg);
						return p;
					},
				});

				// 3. MiniWoB parity suite (folded into the runner) — shares
				//    the file-level MiniWoB server via getBaseUrl and forwards
				//    cfg (the launch object) through config so the 130-task
				//    behavioral suite exercises the configured launch path.
				//
				// With exactOptionalPropertyTypes, omit the capabilities key
				// entirely when undefined rather than passing undefined.
				registerContributedParitySuite({
					name,
					probe,
					...(testCfg.capabilities !== undefined
						? {
								capabilities:
									testCfg.capabilities as Partial<PluginCapabilities>,
							}
						: {}),
					config: testCfg,
					getBaseUrl: async () => miniwobBaseUrl,
				});

				// 4. Quirks introspection suite — reads the bridge's declared quirks
				//    flags via the browser.describeQuirks RPC and runs behavioural
				//    integration tests for quirks that affect the bridge's runtime
				//    behaviour (eval_prefix, scroll_via_wheel).  Flag-only assertions
				//    (fingerprint_managed_context, skip_default_viewport, etc.) are
				//    owned by the Python bridge unit tests
				//    (test_playwright_base_quirks.py).  The beforeAll here proves the
				//    RPC works; the behavioural it() blocks exercise the actual quirk.
				let quirks_: QuirksDescriptor;

				describe("quirks", () => {
					beforeAll(async () => {
						const p = buildAdapter("quirks");
						await p.init(testCfg);
						quirks_ = await p.describeQuirks();
						await p.cleanupAll().catch(() => {});
					});

					it("eval_prefix: evaluate('1 + 1') === 2", async () => {
						if (!quirks_.eval_prefix) return;
						const p = buildAdapter("quirks-eval");
						await p.init(testCfg);
						const nav = await p.navigate(
							`${serverUrl}/simple`,
							"quirks-eval",
							30_000,
						);
						expect(nav.success).toBe(true);
						const r = await p.evaluate("quirks-eval", "1 + 1");
						expect(r.success).toBe(true);
						expect(r.result).toBe(2);
						await p.cleanupAll().catch(() => {});
					});

					it("scroll_via_wheel: scroll moves the page", async () => {
						if (!quirks_.scroll_via_wheel) return;
						const p = buildAdapter("quirks-scroll");
						await p.init(testCfg);
						const nav = await p.navigate(
							`${serverUrl}/scroll`,
							"quirks-scroll",
							30_000,
						);
						expect(nav.success).toBe(true);
						const before = await p.evaluate("quirks-scroll", "window.scrollY");
						expect(before.success).toBe(true);
						expect(before.result).toBe(0);
						const scrollResult = await p.scroll("quirks-scroll", "down");
						expect(scrollResult.success).toBe(true);
						const after = await p.evaluate("quirks-scroll", "window.scrollY");
						expect(after.success).toBe(true);
						expect(typeof after.result).toBe("number");
						expect((after.result as number) > 0).toBe(true);
						await p.cleanupAll().catch(() => {});
					});
				});
			});
		}
	}
}
