/**
 * Plugin Router — registry-based dispatch for interactive browser operations.
 *
 * Replaces the old hardcoded if/else dispatch between chromium and stealth
 * backends. All dispatch now goes through the PluginRegistry, which resolves
 * the correct plugin based on the `strategy` parameter.
 *
 * In Phase A, only "auto" and "chromium" strategies are accepted.
 * The stealth backend is offline until Phase C.
 *
 * Cross-cutting concerns handled here (not in plugins):
 * - Snapshot truncation (compactSnapshot)
 * - URL safety validation
 * - Session lifecycle (via sessionManager)
 * - Auto-recovery from crashed sessions (via lastNav)
 */

import { pluginRegistry } from "./plugin-registry.js";
import { sessionManager } from "./shared/session-manager.js";
import type { BrowserSession } from "./shared/session-manager.js";
import { validateUrl } from "./shared/url-safety.js";
import { snapshotFingerprint } from "./shared/accessibility-tree.js";
import type {
	NavigateResult,
	SnapshotResult,
	InteractionResult,
	ScreenshotResult,
	GetImagesResult,
	ConsoleMessagesResult,
	EvaluateResult,
} from "./plugin-api.js";

// ─── Snapshot truncation constants ────────────────────────────────────

/** Snapshots shorter than this are returned as-is (no truncation). */
const COMPACT_SNAPSHOT_NO_TRUNCATE = 2800;

/** Target truncation length for compact snapshots (newline-aware). */
const COMPACT_SNAPSHOT_LIMIT = 2500;

/** Snapshots exceeding this use "very large page" strategy. */
const COMPACT_SNAPSHOT_VERY_LARGE = 8000;

/** How much of the tree top to preserve for very large pages. */
const COMPACT_SNAPSHOT_TOP_LIMIT = 2000;

/** Max chars for a dialog block appended after truncation. */
const DIALOG_BLOCK_MAX = 500;

// ─── Exported types ──────────────────────────────────────────────────

export interface NavigateOptions {
	strategy?: string;
	timeout?: number;
	signal?: AbortSignal;
	taskId?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Get or create an interactive session for the given task.
 *
 * If a session already exists, returns it. If no session exists but
 * a last-navigation URL is available, auto-creates a session and
 * navigates to that URL.
 *
 * Returns null if no session can be established.
 */
async function requireInteractiveSession(taskId: string): Promise<{
	session: BrowserSession;
	pluginName: string;
	wasAutoCreated: boolean;
} | null> {
	const existing = sessionManager.getSession(taskId);
	if (existing) {
		return {
			session: existing,
			pluginName: existing.pluginName,
			wasAutoCreated: false,
		};
	}

	// No session — try auto-creation via lastNav
	const lastNav = sessionManager.getLastNav(taskId);
	if (!lastNav) return null;

	// Use the same plugin that was used for the original navigation
	const plugin = pluginRegistry.get(lastNav.pluginName);
	if (!plugin) return null;

	sessionManager.createSession(taskId, lastNav.pluginName);
	const session = sessionManager.getSession(taskId)!;
	session.currentUrl = lastNav.url;
	session.currentTitle = lastNav.title;

	const navResult = await plugin.navigate(lastNav.url, taskId, 30_000);
	if (navResult.success) {
		session.currentUrl = navResult.url;
		session.currentTitle = navResult.title;
		return { session, pluginName: lastNav.pluginName, wasAutoCreated: true };
	}

	// Failed — clean up
	await plugin.cleanup(taskId).catch(() => {});
	sessionManager.removeSession(taskId);
	return null;
}

/**
 * Get the plugin for a given session. Returns undefined if the session
 * doesn't exist or the plugin is not available.
 */
function getPluginForSession(
	session: BrowserSession,
): import("./plugin-api.js").BrowserPlugin | undefined {
	return pluginRegistry.get(session.pluginName);
}

/**
 * Extract dialog/alertdialog blocks from a snapshot text.
 *
 * Walks the lines and collects each dialog header followed by its
 * indented children (elements at greater indent than the header).
 * Returns blocks that were *entirely* beyond the character `cutPoint`
 * and thus hidden from the top portion of a compacted snapshot.
 */
interface DialogBlock {
	/** Full block text (header + children). */
	text: string;
	/** Character position where this block starts in the full snapshot. */
	startChar: number;
}

function extractDialogBlocks(snapshot: string, cutPoint: number): string[] {
	const lines = snapshot.split("\n");
	const blocks: DialogBlock[] = [];
	let currentLines: string[] | null = null;
	let headerIndent = -1;
	let charPos = 0;
	let startChar = 0;

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		const lineLen = rawLine.length + 1; // +1 for the newline
		const isDialogHeader =
			trimmed.includes("💬 dialog") ||
			trimmed.includes("⚠ alertdialog") ||
			// Also detect raw YAML format (beyond maxElements cap)
			/^-\s+(alert)?dialog\b/.test(trimmed);

		if (isDialogHeader) {
			// Close any previous dialog
			if (currentLines) {
				const blockText = currentLines.join("\n");
				if (startChar + blockText.length > cutPoint)
					blocks.push({ text: blockText, startChar });
			}
			currentLines = [rawLine];
			startChar = charPos;
			headerIndent = rawLine.search(/\S/);
			if (headerIndent === -1) headerIndent = 0;
		} else if (currentLines) {
			// Check if this line is at the same or lower indent than the header
			const lineIndent = rawLine.search(/\S/);
			const effectiveIndent = lineIndent === -1 ? 0 : lineIndent;

			if (effectiveIndent > headerIndent || trimmed === "") {
				// Child of the dialog or blank line within
				currentLines.push(rawLine);
			} else {
				// Dialog ended — close and finalise
				const blockText = currentLines.join("\n");
				if (startChar + blockText.length > cutPoint)
					blocks.push({ text: blockText, startChar });
				currentLines = null;
			}
		}

		charPos += lineLen;
	}

	// Close any dangling dialog at end of file
	if (currentLines) {
		const blockText = currentLines.join("\n");
		if (startChar + blockText.length > cutPoint)
			blocks.push({ text: blockText, startChar });
	}

	// Cap each block
	return blocks.map((b) =>
		b.text.length > DIALOG_BLOCK_MAX
			? truncateDialogBlock(b.text, DIALOG_BLOCK_MAX)
			: b.text,
	);
}

/**
 * Truncate a dialog block to at most `maxChars` while keeping the
 * header line visible.
 */
function truncateDialogBlock(block: string, maxChars: number): string {
	if (block.length <= maxChars) return block;
	const lines = block.split("\n");
	const header = lines[0]!;
	let result = header;
	for (let i = 1; i < lines.length; i++) {
		if (result.length + lines[i]!.length + 1 > maxChars - 60) {
			const remainingCount = lines.length - i;
			result += `\n… ${remainingCount} more dialog element${remainingCount === 1 ? "" : "s"} (use full=true for complete tree)`;
			break;
		}
		result += "\n" + lines[i]!;
	}
	return result;
}

/**
 * Compact a snapshot to a manageable size for LLM consumption.
 *
 * - Under ~2800 chars: no truncation
 * - ~2800-8000 chars: cut at a natural breakpoint near 2500 chars
 * - Over ~8000 chars: preserve top ~2000 chars + summary
 *
 * Dialog-aware: if any `💬 dialog`/`⚠ alertdialog` blocks fall entirely
 * beyond the cut point, they are included after the top section so the
 * agent can see and interact with modal/dialog elements.
 */
export function compactSnapshot(
	snapshot: string,
	elementCount: number,
): string {
	if (snapshot.length <= COMPACT_SNAPSHOT_NO_TRUNCATE) return snapshot;

	const remaining = elementCount > 0 ? elementCount : undefined;

	if (snapshot.length > COMPACT_SNAPSHOT_VERY_LARGE) {
		let topCut = snapshot.lastIndexOf("\n", COMPACT_SNAPSHOT_TOP_LIMIT);
		if (topCut < COMPACT_SNAPSHOT_TOP_LIMIT / 2)
			topCut = COMPACT_SNAPSHOT_TOP_LIMIT;

		const topSection = snapshot.slice(0, topCut);
		const dialogBlocks = extractDialogBlocks(snapshot, topCut);

		let result = topSection;
		for (const block of dialogBlocks) {
			result += "\n" + block;
		}

		const bottomHint = remaining
			? `\n… ${snapshot.length - result.length} more chars, ${remaining} elements total (use full=true for complete tree)`
			: `\n… ${snapshot.length - result.length} more chars (use full=true for complete tree)`;
		return result + bottomHint;
	}

	let cut = snapshot.lastIndexOf("\n", COMPACT_SNAPSHOT_LIMIT);
	if (cut < COMPACT_SNAPSHOT_LIMIT / 2) cut = COMPACT_SNAPSHOT_LIMIT;

	const topSection = snapshot.slice(0, cut);
	const dialogBlocks = extractDialogBlocks(snapshot, cut);

	let result = topSection;
	for (const block of dialogBlocks) {
		result += "\n" + block;
	}

	const tail = remaining
		? `\n… ${snapshot.length - result.length} more chars, ${remaining} elements total (use full=true for complete tree)`
		: `\n… ${snapshot.length - result.length} more chars (use full=true for complete tree)`;

	return result + tail;
}

/**
 * For interaction tools that use @e refs (click, type, press, scroll, goBack):
 * if the session was just auto-created, the old @e refs are stale, so we
 * return a fresh snapshot instead of performing the action.
 */
async function refBasedInteractionOrSnapshot(
	taskId: string,
	wasAutoCreated: boolean,
	plugin: import("./plugin-api.js").BrowserPlugin,
	action: () => Promise<InteractionResult>,
): Promise<InteractionResult> {
	if (wasAutoCreated) {
		const snap = await plugin.snapshot(taskId);
		if (snap.success) {
			const session = sessionManager.getSession(taskId);
			return {
				success: true,
				snapshot:
					"Page loaded interactively. Previous element references are stale. Use the following accessibility tree to interact:\n\n" +
					compactSnapshot(snap.snapshot, snap.elementCount),
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
	taskId: string,
	result: InteractionResult,
): InteractionResult {
	if (result.success && result.snapshot && result.elementCount !== undefined) {
		const compacted = compactSnapshot(result.snapshot, result.elementCount);

		// Check for DOM changes since the last snapshot (SPA navigation, dynamic content).
		// If the fingerprint changed, warn the agent that @e refs may be stale.
		const session = sessionManager.getSession(taskId);
		if (session) {
			const newFingerprint = snapshotFingerprint(result.snapshot);
			if (
				session.currentSnapshotFingerprint !== undefined &&
				session.currentSnapshotFingerprint !== newFingerprint
			) {
				result.snapshot =
					compacted +
					"\n\n⚠️ Page content structure changed since last interaction. Previously stored @e references may point to different elements. Use fresh @e refs from this tree for reliable interactions.";
			} else {
				result.snapshot = compacted;
			}
			session.currentSnapshotFingerprint = newFingerprint;
		} else {
			result.snapshot = compacted;
		}
	}
	return result;
}

// ─── Navigation ───────────────────────────────────────────────────────

export async function navigate(
	url: string,
	options: NavigateOptions = {},
): Promise<
	NavigateResult & { backendUsed: string; botDetectionWarning?: boolean }
> {
	const strategy = options.strategy ?? "auto";
	const timeoutMs = (options.timeout ?? 30) * 1000;
	const taskId = options.taskId ?? "default";

	// Resolve the plugin from the strategy
	const resolved = pluginRegistry.resolveStrategy(strategy);
	if (!resolved.plugin) {
		const stratResult: NavigateResult & {
			backendUsed: string;
			botDetectionWarning?: boolean;
		} = {
			success: false,
			url,
			title: "",
			snapshot: "",
			elementCount: 0,
			backendUsed: strategy,
		};
		if (resolved.error) stratResult.error = resolved.error;
		return stratResult;
	}
	const plugin = resolved.plugin;

	// Normalise URL
	let normalizedUrl: string;
	try {
		normalizedUrl = new URL(url).href;
	} catch {
		return {
			success: false,
			url,
			title: "",
			snapshot: "",
			elementCount: 0,
			error: `Invalid URL: ${url}`,
			backendUsed: plugin.name,
		} as NavigateResult & {
			backendUsed: string;
			botDetectionWarning?: boolean;
		};
	}

	// URL safety check
	const safety = validateUrl(normalizedUrl);
	if (!safety.safe) {
		return {
			success: false,
			url: normalizedUrl,
			title: "",
			snapshot: "",
			elementCount: 0,
			error: `URL blocked: ${safety.reason}`,
			backendUsed: plugin.name,
		} as NavigateResult & {
			backendUsed: string;
			botDetectionWarning?: boolean;
		};
	}

	// Create session
	sessionManager.createSession(taskId, plugin.name);
	const session = sessionManager.getSession(taskId)!;
	session.currentUrl = normalizedUrl;

	const navOptions: { signal?: AbortSignal } = {};
	if (options.signal) navOptions.signal = options.signal;
	const result = await plugin.navigate(
		normalizedUrl,
		taskId,
		timeoutMs,
		navOptions,
	);

	if (result.success) {
		session.currentUrl = result.url;
		session.currentTitle = result.title;

		// Store snapshot fingerprint for DOM-change detection (SPA navigation etc.)
		session.currentSnapshotFingerprint = snapshotFingerprint(result.snapshot);

		// Store as last-nav for auto-recovery
		sessionManager.setLastNav(taskId, result.url, result.title, plugin.name);

		const botWarn = result.botDetected ?? false;

		// If bot detection triggered AND the page has very few elements,
		// it's likely a challenge/block page. Downgrade to failure so the
		// agent gets a clear signal rather than a misleading partial page.
		if (botWarn && result.elementCount < 5) {
			await plugin.cleanup(taskId).catch(() => {});
			sessionManager.removeSession(taskId);
			return {
				success: false,
				url: result.url,
				title: result.title,
				snapshot: "",
				elementCount: 0,
				error:
					"Page appears to be blocked by anti-automation protection. " +
					"The page may require JavaScript execution or browser interaction to render.",
				backendUsed: plugin.name,
				botDetectionWarning: true,
			} as NavigateResult & {
				backendUsed: string;
				botDetectionWarning?: boolean;
			};
		}

		// Don't compact snapshot when bot-detected — the agent needs
		// the full content to assess whether the page is a false positive.
		const snapshotContent = result.snapshot
			? botWarn
				? result.snapshot
				: compactSnapshot(result.snapshot, result.elementCount)
			: "";

		const successResult: NavigateResult & {
			backendUsed: string;
			botDetectionWarning?: boolean;
		} = {
			success: true,
			url: result.url,
			title: result.title,
			snapshot: snapshotContent,
			elementCount: result.elementCount,
			backendUsed: plugin.name,
		};
		if (botWarn) successResult.botDetectionWarning = true;
		return successResult;
	}

	// Navigation failed — clean up
	await plugin.cleanup(taskId).catch(() => {});
	sessionManager.removeSession(taskId);

	const failResult: NavigateResult & {
		backendUsed: string;
		botDetectionWarning?: boolean;
	} = {
		success: false,
		url: result.url || normalizedUrl,
		title: "",
		snapshot: "",
		elementCount: 0,
		backendUsed: plugin.name,
	};
	if (result.error) failResult.error = result.error;
	if (result.botDetected) failResult.botDetectionWarning = true;
	return failResult;
}

// ─── Snapshot (current page) ────────────────────────────────────────

export async function snapshot(
	taskId?: string,
	full?: boolean,
): Promise<SnapshotResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);

	if (!sr) {
		return {
			success: false,
			snapshot: "",
			elementCount: 0,
			error:
				"No active session — use browser-navigate to visit a page first, then retry",
		};
	}

	const plugin = getPluginForSession(sr.session);
	if (!plugin) {
		return {
			success: false,
			snapshot: "",
			elementCount: 0,
			error: `Plugin '${sr.session.pluginName}' is not available`,
		};
	}

	const result = await plugin.snapshot(tid);
	if (result.success) {
		// Update snapshot fingerprint for DOM-change detection
		const session = sessionManager.getSession(tid);
		if (session) {
			session.currentSnapshotFingerprint = snapshotFingerprint(result.snapshot);
		}
		if (!full) {
			result.snapshot = compactSnapshot(result.snapshot, result.elementCount);
		}
	}
	return result;
}

// ─── Interaction tools ──────────────────────────────────────────────

export async function click(
	taskId: string | undefined,
	ref: string,
): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return noSessionError();
	const plugin = getPluginForSession(sr.session);
	if (!plugin) return pluginNotAvailableError(sr.session.pluginName);

	return refBasedInteractionOrSnapshot(
		tid,
		sr.wasAutoCreated,
		plugin,
		async () => compactInteractionResult(tid, await plugin.click(tid, ref)),
	);
}

export async function type(
	taskId: string | undefined,
	ref: string,
	text: string,
): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return noSessionError();
	const plugin = getPluginForSession(sr.session);
	if (!plugin) return pluginNotAvailableError(sr.session.pluginName);

	return refBasedInteractionOrSnapshot(
		tid,
		sr.wasAutoCreated,
		plugin,
		async () =>
			compactInteractionResult(tid, await plugin.type(tid, ref, text)),
	);
}

export async function scroll(
	taskId: string | undefined,
	direction: "up" | "down",
): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return noSessionError();
	const plugin = getPluginForSession(sr.session);
	if (!plugin) return pluginNotAvailableError(sr.session.pluginName);

	return refBasedInteractionOrSnapshot(
		tid,
		sr.wasAutoCreated,
		plugin,
		async () =>
			compactInteractionResult(tid, await plugin.scroll(tid, direction)),
	);
}

export async function goBack(taskId?: string): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return noSessionError();
	const plugin = getPluginForSession(sr.session);
	if (!plugin) return pluginNotAvailableError(sr.session.pluginName);

	return refBasedInteractionOrSnapshot(
		tid,
		sr.wasAutoCreated,
		plugin,
		async () => compactInteractionResult(tid, await plugin.goBack(tid)),
	);
}

export async function press(
	taskId: string | undefined,
	key: string,
): Promise<InteractionResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return noSessionError();
	const plugin = getPluginForSession(sr.session);
	if (!plugin) return pluginNotAvailableError(sr.session.pluginName);

	return refBasedInteractionOrSnapshot(
		tid,
		sr.wasAutoCreated,
		plugin,
		async () => compactInteractionResult(tid, await plugin.press(tid, key)),
	);
}

// ─── Media ───────────────────────────────────────────────────────────

export async function screenshot(
	taskId?: string,
	fullPage?: boolean,
): Promise<ScreenshotResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return { success: false, dataUri: "", error: noSessionMsg };
	const plugin = getPluginForSession(sr.session);
	if (!plugin)
		return {
			success: false,
			dataUri: "",
			error: `Plugin '${sr.session.pluginName}' is not available`,
		};

	// Respect capability: if fullPage is requested but not supported, fall back
	const screenshotOpts: { fullPage?: boolean } = {};
	if (fullPage && plugin.capabilities.supportsFullPageScreenshot) {
		screenshotOpts.fullPage = true;
	}

	return plugin.screenshot(tid, screenshotOpts);
}

export async function getImages(taskId?: string): Promise<GetImagesResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return { success: false, images: [], error: noSessionMsg };
	const plugin = getPluginForSession(sr.session);
	if (!plugin)
		return {
			success: false,
			images: [],
			error: `Plugin '${sr.session.pluginName}' is not available`,
		};

	return plugin.getImages(tid);
}

// ─── Console & eval ─────────────────────────────────────────────────

export async function getConsoleMessages(
	taskId?: string,
): Promise<ConsoleMessagesResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return { success: false, messages: [], error: noSessionMsg };
	const plugin = getPluginForSession(sr.session);
	if (!plugin)
		return {
			success: false,
			messages: [],
			error: `Plugin '${sr.session.pluginName}' is not available`,
		};

	return plugin.getConsoleMessages(tid);
}

export async function evaluate(
	taskId: string | undefined,
	expression: string,
): Promise<EvaluateResult> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return { success: false, error: noSessionMsg };
	const plugin = getPluginForSession(sr.session);
	if (!plugin)
		return {
			success: false,
			error: `Plugin '${sr.session.pluginName}' is not available`,
		};

	return plugin.evaluate(tid, expression);
}

export async function clearConsole(
	taskId?: string,
): Promise<{ success: boolean; error?: string }> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return { success: false, error: "No active session" };
	const plugin = getPluginForSession(sr.session);
	if (!plugin)
		return {
			success: false,
			error: `Plugin '${sr.session.pluginName}' is not available`,
		};

	try {
		await plugin.clearConsole(tid);
		return { success: true };
	} catch (err: unknown) {
		return {
			success: false,
			error: `Clear console failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ─── Error message constants ─────────────────────────────────────────

const noSessionMsg =
	"No active session — use browser-navigate to visit a page first, then retry";

function noSessionError(): InteractionResult {
	return { success: false, error: noSessionMsg };
}

function pluginNotAvailableError(pluginName: string): InteractionResult {
	return {
		success: false,
		error: `Plugin '${pluginName}' is not available`,
	};
}
