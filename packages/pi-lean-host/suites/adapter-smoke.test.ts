/**
 * Adapter smoke test — Batch B acceptance proof for
 * `browsergym-migration-plan-v2.md` §1.2–1.3.
 *
 * Proves the end-to-end BrowserGym pipeline works against the
 * shipped `chromium` plugin (Mode A): the plugin launches Chromium
 * with `--remote-debugging-port=0`, `getCdpEndpoint()` resolves the
 * port, the Python bridge attaches via `connect_over_cdp`, runs
 * `task.setup(page)` + `task.validate(page)`, and a trivial inline
 * solver drives the page through the `@e`-ref action layer.
 *
 * Uses `click-test` (the confident single-button task — clicking the
 * only button IS the pass condition) with an inline "click first
 * button" solver. Asserts `rawReward > 0`. Batch C moves the real
 * 13-solver suite + the `@e`-ref parser into `pi-lean-host/solvers/`
 * and replaces this with the full `miniwob-trivial.test.ts`.
 *
 * Auto-skip gates (keeps `npm test` / `npm run test:ci` green in
 * bare environments):
 *   - Playwright Chromium installed (Node side)
 *   - BrowserGym venv present at `packages/pi-lean-host/venv/`
 *   - `browsergym.miniwob` importable from the venv
 *   - MiniWoB++ html root present on disk (or `MINIWOB_URL` set)
 *
 * Run: npx vitest run packages/pi-lean-host/suites/adapter-smoke.test.ts
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { ChromiumPlugin } from "../../pi-lean-portal/backends/chromium/index.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";
import type { TestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";
import { startMiniwobServer } from "../../pi-lean-portal/__tests__/helpers/miniwob.js";
import {
	runMiniwobTask,
	type TrivialSolver,
} from "../adapter/browsergym-adapter.js";

// --- Paths ---------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_PKG_DIR = resolve(__dirname, "..");
const VENV_PYTHON = resolve(HOST_PKG_DIR, "venv", "bin", "python3");
const HTML_ROOT =
	process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";

// --- Availability gates --------------------------------------------

const CHROMIUM_AVAILABLE = (() => {
	try {
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
})();

const VENV_AVAILABLE = existsSync(VENV_PYTHON);

/** True when `browsergym.miniwob` imports cleanly under the venv python. */
const BROWSERGYM_AVAILABLE = (() => {
	if (!VENV_AVAILABLE) return false;
	try {
		const res = spawnSync(
			VENV_PYTHON,
			["-c", "import browsergym.miniwob; print('ok')"],
			{ stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
		);
		return res.status === 0 && res.stdout.toString().trim() === "ok";
	} catch {
		return false;
	}
})();

const CONTENT_AVAILABLE =
	Boolean(process.env.MINIWOB_URL) || existsSync(resolve(HTML_ROOT));

function skipReason(): string {
	if (!CHROMIUM_AVAILABLE)
		return "Playwright Chromium not installed (npx playwright install chromium)";
	if (!VENV_AVAILABLE)
		return "BrowserGym venv missing (npm run setup:venv -w pi-lean-host)";
	if (!BROWSERGYM_AVAILABLE)
		return "browsergym.miniwob not importable from the venv";
	if (!CONTENT_AVAILABLE)
		return "MiniWoB content missing (npm run setup:miniwob)";
	return "unknown prerequisite missing";
}

const SHOULD_RUN =
	CHROMIUM_AVAILABLE &&
	VENV_AVAILABLE &&
	BROWSERGYM_AVAILABLE &&
	CONTENT_AVAILABLE;

// --- Inline trivial solver + @e-ref parser (Batch C moves the real ones) ---

/** Parse `@e`-ref snapshot lines into `{ref, line}` pairs. */
function parseRefs(snapshot: string): { ref: string; line: string }[] {
	const out: { ref: string; line: string }[] = [];
	for (const line of snapshot.split("\n")) {
		const m = line.match(/@(e\d+)/);
		if (m?.[1]) out.push({ ref: `@${m[1]}`, line });
	}
	return out;
}

/** Click the first button on the page — solves `click-test` (single button). */
const clickFirstButton: TrivialSolver = async ({
	plugin,
	taskId,
	snapshot,
}) => {
	const btn = parseRefs(snapshot).find((e) => /\bbutton\b/.test(e.line));
	if (btn) await plugin.click(taskId, btn.ref);
};

// --- Suite ---------------------------------------------------------

describe("BrowserGym adapter smoke — chromium + click-test", () => {
	let plugin: BrowserPlugin | undefined;
	let server: TestServer | null = null;
	let baseUrl = "";

	beforeAll(async () => {
		if (!SHOULD_RUN) return;
		if (process.env.MINIWOB_URL) {
			baseUrl = process.env.MINIWOB_URL;
		} else {
			server = await startMiniwobServer(HTML_ROOT);
			baseUrl = server.url;
		}
		plugin = new ChromiumPlugin();
		await plugin.init?.({});
	});

	afterAll(async () => {
		if (plugin) await plugin.cleanupAll().catch(() => {});
		if (server) await server.stop().catch(() => {});
	});

	// One test: runs when prerequisites are met, skips (with reason) otherwise.
	const itFn = SHOULD_RUN ? it : it.skip;
	itFn(
		SHOULD_RUN
			? "runMiniwobTask(click-test) returns rawReward > 0"
			: `prerequisites missing: ${skipReason()}`,
		async () => {
			const result = await runMiniwobTask({
				plugin: plugin!,
				taskName: "click-test",
				seed: 12345,
				baseUrl,
				actor: "trivial",
				solver: clickFirstButton,
				episodeMaxTimeMs: 30_000,
			});

			expect(
				!result.setupFailed,
				result.error ?? "setup failed (no error message)",
			).toBe(true);
			expect(
				result.rawReward,
				`expected rawReward > 0, got ${result.rawReward}` +
					` (done=${result.done}, reason=${result.reason || "<none>"},` +
					` steps=${result.steps}, goal=${result.goal || "<none>"})`,
			).toBeGreaterThan(0);
		},
		60_000,
	);
});
