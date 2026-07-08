/**
 * MiniWoB adapter — runs a MiniWoB++ task end-to-end against a
 * `BrowserPlugin` via `plugin.evaluate()`.
 *
 * The adapter navigates the plugin to a MiniWoB++ task page, runs the
 * episode lifecycle JS (setup, validate) directly on the plugin's own
 * page (no subprocess, no cross-process attach), dispatches to a
 * trivial solver, and returns the result.
 *
 * @module
 */

import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";

import {
	SETUP_JS,
	VALIDATE_JS,
	READY_PROBE_JS,
	UTTERANCE_JS,
	REMOVE_DISPLAY_JS,
} from "./miniwob-episode.js";

// ─── Types ────────────────────────────────────────────────────────

/** Context handed to a {@link TrivialSolver}. */
export interface SolverCtx {
	plugin: BrowserPlugin;
	taskId: string;
	/** Task utterance / goal. */
	goal: string;
	/** Post-setup accessibility snapshot with `@e` refs. */
	snapshot: string;
	/** Helper to take a fresh snapshot. */
	snapshotNow(): Promise<string>;
}

/**
 * A trivial, task-specific solver.
 */
export type TrivialSolver = (ctx: SolverCtx) => Promise<void>;

/** Options for {@link runMiniwobTask}. */
export interface RunMiniwobTaskOptions {
	plugin: BrowserPlugin;
	taskName: string;
	seed: number;
	/** Base URL of the running MiniWoB server (the `miniwob/html/` root). */
	baseUrl: string;
	/** Task-specific solver that drives the page via @e-ref actions. */
	solver?: TrivialSolver;
	/** Hard safety cap on solver/validate round-trips (default 20). Wall-clock `donePollTimeoutMs` is the primary bail; this is a defensive upper bound. */
	maxSteps?: number;
	/** Episode max time in ms (default 30_000). */
	episodeMaxTimeMs?: number;
	/** Per-call navigate timeout in ms (default 15_000). */
	navigateTimeoutMs?: number;
	/** Poll interval for `validate` after the solver returns (default 200ms). */
	donePollIntervalMs?: number;
	/** How long to poll `done` after the solver returns (default 10_000ms). */
	donePollTimeoutMs?: number;
}

/** Result of {@link runMiniwobTask}. */
export interface MiniwobTaskResult {
	goal: string;
	/** `1` if `rawReward > 0`, else `0`. */
	reward: number;
	/** Raw reward float from `validate()`. */
	rawReward: number;
	done: boolean;
	reason: string;
	/** Number of solver/validate round-trips executed (reported count, not a bail condition). */
	steps: number;
	/** True if the done-poll bailed before `done` flipped. */
	timedOut: boolean;
	/** Why the poll loop bailed: `"wall-clock"` (exceeded `donePollTimeoutMs`), `"max-steps"` (hit the `maxSteps` safety cap), or `null` if `done` flipped naturally. */
	bailReason: "wall-clock" | "max-steps" | null;
	/** True if a setup step (navigate / connect / setup) failed. */
	setupFailed: boolean;
	error?: string;
}

// ─── Defaults ─────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_EPISODE_MAX_MS = 30_000;
const DEFAULT_NAVIGATE_TIMEOUT_MS = 15_000;
const DEFAULT_DONE_POLL_INTERVAL_MS = 200;
const DEFAULT_DONE_POLL_TIMEOUT_MS = 10_000;

// ─── sleep helper ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ─── Episode lifecycle helpers ────────────────────────────────────

interface SetupResult {
	goal: string;
	setupFailed: boolean;
	error?: string;
}

/**
 * Run the MiniWoB++ episode setup lifecycle on the plugin's page.
 *
 * Steps:
 *   1. `REMOVE_DISPLAY_JS` – remove the BrowserGym human display overlay.
 *   2. `SETUP_JS(seed, episodeMaxTimeMs)` – seed RNG, set max time,
 *      call `core.startEpisodeReal()`.
 *   3. Poll `READY_PROBE_JS` until `WOB_TASK_READY` flips.
 *   4. Read the utterance via `UTTERANCE_JS`.
 */
async function setupMiniwobEpisode(
	plugin: BrowserPlugin,
	taskId: string,
	seed: number,
	episodeMaxTimeMs: number,
	donePollIntervalMs: number,
	donePollTimeoutMs: number,
): Promise<SetupResult> {
	// 1. Remove human display overlay.
	const rm = await plugin.evaluate(taskId, REMOVE_DISPLAY_JS);
	if (!rm.success) {
		return {
			goal: "",
			setupFailed: true,
			error: rm.error ?? "removeDisplay failed",
		};
	}

	// 2. Seed RNG, set max time, start episode.
	const setup = await plugin.evaluate(taskId, SETUP_JS(seed, episodeMaxTimeMs));
	if (!setup.success) {
		return {
			goal: "",
			setupFailed: true,
			error: setup.error ?? "setup JS failed",
		};
	}

	// 3. Poll WOB_TASK_READY.
	const pollStart = Date.now();
	while (true) {
		const probe = await plugin.evaluate(taskId, READY_PROBE_JS);
		if (!probe.success) {
			return {
				goal: "",
				setupFailed: true,
				error: `WOB_TASK_READY probe failed: ${probe.error}`,
			};
		}
		if (probe.result === true) break;
		if (Date.now() - pollStart > donePollTimeoutMs) {
			return {
				goal: "",
				setupFailed: true,
				error: "WOB_TASK_READY never flipped within timeout",
			};
		}
		await sleep(donePollIntervalMs);
	}

	// 4. Read utterance (goal).
	const goal = await plugin.evaluate(taskId, UTTERANCE_JS);
	if (!goal.success) {
		return {
			goal: "",
			setupFailed: true,
			error: goal.error ?? "utterance read failed",
		};
	}

	return { goal: String(goal.result ?? ""), setupFailed: false };
}

interface ValidateResult {
	reward: number;
	raw_reward: number;
	done: boolean;
	reason: string;
	error?: string;
}

/**
 * Read the MiniWoB++ reward/done globals via VALIDATE_JS.
 */
async function validateMiniwob(
	plugin: BrowserPlugin,
	taskId: string,
): Promise<ValidateResult> {
	const result = await plugin.evaluate(taskId, VALIDATE_JS);
	if (!result.success) {
		const err: ValidateResult = {
			reward: 0,
			raw_reward: 0,
			done: true,
			reason: "",
		};
		if (result.error) err.error = result.error;
		return err;
	}
	const r = result.result as {
		reward: number;
		raw_reward: number;
		done: boolean;
		reason: string;
	};
	return {
		reward: r.reward ?? 0,
		raw_reward: r.raw_reward ?? 0,
		done: r.done ?? true,
		reason: r.reason ?? "",
	};
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Run a single MiniWoB++ task end-to-end against `plugin`.
 *
 * Steps:
 *   1. Navigate the plugin to `${baseUrl}/miniwob/${taskName}.html`.
 *   2. Run the episode lifecycle via `plugin.evaluate()`: remove display
 *      overlay, seed RNG, start episode, wait for task ready, read goal.
 *   3. Take an `@e`-ref snapshot; hand it to the solver.
 *   4. Poll `VALIDATE_JS` until `done` or `donePollTimeoutMs`.
 *   5. Return the result bag.
 *
 * The caller owns the plugin lifecycle (`init` / `cleanupAll`); this
 * function calls `plugin.navigate` and (on success) `plugin.cleanup`
 * for the per-task session.
 */
export async function runMiniwobTask(
	opts: RunMiniwobTaskOptions,
): Promise<MiniwobTaskResult> {
	const {
		plugin,
		taskName,
		seed,
		baseUrl,
		solver,
		maxSteps = DEFAULT_MAX_STEPS,
		episodeMaxTimeMs = DEFAULT_EPISODE_MAX_MS,
		navigateTimeoutMs = DEFAULT_NAVIGATE_TIMEOUT_MS,
		donePollIntervalMs = DEFAULT_DONE_POLL_INTERVAL_MS,
		donePollTimeoutMs = DEFAULT_DONE_POLL_TIMEOUT_MS,
	} = opts;

	if (!solver) {
		return fail("runMiniwobTask requires a solver.");
	}

	const taskId = `miniwob-${taskName}-${seed}`;
	const taskUrl = `${baseUrl.replace(/\/$/, "")}/miniwob/${taskName}.html`;

	// 1. Navigate — launches the browser and loads the task page.
	const nav = await plugin.navigate(taskUrl, taskId, navigateTimeoutMs);
	if (!nav.success) {
		return fail(`navigate failed: ${nav.error ?? "unknown"}`);
	}

	// 2. Setup — run the episode lifecycle JS directly on the plugin's page.
	const setup = await setupMiniwobEpisode(
		plugin,
		taskId,
		seed,
		episodeMaxTimeMs,
		donePollIntervalMs,
		donePollTimeoutMs,
	);
	if (setup.setupFailed) {
		await plugin.cleanup(taskId).catch(() => {});
		return fail(setup.error ?? "episode setup failed");
	}
	const goal = setup.goal;

	try {
		// 3. Snapshot + solver.
		const snap = await plugin.snapshot(taskId);
		const snapshotText = snap.success ? snap.snapshot : "";
		const ctx: SolverCtx = {
			plugin,
			taskId,
			goal,
			snapshot: snapshotText,
			snapshotNow: async (): Promise<string> => {
				const s = await plugin.snapshot(taskId);
				return s.success ? s.snapshot : "";
			},
		};
		try {
			await solver(ctx);
		} catch (err) {
			return {
				goal,
				reward: 0,
				rawReward: 0,
				done: false,
				reason: "",
				steps: 0,
				timedOut: false,
				bailReason: null,
				setupFailed: false,
				error: `solver raised: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// 4. Poll validate until done. Wall-clock (`donePollTimeoutMs`) is the
		// primary bail; `maxSteps` is a hard safety cap. `steps` is a reported
		// count, not a bail condition — both bails set `timedOut=true` and
		// record a `bailReason` so callers can distinguish them.
		const pollStart = Date.now();
		let steps = 0;
		let last: ValidateResult = {
			reward: 0,
			raw_reward: 0,
			done: false,
			reason: "",
		};
		let timedOut = false;
		let bailReason: "wall-clock" | "max-steps" | null = null;
		while (true) {
			last = await validateMiniwob(plugin, taskId);
			// Propagate evaluate errors as a bail condition.
			if (last.error) {
				// Treat evaluate failure during validate as a hard error.
				return {
					goal,
					reward: 0,
					rawReward: 0,
					done: false,
					reason: "",
					steps,
					timedOut: false,
					bailReason: null,
					setupFailed: true,
					error: `validate evaluate failed: ${last.error}`,
				};
			}
			steps++;
			if (last.done) {
				bailReason = null;
				break;
			}
			if (Date.now() - pollStart > donePollTimeoutMs) {
				timedOut = true;
				bailReason = "wall-clock";
				break;
			}
			if (steps >= maxSteps) {
				timedOut = true;
				bailReason = "max-steps";
				break;
			}
			await sleep(donePollIntervalMs);
		}

		return {
			goal,
			reward: last.reward > 0 ? 1 : 0,
			rawReward: last.raw_reward,
			done: last.done,
			reason: last.reason,
			steps,
			timedOut,
			bailReason,
			setupFailed: false,
		};
	} catch (err) {
		return fail(
			`plugin call failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		await plugin.cleanup(taskId).catch(() => {});
	}
}

function fail(error: string): MiniwobTaskResult {
	return {
		goal: "",
		reward: 0,
		rawReward: 0,
		done: false,
		reason: "",
		steps: 0,
		timedOut: false,
		bailReason: null,
		setupFailed: true,
		error,
	};
}
