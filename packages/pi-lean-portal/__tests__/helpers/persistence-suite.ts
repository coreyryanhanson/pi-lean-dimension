/**
 * Shared persistence suite — a generic, backend-agnostic test helper that
 * validates the cookie-persistence lifecycle across navigations.
 *
 * Every interactive browser backend (shipped Python, user-installed stealth)
 * should produce the same persistence behaviour: navigate → consent dialog
 * visible → click Accept All → cookie set → re-navigate → dialog absent
 * → storage-state.json on disk → third navigate still clean.
 *
 * This helper owns the six `it` blocks and the consent-dialog click flow
 * that every persistence file previously copy-pasted. The caller is
 * responsible for:
 *
 *   - Prerequisite probing (path-based venv probe or `probeUserBackend`)
 *   - Adapter construction (choosing shipped vs contributed paths)
 *   - Test server lifecycle (start/stop)
 *   - Passing `describe` or `describe.skip` depending on availability
 *
 * The helper references no backend names and no stealth-engine identifiers.
 * It is git-tracked and policy-clean.
 *
 * @module
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import type { BrowserPlugin } from "../../core/plugin-api.js";
import { sessionManager } from "../../core/shared/session-manager.js";
import {
	loadStorageState,
	deleteStorageState,
} from "../../core/shared/storage-state.js";

// ─── Types ─────────────────────────────────────────────────────────

/**
 * Callable signature that matches both `describe` and `describe.skip`.
 * The caller picks which one to pass based on their prerequisite probe.
 */
export type DescribeFn = (
	name: string,
	fn: () => void,
	timeout?: number,
) => void;

/** Options for {@link runPersistenceSuite}. */
export interface PersistenceSuiteOptions {
	/**
	 * Backend name, used in `it()` titles and profile prefix for
	 * attribution (e.g. `"my-backend"`).
	 */
	name: string;

	/**
	 * Getter that returns the base URL of the local HTTP test server
	 * serving {@link COOKIE_PERSISTENCE_HTML} (the consent-dialog page).
	 *
	 * Implemented as a getter (rather than a plain string) because the
	 * URL is only known after the caller's `beforeAll` starts the test
	 * server.  The helper calls this lazily from its own `beforeAll` /
	 * `it` blocks, by which point the caller's `beforeAll` has set the
	 * value.
	 *
	 * Example:
	 * ```ts
	 * let serverUrl: string;
	 * beforeAll(async () => { serverUrl = (await startTestServer(h)).url; });
	 * runPersistenceSuite(describe, { getServerUrl: () => serverUrl, ... });
	 * ```
	 */
	getServerUrl: () => string;

	/**
	 * Factory that constructs and **initialises** a fresh plugin instance
	 * for the suite.  Called once from the helper's `beforeAll`.
	 *
	 * The caller owns probe + adapter construction (shipped backends use
	 * path-based venv probing; contributed backends use
	 * `probeUserBackend`, and should pass the correct paths into the
	 * adapter constructor here.
	 */
	createPlugin: () => Promise<BrowserPlugin>;

	/** Per-navigate timeout in milliseconds (default 30_000). */
	navTimeout?: number;

	/** Timeout for the enclosing `describe` block (default 120_000). */
	describeTimeout?: number;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Run the six persistence `it` blocks against the provided plugin.
 *
 * The describe block is **gated by the caller**: pass a real `describe`
 * when prerequisites are met, or `describe.skip` to skip the entire
 * suite.  The helper does **not** probe — that is the caller's job.
 *
 * Six `it` blocks (all parametrised with `opts.name` for attribution):
 * 1. Navigate with named profile → consent dialog visible
 * 2. Click Accept All → cookie set, dialog closes
 * 3. Create session + set persistState (simulates the router's setup)
 * 4. Re-navigate with same profile → dialog absent (cookies survived)
 * 5. storage-state.json on disk with the consent cookie
 * 6. Third navigate → still no dialog (persistence confirmed)
 *
 * @param describeFn  `describe` when available, `describe.skip` otherwise.
 * @param opts        Suite options.  See {@link PersistenceSuiteOptions}.
 */
export function runPersistenceSuite(
	describeFn: DescribeFn,
	opts: PersistenceSuiteOptions,
): void {
	const {
		name,
		getServerUrl,
		createPlugin,
		navTimeout = 30_000,
		describeTimeout = 120_000,
	} = opts;

	const TASK_ID = `${name}-persistence`;

	describeFn(
		`${name} cookie persistence across navigations`,
		() => {
			const TEST_PROFILE = `${name}-persist-${Date.now()}`;

			let plugin: BrowserPlugin;

			beforeAll(async () => {
				plugin = await createPlugin();
			});

			afterAll(async () => {
				await plugin.cleanupAll().catch(() => {});
				deleteStorageState(TEST_PROFILE);
			});

			it(`${name}: navigates with a named profile — consent dialog is visible`, async () => {
				const nav = await plugin.navigate(getServerUrl(), TASK_ID, navTimeout, {
					profileName: TEST_PROFILE,
					profileMode: "named",
				});
				expect(nav.success).toBe(true);
				expect(nav.title).toContain("Cookie Persistence Test");
				expect(nav.snapshot).toContain("Consent");
				expect(nav.snapshot).toContain("Accept All");
			});

			it(`${name}: clicks Accept All — cookie set, consent dialog closes`, async () => {
				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				// Find "Accept All" button in the snapshot and extract its @e ref
				const btnMatch = snap.snapshot.match(/@(e\d+)\b.*?button.*?Accept All/);
				expect(btnMatch).toBeTruthy();
				if (!btnMatch) return;

				const ref = `@${btnMatch[1]!}`;
				const clickResult = await plugin.click(TASK_ID, ref);
				expect(clickResult.success).toBe(true);

				// Verify dialog is gone from snapshot
				if (clickResult.snapshot) {
					expect(clickResult.snapshot).not.toContain("Consent");
				}
			});

			it(`${name}: creates session and sets persistState (simulating the router's setup)`, async () => {
				sessionManager.createSession(TASK_ID, name);
				const session = sessionManager.getSession(TASK_ID);
				expect(session).toBeDefined();
				if (session) {
					session.persistState = true;
					session.profileName = TEST_PROFILE;
				}
			});

			it(`${name}: navigates again with same profile — consent dialog does NOT reappear`, async () => {
				const nav = await plugin.navigate(getServerUrl(), TASK_ID, navTimeout, {
					profileName: TEST_PROFILE,
					profileMode: "named",
				});
				expect(nav.success).toBe(true);

				// Consent dialog should NOT be present — cookies survived in-context
				expect(nav.snapshot).not.toContain("Consent");
				expect(nav.snapshot).not.toContain("Accept All");
			});

			it(`${name}: storage-state.json exists on disk with the consent cookie`, async () => {
				const state = loadStorageState(TEST_PROFILE);
				expect(state).not.toBeNull();
				expect(state!.cookies.length).toBeGreaterThan(0);

				const consentCookie = state!.cookies.find(
					(c: { name: string; value: string }) =>
						c.name === "consent" && c.value === "accepted",
				);
				expect(consentCookie).toBeDefined();
			});

			it(`${name}: third navigate also has no consent dialog (persistence confirmed)`, async () => {
				const nav = await plugin.navigate(getServerUrl(), TASK_ID, navTimeout, {
					profileName: TEST_PROFILE,
					profileMode: "named",
				});
				expect(nav.success).toBe(true);

				// Dialog should still be absent
				expect(nav.snapshot).not.toContain("Consent");
				expect(nav.snapshot).not.toContain("Accept All");
			});
		},
		describeTimeout,
	);
}
