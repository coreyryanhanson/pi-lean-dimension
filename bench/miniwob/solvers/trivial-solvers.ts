/**
 * Trivial MiniWoB++ solvers — one per task subdomain, using only
 * `@e`-ref accessibility snapshot + click/type actions.
 *
 * These are intentionally dumb solvers that test the **plugin
 * pipeline**, not agent intelligence. They solve tasks whose pass
 * condition is a single obvious action (click the only button, focus
 * the only textbox). Best-effort solvers verify the pipeline doesn't
 * crash; confident solvers additionally assert `rawReward > 0`.
 *
 * Moved from `pi-lean-portal/__tests__/helpers/miniwob-suite.ts`. Uses the
 * `TrivialSolver` type from `bench/miniwob`'s MiniWoB adapter.
 *
 * ── Attribution ─────────────────────────────────────────────────
 *
 * MiniWoB++ is © Farama-Foundation (Apache-2.0). The task goal
 * descriptions below are paraphrased from the MiniWoB++ task files;
 * the solver logic is original to the pi-lean-portal project.
 *
 * @module
 */

import { parseRefs, withRole, firstWith, goalQuotedTexts } from "./parser.js";
import type { TrivialSolver } from "../adapter/miniwob-adapter.js";

// ─── Individual solvers ───────────────────────────────────────────

/**
 * Click the first button on the page. Solves `click-test` (single
 * button) and `click-dialog` (a dialog's close/OK button is the
 * obvious click target).
 */
export const clickFirstButton: TrivialSolver = async ({
	plugin,
	taskId,
	snapshot,
}) => {
	const btn = firstWith(parseRefs(snapshot), "button");
	if (btn) await plugin.click(taskId, btn.ref);
};

/**
 * Focus the first textbox/searchbox. Solves `focus-text` (single
 * textbox — focusing IS the pass condition) and is a best-effort for
 * `focus-text-2`.
 */
export const focusFirstTextbox: TrivialSolver = async ({
	plugin,
	taskId,
	snapshot,
}) => {
	const tb = firstWith(parseRefs(snapshot), "textbox", "searchbox");
	if (tb) await plugin.click(taskId, tb.ref);
};

/**
 * Click the button whose accessible name matches a quoted string in
 * the goal; fall back to the first button. Best-effort for
 * `click-button`, `click-test-2`, `click-dialog-2`.
 */
export const clickButtonNamedInGoal: TrivialSolver = async ({
	plugin,
	taskId,
	snapshot,
	goal,
}) => {
	const buttons = withRole(parseRefs(snapshot), "button");
	if (buttons.length === 0) return;
	for (const q of goalQuotedTexts(goal)) {
		const hit = buttons.find((b) =>
			b.name.toLowerCase().includes(q.toLowerCase()),
		);
		if (hit) {
			await plugin.click(taskId, hit.ref);
			return;
		}
	}
	await plugin.click(taskId, buttons[0]!.ref);
};

/**
 * Click the link whose name matches a quoted string in the goal; fall
 * back to the first link. Best-effort for `click-link`.
 */
export const clickLinkNamedInGoal: TrivialSolver = async ({
	plugin,
	taskId,
	snapshot,
	goal,
}) => {
	const links = withRole(parseRefs(snapshot), "link");
	if (links.length === 0) return;
	for (const q of goalQuotedTexts(goal)) {
		const hit = links.find((l) =>
			l.name.toLowerCase().includes(q.toLowerCase()),
		);
		if (hit) {
			await plugin.click(taskId, hit.ref);
			return;
		}
	}
	await plugin.click(taskId, links[0]!.ref);
};

/**
 * Type the first quoted string from the goal into the first textbox.
 * Best-effort for `enter-text`, `enter-password`, `enter-text-dynamic`.
 */
export const typeQuotedIntoTextbox: TrivialSolver = async ({
	plugin,
	taskId,
	snapshot,
	goal,
}) => {
	const tb = firstWith(parseRefs(snapshot), "textbox", "searchbox");
	if (!tb) return;
	const quoted = goalQuotedTexts(goal);
	if (quoted.length === 0) return;
	await plugin.type(taskId, tb.ref, quoted[0]!);
};

/**
 * Login form solver: type the first quoted string into the first
 * textbox, the second into the second textbox, then click a
 * submit-like button. Best-effort for `login-user`, `login-user-popup`.
 */
export const loginUser: TrivialSolver = async ({
	plugin,
	taskId,
	snapshot,
	goal,
}) => {
	const els = parseRefs(snapshot);
	const tbs = withRole(els, "textbox");
	const buttons = withRole(els, "button");
	const quoted = goalQuotedTexts(goal);

	if (tbs.length >= 2 && quoted.length >= 2) {
		await plugin.type(taskId, tbs[0]!.ref, quoted[0]!);
		await plugin.type(taskId, tbs[1]!.ref, quoted[1]!);
	} else if (tbs.length >= 1 && quoted.length >= 1) {
		await plugin.type(taskId, tbs[0]!.ref, quoted[0]!);
	}

	const submit = buttons.find((b) =>
		/submit|log\s*in|sign\s*in|ok|continue|enter/i.test(b.name),
	);
	if (submit) await plugin.click(taskId, submit.ref);
	else if (buttons.length > 0) await plugin.click(taskId, buttons[0]!.ref);
};

// ─── Solver registry ─────────────────────────────────────────────

/**
 * Per-subdomain solver map. Add an entry here to enable a task; the
 * test generator in {@link registerMiniwobSuite} picks it up
 * automatically. Tasks absent from this map are reported as `it.skip`
 * with a `needs goal-aware solver (Step 2 follow-up)` reason.
 */
export const SOLVERS: Map<string, TrivialSolver> = new Map([
	// ── Confident (trivial action == pass condition) ──
	["click-test", clickFirstButton],
	["click-dialog", clickFirstButton],
	["focus-text", focusFirstTextbox],

	// ── Best-effort (pipeline smokes; reward NOT asserted) ──
	["focus-text-2", focusFirstTextbox],
	["click-test-2", clickButtonNamedInGoal],
	["click-button", clickButtonNamedInGoal],
	["click-dialog-2", clickButtonNamedInGoal],
	["click-link", clickLinkNamedInGoal],
	["enter-text", typeQuotedIntoTextbox],
	["enter-password", typeQuotedIntoTextbox],
	["enter-text-dynamic", typeQuotedIntoTextbox],
	["login-user", loginUser],
	["login-user-popup", loginUser],
]);

/**
 * Tasks whose trivial solver is expected to earn reward. The test
 * asserts `rawReward > 0` for these. Everything else in
 * {@link SOLVERS} only asserts the pipeline didn't fail.
 */
export const CONFIDENT_TASKS = new Set<string>([
	"click-test",
	"click-dialog",
	"focus-text",
]);
