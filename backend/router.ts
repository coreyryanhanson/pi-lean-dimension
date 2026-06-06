/**
 * Backend Router — auto-escalation logic and backend dispatch.
 *
 * Dispatches to Level 2 (Playwright Chromium) or
 * Level 3 (Invisible Playwright stealth Firefox) based on strategy
 * and auto-detection. Stateless HTTP fetches are handled by
 * web-fetch (see fetch-backend.ts).
 */

import * as playwrightBackend from "./playwright-backend";
import * as stealthBackend from "./stealth-backend";
import {
	sessionManager,
	type BackendLevel,
	type BrowserSession,
} from "../utils/session-manager";
import { validateUrl } from "../utils/url-safety";

/** Backend that was actually used for a navigation. */
export type BackendUsed = BackendLevel;

// ─── Snapshot truncation constants ────────────────────────────────────

/**
 * Snapshots shorter than this are returned as-is (no truncation).
 */
const COMPACT_SNAPSHOT_NO_TRUNCATE = 2800;

/**
 * Target truncation length for compact snapshots (newline-aware).
 */
const COMPACT_SNAPSHOT_LIMIT = 2500;

/**
 * Snapshots exceeding this length use "very large page" strategy:
 * keep the structural top (~2000 chars) and append a summary.
 */
const COMPACT_SNAPSHOT_VERY_LARGE = 8000;

/**
 * How much of the top of the tree to preserve for very large pages.
 */
const COMPACT_SNAPSHOT_TOP_LIMIT = 2000;

// ─── Helpers — Interactive session management ──────────────────────────

/**
 * Get or create an interactive (chromium/stealth) session for the given task.
 *
 * If an interactive session already exists, returns it.
 * If no session exists but a last-navigation URL is available (e.g. from a
 * prior fetch-level navigate), auto-creates a chromium session, navigates
 * to that URL, and returns the session. Falls back to stealth if chromium
 * hits bot detection.
 *
 * Returns null if no session can be established.
 */
async function requireInteractiveSession(
	taskId: string,
): Promise<{ session: BrowserSession; wasAutoEscalated: boolean } | null> {
	const existing = sessionManager.getSession(taskId);
	if (existing) return { session: existing, wasAutoEscalated: false };

	// No session — try auto-escalation via lastNav
	const lastNav = sessionManager.getLastNav(taskId);
	if (!lastNav) return null;

	// Try chromium first
	sessionManager.createSession(taskId, "chromium");
	const session = sessionManager.getSession(taskId)!;
	session.currentUrl = lastNav.url;
	session.currentTitle = lastNav.title;

	const navResult = await playwrightBackend.navigate(
		lastNav.url,
		taskId,
		30000,
	);
	if (navResult.success && !navResult.botDetected) {
		session.currentUrl = navResult.url;
		session.currentTitle = navResult.title;
		return { session, wasAutoEscalated: true };
	}

	// Bot detected or failed — try stealth
	if (navResult.botDetected || !navResult.success) {
		await playwrightBackend.cleanup(taskId).catch(() => {});
		sessionManager.updateSession(taskId, { level: "stealth" });
		const stealthResult = await stealthBackend.navigate(
			lastNav.url,
			taskId,
			30000,
		);
		if (stealthResult.success) {
			session.currentUrl = stealthResult.url;
			session.currentTitle = stealthResult.title;
			return { session, wasAutoEscalated: true };
		}
	}

	// Both failed
	await playwrightBackend.cleanup(taskId).catch(() => {});
	await stealthBackend.cleanup(taskId).catch(() => {});
	sessionManager.removeSession(taskId);
	return null;
}

/**
 * Take a snapshot of the current interactive session.
 * Used after auto-escalation to return the new page state to the model.
 */
async function takeSnapshotAfterEscalation(
	taskId: string,
	full: boolean = false,
): Promise<SnapshotResult> {
	const session = sessionManager.getSession(taskId);
	if (!session) {
		return {
			success: false,
			snapshot: "",
			elementCount: 0,
			error: "No session after escalation",
		};
	}

	let result: SnapshotResult;
	if (session.level === "chromium") {
		result = await playwrightBackend.snapshot(taskId);
	} else if (session.level === "stealth") {
		result = await stealthBackend.snapshot(taskId);
	} else {
		return {
			success: false,
			snapshot: "",
			elementCount: 0,
			error: "Unknown session level",
		};
	}

	if (result.success && !full) {
		result.snapshot = compactSnapshot(result.snapshot, result.elementCount);
	}
	return result;
}

// ─── Types ────────────────────────────────────────────────────────────

export interface NavigateOptions {
	strategy?: "auto" | BackendLevel;
	timeout?: number;
	signal?: AbortSignal;
	taskId?: string;
}

export interface NavigateResult {
	success: boolean;
	url: string;
	title: string;
	/** Page content — accessibility tree for chromium/stealth */
	content: string;
	backendUsed: BackendUsed;
	/** Number of interactive elements (for a11y tree) */
	elementCount?: number;
	/** Bot detection warning flag */
	botDetectionWarning?: boolean;
	/** Error message (absent on success) */
	error?: string;
}

export interface SnapshotResult {
	success: boolean;
	snapshot: string;
	elementCount: number;
	error?: string;
}

export interface InteractionResult {
	success: boolean;
	error?: string;
	newUrl?: string;
	newTitle?: string;
	/** Auto-captured snapshot after interaction, when available */
	snapshot?: string;
	/** Number of elements in the auto-captured snapshot */
	elementCount?: number;
}

export interface ScreenshotResult {
	success: boolean;
	dataUri: string;
	error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Try to escalate to stealth backend when bot detection is triggered
 * and the strategy is auto. Returns the stealth result if successful,
 * or null if escalation wasn't applicable or failed.
 */
async function escalateToStealthIfAuto(
	result: { url: string; error?: string; botDetected?: boolean },
	strategy: string,
	taskId: string,
	timeoutMs: number,
): Promise<{
	success: boolean;
	url: string;
	title: string;
	content: string;
	elementCount?: number;
	backendUsed: BackendUsed;
	botDetectionWarning: boolean;
	error?: string;
} | null> {
	if (result.botDetected && strategy === "auto") {
		// Ensure a session exists (defensive: in normal flow the chromium block
		// already called createSession, but be safe)
		if (!sessionManager.getSession(taskId)) {
			sessionManager.createSession(taskId, "stealth");
		} else {
			sessionManager.updateSession(taskId, { level: "stealth" });
		}
		const stealthResult = await stealthBackend.navigate(
			result.url,
			taskId,
			timeoutMs,
		);
		if (stealthResult.success) {
			return {
				success: true,
				url: stealthResult.url,
				title: stealthResult.title,
				content: compactSnapshot(
					stealthResult.snapshot,
					stealthResult.elementCount,
				),
				elementCount: stealthResult.elementCount,
				backendUsed: "stealth",
				botDetectionWarning: true,
			};
		}
	}
	return null;
}

// ─── Navigation ───────────────────────────────────────────────────────

export async function navigate(
	url: string,
	options: NavigateOptions = {},
): Promise<NavigateResult> {
	const strategy = options.strategy ?? "auto";
	const timeoutMs = (options.timeout ?? 30) * 1000;
	const taskId = options.taskId ?? "default";

	let normalizedUrl: string;
	try {
		normalizedUrl = new URL(url).href;
	} catch {
		return {
			success: false,
			url,
			title: "",
			content: `Invalid URL: ${url}`,
			backendUsed: "chromium",
			error: "Invalid URL",
		};
	}

	// --- URL Safety Check ---
	const safety = validateUrl(normalizedUrl);
	if (!safety.safe) {
		return {
			success: false,
			url: normalizedUrl,
			title: "",
			content: safety.reason || "URL blocked",
			backendUsed: "chromium",
			error: `URL blocked: ${safety.reason}`,
		};
	}

	// --- Level 2: Playwright Chromium ---
	if (strategy === "chromium" || strategy === "auto") {
		sessionManager.createSession(taskId, "chromium");
		const session = sessionManager.getSession(taskId)!;
		session.currentUrl = normalizedUrl;

		const result = await playwrightBackend.navigate(
			normalizedUrl,
			taskId,
			timeoutMs,
			options.signal,
		);

		if (result.success) {
			session.currentUrl = result.url;
			session.currentTitle = result.title;

			// Store as last-nav for auto-recovery if session crashes later
			sessionManager.setLastNav(taskId, result.url, result.title);

			// Bot detected on successful load — try stealth escalation
			const escalated = await escalateToStealthIfAuto(
				result,
				strategy,
				taskId,
				timeoutMs,
			);
			if (escalated) return escalated;
			// Stealth failed or not applicable — fall through to return chromium result with warning

			const botWarn = result.botDetected && strategy === "auto";
			const snapshotContent = result.snapshot
				? compactSnapshot(result.snapshot, result.elementCount)
				: "";
			return {
				success: true,
				url: result.url,
				title: result.title,
				content: snapshotContent,
				elementCount: result.elementCount,
				backendUsed: "chromium",
				...(botWarn ? { botDetectionWarning: true } : {}),
			};
		}

		// Playwright failed — escalate to Level 3 (stealth) if auto
		const escalated = await escalateToStealthIfAuto(
			result,
			strategy,
			taskId,
			timeoutMs,
		);
		if (escalated) return escalated;

		// Stealth also failed or not applicable — report original error
		// Re-check: if we had bot detection but escalation failed
		if (result.botDetected && strategy === "auto") {
			return {
				success: false,
				url: result.url,
				title: "",
				content: result.error || "Unknown error",
				backendUsed: "chromium",
				botDetectionWarning: true,
				...(result.error ? { error: result.error } : {}),
			};
		}

		// Non-bot error or explicit strategy
		await playwrightBackend.cleanup(taskId).catch(() => {});
		sessionManager.removeSession(taskId);
		return {
			success: false,
			url: result.url,
			title: "",
			content: result.error || "Unknown error",
			backendUsed: "chromium",
			...(result.error ? { error: result.error } : {}),
		};
	}

	// --- Level 3: Invisible Playwright Stealth ---
	if (strategy === "stealth") {
		sessionManager.createSession(taskId, "stealth");
		const session = sessionManager.getSession(taskId)!;
		session.currentUrl = normalizedUrl;

		const result = await stealthBackend.navigate(
			normalizedUrl,
			taskId,
			timeoutMs,
		);

		if (result.success) {
			session.currentUrl = result.url;
			session.currentTitle = result.title;
			// Store as last-nav for auto-recovery if session crashes later
			sessionManager.setLastNav(taskId, result.url, result.title);
			const snapshotContent = result.snapshot
				? compactSnapshot(result.snapshot, result.elementCount)
				: "";
			return {
				success: true,
				url: result.url,
				title: result.title,
				content: snapshotContent,
				elementCount: result.elementCount,
				backendUsed: "stealth",
			};
		}

		await stealthBackend.cleanup(taskId).catch(() => {});
		sessionManager.removeSession(taskId);
		return {
			success: false,
			url: result.url,
			title: "",
			content: result.error || "Unknown error",
			backendUsed: "stealth",
			...(result.error ? { error: result.error } : {}),
		};
	}

	// Fallback
	return {
		success: false,
		url: normalizedUrl,
		title: "",
		content: "Unknown strategy",
		backendUsed: "chromium",
		error: "Unknown strategy",
	};
}

// ─── Snapshot (current page) ──────────────────────────────────────────

export async function snapshot(
	taskId?: string,
	full?: boolean,
): Promise<SnapshotResult> {
	const tid = taskId ?? "default";
	const sessionResult = await requireInteractiveSession(tid);

	if (!sessionResult) {
		return {
			success: false,
			snapshot: "",
			elementCount: 0,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	}

	return takeSnapshotAfterEscalation(tid, full ?? false);
}

/**
 * Truncate a snapshot to a compact view (~2500 chars) that still shows
 * the key structure. Appends a hint to use full=true for the complete tree.
 *
 * For very large snapshots (>8000 chars), preserves the first ~2000 chars
 * of structural content (top of the tree including headings/landmarks)
 * plus a structural summary showing what was cut.
 */
function compactSnapshot(snapshot: string, elementCount: number): string {
	if (snapshot.length <= COMPACT_SNAPSHOT_NO_TRUNCATE) return snapshot;

	const remaining = elementCount > 0 ? elementCount : undefined;

	// For very large pages, try to preserve the top of the tree
	// which typically contains page structure (banner, navigation, headings).
	if (snapshot.length > COMPACT_SNAPSHOT_VERY_LARGE) {
		// Keep first ~COMPACT_SNAPSHOT_TOP_LIMIT chars of the tree top
		let topCut = snapshot.lastIndexOf("\n", COMPACT_SNAPSHOT_TOP_LIMIT);
		if (topCut < COMPACT_SNAPSHOT_TOP_LIMIT / 2)
			topCut = COMPACT_SNAPSHOT_TOP_LIMIT;

		const topSection = snapshot.slice(0, topCut);
		const bottomHint = remaining
			? `\n… ${snapshot.length - topCut} more chars, ${remaining} elements total (use full=true for complete tree)`
			: `\n… ${snapshot.length - topCut} more chars (use full=true for complete tree)`;
		return topSection + bottomHint;
	}

	// Moderate-sized pages: cut at a natural breakpoint near the limit
	let cut = snapshot.lastIndexOf("\n", COMPACT_SNAPSHOT_LIMIT);
	if (cut < COMPACT_SNAPSHOT_LIMIT / 2) cut = COMPACT_SNAPSHOT_LIMIT;

	const tail = remaining
		? `\n… ${snapshot.length - cut} more chars, ${remaining} elements total (use full=true for complete tree)`
		: `\n… ${snapshot.length - cut} more chars (use full=true for complete tree)`;

	return snapshot.slice(0, cut) + tail;
}

/**
 * For interaction tools that use @e refs (click, type, press, scroll, goBack):
 * if the session was just auto-escalated, the old @e refs are stale, so we
 * return a fresh snapshot instead of performing the action.
 */
async function refBasedInteractionOrSnapshot(
	tid: string,
	wasAutoEscalated: boolean,
	action: () => Promise<InteractionResult>,
): Promise<InteractionResult> {
	if (wasAutoEscalated) {
		const snap = await takeSnapshotAfterEscalation(tid, false);
		if (snap.success) {
			const session = sessionManager.getSession(tid);
			return {
				success: true,
				snapshot:
					"Page loaded interactively. Previous element references are stale. Use the following accessibility tree to interact:\n\n" +
					snap.snapshot,
				elementCount: snap.elementCount,
				...(session?.currentUrl ? { newUrl: session.currentUrl } : {}),
				...(session?.currentTitle ? { newTitle: session.currentTitle } : {}),
			};
		}
		return { success: false, error: "Could not load page interactively" };
	}
	return action();
}

/** Apply compact truncation to auto-snapshots in interaction results */
function compactInteractionResult(
	result: InteractionResult,
): InteractionResult {
	if (result.success && result.snapshot && result.elementCount !== undefined) {
		result.snapshot = compactSnapshot(result.snapshot, result.elementCount);
	}
	return result;
}

// ─── Click ────────────────────────────────────────────────────────────

export async function click(
	taskId: string | undefined,
	ref: string,
): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	return refBasedInteractionOrSnapshot(tid, sr.wasAutoEscalated, async () => {
		if (sr.session.level === "chromium")
			return compactInteractionResult(await playwrightBackend.click(tid, ref));
		if (sr.session.level === "stealth")
			return compactInteractionResult(await stealthBackend.click(tid, ref));
		return { success: false, error: "Unknown session level" };
	});
}

// ─── Type ─────────────────────────────────────────────────────────────

export async function type(
	taskId: string | undefined,
	ref: string,
	text: string,
): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	return refBasedInteractionOrSnapshot(tid, sr.wasAutoEscalated, async () => {
		if (sr.session.level === "chromium")
			return compactInteractionResult(
				await playwrightBackend.type(tid, ref, text),
			);
		if (sr.session.level === "stealth")
			return compactInteractionResult(
				await stealthBackend.type(tid, ref, text),
			);
		return { success: false, error: "Unknown session level" };
	});
}

// ─── Scroll ───────────────────────────────────────────────────────────

export async function scroll(
	taskId: string | undefined,
	direction: "up" | "down",
): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	return refBasedInteractionOrSnapshot(tid, sr.wasAutoEscalated, async () => {
		if (sr.session.level === "chromium")
			return compactInteractionResult(
				await playwrightBackend.scroll(tid, direction),
			);
		if (sr.session.level === "stealth")
			return compactInteractionResult(
				await stealthBackend.scroll(tid, direction),
			);
		return { success: false, error: "Unknown session level" };
	});
}

// ─── Screenshot ───────────────────────────────────────────────────────

export async function screenshot(
	taskId?: string,
	fullPage?: boolean,
): Promise<ScreenshotResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			dataUri: "",
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	if (sr.session.level === "chromium")
		return playwrightBackend.screenshot(tid, fullPage ?? false);
	if (sr.session.level === "stealth") return stealthBackend.screenshot(tid);
	return { success: false, dataUri: "", error: "Unknown session level" };
}

// ─── Go Back ──────────────────────────────────────────────────────────

export async function goBack(taskId?: string): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	return refBasedInteractionOrSnapshot(tid, sr.wasAutoEscalated, async () => {
		if (sr.session.level === "chromium")
			return compactInteractionResult(await playwrightBackend.goBack(tid));
		if (sr.session.level === "stealth")
			return compactInteractionResult(await stealthBackend.goBack(tid));
		return { success: false, error: "Unknown session level" };
	});
}

// ─── Press Key ────────────────────────────────────────────────────────

export async function press(
	taskId: string | undefined,
	key: string,
): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	return refBasedInteractionOrSnapshot(tid, sr.wasAutoEscalated, async () => {
		if (sr.session.level === "chromium")
			return compactInteractionResult(await playwrightBackend.press(tid, key));
		if (sr.session.level === "stealth")
			return compactInteractionResult(await stealthBackend.press(tid, key));
		return { success: false, error: "Unknown session level" };
	});
}

// ─── Images ────────────────────────────────────────────────────────────

export interface GetImagesResult {
	success: boolean;
	images: Array<{ src: string; alt: string; width: number; height: number }>;
	count: number;
	error?: string;
}

export async function getImages(taskId?: string): Promise<GetImagesResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			images: [],
			count: 0,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	if (sr.session.level === "chromium") {
		const result = await playwrightBackend.getImages(tid);
		return {
			success: result.success,
			images: result.images,
			count: result.images.length,
			...(result.error ? { error: result.error } : {}),
		};
	}
	if (sr.session.level === "stealth") {
		const result = await stealthBackend.getImages(tid);
		return {
			success: result.success,
			images: result.images,
			count: result.images.length,
			...(result.error ? { error: result.error } : {}),
		};
	}
	return {
		success: false,
		images: [],
		count: 0,
		error: "Unknown session level",
	};
}

// ─── Console & Eval ──────────────────────────────────────────────────

export async function getConsoleMessages(taskId?: string): Promise<{
	success: boolean;
	messages: Array<{ type: string; text: string }>;
	error?: string;
}> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			messages: [],
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	if (sr.session.level === "chromium") {
		const msgs = await playwrightBackend.getConsoleMessages(tid);
		return { success: true, messages: msgs };
	}
	if (sr.session.level === "stealth") {
		const msgs = await stealthBackend.getConsoleMessages(tid);
		return { success: true, messages: msgs };
	}
	return { success: false, messages: [], error: "Unknown session level" };
}

export async function evaluate(
	taskId: string | undefined,
	expression: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr)
		return {
			success: false,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	if (sr.session.level === "chromium")
		return playwrightBackend.evaluate(tid, expression);
	if (sr.session.level === "stealth")
		return stealthBackend.evaluate(tid, expression);
	return { success: false, error: "Unknown session level" };
}

export async function clearConsole(
	taskId?: string,
): Promise<{ success: boolean }> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return { success: false };
	if (sr.session.level === "chromium") {
		await playwrightBackend.clearConsole(tid);
		return { success: true };
	}
	if (sr.session.level === "stealth") {
		await stealthBackend.clearConsole(tid);
		return { success: true };
	}
	return { success: false };
}
