/**
 * Reusable MiniWoB++ suite machinery — Step 3 of
 * `miniwob-integration-plan.md`.
 *
 * The project-maintained `miniwob.test.ts` drives the **four shipped
 * backends** (`chromium`, `firefox`, `chromium-py`, `firefox-py`)
 * through every MiniWoB task using the helpers in this file. User-
 * installed backends (camoufox-py, invisible-py, or any future custom
 * plugin) are NOT hardcoded here — instead, this file exports
 * everything a user-owned parity test file needs to register its own
 * backend against the same task suite:
 *
 * ```ts
 * // my-miniwob-stealth.test.ts (user-owned)
 * import { describe } from "vitest";
 * import { registerMiniwobSuite, type MiniwobBackend } from "./helpers/miniwob-suite.js";
 * import { startMiniwobServer } from "./helpers/miniwob.js";
 * import { PythonPluginAdapter } from "../backends/python-adapter.js";
 *
 * const backend: MiniwobBackend = { name: "camoufox-py", available: ..., initPlugin: ... };
 *
 * describe("my stealth parity", () => {
 *   let server;
 *   beforeAll(async () => { server = await startMiniwobServer(); });
 *   afterAll(async () => { if (server) await server.stop().catch(() => {}); });
 *   registerMiniwobSuite(backend, async () => server.url.replace(/\/$/, ""));
 * });
 * ```
 *
 * This keeps the ownership boundary clean: shipped code ↔ shipped
 * plugins; user-owned code ↔ user-installed plugins. A known parity
 * gap in a user backend (e.g. camoufox-py's setup-injection race —
 * see `miniwob-integration-plan.md` Step 3) lives in the user's test
 * file or the plan doc, not in project-maintained code.
 *
 * ── Attribution ─────────────────────────────────────────────────
 *
 * MiniWoB++ © Farama-Foundation (Apache-2.0); BrowserGym © ServiceNow
 * (Apache-2.0). The setup JS and reward protocol live in
 * `helpers/miniwob.ts` (with attribution); this file only consumes
 * them. Tests aren't shipped in the published package.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
	MINIWOB_TASKS,
	runMiniwobTask,
	type MiniwobSolver,
	type MiniwobRequires,
} from "./miniwob.js";
import type { BrowserPlugin } from "../../core/plugin-api.js";

// ─── Constants ───────────────────────────────────────────────────

/**
 * Fixed seed for deterministic episode content. MiniWoB's
 * `Math.seedrandom(seed)` makes randomized-content tasks (email-inbox,
 * click-checkboxes, form-sequence) reproducible run-to-run.
 */
export const SEED = 12345;

/** Per-test timeout — navigate + setup + solve + done-poll can take ~20s. */
export const TEST_TIMEOUT = 60_000;

// ─── Snapshot parsing helpers ────────────────────────────────────

/**
 * A minimal view of an `@e`-ref snapshot line: ref, accessible name,
 * and the raw line (kept for role-keyword substring checks, which are
 * more tolerant of icon/whitespace variance than a strict role parse).
 */
export interface SnapEl {
	ref: string;
	name: string;
	line: string;
}

/**
 * Parse an accessibility snapshot into {@link SnapEl}s, one per
 * `@e<digits>` line. Role is NOT parsed out as a field; use
 * {@link withRole} to filter by role keyword (matched as a substring
 * of the rendered line, e.g. `"button"`, `"textbox"`, `"link"`).
 *
 * The snapshot line format (from `core/shared/accessibility-tree.ts`)
 * is `{indent}@e{n} {icon} {role} "{name}" [props]`, where the icon
 * carries a trailing space (e.g. `🔘 `). We extract the ref via
 * `/@(e\d+)/` and the name via `/"([^"]*)"/`; role is left to
 * {@link withRole} for tolerant matching.
 */
export function parseRefs(snapshot: string): SnapEl[] {
	const out: SnapEl[] = [];
	for (const line of snapshot.split("\n")) {
		const refMatch = line.match(/@(e\d+)/);
		if (!refMatch?.[1]) continue;
		const nameMatch = line.match(/"([^"]*)"/);
		out.push({
			ref: `@${refMatch[1]}`,
			name: nameMatch?.[1] ?? "",
			line,
		});
	}
	return out;
}

/**
 * Filter elements whose snapshot line contains the role keyword as a
 * whole word. The rendered line embeds the role literally (e.g.
 * `@e2 🔘 button "Cancel"`), so a word-boundary match avoids the
 * `button`/`spinbutton` and `checkbox`/`menuitemcheckbox` collisions
 * a naive `.includes()` would produce.
 */
export function withRole(els: SnapEl[], roleKeyword: string): SnapEl[] {
	const re = new RegExp(`\\b${roleKeyword}\\b`);
	return els.filter((e) => re.test(e.line));
}

/** Find the first element whose line contains any of the keywords. */
export function firstWith(
	els: SnapEl[],
	...roleKeywords: string[]
): SnapEl | undefined {
	for (const kw of roleKeywords) {
		const found = withRole(els, kw);
		if (found.length > 0) return found[0];
	}
	return undefined;
}

/**
 * Extract double-quoted strings from the goal utterance. MiniWoB
 * utterances typically quote the target text (button name, link text,
 * the text to type, the username/password), e.g.
 * `Click on the "Cancel" button` or `Enter "hello world" into the
 * textfield`. Returns `[]` when the utterance is unquoted — callers
 * fall back to a generic action in that case.
 */
export function goalQuotedTexts(goal: string): string[] {
	const out: string[] = [];
	const re = /"([^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(goal)) !== null) {
		if (m[1]) out.push(m[1]);
	}
	return out;
}

// ─── Trivial solvers ─────────────────────────────────────────────

/**
 * Click the first button on the page. Solves `click-test` (single
 * button) and `click-dialog` (a dialog's close/OK button is the
 * obvious click target).
 */
export const clickFirstButton: MiniwobSolver = async ({
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
export const focusFirstTextbox: MiniwobSolver = async ({
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
export const clickButtonNamedInGoal: MiniwobSolver = async ({
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
export const clickLinkNamedInGoal: MiniwobSolver = async ({
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
export const typeQuotedIntoTextbox: MiniwobSolver = async ({
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
export const loginUser: MiniwobSolver = async ({
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
export const SOLVERS: Map<string, MiniwobSolver> = new Map([
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
 * asserts `WOB_RAW_REWARD_GLOBAL > 0` for these. Everything else in
 * {@link SOLVERS} only asserts the pipeline didn't fail.
 */
export const CONFIDENT_TASKS = new Set<string>([
	"click-test",
	"click-dialog",
	"focus-text",
]);

// ─── Skip reasons for non-element tasks ──────────────────────────

export const SKIP_REASON_BY_REQ: Record<
	Exclude<MiniwobRequires, "element">,
	string
> = {
	coord: "no coordinate-click tool on BrowserPlugin (canvas-rendered task)",
	drag: "no drag action on BrowserPlugin",
	hover: "no slider/continuous-hover tool on BrowserPlugin",
	select: "no spinner/select widget tool on BrowserPlugin",
};

// ─── Backend registry + suite registration ───────────────────────

/**
 * A backend the MiniWoB suite can drive. `available` is the AND of
 * content availability + the backend's own browser prerequisites; the
 * describe block uses `describe` vs `describe.skip` accordingly.
 * `initPlugin` constructs and initializes a fresh plugin instance for
 * the suite's `beforeAll`.
 */
export interface MiniwobBackend {
	name: string;
	available: boolean;
	initPlugin: () => Promise<BrowserPlugin>;
	/**
	 * When set, every task for this backend `it.skip`s with this reason
	 * instead of running. Used for backends with a known parity gap
	 * (e.g. a stealth backend whose eval layer is incompatible with
	 * MiniWoB's setup injection). Remove the entry to re-enable the
	 * backend once the gap is fixed. Useful in user-owned parity test
	 * files to record a gap without spinning up the plugin.
	 */
	knownIssue?: string;
}

/**
 * Registers one `describe` block driving all 125 MiniWoB tasks through
 * `backend`. The block `describe.skip`s when `backend.available` is
 * false. The solver registry, parsing helpers, and task loop are
 * shared across backends — only plugin lifecycle and the describe
 * label differ.
 *
 * @param backend     The backend to drive (shipped or user-installed).
 * @param getBaseUrl  Resolver returning the MiniWoB base URL (the
 *                    `miniwob/html/` root). Called once per backend
 *                    in its `beforeAll` (only when the backend is
 *                    available and has no `knownIssue`). The caller
 *                    owns the server lifecycle — typically a
 *                    file-level `beforeAll`/`afterAll` starts/stops
 *                    `startMiniwobServer()` and `getBaseUrl` returns
 *                    its `url` (or `process.env.MINIWOB_URL`).
 */
export function registerMiniwobSuite(
	backend: MiniwobBackend,
	getBaseUrl: () => Promise<string>,
): void {
	// A backend with a known parity gap skips every task with its reason
	// (the gap is real but not yet fixed — see the `knownIssue` doc). The
	// block still uses `describe` (not `describe.skip`) so each task's
	// `it.skip` carries the per-task reason in the report, but no plugin
	// is spun up.
	const describeFn = backend.available ? describe : describe.skip;
	const skipAll = Boolean(backend.knownIssue);
	const knownIssueReason = backend.knownIssue ?? "";

	describeFn(`MiniWoB++ task suite — ${backend.name}`, () => {
		let plugin: BrowserPlugin;
		let baseUrl: string;

		beforeAll(async () => {
			if (skipAll) return; // no plugin needed for a fully-skipped block
			baseUrl = await getBaseUrl();
			plugin = await backend.initPlugin();
		});

		afterAll(async () => {
			if (plugin) await plugin.cleanupAll().catch(() => {});
		});

		for (const task of MINIWOB_TASKS) {
			const subdomain = task.subdomain;

			// Backend-level known parity gap: skip every task with the reason.
			if (skipAll) {
				it.skip(`${subdomain} — ${knownIssueReason}`, () => {});
				continue;
			}

			// Non-element tasks: skip with the missing-tool reason.
			if (task.requires !== "element") {
				const reason =
					SKIP_REASON_BY_REQ[task.requires] ?? "unsupported capability";
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
					const result = await runMiniwobTask(plugin, subdomain, SEED, solver, {
						baseUrl,
						episodeMaxMs: 30_000,
					});

					// The pipeline must not fail at any setup step
					// (navigate / core-wait / setup-inject / task-ready).
					expect(
						!result.setupFailed,
						result.setupFailed
							? `${subdomain} setup failed: ${result.error ?? "unknown"}`
							: `${subdomain} setup ok`,
					).toBe(true);

					// Confident solvers must earn reward.
					if (confident) {
						expect(
							result.reward,
							`${subdomain} expected reward 1, got ${result.reward}` +
								` (raw=${result.rawReward}, reason=${result.reason || "<none>"})`,
						).toBe(1);
					}

					// Release the per-task browser session — the driver
					// intentionally leaves it alive so failures are inspectable.
					await plugin.cleanup(`miniwob-${subdomain}-${SEED}`).catch(() => {});
				},
				TEST_TIMEOUT,
			);
		}
	});
}
