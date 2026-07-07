/**
 * Adapter smoke test — proves the end-to-end MiniWoB pipeline works
 * against the shipped `chromium` plugin (Mode A): the plugin launches
 * Chromium with `--remote-debugging-port=0`, `getAttachEndpoint()` resolves
 * the port, the Python driver attaches via `connect_over_cdp`, runs
 * setup + validate, and a trivial inline solver drives the page through
 * the `@e`-ref action layer.
 *
 * Uses `click-test` (the confident single-button task — clicking the
 * only button IS the pass condition) with an inline "click first
 * button" solver. Asserts `rawReward > 0`.
 *
 * Auto-skip gates (keeps `npm test` / `npm run test:ci` green in
 * bare environments):
 *   - Playwright Chromium installed (Node side)
 *   - MiniWoB++ html root present on disk (or `MINIWOB_URL` set)
 *
 * Run: npx vitest run packages/pi-lean-host/suites/adapter-smoke.test.ts
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { ChromiumPlugin } from "../../pi-lean-portal/backends/chromium/index.js";
import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";
import type { TestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";
import { startMiniwobServer } from "../scripts/miniwob-server.js";
import {
	runMiniwobTask,
	type TrivialSolver,
} from "../adapter/miniwob-adapter.js";

// --- Paths ---------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
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

const CONTENT_AVAILABLE =
	Boolean(process.env.MINIWOB_URL) || existsSync(resolve(HTML_ROOT));

function skipReason(): string {
	if (!CHROMIUM_AVAILABLE)
		return "Playwright Chromium not installed (npx playwright install chromium)";
	if (!CONTENT_AVAILABLE)
		return "MiniWoB content missing (npm run setup:miniwob)";
	return "unknown prerequisite missing";
}

const SHOULD_RUN = CHROMIUM_AVAILABLE && CONTENT_AVAILABLE;

// --- Inline trivial solver + @e-ref parser ---

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

describe("MiniWoB adapter smoke — chromium + click-test", () => {
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
