/**
 * MiniWoB++ Test Helper — Step 1 of `miniwob-integration-plan.md`.
 *
 * Ports the MiniWoB++ task model from BrowserGym into our TypeScript
 * + vitest + Playwright-plugin test suite, WITHOUT taking a runtime
 * dependency on `browsergym` / `browsergym-miniwob` (see the plan's
 * "Architecture decision: port the task model, not the framework").
 *
 * What this file provides:
 *   1. `MINIWOB_TASKS` — the 125-task table ported from
 *      `browsergym/miniwob/all.py` (the plan's "126 tasks" headline
 *      overcounts by one — `all.py` @ `7fd85d71` defines 125 task
 *      classes; see the plan's own gotcha on the overstatement),
 *      classified by the plugin capability each task requires
 *      (`element` | `coord` | `drag` | `hover` | `select`). Only
 *      `element`-tagged tasks are reachable through our `@e`-ref
 *      accessibility snapshot; the rest are skipped by the Step 2
 *      suite with `it.skip` + a comment naming the missing tool.
 *   2. `buildMiniwobSetupJs()` + `miniwobRewardInfo()` + `miniwobGetGoal()`
 *      — near-verbatim ports of `base.py`'s `setup()` JS injection and
 *      `validate()` reward-reading protocol.
 *   3. `startMiniwobServer()` — wraps `startTestServer` to serve the
 *      cloned `miniwob-plusplus/miniwob/html/` directory over HTTP.
 *   4. `runMiniwobTask(plugin, subdomain, seed, solver, options?)` —
 *      navigates, injects the setup JS, polls `WOB_DONE_GLOBAL`, and
 *      returns the reward/done/info bag.
 *
 * ── Attribution ─────────────────────────────────────────────────
 *
 * MiniWoB++ is © Farama-Foundation, licensed Apache-2.0.
 * BrowserGym is © ServiceNow / BrowserGym, licensed Apache-2.0.
 *
 * The JS injection and reward protocol below are ported (near-)verbatim
 * from `browsergym/miniwob/base.py` at the frozen commit pin
 * `miniwob-plusplus@7fd85d71a4b60325c6585396ec4f48377d049838`.
 * Tests are not shipped in the published package, but both projects
 * are credited here and in `automate-testing.md`.
 *
 * ── Prerequisites ───────────────────────────────────────────────
 *
 * The caller is responsible for cloning miniwob-plusplus at the pinned
 * commit and pointing `startMiniwobServer()` at the resulting
 * `miniwob/html/` directory. See `miniwob-integration-plan.md`
 * Step 4 for the one-time setup script.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BrowserPlugin } from "../../core/plugin-api.js";
import { startTestServer, type TestServer } from "./test-server.js";

// ─── Task table ──────────────────────────────────────────────────

/**
 * The plugin capability a MiniWoB task requires.
 *
 * - `element` — reachable via our `@e`-ref snapshot + click/type/press/
 *   scroll/navigate. These are the tasks Step 2 offloads.
 * - `coord`   — renders to `<canvas>`; no semantic elements for our
 *   `@e`-ref model to target. Skipped (no coordinate-click tool).
 * - `drag`    — requires drag-and-drop, which `BrowserPlugin` does not
 *   expose. Skipped.
 * - `hover`   — requires slider/colorwheel-style continuous input with
 *   no matching tool. Skipped.
 * - `select`  — requires a spinner/select interaction with no matching
 *   tool. Skipped.
 */
export type MiniwobRequires = "element" | "coord" | "drag" | "hover" | "select";

export interface MiniwobTask {
	subdomain: string;
	desc: string;
	requires: MiniwobRequires;
	/** True for tasks BrowserGym flags as nondeterministic. */
	nondeterministic?: boolean;
}

/**
 * The 125 MiniWoB++ tasks, ported from
 * `browsergym/miniwob/all.py` @ `7fd85d71`, classified by the plugin
 * capability each requires. Sorted alphabetically by subdomain to
 * mirror `all.py`.
 *
 * Classification is cross-referenced against our `BrowserPlugin`
 * interface in `miniwob-integration-plan.md`. The "boundary" tasks
 * flagged there for per-task verification are kept under `element`
 * here; Step 2's per-task solvers will confirm or downgrade them.
 */
export const MINIWOB_TASKS: readonly MiniwobTask[] = [
	{
		subdomain: "ascending-numbers",
		desc: "Click on the numbers in ascending order.",
		requires: "element",
	},
	{
		subdomain: "bisect-angle",
		desc: "Find the line that bisects an angle evenly in two.",
		requires: "coord",
	},
	{
		subdomain: "book-flight",
		desc: "Search for flight results.",
		requires: "element",
	},
	{
		subdomain: "book-flight-nodelay",
		desc: "[book-flight] Removed animation.",
		requires: "element",
	},
	{
		subdomain: "buy-ticket",
		desc: "Buy a ticket that matches the requested criteria.",
		requires: "element",
	},
	{
		subdomain: "choose-date",
		desc: "Learn to operate a date picker tool.",
		requires: "element",
	},
	{
		subdomain: "choose-date-easy",
		desc: "[choose-date] December only.",
		requires: "element",
	},
	{
		subdomain: "choose-date-medium",
		desc: "[choose-date] December or November only.",
		requires: "element",
	},
	{
		subdomain: "choose-date-nodelay",
		desc: "[choose-date] Removed animation.",
		requires: "element",
	},
	{
		subdomain: "choose-list",
		desc: "Choose an item from a drop down list.",
		requires: "element",
	},
	{
		subdomain: "circle-center",
		desc: "Find the center of a circle.",
		requires: "coord",
	},
	{
		subdomain: "click-button",
		desc: "Click on a specific button in a generated form.",
		requires: "element",
	},
	{
		subdomain: "click-button-sequence",
		desc: "Click on buttons in a certain order.",
		requires: "element",
	},
	{
		subdomain: "click-checkboxes",
		desc: "Click desired checkboxes.",
		requires: "element",
	},
	{
		subdomain: "click-checkboxes-large",
		desc: "[click-checkboxes] Click at least 5 out of up to 12 checkboxes.",
		requires: "element",
	},
	{
		subdomain: "click-checkboxes-soft",
		desc: "[click-checkboxes] Paraphrased entries.",
		requires: "element",
	},
	{
		subdomain: "click-checkboxes-transfer",
		desc: "[click-checkboxes] Train and test on different number of targets.",
		requires: "element",
	},
	{
		subdomain: "click-collapsible",
		desc: "Click a collapsible element to expand it.",
		requires: "element",
	},
	{
		subdomain: "click-collapsible-2",
		desc: "Find and click on a specified link, from collapsible elements.",
		requires: "element",
	},
	{
		subdomain: "click-collapsible-2-nodelay",
		desc: "[click-collapsible-2] Removed animation.",
		requires: "element",
	},
	{
		subdomain: "click-collapsible-nodelay",
		desc: "[click-collapsible] Removed animation.",
		requires: "element",
	},
	{
		subdomain: "click-color",
		desc: "Click the specified color.",
		requires: "coord",
	},
	{
		subdomain: "click-dialog",
		desc: "Click the button to close the dialog box.",
		requires: "element",
	},
	{
		subdomain: "click-dialog-2",
		desc: "Click a specific button in a dialog box.",
		requires: "element",
	},
	{
		subdomain: "click-link",
		desc: "Click on a specified link in text.",
		requires: "element",
	},
	{ subdomain: "click-menu", desc: "Click menu items.", requires: "element" },
	{
		subdomain: "click-menu-2",
		desc: "Find a specific item from a menu.",
		requires: "element",
	},
	{
		subdomain: "click-option",
		desc: "Click option boxes.",
		requires: "element",
	},
	{
		subdomain: "click-pie",
		desc: "Click items on a pie menu.",
		requires: "coord",
		nondeterministic: true,
	},
	{
		subdomain: "click-pie-nodelay",
		desc: "[click-pie] Removed animation.",
		requires: "coord",
		nondeterministic: true,
	},
	{
		subdomain: "click-scroll-list",
		desc: "Click multiple items from a scroll list.",
		requires: "element",
	},
	{
		subdomain: "click-shades",
		desc: "Click the shades that match a specified color.",
		requires: "coord",
	},
	{
		subdomain: "click-shape",
		desc: "Click on a specific shape.",
		requires: "coord",
	},
	{
		subdomain: "click-tab",
		desc: "Click on a tab element.",
		requires: "element",
	},
	{
		subdomain: "click-tab-2",
		desc: "Click a link inside a specific tab element.",
		requires: "element",
	},
	{
		subdomain: "click-tab-2-easy",
		desc: "[click-tab-2] One 1 tab.",
		requires: "element",
	},
	{
		subdomain: "click-tab-2-hard",
		desc: "[click-tab-2] Varying number of tabs from 2 to 6.",
		requires: "element",
	},
	{
		subdomain: "click-tab-2-medium",
		desc: "[click-tab-2] Choose between a link or ‘no match’.",
		requires: "element",
	},
	{
		subdomain: "click-test",
		desc: "Click on a single button.",
		requires: "element",
	},
	{
		subdomain: "click-test-2",
		desc: "Click on one of two buttons.",
		requires: "element",
	},
	{
		subdomain: "click-test-transfer",
		desc: "[click-test] Different buttons during train and test.",
		requires: "element",
	},
	{
		subdomain: "click-widget",
		desc: "Click on a specific widget in a generated form.",
		requires: "element",
	},
	{
		subdomain: "copy-paste",
		desc: "Copy text and paste it into an input.",
		requires: "drag",
	},
	{
		subdomain: "copy-paste-2",
		desc: "Copy text from a specific textarea and paste it into an input.",
		requires: "drag",
	},
	{
		subdomain: "count-shape",
		desc: "Count number of shapes.",
		requires: "coord",
	},
	{
		subdomain: "count-sides",
		desc: "Count the number of sides on a shape.",
		requires: "coord",
	},
	{
		subdomain: "daily-calendar",
		desc: "Create an event on a daily calendar.",
		requires: "element",
	},
	{
		subdomain: "drag-box",
		desc: "Drag the smaller box into the larger box.",
		requires: "drag",
	},
	{
		subdomain: "drag-circle",
		desc: "Drag an item in a specified direction.",
		requires: "drag",
	},
	{
		subdomain: "drag-cube",
		desc: "Drag a 3D cube to show a specific face.",
		requires: "drag",
	},
	{
		subdomain: "drag-items",
		desc: "Drag items in a list, in a specified direction",
		requires: "drag",
	},
	{
		subdomain: "drag-items-grid",
		desc: "Drag items in a 2D grid around.",
		requires: "drag",
	},
	{
		subdomain: "drag-shapes",
		desc: "Drag shapes into a box.",
		requires: "drag",
	},
	{
		subdomain: "drag-shapes-2",
		desc: "Drag shapes into boxes, categorized by type.",
		requires: "drag",
	},
	{
		subdomain: "drag-single-shape",
		desc: "Drag a randomly generated shape in a specified direction.",
		requires: "drag",
	},
	{
		subdomain: "drag-sort-numbers",
		desc: "Drag numbers into sorted ascending order.",
		requires: "drag",
	},
	{
		subdomain: "draw-circle",
		desc: "Draw a circle around a marked point.",
		requires: "coord",
	},
	{
		subdomain: "draw-line",
		desc: "Draw a line through a marked point.",
		requires: "coord",
	},
	{
		subdomain: "email-inbox",
		desc: "Navigate through an email inbox and perform some actions.",
		requires: "element",
	},
	{
		subdomain: "email-inbox-delete",
		desc: "[email-inbox] No scrolling + 1 subtask.",
		requires: "element",
	},
	{
		subdomain: "email-inbox-forward",
		desc: "[email-inbox] No scrolling + 1 subtask.",
		requires: "element",
	},
	{
		subdomain: "email-inbox-forward-nl",
		desc: "[email-inbox-forward] varied instruction texts (30 templates).",
		requires: "element",
	},
	{
		subdomain: "email-inbox-forward-nl-turk",
		desc: "[email-inbox-forward] varied instruction texts (100 templates).",
		requires: "element",
	},
	{
		subdomain: "email-inbox-important",
		desc: "[email-inbox] No scrolling + 1 subtask.",
		requires: "element",
	},
	{
		subdomain: "email-inbox-nl-turk",
		desc: "[email-inbox] varied instruction texts (100 templates for each subtask).",
		requires: "element",
	},
	{
		subdomain: "email-inbox-noscroll",
		desc: "[email-inbox] No scrolling.",
		requires: "element",
	},
	{
		subdomain: "email-inbox-reply",
		desc: "[email-inbox] No scrolling + 1 subtask.",
		requires: "element",
	},
	{
		subdomain: "email-inbox-star-reply",
		desc: "[email-inbox] No scrolling + 2 subtasks.",
		requires: "element",
	},
	{
		subdomain: "enter-date",
		desc: "Use the date input to pick the correct date.",
		requires: "element",
	},
	{
		subdomain: "enter-password",
		desc: "Enter the password into the form.",
		requires: "element",
	},
	{
		subdomain: "enter-text",
		desc: "Enter given text to a textfield.",
		requires: "element",
	},
	{
		subdomain: "enter-text-2",
		desc: "Convert given text to upper or lower case.",
		requires: "element",
	},
	{
		subdomain: "enter-text-dynamic",
		desc: "Enter dynamically generated text to a textfield.",
		requires: "element",
	},
	{
		subdomain: "enter-time",
		desc: "Enter the specified time into the input.",
		requires: "element",
	},
	{
		subdomain: "find-greatest",
		desc: "Find the card with the greatest number.",
		requires: "element",
	},
	{
		subdomain: "find-midpoint",
		desc: "Find the shortest mid-point of two points.",
		requires: "coord",
	},
	{
		subdomain: "find-word",
		desc: "Find nth word in a block of text.",
		requires: "element",
	},
	{
		subdomain: "focus-text",
		desc: "Focus into a text input.",
		requires: "element",
	},
	{
		subdomain: "focus-text-2",
		desc: "Focus on a specific text input.",
		requires: "element",
	},
	{
		subdomain: "form-sequence",
		desc: "Perform a series of instructions on a form.",
		requires: "element",
	},
	{
		subdomain: "form-sequence-2",
		desc: "Perform a series of instructions on a form.",
		requires: "element",
	},
	{
		subdomain: "form-sequence-3",
		desc: "Perform a series of instructions on a form.",
		requires: "element",
	},
	{
		subdomain: "generate-number",
		desc: "Generate a random number that meets certain criteria.",
		requires: "element",
	},
	{
		subdomain: "grid-coordinate",
		desc: "Find the Cartesian coordinates on a grid.",
		requires: "coord",
	},
	{ subdomain: "guess-number", desc: "Guess the number.", requires: "coord" },
	{
		subdomain: "highlight-text",
		desc: "Highlight all the text.",
		requires: "element",
	},
	{
		subdomain: "highlight-text-2",
		desc: "Highlight the specified paragraph.",
		requires: "element",
	},
	{
		subdomain: "hot-cold",
		desc: "Find and click on the hot area.",
		requires: "coord",
	},
	{
		subdomain: "identify-shape",
		desc: "Identify a randomly generated shape.",
		requires: "coord",
	},
	{
		subdomain: "login-user",
		desc: "Enter user login details into the form.",
		requires: "element",
	},
	{
		subdomain: "login-user-popup",
		desc: "[login-user] Random popup.",
		requires: "element",
	},
	{
		subdomain: "multi-layouts",
		desc: "Fill in forms of varying layouts.",
		requires: "element",
	},
	{
		subdomain: "multi-orderings",
		desc: "Fill in forms with shuffled field orderings.",
		requires: "element",
	},
	{
		subdomain: "navigate-tree",
		desc: "Navigate a file tree to find a specified file or folder.",
		requires: "element",
	},
	{
		subdomain: "number-checkboxes",
		desc: "Draw a given number using checkboxes.",
		requires: "element",
	},
	{
		subdomain: "odd-or-even",
		desc: "Mark each number as odd or even.",
		requires: "element",
	},
	{
		subdomain: "order-food",
		desc: "Order food items from a menu.",
		requires: "element",
	},
	{
		subdomain: "phone-book",
		desc: "Find a contact in a phone book.",
		requires: "element",
	},
	{
		subdomain: "read-table",
		desc: "Read information out from a table.",
		requires: "element",
	},
	{
		subdomain: "read-table-2",
		desc: "Read multiple pieces of information out from a table.",
		requires: "element",
	},
	{
		subdomain: "resize-textarea",
		desc: "Resize a textarea in a given direction.",
		requires: "drag",
	},
	{
		subdomain: "right-angle",
		desc: "Given two points, add a third point to create a right angle.",
		requires: "coord",
	},
	{
		subdomain: "scroll-text",
		desc: "Scroll through a text area element and enter last word into text area.",
		requires: "element",
	},
	{
		subdomain: "scroll-text-2",
		desc: "Scroll through a text area in a given direction.",
		requires: "element",
	},
	{
		subdomain: "search-engine",
		desc: "Search through a bunch of results to find a specified link.",
		requires: "element",
	},
	{
		subdomain: "sign-agreement",
		desc: "Sign a user agreement.",
		requires: "element",
	},
	{ subdomain: "simple-algebra", desc: "Solve for X.", requires: "element" },
	{
		subdomain: "simple-arithmetic",
		desc: "Perform some arithmetic math operations.",
		requires: "element",
	},
	{
		subdomain: "social-media",
		desc: "Interact with a social media feed.",
		requires: "element",
	},
	{
		subdomain: "social-media-all",
		desc: "[social-media] Do some action on all matching entries.",
		requires: "element",
	},
	{
		subdomain: "social-media-some",
		desc: "[social-media] Do some action on some matching entries.",
		requires: "element",
	},
	{
		subdomain: "stock-market",
		desc: "Buy from the stock market below a specified price.",
		requires: "element",
	},
	{
		subdomain: "terminal",
		desc: "Use the terminal to delete a file.",
		requires: "element",
		nondeterministic: true,
	},
	{
		subdomain: "text-editor",
		desc: "Modify a text's style in a text-editor.",
		requires: "element",
	},
	{
		subdomain: "text-transform",
		desc: "Enter slightly transformed text into a text box.",
		requires: "element",
	},
	{
		subdomain: "tic-tac-toe",
		desc: "Win a game of tic-tac-toe.",
		requires: "element",
	},
	{
		subdomain: "unicode-test",
		desc: "Click on the button with the correct Unicode text.",
		requires: "element",
	},
	{
		subdomain: "use-autocomplete",
		desc: "Use autocomplete element efficiently.",
		requires: "element",
	},
	{
		subdomain: "use-autocomplete-nodelay",
		desc: "[use-autocomplete] Removed delay.",
		requires: "element",
	},
	{
		subdomain: "use-colorwheel",
		desc: "Use a color wheel.",
		requires: "hover",
	},
	{
		subdomain: "use-colorwheel-2",
		desc: "Use a color wheel given specific random color.",
		requires: "hover",
	},
	{
		subdomain: "use-slider",
		desc: "Use a slider to select a particular value.",
		requires: "hover",
	},
	{
		subdomain: "use-slider-2",
		desc: "Use sliders to create a given combination.",
		requires: "hover",
	},
	{
		subdomain: "use-spinner",
		desc: "Use a spinner to select given number.",
		requires: "select",
	},
	{
		subdomain: "visual-addition",
		desc: "Count the total number of blocks.",
		requires: "coord",
		nondeterministic: true,
	},
] as const;

/** Quick lookup of a task by subdomain. */
const MINIWOB_TASK_BY_SUBDOMAIN = new Map<string, MiniwobTask>(
	MINIWOB_TASKS.map((t) => [t.subdomain, t]),
);

/**
 * Returns the task definition for a subdomain, or throws if unknown.
 * Use this in solvers to look up `desc` / `requires`.
 */
export function getMiniwobTask(subdomain: string): MiniwobTask {
	const task = MINIWOB_TASK_BY_SUBDOMAIN.get(subdomain);
	if (!task) {
		throw new Error(`Unknown MiniWoB subdomain: ${subdomain}`);
	}
	return task;
}

/** All `element`-tagged tasks (the reachable subset for Step 2). */
export const MINIWOB_ELEMENT_TASKS: readonly MiniwobTask[] =
	MINIWOB_TASKS.filter((t) => t.requires === "element");

// ─── setup() JS injection (ported from base.py) ──────────────────

/**
 * Builds the BrowserGym `base.py` `setup()` JS injection for a given
 * seed and episode max time. Ported near-verbatim from
 * `browsergym/miniwob/base.py` @ `7fd85d71`.
 *
 * What it does:
 *   - Removes the `reward-display`, `click-canvas`, and
 *     `sync-task-cover` (START overlay) elements from the DOM so they
 *     don't pollute the agent's snapshot.
 *   - Monkeypatches `core.endEpisode`, `core.startEpisodeReal`, and
 *     `core.getUtterance` so the human display is brought back only
 *     while those internals run, then removed again — keeping the
 *     agent's view clean without breaking the reward protocol.
 *   - Calls `Math.seedrandom(seed)` for deterministic content on
 *     randomized tasks, sets `core.EPISODE_MAX_TIME`, and invokes
 *     `core.startEpisodeReal()` to trigger `genProblem()` (bypassing
 *     the START overlay — see `miniwob-spike-findings.md` §2).
 *
 * @param seed         Random seed (matches base.py's `self.random.randint`).
 * @param episodeMaxMs Episode max time in ms (base.py default 1_000_000;
 *                     the plan recommends ~10-30s for a test suite).
 * @param removeHumanDisplay When false, the display-removal block is
 *                     omitted (matches `remove_human_display=False`).
 */
export function buildMiniwobSetupJs(
	seed: number,
	episodeMaxMs: number,
	removeHumanDisplay = true,
): string {
	const removeDisplayBlock = removeHumanDisplay
		? `
let __display_ids = ['reward-display', 'click-canvas', 'sync-task-cover'];
let __display_divs = {};
let __query_div_hidden_copy = null;

removeDisplay = function() {
  core.clearTimer();
  document.body.removeEventListener('click', core.canvasDrawClick);

  __query_div_hidden_copy = document.getElementById('query').cloneNode(true);
  document.getElementById('query').innerHTML = '';

  for (i in __display_ids) {
    elem_id = __display_ids[i];
    elem = document.getElementById(elem_id);
    // remove elem from the document
    elem.remove();
    // but keep it stored somewhere to bring back later
    __display_divs[elem_id] = elem;
  }
};

bringBackDisplay = function() {
  document.getElementById('query').innerHTML = __query_div_hidden_copy.innerHTML;
  for (var elem_id in __display_divs){
    document.body.appendChild(__display_divs[elem_id]);
  }
  core.createDisplay();
};

core.endEpisode_legacy = core.endEpisode;
core.startEpisodeReal_legacy = core.startEpisodeReal;
core.getUtterance_legacy = core.getUtterance;

core.getUtterance = function () {
  bringBackDisplay();
  utterance = core.getUtterance_legacy();
  removeDisplay();
  return utterance;
};

core.endEpisode = function(reward, time_proportional, reason){
  bringBackDisplay();
  core.endEpisode_legacy(reward, time_proportional, reason);
  removeDisplay();
};

core.startEpisodeReal = function() {
  bringBackDisplay();
  core.startEpisodeReal_legacy();
  removeDisplay();
};

removeDisplay();
`
		: "";

	return `
${removeDisplayBlock}
Math.seedrandom(${JSON.stringify(seed)});
core.EPISODE_MAX_TIME = ${JSON.stringify(episodeMaxMs)};
core.startEpisodeReal();
`;
}

/**
 * Attribution/credit string for the ported `base.py` JS injection and
 * reward protocol. Surfaced in tests so the Apache-2.0 attribution
 * stays verifiable (both projects are also credited in
 * `automate-testing.md` per the plan's gotcha #8).
 */
export const MINIWOB_SETUP_JS_ATTRIBUTION =
	"Ported from browsergym/miniwob/base.py @ miniwob-plusplus@7fd85d71 (Apache-2.0)";

// ─── validate() reward protocol (ported from base.py) ────────────

/** The reward/info bag read from a MiniWoB page. */
export interface MiniwobRewardInfo {
	/** `WOB_REWARD_GLOBAL` — time-discounted reward (not used for pass/fail). */
	REWARD_GLOBAL: number;
	/** `WOB_RAW_REWARD_GLOBAL` — raw reward; `> 0` is the pass signal. */
	RAW_REWARD_GLOBAL: number;
	/** `WOB_REWARD_REASON` — human-readable reason string. */
	REWARD_REASON: string;
	/** `WOB_DONE_GLOBAL` — true once the episode ended (success/fail/timeout). */
	DONE_GLOBAL: boolean;
	/** `WOB_EPISODE_ID` — monotonic episode id. */
	EPISODE_ID: number;
	/** `WOB_TASK_READY` — true once `genProblem()` has finished. */
	TASK_READY: boolean;
}

/** Sentinel returned when the reward globals can't be read. */
const NULL_REWARD_INFO: MiniwobRewardInfo = {
	REWARD_GLOBAL: 0,
	RAW_REWARD_GLOBAL: 0,
	REWARD_REASON: "",
	DONE_GLOBAL: false,
	EPISODE_ID: -1,
	TASK_READY: false,
};

/**
 * Reads the MiniWoB reward globals from the page via `plugin.evaluate`.
 * Ports `base.py`'s `_get_info()` verbatim (the same six globals in
 * the same order).
 *
 * Returns a null info bag (all-zero / `DONE_GLOBAL=false`) if the
 * evaluate call fails — the caller should treat this as "not done yet"
 * rather than a hard failure, matching how BrowserGym tolerates a
 * missing page during teardown.
 */
export async function miniwobRewardInfo(
	plugin: BrowserPlugin,
	taskId: string,
): Promise<MiniwobRewardInfo> {
	const res = await plugin.evaluate(
		taskId,
		`() => [WOB_REWARD_GLOBAL, WOB_RAW_REWARD_GLOBAL, WOB_REWARD_REASON, WOB_DONE_GLOBAL, WOB_EPISODE_ID, WOB_TASK_READY]`,
	);
	if (!res.success || !Array.isArray(res.result) || res.result.length < 6) {
		return { ...NULL_REWARD_INFO };
	}
	const r = res.result;
	return {
		REWARD_GLOBAL: Number(r[0]) || 0,
		RAW_REWARD_GLOBAL: Number(r[1]) || 0,
		REWARD_REASON: r[2] === null || r[2] === undefined ? "" : String(r[2]),
		DONE_GLOBAL: Boolean(r[3]),
		EPISODE_ID: Number(r[4]) || -1,
		TASK_READY: Boolean(r[5]),
	};
}

/**
 * Reads the task utterance (goal) via the monkeypatched
 * `core.getUtterance()`. Matches `base.py`'s `_get_goal()`: if the
 * function returns an object, unwrap `utterance`; otherwise return the
 * string as-is. Returns `""` if the read fails.
 */
export async function miniwobGetGoal(
	plugin: BrowserPlugin,
	taskId: string,
): Promise<string> {
	const res = await plugin.evaluate(taskId, `() => core.getUtterance()`);
	if (!res.success || res.result === null || res.result === undefined)
		return "";
	const r = res.result;
	if (typeof r === "object" && r !== null && "utterance" in r) {
		return String((r as { utterance: unknown }).utterance ?? "");
	}
	return String(r);
}

// ─── Static file server ──────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

/**
 * Starts a static HTTP server serving `miniwob-plusplus/miniwob/html/`
 * (the cloned MiniWoB++ HTML root) on an ephemeral loopback port.
 *
 * Wraps {@link startTestServer} from `test-server.js`. The returned
 * `url` points at the html root, so a task's HTML lives at
 * `${url}/miniwob/<subdomain>.html` (mirroring the spike's layout
 * where `html/miniwob/` holds the per-task files and `html/core/`,
 * `html/common/` hold shared resources).
 *
 * @param htmlRoot Absolute path to the cloned `miniwob-plusplus/miniwob/html/`
 *                  directory. Defaults to the spike's `/tmp` location.
 * @throws if `htmlRoot` does not exist.
 */
export async function startMiniwobServer(
	htmlRoot = process.env.MINIWOB_HTML_ROOT ??
		"/tmp/miniwob-plusplus/miniwob/html",
): Promise<TestServer> {
	const root = resolve(htmlRoot);
	if (!existsSync(root)) {
		throw new Error(
			`MiniWoB html root not found: ${root}. Clone miniwob-plusplus@7fd85d71 ` +
				`and pass its miniwob/html/ directory to startMiniwobServer().`,
		);
	}

	return startTestServer((req: IncomingMessage, res: ServerResponse) => {
		// serveStatic handles its own 403 (traversal) / 404 (missing);
		// `void` suppresses the floating-promise lint for the async read.
		void serveStatic(root, req, res);
	});
}

/** Static file request handler with path-traversal guard. */
async function serveStatic(
	root: string,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const parsed = new URL(req.url ?? "/", "http://localhost");
	const decoded = decodeURIComponent(parsed.pathname);
	// Normalize and ensure the resolved path stays under root.
	const target = normalize(join(root, decoded));
	const rel = relative(root, target);
	if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
		res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("403 Forbidden");
		return;
	}

	try {
		const data = await readFile(target);
		const mime =
			MIME_BY_EXT[extname(target).toLowerCase()] ?? "application/octet-stream";
		res.writeHead(200, { "Content-Type": mime });
		res.end(data);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("404 Not Found");
	}
}

// ─── Task driver ─────────────────────────────────────────────────

/** Context handed to a {@link MiniwobSolver}. */
export interface MiniwobSolverCtx {
	plugin: BrowserPlugin;
	taskId: string;
	/** The task's utterance / goal string (from `core.getUtterance()`). */
	goal: string;
	/** The post-start accessibility snapshot with `@e` refs. */
	snapshot: string;
	/** The {@link MiniwobTask} definition. */
	task: MiniwobTask;
	/** Helper to take a fresh snapshot. */
	snapshotNow(): Promise<string>;
	/** Helper to read the live reward info. */
	rewardInfo(): Promise<MiniwobRewardInfo>;
}

/**
 * A trivial, task-specific solver. Step 2's solvers are intentionally
 * dumb — we're testing the **plugin pipeline**, not agent intelligence.
 * A solver typically: parses `snapshot` for an obvious `@e` ref, calls
 * `plugin.click` / `plugin.type`, and returns. The driver handles
 * reward polling and pass/fail.
 */
export type MiniwobSolver = (ctx: MiniwobSolverCtx) => Promise<void>;

export interface RunMiniwobTaskOptions {
	/**
	 * Base URL of the running MiniWoB server (the `miniwob/html/` root).
	 * Defaults to `process.env.MINIWOB_URL`, matching BrowserGym's own
	 * convention from `base.py`. Throws if neither is set.
	 */
	baseUrl?: string;
	/** Episode max time in ms (default 30_000 — see plan gotcha #5). */
	episodeMaxMs?: number;
	/** Whether to remove the human display (default true, matches base.py). */
	removeHumanDisplay?: boolean;
	/** Per-call navigate timeout in ms (default 15_000). */
	navigateTimeoutMs?: number;
	/**
	 * How long to poll `WOB_DONE_GLOBAL` after the solver returns
	 * (default 10_000ms). MiniWoB sets `DONE_GLOBAL` on success,
	 * failure, or episode timeout.
	 */
	donePollTimeoutMs?: number;
	/** Poll interval for `WOB_DONE_GLOBAL` (default 200ms). */
	donePollIntervalMs?: number;
	/**
	 * How long to wait for `core` to be defined before injecting setup
	 * JS (default 5_000ms). Guards against racing the page load.
	 */
	coreReadyTimeoutMs?: number;
}

export interface MiniwobTaskResult {
	/** Task utterance / goal. */
	goal: string;
	/** `1` if `RAW_REWARD_GLOBAL > 0`, else `0` — matches base.py `validate()`. */
	reward: number;
	/** Raw `WOB_RAW_REWARD_GLOBAL`. */
	rawReward: number;
	/** `WOB_DONE_GLOBAL` at the end of the run. */
	done: boolean;
	/** `WOB_REWARD_REASON`. */
	reason: string;
	/** Final reward/info bag. */
	info: MiniwobRewardInfo;
	/** True if the done-poll timed out before `WOB_DONE_GLOBAL` flipped. */
	timedOut: boolean;
	/** True if the navigate or setup-injection step failed. */
	setupFailed: boolean;
	/** Error message when `setupFailed` is true. */
	error?: string;
}

/**
 * Runs a single MiniWoB++ task end-to-end through a `BrowserPlugin`.
 *
 * Steps (mirroring BrowserGym's `base.py` `setup()` + `validate()`):
 *   1. Navigate to `${baseUrl}/miniwob/${subdomain}.html`.
 *   2. Wait for `core` to be defined on the page.
 *   3. Inject {@link buildMiniwobSetupJs} (removes human display,
 *      monkeypatches start/getUtterance/endEpisode, seeds RNG, calls
 *      `core.startEpisodeReal()` — bypassing the START overlay).
 *   4. Wait for `WOB_TASK_READY`.
 *   5. Read the goal via `core.getUtterance()`.
 *   6. Take an accessibility snapshot and hand it to `solver`.
 *   7. Poll `WOB_DONE_GLOBAL` until true or `donePollTimeoutMs`.
 *   8. Read the final reward bag and return it.
 *
 * `baseUrl` resolves from `options.baseUrl ?? process.env.MINIWOB_URL`
 * (matching `base.py`'s own `MINIWOB_URL` convention). Callers that
 * start a fresh server per run should pass `baseUrl` explicitly.
 *
 * The caller owns plugin lifecycle (`init` / `cleanupAll`); this driver
 * only calls `navigate`, `evaluate`, `snapshot`, and (via the solver)
 * the interaction methods. The caller MUST `plugin.cleanup(taskId)`
 * after inspecting the result (the driver does not clean up, so the
 * solver's final snapshot stays inspectable on failure).
 */
export async function runMiniwobTask(
	plugin: BrowserPlugin,
	subdomain: string,
	seed: number,
	solver: MiniwobSolver,
	options: RunMiniwobTaskOptions = {},
): Promise<MiniwobTaskResult> {
	const {
		baseUrl = process.env.MINIWOB_URL,
		episodeMaxMs = 30_000,
		removeHumanDisplay = true,
		navigateTimeoutMs = 15_000,
		donePollTimeoutMs = 10_000,
		donePollIntervalMs = 200,
		coreReadyTimeoutMs = 5_000,
	} = options;

	if (!baseUrl) {
		return failTask(
			`No baseUrl: pass options.baseUrl or set MINIWOB_URL (got neither).`,
		);
	}

	const task = getMiniwobTask(subdomain);
	const taskId = `miniwob-${subdomain}-${seed}`;
	const url = `${baseUrl.replace(/\/$/, "")}/miniwob/${subdomain}.html`;

	// 1. Navigate.
	const nav = await plugin.navigate(url, taskId, navigateTimeoutMs);
	if (!nav.success) {
		return failTask(`navigate failed: ${nav.error ?? "unknown"}`);
	}

	// 2. Wait for `core` to be defined (defensive — base.py relies on
	//    goto's load event, but our nav-settle may return slightly
	//    earlier on some backends).
	const coreReady = await waitForCore(plugin, taskId, coreReadyTimeoutMs);
	if (!coreReady) {
		return failTask(
			`core not defined within ${coreReadyTimeoutMs}ms at ${url}`,
		);
	}

	// 3. Inject setup JS (removes display, seeds RNG, starts episode).
	const setupJs = buildMiniwobSetupJs(seed, episodeMaxMs, removeHumanDisplay);
	const setupRes = await plugin.evaluate(taskId, setupJs);
	if (!setupRes.success) {
		return failTask(
			`setup JS injection failed: ${setupRes.error ?? "unknown"}`,
		);
	}

	// 4. Wait for WOB_TASK_READY.
	const ready = await waitForTaskReady(plugin, taskId, coreReadyTimeoutMs);
	if (!ready) {
		return failTask(
			`WOB_TASK_READY never became true within ${coreReadyTimeoutMs}ms`,
		);
	}

	// 5. Read the goal.
	const goal = await miniwobGetGoal(plugin, taskId);

	// 6. Snapshot + solver.
	const snap = await plugin.snapshot(taskId);
	const snapshotText = snap.success ? snap.snapshot : "";
	const ctx: MiniwobSolverCtx = {
		plugin,
		taskId,
		goal,
		snapshot: snapshotText,
		task,
		snapshotNow: async (): Promise<string> => {
			const s = await plugin.snapshot(taskId);
			return s.success ? s.snapshot : "";
		},
		rewardInfo: (): Promise<MiniwobRewardInfo> =>
			miniwobRewardInfo(plugin, taskId),
	};
	await solver(ctx);

	// 7. Poll WOB_DONE_GLOBAL.
	const pollStart = Date.now();
	let info = await miniwobRewardInfo(plugin, taskId);
	let timedOut = false;
	while (!info.DONE_GLOBAL) {
		if (Date.now() - pollStart > donePollTimeoutMs) {
			timedOut = true;
			break;
		}
		await sleep(donePollIntervalMs);
		info = await miniwobRewardInfo(plugin, taskId);
	}

	// 8. Final bag.
	return {
		goal,
		reward: info.RAW_REWARD_GLOBAL > 0 ? 1 : 0,
		rawReward: info.RAW_REWARD_GLOBAL,
		done: info.DONE_GLOBAL,
		reason: info.REWARD_REASON,
		info,
		timedOut,
		setupFailed: false,
	};
}

// ─── Internal wait helpers ───────────────────────────────────────

/**
 * Builds a `setupFailed` {@link MiniwobTaskResult}. Used for every
 * early-return path in {@link runMiniwobTask} (navigate/core/setup/
 * task-ready failures). `info` defaults to a null bag.
 */
function failTask(
	error: string,
	info: MiniwobRewardInfo = { ...NULL_REWARD_INFO },
): MiniwobTaskResult {
	return {
		goal: "",
		reward: 0,
		rawReward: info.RAW_REWARD_GLOBAL,
		done: info.DONE_GLOBAL,
		reason: info.REWARD_REASON,
		info,
		timedOut: false,
		setupFailed: true,
		error,
	};
}

/** Polls until `typeof core !== 'undefined'`, up to `timeoutMs`. */
async function waitForCore(
	plugin: BrowserPlugin,
	taskId: string,
	timeoutMs: number,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await plugin.evaluate(
			taskId,
			`(() => typeof core !== 'undefined')()`,
		);
		if (res.success && res.result === true) return true;
		await sleep(100);
	}
	return false;
}

/** Polls until `WOB_TASK_READY === true`, up to `timeoutMs`. */
async function waitForTaskReady(
	plugin: BrowserPlugin,
	taskId: string,
	timeoutMs: number,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await plugin.evaluate(
			taskId,
			`(() => WOB_TASK_READY === true)()`,
		);
		if (res.success && res.result === true) return true;
		await sleep(100);
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
