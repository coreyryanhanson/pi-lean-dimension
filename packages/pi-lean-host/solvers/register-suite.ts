/**
 * MiniWoB++ suite harness — register one `describe` block for a
 * BrowserPlugin backend against the full 125-task MiniWoB++ suite.
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
 * Moved from `pi-lean-portal/__tests__/helpers/miniwob-suite.ts` as part
 * of the BrowserGym migration (Batch C, §1.5). Changes from the original:
 * - Removed the speculative `knownIssue` field (no shipped backend used it;
 *   re-add when a backend needs a per-task skip reason).
 * - Task classification uses a static non-element subdomain set instead of
 *   iterating a full ported task table.
 * - Uses the BrowserGym-backed `runMiniwobTask` from `pi-lean-host/adapter/`
 *   instead of the old portal-injection-based task driver.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { runMiniwobTask } from "../adapter/browsergym-adapter.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";
import { SOLVERS, CONFIDENT_TASKS } from "./trivial-solvers.js";

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
 * `miniwob-plusplus@7fd85d71`. Only 35 of 125 tasks are non-element.
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
 */
export interface MiniwobBackend {
	name: string;
	available: boolean;
	initPlugin: () => Promise<BrowserPlugin>;
}

// ─── Suite registration ──────────────────────────────────────────

/**
 * Registers one `describe` block driving all 125 MiniWoB tasks through
 * `backend`. The block `describe.skip`s when `backend.available` is
 * false. The solver registry, parsing helpers, and task loop are
 * shared across backends — only plugin lifecycle and the describe
 * label differ.
 *
 * The 125-task classification is a static set of non-element subdomains
 * (35 entries). Everything else is assumed element-reachable. Within
 * element tasks, only the 13 tasks with registered solvers run; the
 * remaining 77 element tasks skip with a "needs goal-aware solver" reason.
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

		// Build the task list: all known subdomains from the solver map
		// plus all non-element subdomains, plus 90 - 13 - 35 = learn-as-we-go.
		// We use the NON_ELEMENT_TASKS + SOLVERS + implicit-element approach:
		// iterate the known universe.
		const allSubdomains = collectAllSubdomains();

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
 * Collect all 125 subdomains: the union of solver keys, non-element
 * keys, and a hardcoded remainder of element-but-unsolved subdomains.
 *
 * This avoids porting the 125-entry table while keeping the suite
 * structure stable (every subdomain that the old table produced is
 * still present with the same classification).
 */
function collectAllSubdomains(): string[] {
	const solverKeys = new Set(SOLVERS.keys());
	const nonElementKeys = new Set(Object.keys(NON_ELEMENT_TASKS));

	// Manually maintained list of the 77 element subdomains that have no
	// trivial solver. This list is frozen from
	// `miniwob-plusplus@7fd85d71` and stays stable as long as the pin
	// doesn't change. Re-pin deliberately and sync this list.
	const unsolvedElement: readonly string[] = [
		"ascending-numbers",
		"book-flight",
		"book-flight-nodelay",
		"buy-ticket",
		"choose-date",
		"choose-date-easy",
		"choose-date-medium",
		"choose-date-nodelay",
		"choose-list",
		"click-button-sequence",
		"click-checkboxes",
		"click-checkboxes-large",
		"click-checkboxes-soft",
		"click-checkboxes-transfer",
		"click-collapsible",
		"click-collapsible-2",
		"click-collapsible-2-nodelay",
		"click-collapsible-nodelay",
		"click-menu",
		"click-menu-2",
		"click-option",
		"click-scroll-list",
		"click-tab",
		"click-tab-2",
		"click-tab-2-easy",
		"click-tab-2-hard",
		"click-tab-2-medium",
		"click-test-transfer",
		"click-widget",
		"daily-calendar",
		"email-inbox",
		"email-inbox-delete",
		"email-inbox-forward",
		"email-inbox-forward-nl",
		"email-inbox-forward-nl-turk",
		"email-inbox-important",
		"email-inbox-nl-turk",
		"email-inbox-noscroll",
		"email-inbox-reply",
		"email-inbox-star-reply",
		"enter-date",
		"enter-text-2",
		"enter-time",
		"find-greatest",
		"find-word",
		"form-sequence",
		"form-sequence-2",
		"form-sequence-3",
		"generate-number",
		"highlight-text",
		"highlight-text-2",
		"multi-layouts",
		"multi-orderings",
		"navigate-tree",
		"number-checkboxes",
		"odd-or-even",
		"order-food",
		"phone-book",
		"read-table",
		"read-table-2",
		"scroll-text",
		"scroll-text-2",
		"search-engine",
		"sign-agreement",
		"simple-algebra",
		"simple-arithmetic",
		"social-media",
		"social-media-all",
		"social-media-some",
		"stock-market",
		"terminal",
		"text-editor",
		"text-transform",
		"tic-tac-toe",
		"unicode-test",
		"use-autocomplete",
		"use-autocomplete-nodelay",
	];

	// Build the union: solver tasks + non-element tasks + unsolved element.
	// The three sets are disjoint (solved tasks are excluded from the
	// unsolved list), so the union count is 13 + 35 + 77 = 125.
	const all = new Set<string>();

	for (const key of solverKeys) all.add(key);
	for (const key of nonElementKeys) all.add(key);
	for (const key of unsolvedElement) all.add(key);

	return [...all].sort();
}
