/**
 * Plugin Router — registry-based dispatch for interactive browser operations.
 * Handles snapshot truncation, session lifecycle, and crash recovery.
 */

import { writeFileSync } from "node:fs";
import { BROWSER_TEMP_DIR, ensureBrowserTempDir } from "./shared/paths.js";
import { cutAtNewline } from "./shared/temp-files.js";
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
import { isSessionProfile, loadStorageState } from "./shared/storage-state.js";
import {
	mergeProfilePrecedence,
	resolveNavigateProfile,
} from "./profile-resolution.js";
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
	BrowserPlugin,
	DialogEvent,
	NavigateResult,
	PluginNavigateOptions,
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
	 * Profile mode or named profile. Agent-typed names must exist on disk
	 * (typo protection); defaults materialize on first use — see
	 * resolveNavigateProfile in core/profile-resolution.ts.
	 */
	profile?: "none" | "session" | string;
	/** Conversation default profile (/web profile <name>). Ignored when
	 *  `profile` is set explicitly. */
	conversationDefault?: string;
	/** pi session ID used to derive the internal `_session-<piSessionId>`
	 *  profile name for profile="session". */
	piSessionId?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Format dialog events for appending to snapshot output.
 * Returns an empty string when there are no events.
 */
function formatDialogEvents(events: DialogEvent[]): string {
	if (events.length === 0) return "";

	const lines = events.map((d) => {
		const prefix = { alert: "📢", confirm: "❓", crash: "💥" }[d.type] ?? "💬";
		const handled = d.handledAs ? ` (auto-${d.handledAs})` : "";
		return `${prefix} [${d.type}] ${d.message}${handled}`;
	});

	return "\n\n--- Page events (dialogs, crashes) ---\n" + lines.join("\n");
}

/**
 * Navigate result as returned to the agent — the base `NavigateResult`
 * plus the backend that served the request (and the bot-warning flag).
 */
export type NavResult = Omit<NavigateResult, "errorKind"> & {
	backendUsed: string;
	/** Router-derived profile metadata — backends never produce these (kept off NavigateResult so the plugin contract stays clean). */
	profileMode?: "none" | "session" | "named";
	/** Which profile was resolved for this session (if any) */
	profileName?: string;
	botDetectionWarning?: boolean;
	/** Failure classification: "profile-refusal" is agent-actionable validation,
	 *  "not-installed" an environment problem fixable via /web install. */
	errorKind?: "profile-refusal" | "not-installed";
};

/**
 * Build a failed navigate result with the shared failure shape.
 *
 * Success paths construct their own object (they carry snapshot content,
 * dialog/profile metadata); every failure path funnels through here so the
 * base shape can't drift.
 */
function navFailure(
	backendUsed: string,
	url: string,
	extra?: {
		error?: string | undefined;
		title?: string;
		botDetectionWarning?: boolean | undefined;
		errorKind?: "profile-refusal" | "not-installed" | undefined;
	},
): NavResult {
	return {
		success: false,
		url,
		title: extra?.title ?? "",
		snapshot: "",
		elementCount: 0,
		backendUsed,
		...(extra?.error ? { error: extra.error } : {}),
		...(extra?.botDetectionWarning ? { botDetectionWarning: true } : {}),
		...(extra?.errorKind ? { errorKind: extra.errorKind } : {}),
	};
}

/**
 * Build plugin navigate options for a resolved profile: load the profile's
 * saved storage state (if any) and pass the profile name so the backend keys
 * its context and saves to it. Shared by the fresh-navigate and auto-recovery
 * paths so the two can't drift on what they hand a backend.
 */
function navOptionsFor(
	profileName: string | undefined,
	extra?: { signal?: AbortSignal | undefined },
): PluginNavigateOptions {
	const navOptions: PluginNavigateOptions = {};
	if (extra?.signal) navOptions.signal = extra.signal;
	if (profileName) {
		// null for missing, corrupt, or invalid names — proceed with fresh state.
		const state = loadStorageState(profileName);
		if (state) navOptions.storageState = state;
		navOptions.profile = profileName;
	}
	return navOptions;
}

/**
 * Abandon a task's session after a failed navigation: suppress the auto-save,
 * clean up on the plugin, and drop the session record and snapshot files.
 *
 * Skip auto-save: the nav never produced a validated page, so persisting
 * would write a near-empty state (and materialize the profile dir) for a
 * session the agent never actually used. Saves merge, so nothing already on
 * disk is at risk.
 */
async function abandon(taskId: string, plugin: BrowserPlugin): Promise<void> {
	sessionManager.updateSession(taskId, { persistState: false });
	await plugin.cleanup(taskId).catch(() => {});
	sessionManager.removeSession(taskId);
	removeSnapshotFiles(taskId);
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

	// Navigate — plugin loads its own storage state if needed
	const navResult = await plugin.navigate(
		lastNav.url,
		taskId,
		30_000,
		navOptionsFor(lastNav.profileName),
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

	// Failed — clean up (save suppressed: a failed recovery nav never validated)
	await abandon(taskId, plugin);
	return null;
}

interface ResolvedSession {
	tid: string;
	session: BrowserSession;
	plugin: BrowserPlugin;
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
		const topCut = cutAtNewline(snapshot, COMPACT_SNAPSHOT_TOP_LIMIT);

		const topSection = snapshot.slice(0, topCut);
		const bottomHint = remaining
			? `\n… ${snapshot.length - topSection.length} more chars, ${remaining} elements total`
			: `\n… ${snapshot.length - topSection.length} more chars`;
		return topSection + bottomHint;
	}

	const cut = cutAtNewline(snapshot, COMPACT_SNAPSHOT_LIMIT);

	const topSection = snapshot.slice(0, cut);
	const tail = remaining
		? `\n… ${snapshot.length - topSection.length} more chars, ${remaining} elements total`
		: `\n… ${snapshot.length - topSection.length} more chars`;

	return topSection + tail;
}

/**
 * Compose the compacted snapshot output block shared by all snapshot-bearing
 * results: compacted tree + cache notice + fingerprint + optional dialog events.
 */
function renderSnapshotBlock(
	raw: string,
	elementCount: number,
	fingerprint: string,
	cacheResult: CacheResult | null,
	dialogEvents?: DialogEvent[],
): string {
	return (
		compactSnapshot(raw, elementCount) +
		formatCacheNotice(cacheResult, raw.length, elementCount) +
		`\nfingerprint:${fingerprint}` +
		(dialogEvents ? formatDialogEvents(dialogEvents) : "")
	);
}

/**
 * For interaction tools that use @e refs (click, type, press, scroll, goBack):
 * if the session was just auto-created, the old @e refs are stale, so we
 * return a fresh snapshot instead of performing the action.
 */
async function refBasedInteractionOrSnapshot(
	taskId: string,
	wasAutoCreated: boolean,
	plugin: BrowserPlugin,
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
			const fingerprint = snapshotFingerprint(snap.snapshot);
			const cacheResult = cacheSnapshot(taskId, snap.snapshot, fingerprint);

			return {
				success: true,
				snapshot:
					"Page loaded interactively. Previous element references are stale. Use the following accessibility tree to interact:\n\n" +
					renderSnapshotBlock(
						snap.snapshot,
						snap.elementCount,
						fingerprint,
						cacheResult,
					),
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
		const cacheResult = cacheSnapshot(taskId, rawSnapshot, newFingerprint);

		result.snapshot = renderSnapshotBlock(
			rawSnapshot,
			result.elementCount,
			newFingerprint,
			cacheResult,
			result.dialogEvents,
		);

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
): Promise<NavResult> {
	const strategy = options.strategy ?? "auto";
	const timeoutMs = (options.timeout ?? 30) * 1000;
	const taskId = options.taskId ?? "default";

	// Resolve the plugin from the strategy
	const resolved = pluginRegistry.resolveStrategy(strategy);
	if (!resolved.plugin) {
		return navFailure(strategy, url, { error: resolved.error });
	}
	const plugin = resolved.plugin;

	// Normalise URL
	let normalizedUrl: string;
	try {
		normalizedUrl = new URL(url).href;
	} catch {
		return navFailure(plugin.name, url, {
			error: `Invalid URL: ${url}`,
		});
	}

	// ── Resolve profile mode ───────────────────────────────────
	const profileInput = mergeProfilePrecedence({
		explicit: options.profile,
		conversationDefault: options.conversationDefault,
		settingsDefault: loadFullConfig().browser.defaultProfile,
	});
	// An explicit profile is agent-typed (refused when missing); any default
	// is materialized on first use.
	const profileSource =
		options.profile !== undefined ? "agent" : "conversation";
	const resolution = resolveNavigateProfile(
		profileInput,
		profileSource,
		options.piSessionId,
	);
	if ("refusal" in resolution) {
		// The resolver reports the refusal; the router owns the failure taxonomy.
		return navFailure(plugin.name, normalizedUrl, {
			error: resolution.refusal.error,
			errorKind: "profile-refusal",
		});
	}
	const resolvedProfileName = resolution.profileName;
	// Mode is a pure derivation of the name, computed in one place so the
	// recorded name and the mode cannot disagree.
	const profileMode =
		resolvedProfileName === undefined
			? "none"
			: isSessionProfile(resolvedProfileName)
				? "session"
				: "named";

	// ── Debug: resolved profile ───────────────────
	if (process.env.BROWSER_DEBUG) {
		const parts = [`[browser] profile: task=${taskId}`];
		if (resolvedProfileName) parts.push(`profile=${resolvedProfileName}`);
		parts.push(`mode=${profileMode}`);
		console.error(parts.join(" "));
	}

	// ── Create session and navigate ───────────────────────────
	// Retire the old context (if any) before the session record flips, on the
	// plugin that owns it: cleanup persists the old profile's state to disk
	// first, so a profile/backend switch never mislabels cookies and the new
	// profile's storage state loads into a fresh context.
	const priorSession = sessionManager.getSession(taskId);
	const priorPlugin = priorSession ? pluginRegistry.get(priorSession.pluginName) : undefined;
	const retireOldContext =
		priorSession !== undefined &&
		(priorSession.pluginName !== plugin.name ||
			priorSession.profileName !== resolvedProfileName);
	if (retireOldContext) {
		// Only the prior plugin owns the old context; if it's no longer
		// registered there is nothing to retire, and cleaning up on the new
		// plugin would target a task it never saw.
		if (priorPlugin) await priorPlugin.cleanup(taskId).catch(() => {});
	}
	const session = sessionManager.createSession(taskId, plugin.name);
	sessionManager.updateSession(taskId, {
		currentUrl: normalizedUrl,
		persistState: resolvedProfileName !== undefined,
		profileName: resolvedProfileName ?? null,
		...(options.piSessionId === undefined
			? {}
			: { piSessionId: options.piSessionId }),
	});

	const result = await plugin.navigate(
		normalizedUrl,
		taskId,
		timeoutMs,
		navOptionsFor(resolvedProfileName, { signal: options.signal }),
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
			await abandon(taskId, plugin);
			return navFailure(plugin.name, result.url, {
				title: result.title,
				error:
					"Page appears to be blocked by anti-automation protection. " +
					"Retry `browser-navigate` with a stealth backend name from the `strategy` parameter's listed backends, " +
					"or try `web-fetch` for the raw HTML (it skips JS fingerprinting but loses interactivity).",
				botDetectionWarning: true,
			});
		}

		const fp = session.currentSnapshotFingerprint!;

		// --- Cache the raw snapshot before compaction ---
		const rawSnapshot = result.snapshot;
		const cacheResult: CacheResult | null = rawSnapshot
			? cacheSnapshot(taskId, rawSnapshot, fp)
			: null;
		// ---

		const snapshotContent = rawSnapshot
			? renderSnapshotBlock(
					rawSnapshot,
					result.elementCount,
					fp,
					cacheResult,
					result.dialogEvents,
				)
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

		const successResult: NavResult = {
			success: true,
			url: result.url,
			title: result.title,
			snapshot: snapshotContent,
			elementCount: result.elementCount,
			dialogDetected,
			backendUsed: plugin.name,
		};
		successResult.profileMode = profileMode;
		if (resolvedProfileName !== undefined)
			successResult.profileName = resolvedProfileName;
		if (botWarn) successResult.botDetectionWarning = true;
		return successResult;
	}

	// Navigation failed — `session` comes from createSession above, so it
	// always exists.
	await abandon(taskId, plugin);

	return navFailure(plugin.name, result.url || normalizedUrl, {
		error: result.error,
		...(result.errorKind ? { errorKind: result.errorKind } : {}),
		botDetectionWarning: result.botDetected,
	});
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
			result.snapshot = renderSnapshotBlock(
				result.snapshot,
				result.elementCount,
				fp,
				null,
			);
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
		plugin: BrowserPlugin,
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
	return wrapInteraction(taskId, (plugin, tid) => plugin.scroll(tid, direction));
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
			params.maxChars === undefined ? INSPECT_DEFAULT_LIMIT : params.maxChars;
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
				...(params.role === undefined ? {} : { role: params.role }),
				...(params.name === undefined ? {} : { name: params.name }),
				...(params.ref === undefined ? {} : { ref: params.ref }),
				...(params.subtree === undefined ? {} : { subtree: params.subtree }),
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
				...(params.ref === undefined ? {} : { ref: params.ref }),
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
