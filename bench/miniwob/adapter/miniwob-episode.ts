/**
 * MiniWoB++ episode-lifecycle JS — runs via `plugin.evaluate()` on the
 * plugin's own page. Replaces the former `miniwob-driver.py` subprocess.
 *
 * Attribution:
 *   MiniWoB++ (c) Farama-Foundation (Apache-2.0).
 *   The `REMOVE_DISPLAY_JS` block was obtained from BrowserGym
 *   (ServiceNow, Apache-2.0) and copied verbatim; no changes were made.
 *   Episode-setup protocol paraphrased from BrowserGym's `base.py`.
 *
 * @module
 */

/**
 * Seed RNG, set episode max time, start the episode, then return
 * immediately. The adapter polls `WOB_TASK_READY` separately
 * (see {@link READY_PROBE_JS}) before reading the utterance.
 */
export const SETUP_JS = (seed: number, episodeMaxTimeMs: number): string =>
	`Math.seedrandom(${seed}); core.EPISODE_MAX_TIME = ${episodeMaxTimeMs}; core.startEpisodeReal();`;

/**
 * Read the WOB_*_GLOBAL reward globals as a plain object expression.
 * Evaluates directly (no function wrapper) so `plugin.evaluate()`
 * returns the reward object, not a function reference.
 */
export const VALIDATE_JS: string =
	`({ reward: WOB_RAW_REWARD_GLOBAL > 0 ? 1 : 0, ` +
	`raw_reward: WOB_RAW_REWARD_GLOBAL, done: WOB_DONE_GLOBAL, ` +
	`reason: WOB_REWARD_REASON })`;

/**
 * Probe expression: returns `true` once the MiniWoB task is ready
 * (`WOB_TASK_READY` exists and is truthy).
 */
export const READY_PROBE_JS: string =
	`typeof WOB_TASK_READY !== 'undefined' && WOB_TASK_READY`;

/**
 * Read the current task utterance (goal text) from the MiniWoB core.
 */
export const UTTERANCE_JS: string = `core.getUtterance()`;

/**
 * BrowserGym's `removeDisplay` block, copied verbatim with attribution.
 *
 * Deletes the `sync-task-cover`, `reward-display`, and `click-canvas` divs
 * and monkeypatches `core.startEpisodeReal` / `core.endEpisode` /
 * `core.getUtterance` to bring them back transiently so the cover never
 * intercepts the solver's clicks and `getUtterance()` still works.
 *
 * Source: BrowserGym (ServiceNow, Apache-2.0),
 *   browsergym/miniwob/src/browsergym/miniwob/base.py (lines 69–118).
 * Copied verbatim; no changes made.
 */
export const REMOVE_DISPLAY_JS: string = `
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
`;
