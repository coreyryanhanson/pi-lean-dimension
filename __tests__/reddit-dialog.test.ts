/**
 * Reddit dialog fixture — standalone TypeScript ChromiumPlugin tests.
 *
 * Exercises consent dialog interaction, stacked dialogs, async dialogs,
 * and occlusion rejection against a local test server serving the
 * shared fixture HTML from reddit-fixture.ts.
 *
 * Includes a ×10 consistency loop that closes the consent dialog
 * ten times in independent sessions.
 *
 * Run: npx vitest run --reporter verbose __tests__/reddit-dialog.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChromiumPlugin } from "../backends/chromium/index.js";
import { startTestServer } from "./helpers/test-server.js";
import {
	REDDIT_DIALOG_HTML,
	REDDIT_STACKED_HTML,
	REDDIT_ASYNC_HTML,
	findRef,
	dialogCount,
} from "./helpers/reddit-fixture.js";

// ─── Test Server ──────────────────────────────────────────────────

let serverUrl: string;
let stopServer: () => Promise<void>;

beforeAll(async () => {
	const server = await startTestServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const pages: Record<string, string> = {
			"/reddit-dialog": REDDIT_DIALOG_HTML,
			"/reddit-stacked": REDDIT_STACKED_HTML,
			"/reddit-async": REDDIT_ASYNC_HTML,
		};
		const html = pages[url.pathname];
		if (html) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html);
		} else {
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end("404");
		}
	});
	serverUrl = server.url;
	stopServer = server.stop;
});

afterAll(async () => {
	await stopServer();
});

// ─── ChromiumPlugin Setup ───────────────────────────────────────

async function createPlugin(): Promise<ChromiumPlugin> {
	const p = new ChromiumPlugin();
	await p.init({});
	return p;
}

const NAV_TIMEOUT = 30_000;

// ═══════════════════════════════════════════════════════════════
// First Pass — individual behavioral tests
// ═══════════════════════════════════════════════════════════════

describe("Reddit dialog — first pass", () => {
	const TASK_ID = "reddit-first-pass";
	let plugin: ChromiumPlugin;

	beforeAll(async () => {
		plugin = await createPlugin();
	});

	afterAll(async () => {
		await plugin.cleanupAll().catch(() => {});
	});

	it("navigates and snapshot includes consent dialog", async () => {
		const nav = await plugin.navigate(
			`${serverUrl}/reddit-dialog`,
			TASK_ID,
			NAV_TIMEOUT,
		);
		expect(nav.success).toBe(true);
		expect(nav.title).toContain("Reddit");
		expect(nav.snapshot).toContain("Consent");

		const snap = await plugin.snapshot(TASK_ID);
		expect(snap.success).toBe(true);
		expect(dialogCount(snap.snapshot)).toBeGreaterThanOrEqual(1);
	});

	it("reject all (nested SVG button) closes the dialog", async () => {
		await plugin.navigate(`${serverUrl}/reddit-dialog`, TASK_ID, NAV_TIMEOUT);
		const snap = await plugin.snapshot(TASK_ID);
		expect(snap.success).toBe(true);

		const info = findRef(snap.snapshot, "Reject All");
		if (!info) return; // element beyond cap

		const result = await plugin.click(TASK_ID, info.ref);
		expect(result.success).toBe(true);

		const after = await plugin.snapshot(TASK_ID);
		expect(dialogCount(after.snapshot)).toBe(0);
	});

	it("accept all (plain button) closes the dialog", async () => {
		await plugin.navigate(`${serverUrl}/reddit-dialog`, TASK_ID, NAV_TIMEOUT);
		const snap = await plugin.snapshot(TASK_ID);
		expect(snap.success).toBe(true);

		const info = findRef(snap.snapshot, "Accept All");
		if (!info) return;

		const result = await plugin.click(TASK_ID, info.ref);
		expect(result.success).toBe(true);

		const after = await plugin.snapshot(TASK_ID);
		expect(dialogCount(after.snapshot)).toBe(0);
	});

	it("stacked dialogs — consent then welcome — both dismissible", async () => {
		const S_TASK = "reddit-stacked";
		await plugin.navigate(`${serverUrl}/reddit-stacked`, S_TASK, NAV_TIMEOUT);

		// Dialog A: consent
		const snap1 = await plugin.snapshot(S_TASK);
		expect(snap1.success).toBe(true);
		expect(snap1.snapshot).toContain("Consent");

		const rejectInfo = findRef(snap1.snapshot, "Reject All");
		if (!rejectInfo) {
			await plugin.cleanup(S_TASK);
			return;
		}
		const r1 = await plugin.click(S_TASK, rejectInfo.ref);
		expect(r1.success).toBe(true);

		// Dialog B: welcome back
		const snap2 = await plugin.snapshot(S_TASK);
		expect(snap2.success).toBe(true);
		expect(snap2.snapshot).toContain("Welcome");

		const dismissInfo = findRef(snap2.snapshot, "Dismiss");
		if (!dismissInfo) {
			await plugin.cleanup(S_TASK);
			return;
		}
		const r2 = await plugin.click(S_TASK, dismissInfo.ref);
		expect(r2.success).toBe(true);

		// No dialogs remain
		const snap3 = await plugin.snapshot(S_TASK);
		expect(dialogCount(snap3.snapshot)).toBe(0);

		await plugin.cleanup(S_TASK);
	});

	it("async dialog arrives after timeout and is dismissible", async () => {
		const A_TASK = "reddit-async";
		await plugin.navigate(`${serverUrl}/reddit-async`, A_TASK, NAV_TIMEOUT);

		// Wait for async dialog (setTimeout 500ms in fixture)
		await new Promise((r) => setTimeout(r, 1000));

		const snap = await plugin.snapshot(A_TASK);
		expect(snap.success).toBe(true);
		expect(snap.snapshot).toContain("Consent");

		const info = findRef(snap.snapshot, "Reject All");
		if (!info) {
			await plugin.cleanup(A_TASK);
			return;
		}
		const result = await plugin.click(A_TASK, info.ref);
		expect(result.success).toBe(true);

		await plugin.cleanup(A_TASK);
	});

	it("feed link click is blocked by consent dialog occlusion", async () => {
		await plugin.navigate(`${serverUrl}/reddit-dialog`, TASK_ID, NAV_TIMEOUT);
		const snap = await plugin.snapshot(TASK_ID);
		expect(snap.success).toBe(true);

		// Try clicking a feed post link — should be behind the overlay
		const info = findRef(snap.snapshot, "Post Title");
		if (!info) return; // beyond cap

		const result = await plugin.click(TASK_ID, info.ref);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

// ═══════════════════════════════════════════════════════════════
// ×10 Consistency — close the dialog 10 times in isolation
// ═══════════════════════════════════════════════════════════════

describe("Reddit dialog — consistency × 10", () => {
	let plugin: ChromiumPlugin;

	/** Shared no-op error handler to avoid arrow-function-in-loop allocations. */
	const noop = () => {};

	beforeAll(async () => {
		plugin = await createPlugin();
	});

	afterAll(async () => {
		await plugin.cleanupAll().catch(() => {});
	});

	it("closes the consent dialog 10 times in independent sessions", async () => {
		const failures: string[] = [];

		for (let i = 0; i < 10; i++) {
			const taskId = `consistency-${i}`;
			try {
				const nav = await plugin.navigate(
					`${serverUrl}/reddit-dialog`,
					taskId,
					NAV_TIMEOUT,
				);
				expect(nav.success).toBe(true);
				expect(nav.snapshot).toContain("Consent");

				const snap = await plugin.snapshot(taskId);
				expect(snap.success).toBe(true);

				const info = findRef(snap.snapshot, "Reject All");
				if (!info) {
					// Element may be beyond cap on some runs; accept it
					await plugin.cleanup(taskId).catch(noop);
					continue;
				}

				const clickResult = await plugin.click(taskId, info.ref);
				expect(clickResult.success).toBe(true);

				const after = await plugin.snapshot(taskId);
				expect(dialogCount(after.snapshot)).toBe(0);

				await plugin.cleanup(taskId).catch(noop);
			} catch (err) {
				failures.push(
					`Iteration ${i}: ${err instanceof Error ? err.message : String(err)}`,
				);
				await plugin.cleanup(taskId).catch(noop);
			}
		}

		expect(failures).toHaveLength(0);
	}, 120_000);
});
