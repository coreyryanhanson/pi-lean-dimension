/**
 * MiniWoB++ task suite — Step 2 of `miniwob-integration-plan.md`.
 *
 * Drives every MiniWoB++ task through the ChromiumPlugin via the
 * {@link runMiniwobTask} helper (Step 1) and asserts the plugin
 * pipeline behaves. This is the behavioral-contract slice the plan
 * offloads from the hand-rolled HTML fixtures in `plugin-contract.ts`
 * and `reddit-dialog.test.ts`.
 *
 * ── What runs vs. what skips ───────────────────────────────────
 *
 * - **Confident solvers** (3 tasks): `click-test`, `click-dialog`,
 *   `focus-text`. The trivial action (click the only button / focus
 *   the only textbox) IS the task's pass condition, so we assert
 *   `WOB_RAW_REWARD_GLOBAL > 0`.
 * - **Best-effort solvers** (a handful of `click-*`/`enter-*`/
 *   `login-*` tasks): parse the goal utterance for quoted text and
 *   click/type the matching `@e` ref, falling back to the first
 *   matching role. These exercise the full pipeline (navigate →
 *   setup-inject → snapshot → solve → reward-read) but a dumb solver
 *   isn't guaranteed to earn reward, so we only assert the pipeline
 *   didn't fail (`!setupFailed`). They're pipeline smokes, not
 *   intelligence tests — matching the plan's "testing the plugin
 *   pipeline, not agent intelligence".
 * - **Element tasks with no registered solver**: `it.skip` with the
 *   reason `needs goal-aware solver (Step 2 follow-up)`. Register a
 *   solver in `SOLVERS` below to enable.
 * - **Non-element tasks** (`coord`/`drag`/`hover`/`select`): `it.skip`
 *   with the missing-tool reason from `SKIP_REASON_BY_REQ`.
 *
 * ── Auto-skip gate ─────────────────────────────────────────────
 *
 * The whole suite skips when MiniWoB isn't usable: either
 * `MINIWOB_HTML_ROOT` (default `/tmp/miniwob-plusplus/miniwob/html`)
 * doesn't exist AND `MINIWOB_URL` isn't set, or Playwright Chromium
 * isn't installed. This keeps `npm test` / `npm run test:ci` green in
 * environments without the cloned MiniWoB++ tree (see the plan's
 * Step 4 setup script). Run the suite explicitly with
 * `npm run test:miniwob`.
 *
 * ── Attribution ───────────────────────────────────────────────
 *
 * MiniWoB++ © Farama-Foundation (Apache-2.0); BrowserGym © ServiceNow
 * (Apache-2.0). The setup JS and reward protocol are ported in the
 * helper (`helpers/miniwob.ts`) with attribution; this suite only
 * consumes the helper. Tests aren't shipped in the published package.
 *
 * Run: npm run test:miniwob
 *      npx vitest run packages/pi-lean-portal/__tests__/miniwob.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

import { ChromiumPlugin } from "../backends/chromium/index.js";
import {
	MINIWOB_TASKS,
	runMiniwobTask,
	startMiniwobServer,
	type MiniwobSolver,
	type MiniwobRequires,
} from "./helpers/miniwob.js";
import type { TestServer } from "./helpers/test-server.js";

// ─── Constants ───────────────────────────────────────────────────

/**
 * Fixed seed for deterministic episode content. MiniWoB's
 * `Math.seedrandom(seed)` makes randomized-content tasks (email-inbox,
 * click-checkboxes, form-sequence) reproducible run-to-run.
 */
const SEED = 12345;

/** Per-test timeout — navigate + setup + solve + done-poll can take ~20s. */
const TEST_TIMEOUT = 60_000;

const HTML_ROOT =
	process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";

// ─── Availability gate ───────────────────────────────────────────

/** True when an external MiniWoB server is pointed at via MINIWOB_URL. */
const HAS_EXTERNAL_URL = Boolean(process.env.MINIWOB_URL);

/** True when the cloned MiniWoB++ html root is present on disk. */
const HTML_ROOT_PRESENT = existsSync(resolve(HTML_ROOT));

/** True when Playwright Chromium is installed (mirrors firefox.test.ts). */
const CHROMIUM_AVAILABLE = (() => {
	try {
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
})();

/**
 * The suite runs only when MiniWoB content is reachable (external URL
 * OR local html root) AND Chromium is installed. Otherwise every test
 * is skipped — no hangs, no false failures in bare CI.
 */
const SUITE_AVAILABLE =
	(HAS_EXTERNAL_URL || HTML_ROOT_PRESENT) && CHROMIUM_AVAILABLE;

const describeIfAvailable = SUITE_AVAILABLE ? describe : describe.skip;

// ─── Snapshot parsing helpers ────────────────────────────────────

/**
 * A minimal view of an `@e`-ref snapshot line: ref, accessible name,
 * and the raw line (kept for role-keyword substring checks, which are
 * more tolerant of icon/whitespace variance than a strict role parse).
 */
interface SnapEl {
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
function parseRefs(snapshot: string): SnapEl[] {
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
function withRole(els: SnapEl[], roleKeyword: string): SnapEl[] {
	const re = new RegExp(`\\b${roleKeyword}\\b`);
	return els.filter((e) => re.test(e.line));
}

/** Find the first element whose line contains any of the keywords. */
function firstWith(
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
function goalQuotedTexts(goal: string): string[] {
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
const clickFirstButton: MiniwobSolver = async ({
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
const focusFirstTextbox: MiniwobSolver = async ({
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
const clickButtonNamedInGoal: MiniwobSolver = async ({
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
const clickLinkNamedInGoal: MiniwobSolver = async ({
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
const typeQuotedIntoTextbox: MiniwobSolver = async ({
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
const loginUser: MiniwobSolver = async ({ plugin, taskId, snapshot, goal }) => {
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
 * test generator below picks it up automatically. Tasks absent from
 * this map are reported as `it.skip` with a
 * `needs goal-aware solver (Step 2 follow-up)` reason.
 */
const SOLVERS: Map<string, MiniwobSolver> = new Map([
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
const CONFIDENT_TASKS = new Set<string>([
	"click-test",
	"click-dialog",
	"focus-text",
]);

// ─── Skip reasons for non-element tasks ──────────────────────────

const SKIP_REASON_BY_REQ: Record<
	Exclude<MiniwobRequires, "element">,
	string
> = {
	coord: "no coordinate-click tool on BrowserPlugin (canvas-rendered task)",
	drag: "no drag action on BrowserPlugin",
	hover: "no slider/continuous-hover tool on BrowserPlugin",
	select: "no spinner/select widget tool on BrowserPlugin",
};

// ─── Suite ───────────────────────────────────────────────────────

describeIfAvailable("MiniWoB++ task suite (Step 2)", () => {
	let plugin: ChromiumPlugin;
	let baseUrl: string;
	let server: TestServer | null = null;

	beforeAll(async () => {
		if (process.env.MINIWOB_URL) {
			baseUrl = process.env.MINIWOB_URL;
		} else {
			server = await startMiniwobServer(HTML_ROOT);
			baseUrl = server.url;
		}
		plugin = new ChromiumPlugin();
		await plugin.init({});
	});

	afterAll(async () => {
		if (plugin) await plugin.cleanupAll().catch(() => {});
		if (server) await server.stop().catch(() => {});
	});

	for (const task of MINIWOB_TASKS) {
		const subdomain = task.subdomain;

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
