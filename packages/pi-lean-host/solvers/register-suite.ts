/**
 * MiniWoB++ suite harness — register one `describe` block for a
 * BrowserPlugin backend against the full 130-task MiniWoB++ suite.
 *
 * This is the public extension point for user-owned parity test files.
 * Any custom BrowserPlugin (stealth browser, WebKit, research prototype)
 * can register itself against the same MiniWoB++ task set by calling
 * `registerMiniwobSuite(backend, getBaseUrl)` from their own test file:
 *
 * ```ts
 * // my-miniwob-parity.test.ts (user-owned)
 * import { describe } from "vitest";
 * import { registerMiniwobSuite, type MiniwobBackend } from "pi-lean-host";
 * import { MyStealthPlugin } from "../src/index.ts";
 *
 * const backend: MiniwobBackend = {
 *   name: "my-stealth",
 *   available: Boolean(process.env.MY_STEALTH_AVAILABLE),
 *   initPlugin: async () => new MyStealthPlugin(),
 * };
 *
 * // The caller owns the server lifecycle — start in beforeAll, stop in afterAll.
 * registerMiniwobSuite(backend, async () => process.env.MINIWOB_URL ?? "http://…");
 * ```
 *
 * The suite handles task classification (element vs. non-element), solver
 * dispatch, and result assertions automatically. See the "Benchmarking your
 * own BrowserPlugin" section of `pi-lean-host/README.md` for details.
 *
 * Moved from `pi-lean-portal/__tests__/helpers/miniwob-suite.ts`.
 * Changes from the original:
 * - Removed the speculative `knownIssue` field (no shipped backend used it;
 *   re-add when a backend needs a per-task skip reason).
 * - Task classification uses a static non-element subdomain set instead of
 *   iterating a full ported task table.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { runMiniwobTask } from "../adapter/miniwob-adapter.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";
import { SOLVERS, CONFIDENT_TASKS } from "./trivial-solvers.js";
import { MINIWOB_SUBDOMAINS } from "../generated/subdomains.js";

// ─── Constants ───────────────────────────────────────────────────

/** Fixed seed for deterministic episode content. */
export const SEED = 12345;

/** Per-test timeout — navigate + setup + solve + done-poll can take ~20s. */
export const TEST_TIMEOUT = 60_000;

// ─── Task classification (static, no ported table) ───────────────

/**
 * Non-element tasks by subdomain. These tasks require capabilities the
 * `BrowserPlugin` interface does not expose (coordinate clicks, drag,
 * hover/slider, select/spinner). The suite skips them with an
 * appropriate reason.
 *
 * Classification is frozen from the ported table at
 * `miniwob-plusplus@7fd85d71`. Only 35 of 130 tasks are non-element.
 *
 * Terms refer to BrowserPlugin capabilities (not the task's own
 * rendering). A `coord` task draws on a `<canvas>` with no semantic
 * elements for `@e`-ref targeting; a `drag` task requires drag-and-drop
 * (no tool); `hover` requires slider/colorwheel continuous input (no
 * tool); `select` requires a spinner/select widget (no tool).
 */
const NON_ELEMENT_TASKS: Record<string, "coord" | "drag" | "hover" | "select"> =
	{
		// coord (18)
		"bisect-angle": "coord",
		"circle-center": "coord",
		"click-color": "coord",
		"click-pie": "coord",
		"click-pie-nodelay": "coord",
		"click-shades": "coord",
		"click-shape": "coord",
		"count-shape": "coord",
		"count-sides": "coord",
		"draw-circle": "coord",
		"draw-line": "coord",
		"find-midpoint": "coord",
		"grid-coordinate": "coord",
		"guess-number": "coord",
		"hot-cold": "coord",
		"identify-shape": "coord",
		"right-angle": "coord",
		"visual-addition": "coord",
		// drag (12)
		"copy-paste": "drag",
		"copy-paste-2": "drag",
		"drag-box": "drag",
		"drag-circle": "drag",
		"drag-cube": "drag",
		"drag-items": "drag",
		"drag-items-grid": "drag",
		"drag-shapes": "drag",
		"drag-shapes-2": "drag",
		"drag-single-shape": "drag",
		"drag-sort-numbers": "drag",
		"resize-textarea": "drag",
		// hover (4)
		"use-colorwheel": "hover",
		"use-colorwheel-2": "hover",
		"use-slider": "hover",
		"use-slider-2": "hover",
		// select (1)
		"use-spinner": "select",
	};

/** Resolve whether a subdomain is element-reachable. */
function taskRequires(
	subdomain: string,
): "element" | "coord" | "drag" | "hover" | "select" {
	return NON_ELEMENT_TASKS[subdomain] ?? "element";
}

// ─── Skip reasons ────────────────────────────────────────────────

export const SKIP_REASON_BY_REQ: Record<
	"coord" | "drag" | "hover" | "select",
	string
> = {
	coord: "no coordinate-click tool on BrowserPlugin (canvas-rendered task)",
	drag: "no drag action on BrowserPlugin",
	hover: "no slider/continuous-hover tool on BrowserPlugin",
	select: "no spinner/select widget tool on BrowserPlugin",
};

// ─── Backend type ────────────────────────────────────────────────

/**
 * A backend the MiniWoB suite can drive. `available` is the AND of
 * content availability + the backend's own browser prerequisites; the
 * describe block uses `describe` vs `describe.skip` accordingly.
 * `initPlugin` constructs and initializes a fresh plugin instance for
 * the suite's `beforeAll`.
 *
 * NOTE: the old `knownIssue` field was removed per the Batch C cleanup
 * (no shipped backend used it). If a user backend has a known parity
 * gap, wrap `registerMiniwobSuite` in a `describe.skip` or file-level
 * `describe` with `it.skip` in a custom loop.
 *
 * NOTE: the old `driverPythonPath` field was removed when the
 * cross-process MiniWoB driver was eliminated — the episode lifecycle
 * now runs via `plugin.evaluate()` on the plugin's own page. User-owned
 * parity tests no longer need to supply a driver Python.
 */
export interface MiniwobBackend {
	name: string;
	available: boolean;
	initPlugin: () => Promise<BrowserPlugin>;
}

// ─── Suite registration ──────────────────────────────────────────

/**
 * Registers one `describe` block driving all 130 MiniWoB tasks through
 * `backend`. The block `describe.skip`s when `backend.available` is
 * false. The solver registry, parsing helpers, and task loop are
 * shared across backends — only plugin lifecycle and the describe
 * label differ.
 *
 * The 130-task classification is a static set of non-element subdomains
 * (35 entries). Everything else is assumed element-reachable. Within
 * element tasks, only the 13 tasks with registered solvers run; the
 * remaining 82 element tasks skip with a "needs goal-aware solver" reason.
 *
 * @param backend     The backend to drive (shipped or user-installed).
 * @param getBaseUrl  Resolver returning the MiniWoB base URL (the
 *                    `miniwob/html/` root). Called once per backend in
 *                    its `beforeAll`. The caller owns the server
 *                    lifecycle — typically a file-level `beforeAll`/
 *                    `afterAll` pattern around `startMiniwobServer()`.
 */
export function registerMiniwobSuite(
	backend: MiniwobBackend,
	getBaseUrl: () => Promise<string>,
): void {
	const describeFn = backend.available ? describe : describe.skip;

	describeFn(`MiniWoB++ task suite — ${backend.name}`, () => {
		let plugin: BrowserPlugin;
		let baseUrl: string;

		beforeAll(async () => {
			baseUrl = await getBaseUrl();
			plugin = await backend.initPlugin();
		});

		afterAll(async () => {
			if (plugin) await plugin.cleanupAll().catch(() => {});
		});

		// Collect all known subdomains (generated from the MiniWoB++ html
		// directory). Classification uses the NON_ELEMENT_TASKS static set
		// (35 entries) — everything else is assumed element-reachable.
		const allSubdomains = collectAllSubdomains();

		// When MiniWoB++ content is absent (fresh clone without setup),
		// the globalSetup writes a placeholder stub with an empty array.
		// Surface a single clear skip reason instead of silent 0-test pass.
		if (allSubdomains.length === 0) {
			it.skip("MiniWoB++ content not available — run `npm run setup:miniwob` to download the task fixtures", () => {});
			return;
		}

		for (const subdomain of allSubdomains) {
			const requires = taskRequires(subdomain);

			// Non-element tasks: skip with the missing-tool reason.
			if (requires !== "element") {
				const reason = SKIP_REASON_BY_REQ[requires] ?? "unsupported capability";
				it.skip(`${subdomain} — ${reason}`, () => {});
				continue;
			}

			// Element tasks without a registered solver: skip as follow-up.
			const solver = SOLVERS.get(subdomain);
			if (!solver) {
				it.skip(`${subdomain} — needs goal-aware solver (Step 2 follow-up)`, () => {});
				continue;
			}

			const confident = CONFIDENT_TASKS.has(subdomain);
			const label = confident
				? `${subdomain} — reward > 0 (confident solver)`
				: `${subdomain} — pipeline ok (best-effort solver)`;

			it(
				label,
				async () => {
					const result = await runMiniwobTask({
						plugin,
						taskName: subdomain,
						seed: SEED,
						baseUrl,
						actor: "trivial",
						solver,
						episodeMaxTimeMs: 30_000,
					});

					// The pipeline must not fail at any setup step.
					expect(
						!result.setupFailed,
						result.setupFailed
							? `${subdomain} setup failed: ${result.error ?? "unknown"}`
							: `${subdomain} setup ok`,
					).toBe(true);

					// Confident solvers must earn reward.
					if (confident) {
						expect(
							result.rawReward,
							`${subdomain} expected rawReward > 0, got ${result.rawReward}` +
								` (reward=${result.reward}, reason=${result.reason || "<none>"})`,
						).toBeGreaterThan(0);
					}

					// Release the per-task browser session.
					await plugin.cleanup(`miniwob-${subdomain}-${SEED}`).catch(() => {});
				},
				TEST_TIMEOUT,
			);
		}
	});
}

// ─── Subdomain collection ────────────────────────────────────────

/**
 * Collect all known subdomains from the generated file derived from
 * the MiniWoB++ html directory at setup time.
 */
function collectAllSubdomains(): string[] {
	return [...MINIWOB_SUBDOMAINS].sort();
}
