/**
 * pi-lean-host — public API entry point.
 *
 * Exports the benchmarking API that any BrowserPlugin can use to run
 * against BrowserGym-backed task suites (MiniWoB++, and in future
 * phases WebArena / WorkArena).
 *
 * Phase 1: MiniWoB++ (chromium Mode A) via trivial solvers.
 *
 * @module
 */

export { runMiniwobTask } from "../adapter/browsergym-adapter.js";
export type {
	TrivialSolver,
	SolverCtx,
	RunMiniwobTaskOptions,
	MiniwobTaskResult,
} from "../adapter/browsergym-adapter.js";

export { benchPlugin } from "../adapter/bench.js";
export type { BenchMode, BenchOpts, BenchResult } from "../adapter/bench.js";

export { registerMiniwobSuite } from "../solvers/register-suite.js";
export type { MiniwobBackend } from "../solvers/register-suite.js";
export { SEED, TEST_TIMEOUT } from "../solvers/register-suite.js";

export {
	SOLVERS,
	CONFIDENT_TASKS,
	clickFirstButton,
	focusFirstTextbox,
	clickButtonNamedInGoal,
	clickLinkNamedInGoal,
	typeQuotedIntoTextbox,
	loginUser,
} from "../solvers/trivial-solvers.js";

export {
	parseRefs,
	withRole,
	firstWith,
	goalQuotedTexts,
} from "../solvers/parser.js";
export type { SnapEl } from "../solvers/parser.js";
