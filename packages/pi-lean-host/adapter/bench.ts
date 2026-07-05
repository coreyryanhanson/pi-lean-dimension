/**
 * High-level `benchPlugin()` entry point — benchmark any `BrowserPlugin`
 * against a MiniWoB++ (and future BrowserGym) task.
 *
 * Two browser-ownership modes:
 *
 * **Mode A — plugin-owns-browser** (default). The plugin launches its
 * own browser and exposes `getCdpEndpoint()`. The BrowserGym bridge
 * attaches via CDP. Tests the plugin's real launch path.
 *
 * **Mode B — host-owns-browser** (for plugins that implement
 * `connectOverCDP`). `pi-lean-host` launches a reference Chromium with
 * `--remote-debugging-port`, BrowserGym attaches via CDP, and the
 * plugin connects to the same endpoint. Only tests snapshot/click/type
 * methods, not the plugin's launch path.
 *
 * Mode negotiation (in `benchPlugin`):
 *   1. If `opts.mode` is explicitly set, the caller chose.
 *   2. If `plugin.getCdpEndpoint` is a function → Mode A.
 *   3. If `plugin.connectOverCDP` is a function → Mode B.
 *   4. Otherwise throws — caller must pick or implement one of the
 *      two optional methods.
 *
 * ── Attribution ───────────────────────────────────────────────────
 *
 * MiniWoB++ © Farama-Foundation (Apache-2.0); BrowserGym © ServiceNow
 * (Apache-2.0). This file only wires the adapter; the actual task and
 * reward protocol live in the BrowserGym Python package.
 *
 * @module
 */

import { chromium as playwrightChromium } from "playwright";

import {
	runMiniwobTask,
	type MiniwobTaskResult,
} from "./browsergym-adapter.js";
import type { TrivialSolver } from "./browsergym-adapter.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";
import { resolveCdpEndpoint } from "../../pi-lean-portal/core/shared/cdp-endpoint.js";

// ─── Types ─────────────────────────────────────────────────────────

export type BenchMode = "plugin-owns-browser" | "host-owns-browser";

export interface BenchOpts {
	/** Task subdomain (e.g. `"click-test"`). */
	taskName: string;
	/** Browser ownership mode. Auto-detected when omitted. */
	mode?: BenchMode;
	/** The solver function for this task. */
	solver: TrivialSolver;
	/** Seed for deterministic MiniWoB++ episodes. Defaults to 12345. */
	seed?: number;
	/** MiniWoB++ server base URL (the `miniwob/html/` root). */
	baseUrl: string;
	/** Max solver/validate round-trips. Defaults to 20. */
	maxSteps?: number;
	/** Per-episode max time in ms. Defaults to 30_000. */
	episodeMaxTimeMs?: number;
	/**
	 * Fixed CDP port for Mode B. When set, skips the `ss -tlnp` scan
	 * and uses this port directly. Useful for non-Linux or parallel CI.
	 */
	cdpPort?: number;
}

export type BenchResult = MiniwobTaskResult;

// ─── benchPlugin ───────────────────────────────────────────────────

/**
 * Benchmark `plugin` against a single MiniWoB++ task.
 *
 * Auto-detects the browser-ownership mode unless `opts.mode` is set:
 * - `plugin.getCdpEndpoint` exists (and is a function) → Mode A
 * - `plugin.connectOverCDP` exists (and is a function) → Mode B
 *
 * @returns The task result bag.
 * @throws if no mode is configurable (neither `getCdpEndpoint` nor
 *   `connectOverCDP` is implemented).
 */
export async function benchPlugin(
	plugin: BrowserPlugin,
	opts: BenchOpts,
): Promise<BenchResult> {
	const {
		taskName,
		mode,
		solver,
		seed = 12345,
		baseUrl,
		maxSteps,
		episodeMaxTimeMs,
		cdpPort,
	} = opts;

	// Resolve mode.
	const mode_ = mode ?? resolveMode(plugin);

	if (mode_ === "plugin-owns-browser") {
		// Mode A: plugin has already launched (or will on first navigate).
		// The plugin exposes its own CDP endpoint via getCdpEndpoint.
		return runMiniwobTask({
			plugin,
			taskName,
			seed,
			baseUrl,
			actor: "trivial",
			solver,
			maxSteps: maxSteps ?? 20,
			episodeMaxTimeMs: episodeMaxTimeMs ?? 30_000,
		});
	}

	// Mode B: host launches a reference Chromium, then connects the plugin.
	const { endpoint, close: closeBrowser } =
		await launchReferenceBrowser(cdpPort);

	try {
		const connect = plugin.connectOverCDP;
		if (typeof connect !== "function") {
			throw new Error(
				`Mode B requires plugin.connectOverCDP to be a function ` +
					`(typeof=${typeof connect}). ${plugin.name ?? "plugin"} does not ` +
					`implement it.`,
			);
		}
		await connect.call(plugin, endpoint);

		return await runMiniwobTask({
			plugin,
			taskName,
			seed,
			baseUrl,
			actor: "trivial",
			solver,
			maxSteps: maxSteps ?? 20,
			episodeMaxTimeMs: episodeMaxTimeMs ?? 30_000,
			// Pass the CDP endpoint directly so the bridge doesn't need
			// plugin.getCdpEndpoint() — the Mode B host owns the browser.
			_cdpEndpointOverride: endpoint,
		});
	} finally {
		await closeBrowser().catch(() => {});
	}
}

// ─── Mode resolution ───────────────────────────────────────────────

function resolveMode(plugin: BrowserPlugin): BenchMode {
	if (typeof plugin.getCdpEndpoint === "function") return "plugin-owns-browser";
	if (typeof plugin.connectOverCDP === "function") return "host-owns-browser";
	throw new Error(
		`Cannot determine browser-ownership mode for plugin ` +
			`${plugin.name ?? "?"}. The plugin must implement at least one of ` +
			`getCdpEndpoint() (Mode A) or connectOverCDP() (Mode B).`,
	);
}

// ─── Reference Chromium launcher (Mode B) ──────────────────────

/**
 * Launch a reference Chromium for Mode B (host-owns-browser).
 * Returns the CDP endpoint + a close handle so the caller can release
 * the browser after the task completes.
 *
 * Uses a fixed port from `cdpPort` if provided, otherwise lets the OS
 * assign one via port 0 and discovers it via `resolveCdpEndpoint`.
 */
async function launchReferenceBrowser(
	cdpPort?: number,
): Promise<{ endpoint: string; close: () => Promise<void> }> {
	// When a fixed port is provided, set CDP_PORT env so resolveCdpEndpoint picks it up.
	if (cdpPort !== undefined) {
		process.env.CDP_PORT = String(cdpPort);
	}

	const browser = await playwrightChromium.launch({
		args: [
			"--remote-debugging-port=0",
			"--remote-debugging-address=127.0.0.1",
			"--headless",
			"--no-sandbox",
			"--disable-gpu",
		],
	});

	const endpoint = await resolveCdpEndpoint({
		processNames: ["chrome-headless", "chromium"],
	});

	if (!endpoint) {
		await browser.close().catch(() => {});
		throw new Error(
			"Failed to discover CDP endpoint for Mode B reference browser. " +
				"Set CDP_PORT env var or cdpPort option for a fixed port.",
		);
	}

	const close = async (): Promise<void> => {
		await browser.close().catch(() => {});
	};

	return { endpoint, close };
}
