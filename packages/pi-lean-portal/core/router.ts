/**
 * Plugin Router — registry-based dispatch for interactive browser operations.
 * Handles snapshot truncation, session lifecycle, and crash recovery.
 */

import { writeFileSync } from "node:fs";
import { BROWSER_TEMP_DIR, ensureBrowserTempDir } from "./shared/paths.js";
import { pluginRegistry } from "./plugin-registry.js";
import { sessionManager } from "./shared/session-manager.js";
import type { BrowserSession } from "./shared/session-manager.js";
import { snapshotFingerprint } from "./shared/accessibility-tree.js";
import {
	cacheSnapshot,
	formatCacheNotice,
	removeSnapshotFiles,
	SNAPSHOT_TRUNCATE_THRESHOLD,
	type CacheResult,
} from "./shared/snapshot-cache.js";
import {
	loadStorageState,
	sanitizeProfileName,
	sessionProfileName,
} from "./shared/storage-state.js";
import { loadFullConfig } from "./plugin-config.js";
import {
	runExtractor,
	correlateElements,
	queryElementCache,
	formatElementList,
	formatRoleCountSummary,
	type ExtractResult,
	type QueryStatus,
} from "./shared/dom-extractor.js";
import type {
	DialogEvent,
	NavigateResult,
	SnapshotResult,
	InteractionResult,
	ConsoleMessagesResult,
	EvaluateResult,
	Cookie,
	CookieResult,
	ClearCookiesOptions,
	ResultBase,
} from "./plugin-api.js";

// ─── Snapshot truncation constants ────────────────────────────────────

/** Target truncation length for compact snapshots (newline-aware). */
const COMPACT_SNAPSHOT_LIMIT = 2500;

/** Snapshots exceeding this use "very large page" strategy. */
const COMPACT_SNAPSHOT_VERY_LARGE = 8000;

/** How much of the tree top to preserve for very large pages. */
const COMPACT_SNAPSHOT_TOP_LIMIT = 2000;

// ─── browser-inspect truncation constants ────────────────────────────

/** Default truncation limit for browser-inspect text output when maxChars is not provided. */
const INSPECT_DEFAULT_LIMIT = 2500;

// ─── Exported types ──────────────────────────────────────────────────

export interface NavigateOptions {
	strategy?: string;
	timeout?: number;
	signal?: AbortSignal;
	taskId?: string;
	/**
	 * Profile mode or named profile.
	 * - "none": clean slate, no persistence
	 * - "session": persist for this conversation
	 * - A named profile string (e.g. "shopping", "work")
	 */
	profile?: "none" | "session" | string;
	/**
	 * pi session ID for session-scoped profiles (profile="session").
	 * Used to derive the internal `_session-<piSessionId>` profile name.
	 */
	piSessionId?: string;
}

// ─── Profile Change Callback ───────────────────────────────────────

/**
 * Simple nullable callback for profile changes.
 * Used by index.ts to update the TUI status bar.
 */
let _onProfileChange:
	| ((
			taskId: string,
			profileName?: string,
			profileMode?: "none" | "session" | "named",
	  ) => void)
	| null = null;

/**
 * Set the profile change callback.
 * Called once at extension startup from index.ts.
 */
export function setOnProfileChange(
	handler:
		| ((
				taskId: string,
				profileName?: string,
				profileMode?: "none" | "session" | "named",
		  ) => void)
		| null,
): void {
	_onProfileChange = handler;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Format dialog events for appending to snapshot output.
 * Returns an empty string when there are no events.
 */
function formatDialogEvents(events: DialogEvent[]): string {
	if (events.length === 0) return "";

	const lines = events.map((d) => {
		const prefix =
			d.type === "alert" ? "📢" : d.type === "confirm" ? "❓" : "💬";
		return `${prefix} [${d.type}] ${d.message} (auto-${d.handledAs})`;
	});

	return "\n\n--- Auto-dismissed dialogs ---\n" + lines.join("\n");
}

/**
 * Get or create an interactive session for the given task.
 *
 * If a session already exists, returns it. If no session exists but
 * a last-navigation URL is available, auto-creates a session and
 * navigates to that URL.
 *
 * When restoring from a lastNav with a profile, the storage state
 * for that profile is loaded and passed to the plugin.
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
	sessionManager.updateSession(taskId, {
		currentUrl: lastNav.url,
		currentTitle: lastNav.title,
	});

	// Restore profile name if the last navigation used a profile
	if (lastNav.profileName) {
		sessionManager.updateSession(taskId, {
			persistState: true,
			profileName: lastNav.profileName,
		});
	}

	// ── Load saved storage state for the profile (if any) ────────────
	let loadedStorageState: unknown;
	if (lastNav.profileName) {
		try {
			const loaded = loadStorageState(lastNav.profileName);
			if (loaded !== null) {
				loadedStorageState = loaded;
			}
		} catch {
			// Corrupt/unreadable file — proceed with fresh state
		}
	}

	// Navigate — plugin loads its own storage state if needed
	const navOptions: { signal?: AbortSignal; storageState?: unknown } = {};
	if (loadedStorageState !== undefined) {
		navOptions.storageState = loadedStorageState;
	}
	const navResult = await plugin.navigate(
		lastNav.url,
		taskId,
		30_000,
		navOptions,
	);
	if (navResult.success) {
		sessionManager.updateSession(taskId, {
			currentUrl: navResult.url,
			currentTitle: navResult.title,
		});
		return {
			session: sessionManager.getSession(taskId)!,
			pluginName: lastNav.pluginName,
			wasAutoCreated: true,
		};
	}

	// Failed — clean up
	await plugin.cleanup(taskId).catch(() => {});
	sessionManager.removeSession(taskId);
	removeSnapshotFiles(taskId);
	return null;
}

interface ResolvedSession {
	tid: string;
	session: BrowserSession;
	plugin: import("./plugin-api.js").BrowserPlugin;
	wasAutoCreated: boolean;
}

/**
 * Resolve a task ID and require an active interactive session + plugin.
 * Returns null if no session exists or the plugin is unavailable.
 */
async function resolveSession(
	taskId: string | undefined,
): Promise<ResolvedSession | null> {
	const tid = taskId ?? "default";
	const sr = await requireInteractiveSession(tid);
	if (!sr) return null;
	const plugin = pluginRegistry.get(sr.session.pluginName);
	if (!plugin) return null;
	return {
		tid,
		session: sr.session,
		plugin,
		wasAutoCreated: sr.wasAutoCreated,
	};
}

/**
 * Compact a snapshot to a manageable size for LLM consumption.
 *
 * - Under ~2800 chars: no truncation
 * - ~2800-8000 chars: cut at a natural breakpoint near 2500 chars
 * - Over ~8000 chars: preserve top ~2000 chars + summary
 */
export function compactSnapshot(
	snapshot: string,
	elementCount: number,
): string {
	if (snapshot.length <= SNAPSHOT_TRUNCATE_THRESHOLD) return snapshot;

	const remaining = elementCount > 0 ? elementCount : undefined;

	if (snapshot.length > COMPACT_SNAPSHOT_VERY_LARGE) {
		let topCut = snapshot.lastIndexOf("\n", COMPACT_SNAPSHOT_TOP_LIMIT);
		if (topCut < COMPACT_SNAPSHOT_TOP_LIMIT / 2)
			topCut = COMPACT_SNAPSHOT_TOP_LIMIT;

		const topSection = snapshot.slice(0, topCut);
		const bottomHint = remaining
			? `\n… ${snapshot.length - topSection.length} more chars, ${remaining} elements total`
			: `\n… ${snapshot.length - topSection.length} more chars`;
		return topSection + bottomHint;
	}

	let cut = snapshot.lastIndexOf("\n", COMPACT_SNAPSHOT_LIMIT);
	if (cut < COMPACT_SNAPSHOT_LIMIT / 2) cut = COMPACT_SNAPSHOT_LIMIT;

	const topSection = snapshot.slice(0, cut);
	const tail = remaining
		? `\n… ${snapshot.length - topSection.length} more chars, ${remaining} elements total`
		: `\n… ${snapshot.length - topSection.length} more chars`;

	return topSection + tail;
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
	if (!wasAutoCreated) {
		// Mark interaction time for staleness detection
		const sess = sessionManager.getSession(taskId);
		if (sess) {
			sessionManager.updateSession(taskId, {
				lastInteractionAt: Date.now(),
			});
		}
	}

	if (wasAutoCreated) {
		const snap = await plugin.snapshot(taskId);
		if (snap.success) {
			const session = sessionManager.getSession(taskId);

			// Cache the auto-snapshot before compaction
			const truncated = snap.snapshot.length > SNAPSHOT_TRUNCATE_THRESHOLD;
			const fingerprint = snapshotFingerprint(snap.snapshot);
			const cacheResult = cacheSnapshot(taskId, snap.snapshot, fingerprint);

			return {
				success: true,
				snapshot:
					"Page loaded interactively. Previous element references are stale. Use the following accessibility tree to interact:\n\n" +
					compactSnapshot(snap.snapshot, snap.elementCount) +
					formatCacheNotice(
						cacheResult,
						snap.snapshot.length,
						truncated,
						snap.elementCount,
					) +
					`\nfingerprint:${fingerprint}`,
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
		const rawSnapshot = result.snapshot;
		const newFingerprint = snapshotFingerprint(rawSnapshot);

		// Cache (before compacting)
		const truncated = rawSnapshot.length > SNAPSHOT_TRUNCATE_THRESHOLD;
		const cacheResult = cacheSnapshot(taskId, rawSnapshot, newFingerprint);

		const compacted = compactSnapshot(rawSnapshot, result.elementCount);
		result.snapshot =
			compacted +
			formatCacheNotice(
				cacheResult,
				rawSnapshot.length,
				truncated,
				result.elementCount,
			) +
			`\nfingerprint:${newFingerprint}` +
			formatDialogEvents(result.dialogEvents ?? []);

		const session = sessionManager.getSession(taskId);
		if (session) {
			sessionManager.updateSession(taskId, {
				currentSnapshotFingerprint: newFingerprint,
				...(cacheResult ? { cachePopulatedAt: Date.now() } : {}),
			});
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

	// ── Resolve profile mode ───────────────────────────────────
	let resolvedProfileName: string | undefined;
	let profileMode: "none" | "session" | "named" | undefined;

	const browserConfig = loadFullConfig().browser;
	const profileInput = options.profile ?? browserConfig.defaultProfile;

	if (profileInput === "none") {
		profileMode = "none";
	} else if (profileInput === "session") {
		profileMode = "session";
		const piSessionId = options.piSessionId;
		if (piSessionId) {
			resolvedProfileName = sessionProfileName(piSessionId);
		} else {
			// Can't resolve session profile without piSessionId — fall back with warning
			console.warn(
				"[pi-lean-portal] profile='session' requested but piSessionId unavailable. " +
					"Falling back to profile='none'.",
			);
			profileMode = "none";
		}
	} else {
		// Named profile
		profileMode = "named";
		try {
			sanitizeProfileName(profileInput);
		} catch (err) {
			return {
				success: false,
				url: normalizedUrl,
				title: "",
				snapshot: "",
				elementCount: 0,
				error: `Invalid profile name: ${err instanceof Error ? err.message : String(err)}`,
				backendUsed: plugin.name,
			} as NavigateResult & {
				backendUsed: string;
				botDetectionWarning?: boolean;
			};
		}
		resolvedProfileName = profileInput;
	}

	// ── Notify profile change callback ─────────────────────
	_onProfileChange?.(taskId, resolvedProfileName, profileMode);

	// ── Create session and navigate ───────────────────────────
	sessionManager.createSession(taskId, plugin.name);
	sessionManager.updateSession(taskId, {
		currentUrl: normalizedUrl,
		persistState: resolvedProfileName !== undefined,
		...(options.piSessionId !== undefined
			? { piSessionId: options.piSessionId }
			: {}),
	});

	// Set/clear profileName directly
	const session = sessionManager.getSession(taskId)!;
	if (session) {
		if (resolvedProfileName !== undefined) {
			session.profileName = resolvedProfileName;
		} else {
			delete session.profileName;
		}
	}

	// ── Load saved storage state for the profile (if any) ────────────
	let loadedStorageState: unknown;
	if (resolvedProfileName !== undefined) {
		try {
			const loaded = loadStorageState(resolvedProfileName);
			if (loaded !== null) {
				loadedStorageState = loaded;
			}
		} catch {
			// Corrupt/unreadable file — proceed with fresh state
		}
	}

	const navOptions: {
		signal?: AbortSignal;
		storageState?: unknown;
		profileName?: string;
		profileMode?: "none" | "session" | "named";
	} = {};
	if (options.signal) navOptions.signal = options.signal;
	if (loadedStorageState !== undefined) {
		navOptions.storageState = loadedStorageState;
	}
	if (resolvedProfileName !== undefined) {
		navOptions.profileName = resolvedProfileName;
		navOptions.profileMode = profileMode;
	}
	const result = await plugin.navigate(
		normalizedUrl,
		taskId,
		timeoutMs,
		navOptions,
	);

	if (result.success) {
		sessionManager.updateSession(taskId, {
			currentUrl: result.url,
			currentTitle: result.title,
			currentSnapshotFingerprint: snapshotFingerprint(result.snapshot),
		});

		// Store as last-nav for auto-recovery (include profileName)
		sessionManager.setLastNav(
			taskId,
			result.url,
			result.title,
			plugin.name,
			resolvedProfileName,
		);

		const botWarn = result.botDetected ?? false;

		// If bot detection triggered AND the page has very few elements,
		// it's likely a challenge/block page. Downgrade to failure so the
		// agent gets a clear signal rather than a misleading partial page.
		if (botWarn && result.elementCount < 5) {
			// Prevent auto-save of empty/blocked-page state which would
			// overwrite previously saved good state
			sessionManager.updateSession(taskId, { persistState: false });

			await plugin.cleanup(taskId).catch(() => {});
			sessionManager.removeSession(taskId);
			removeSnapshotFiles(taskId);
			return {
				success: false,
				url: result.url,
				title: result.title,
				snapshot: "",
				elementCount: 0,
				error:
					"Page appears to be blocked by anti-automation protection. " +
					"Retry `browser-navigate` with a stealth backend name from the `strategy` parameter's listed backends, " +
					"or try `web-fetch` for the raw HTML (it skips JS fingerprinting but loses interactivity).",
				backendUsed: plugin.name,
				botDetectionWarning: true,
			} as NavigateResult & {
				backendUsed: string;
				botDetectionWarning?: boolean;
			};
		}

		const fp = session.currentSnapshotFingerprint!;

		// --- Cache the raw snapshot before compaction ---
		const rawSnapshot = result.snapshot;
		const isTruncated = rawSnapshot.length > SNAPSHOT_TRUNCATE_THRESHOLD;
		const cacheResult: CacheResult | null = rawSnapshot
			? cacheSnapshot(taskId, rawSnapshot, fp)
			: null;
		// ---

		const dialogContent = formatDialogEvents(result.dialogEvents ?? []);
		const snapshotContent = rawSnapshot
			? compactSnapshot(rawSnapshot, result.elementCount) +
				formatCacheNotice(
					cacheResult,
					rawSnapshot.length,
					isTruncated,
					result.elementCount,
				) +
				`\nfingerprint:${fp}` +
				dialogContent
			: "";

		// Track cache population time for staleness detection
		if (cacheResult) {
			sessionManager.updateSession(taskId, {
				cachePopulatedAt: Date.now(),
			});
		}

		const elementCache = plugin.getElementCache(taskId);
		const dialogDetected = elementCache
			? Array.from(elementCache.values()).some(
					(n) => n.role === "dialog" || n.role === "alertdialog",
				)
			: false;

		const successResult: NavigateResult & {
			backendUsed: string;
			botDetectionWarning?: boolean;
		} = {
			success: true,
			url: result.url,
			title: result.title,
			snapshot: snapshotContent,
			elementCount: result.elementCount,
			dialogDetected,
			backendUsed: plugin.name,
		};
		if (profileMode !== undefined) successResult.profileMode = profileMode;
		if (resolvedProfileName !== undefined)
			successResult.profileName = resolvedProfileName;
		if (botWarn) successResult.botDetectionWarning = true;
		return successResult;
	}

	// Navigation failed — clean up
	// Prevent auto-save of empty state which would overwrite
	// previously saved good state from a prior successful session
	if (session) {
		sessionManager.updateSession(taskId, { persistState: false });
	}

	await plugin.cleanup(taskId).catch(() => {});
	sessionManager.removeSession(taskId);
	removeSnapshotFiles(taskId);

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
	const resolved = await resolveSession(taskId);
	if (!resolved) {
		return {
			success: false,
			snapshot: "",
			elementCount: 0,
			error: noSessionMsg,
		};
	}

	const { tid, plugin } = resolved;
	const result = await plugin.snapshot(tid);
	if (result.success) {
		// Update snapshot fingerprint (passive — surfaced in output)
		const session = sessionManager.getSession(tid);
		const fp = snapshotFingerprint(result.snapshot);
		if (session) {
			sessionManager.updateSession(tid, {
				currentSnapshotFingerprint: fp,
			});
		}
		if (!full) {
			const rawLength = result.snapshot.length;
			const wasTruncated = rawLength > SNAPSHOT_TRUNCATE_THRESHOLD;
			result.snapshot =
				compactSnapshot(result.snapshot, result.elementCount) +
				formatCacheNotice(null, rawLength, wasTruncated, result.elementCount) +
				`\nfingerprint:${fp}`;
		}
		result.snapshot += formatDialogEvents(result.dialogEvents ?? []);
	}
	return result;
}

// ─── Interaction tools ──────────────────────────────────────────────

/** Shared shape for the 5 ref-based interaction tools (click/type/scroll/goBack/press). */
async function wrapInteraction(
	taskId: string | undefined,
	run: (
		plugin: import("./plugin-api.js").BrowserPlugin,
		tid: string,
	) => Promise<InteractionResult>,
): Promise<InteractionResult> {
	const resolved = await resolveSession(taskId);
	if (!resolved) return noSessionError();
	return refBasedInteractionOrSnapshot(
		resolved.tid,
		resolved.wasAutoCreated,
		resolved.plugin,
		async () =>
			compactInteractionResult(
				resolved.tid,
				await run(resolved.plugin, resolved.tid),
			),
	);
}

export async function click(
	taskId: string | undefined,
	ref: string,
): Promise<InteractionResult> {
	return wrapInteraction(taskId, (plugin, tid) => plugin.click(tid, ref));
}

export async function type(
	taskId: string | undefined,
	ref: string,
	text: string,
): Promise<InteractionResult> {
	return wrapInteraction(taskId, (plugin, tid) => plugin.type(tid, ref, text));
}

export async function scroll(
	taskId: string | undefined,
	direction: "up" | "down",
): Promise<InteractionResult> {
	return wrapInteraction(taskId, (plugin, tid) =>
		plugin.scroll(tid, direction),
	);
}

export async function goBack(taskId?: string): Promise<InteractionResult> {
	return wrapInteraction(taskId, (plugin, tid) => plugin.goBack(tid));
}

export async function press(
	taskId: string | undefined,
	key: string,
): Promise<InteractionResult> {
	return wrapInteraction(taskId, (plugin, tid) => plugin.press(tid, key));
}

/**
 * Capture a screenshot and save it to a temp file.
 * Returns the file path on success, or null on failure (graceful degradation).
 * Does NOT resize the viewport — captures at whatever the current viewport is.
 *
 * Uses a stable filename per task so new captures overwrite old ones.
 * The LLM can use `read` on the returned path to visually inspect the page.
 */
export async function screenshotToTemp(
	taskId?: string,
): Promise<string | null> {
	const resolved = await resolveSession(taskId);
	if (!resolved) return null;

	const { tid, plugin } = resolved;
	try {
		const result = await plugin.screenshot(tid, { fullPage: false });
		if (!result.success || !result.dataUri) return null;

		// Decode the base64 data URI
		const base64Data = result.dataUri.replace(/^data:image\/\w+;base64,/, "");
		if (!base64Data) return null;

		const buffer = Buffer.from(base64Data, "base64");
		ensureBrowserTempDir();
		const filename = `screenshot-${tid}.jpg`;
		const path = `${BROWSER_TEMP_DIR}/${filename}`;
		writeFileSync(path, buffer);
		return path;
	} catch {
		return null; // Non-critical — snapshot tree is still valid
	}
}

/**
 * Capture a screenshot and return a formatted output line for tool results,
 * or an empty string on failure (non-critical).
 *
 * The formatted line tells the LLM the screenshot is only current as of this
 * call and goes stale after any interaction tool (click/type/scroll/press/back).
 */
export async function captureScreenshotLine(tid: string): Promise<string> {
	const path = await screenshotToTemp(tid);
	if (!path) return "";
	return (
		`📷 Screenshot (current as of this call): ${path}` +
		`\n  → Stale after any subsequent click/type/scroll/press/back. Call browser-snapshot to refresh.`
	);
}

// ─── Console & eval ─────────────────────────────────────────────────

export async function getConsoleMessages(
	taskId?: string,
): Promise<ConsoleMessagesResult> {
	const resolved = await resolveSession(taskId);
	if (!resolved) {
		return { success: false, messages: [], error: noSessionMsg };
	}
	return resolved.plugin.getConsoleMessages(resolved.tid);
}

export async function evaluate(
	taskId: string | undefined,
	expression: string,
): Promise<EvaluateResult> {
	const resolved = await resolveSession(taskId);
	if (!resolved) {
		return { success: false, error: noSessionMsg };
	}
	return resolved.plugin.evaluate(resolved.tid, expression);
}

export async function clearConsole(
	taskId?: string,
): Promise<{ success: boolean; error?: string }> {
	const resolved = await resolveSession(taskId);
	if (!resolved) {
		return { success: false, error: noSessionMsg };
	}

	try {
		await resolved.plugin.clearConsole(resolved.tid);
		return { success: true };
	} catch (err: unknown) {
		return {
			success: false,
			error: `Clear console failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ─── browser-inspect public types ──────────────────────────────────

interface InspectParams {
	role?: string;
	name?: string;
	ref?: string;
	subtree?: string;
	text?: boolean;
	maxChars?: number;
	/** Filter extracted content to elements containing this case-insensitive substring. */
	query?: string;
}

export interface InspectResult {
	success: boolean;
	/** Formatted text or element list */
	content: string;
	/** Whether staleness notice was appended */
	staleCacheWarning?: boolean;
	/** Error message if unsuccessful */
	error?: string;
}

// ─── browser-inspect dispatch ───────────────────────────────────────

/**
 * browser-inspect: unified element query + text extraction.
 *
 * Dispatch logic:
 * - text=true: run DOM extractor, correlate with element cache
 * - role/name/ref/subtree: query element cache directly
 * - both (text + ref/role): text extraction with filters
 * - neither: count-by-role summary
 */
export async function browserInspect(
	taskId: string | undefined,
	params: InspectParams,
): Promise<InspectResult> {
	const resolved = await resolveSession(taskId);
	if (!resolved) {
		return {
			success: false,
			content: "",
			error: noSessionMsg,
		};
	}

	const { tid, plugin, session } = resolved;

	// 2. Get element cache from the plugin
	const cache = plugin.getElementCache(tid);
	const cacheExists = cache !== null && cache.size > 0;

	// 3. Staleness check
	const cacheFresh = stalenessCheck(session);

	// 4. Dispatch based on params
	if (params.text) {
		// --- Text extraction path ---
		if (!plugin.capabilities.supportsJavaScriptEvaluate) {
			return {
				success: false,
				content: "",
				error: "Text extraction is not supported by this backend.",
			};
		}

		if (!cacheExists) {
			return {
				success: false,
				content: "",
				error:
					"No elements cached yet — use browser-snapshot to populate element cache.",
			};
		}

		// Run the DOM extractor. The !cacheExists guard above guarantees
		// cache is non-null and non-empty here, so we always route to the
		// live-cache query hint on failure.
		const outcome = await runExtractor(tid, plugin);
		if (!outcome.ok) {
			return {
				success: false,
				content: "",
				error:
					`Text extraction failed: ${outcome.error}. ` +
					`A live element cache (${cache!.size} elements) is available — ` +
					"use browser-inspect with role=, name=, or ref= to query it, " +
					"or browser-snapshot to refresh.",
			};
		}

		const extracted = outcome.result;

		// Keyword filtering — case-insensitive substring match on extracted text
		if (params.query) {
			applyQueryFilter(extracted, params.query);
		}

		// Correlate with element cache
		const correlated = correlateElements(extracted, cache!, cacheFresh);

		let content = correlated.text;

		// maxChars truncation — default ~2500 when not specified
		const effectiveMaxChars =
			params.maxChars !== undefined ? params.maxChars : INSPECT_DEFAULT_LIMIT;
		if (effectiveMaxChars > 0 && content.length > effectiveMaxChars) {
			const remaining = content.length - effectiveMaxChars;
			content =
				content.slice(0, effectiveMaxChars) +
				`\n… ${remaining} more chars (use maxChars=0 for full content)`;
		}

		const result: InspectResult = {
			success: true,
			content,
		};
		if (correlated.staleCache) {
			result.staleCacheWarning = true;
		}
		return result;
	}

	if (params.role || params.name || params.ref || params.subtree) {
		// --- Element query path ---
		if (!cacheExists) {
			return {
				success: false,
				content: "",
				error:
					"No elements cached yet — use browser-snapshot to populate element cache.",
			};
		}

		const status: QueryStatus = {};
		const filtered = queryElementCache(
			cache!,
			{
				...(params.role !== undefined ? { role: params.role } : {}),
				...(params.name !== undefined ? { name: params.name } : {}),
				...(params.ref !== undefined ? { ref: params.ref } : {}),
				...(params.subtree !== undefined ? { subtree: params.subtree } : {}),
			},
			status,
		);

		let content: string;
		if (filtered.length === 0 && status.refFilteredOut) {
			const { node, filter, value } = status.refFilteredOut;
			content =
				`Element @${node.ref} found in cache (role=${node.role}` +
				`${node.name ? `, name="${node.name}"` : ""}) but does not match ` +
				`filter ${filter}="${value}". Drop the ${filter} filter or adjust it.`;
		} else {
			content = formatElementList(filtered, {
				...(params.ref !== undefined ? { ref: params.ref } : {}),
			});
		}

		return {
			success: true,
			content,
			staleCacheWarning: !cacheFresh && filtered.length > 0,
		};
	}

	// --- No params — role-count summary ---
	if (!cacheExists) {
		return {
			success: true,
			content:
				"No elements cached yet — use browser-snapshot to populate element cache.",
		};
	}

	const summary = formatRoleCountSummary(cache!);
	return {
		success: true,
		content: summary,
		staleCacheWarning: !cacheFresh,
	};
}

/**
 * Filter an ExtractResult in-place to only include elements whose text
 * contains the given query string (case-insensitive). Also checks link
 * hrefs and image sources for the query.
 *
 * When no elements match across any category, appends a notice to the
 * paragraphs array so the agent gets a clear signal.
 */
function applyQueryFilter(extracted: ExtractResult, query: string): void {
	const q = query.toLowerCase();

	extracted.headings = extracted.headings.filter((h) =>
		h.text.toLowerCase().includes(q),
	);
	extracted.paragraphs = extracted.paragraphs.filter((p) =>
		p.text.toLowerCase().includes(q),
	);
	extracted.links = extracted.links.filter(
		(l) => l.text.toLowerCase().includes(q) || l.href.toLowerCase().includes(q),
	);
	extracted.images = extracted.images.filter(
		(img) =>
			img.alt.toLowerCase().includes(q) || img.src.toLowerCase().includes(q),
	);
	extracted.interactive = extracted.interactive.filter((el) =>
		el.text.toLowerCase().includes(q),
	);

	const afterCount =
		extracted.headings.length +
		extracted.paragraphs.length +
		extracted.links.length +
		extracted.images.length +
		extracted.interactive.length;

	// Signal empty results so the agent doesn't get a silent empty page
	if (afterCount === 0) {
		extracted.paragraphs.push({
			text: `⚠ No content matched "${query}". Try a different keyword or remove the query parameter.`,
		});
	}
}

/**
 * Check whether the element cache is still fresh compared to the
 * last interaction time. Returns true if fresh or if timestamps
 * are unavailable (conservative: assume fresh).
 */
function stalenessCheck(session: BrowserSession | undefined): boolean {
	if (!session) return true; // No session — assume fresh
	if (session.cachePopulatedAt === undefined) return true; // No cache time — assume fresh
	if (session.lastInteractionAt === undefined) return true; // No interactions — assume fresh
	return session.cachePopulatedAt >= session.lastInteractionAt;
}

// ─── Cookie dispatch ──────────────────────────────────────────────

export async function getCookies(
	taskId: string | undefined,
	urls?: string[],
): Promise<CookieResult> {
	const resolved = await resolveSession(taskId);
	if (!resolved) {
		return { success: false, cookies: [], error: noSessionMsg };
	}
	return resolved.plugin.getCookies(resolved.tid, urls);
}

export async function addCookies(
	taskId: string | undefined,
	cookies: Cookie[],
): Promise<ResultBase> {
	const resolved = await resolveSession(taskId);
	if (!resolved) {
		return { success: false, error: noSessionMsg };
	}
	return resolved.plugin.addCookies(resolved.tid, cookies);
}

export async function clearCookies(
	taskId: string | undefined,
	options?: ClearCookiesOptions,
): Promise<ResultBase> {
	const resolved = await resolveSession(taskId);
	if (!resolved) {
		return { success: false, error: noSessionMsg };
	}
	return resolved.plugin.clearCookies(resolved.tid, options);
}

// ─── Error message constants ─────────────────────────────────────────

const noSessionMsg =
	"No active session — use browser-navigate to visit a page first, then retry";

function noSessionError(): InteractionResult {
	return { success: false, error: noSessionMsg };
}
