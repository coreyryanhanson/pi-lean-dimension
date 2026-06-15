import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Browser Toggle — integrated into pi-browser extension.
 *
 * Provides /web on, /web off, /web learn, and /web status commands to enable / disable
 * browser automation tools (browsing tools) and learn tools (web-learn) in the system prompt.
 *
 * Three states: on (browsing only), learn (browsing + web-learn), off (all disabled).
 * Internally stores two independent booleans (browserToolsEnabled, learnToolsEnabled).
 *
 * When browser tools are disabled, the LLM cannot see them — no descriptions,
 * parameter schemas, prompt snippets, or guidelines are included in the context,
 * saving roughly 1500–2000 tokens per turn.
 *
 * ── Stateless fallback ─────────────────────────────────────────
 *
 * web-fetch is a stateless HTTP tool (no session, no interactivity).  If you
 * only need quick page content and never use the interactive browser tools,
 * you can leave browser tools disabled and rely on web-fetch alone.
 */

// ---- Constants -------------------------------------------------

/** Global pi settings path */
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Project pi settings path (relative to current working dir) */
const PROJECT_SETTINGS_PATH = ".pi/settings.json";

/** Default toggle config key */
const CONFIG_KEY = "browserToggle";

/** Names of every browser browsing tool registered by pi-browser's index.ts (excludes learn tools). */
const BROWSER_TOOL_NAMES = new Set([
	"web-fetch",
	"browser-navigate",
	"browser-snapshot",
	"browser-click",
	"browser-type",
	"browser-scroll",
	"browser-screenshot",
	"browser-get-images",
	"browser-back",
	"browser-press",
	"browser-console",
]);

/** Names of learn tools (web-learn) that require /web learn to be active. */
const LEARN_TOOL_NAMES = new Set(["web-learn"]);

/** Persisted state shape — two independent booleans plus conversation-scoped default profile. */
interface BrowserToggleState {
	browserToolsEnabled: boolean;
	learnToolsEnabled: boolean;
	/** Default profile for the current conversation. "none" means no override. */
	defaultProfile: string;
}

/** Last known toggle state — used by status bar */
let _lastToggleState = true;

/** Conversation-scoped default profile. "none" means: read from config file. */
let _conversationDefaultProfile: string | undefined;

/**
 * Get the effective default profile. Returns the conversation-scoped override
 * if set, otherwise falls back to "none" (the router reads browser.defaultProfile
 * from settings.json as its own fallback).
 */
export function getConversationDefaultProfile(): string | undefined {
	return _conversationDefaultProfile;
}

// ---- Helpers ---------------------------------------------------

/**
 * Return the subset of BROWSER_TOOL_NAMES that are actually registered.
 * This safely handles the case where pi-browser is not installed.
 * (With the toggle integrated into pi-browser, this is always non-empty
 *  when pi-browser is loaded, but the helper remains for robustness.)
 */
function getRegisteredBrowserTools(pi: ExtensionAPI): string[] {
	return pi
		.getAllTools()
		.map((t) => t.name)
		.filter((n) => BROWSER_TOOL_NAMES.has(n));
}

/**
 * Check whether browser tools are currently active in the system prompt.
 * Returns true when no browser tools exist (nothing to toggle).
 */
function isBrowserEnabled(pi: ExtensionAPI): boolean {
	const registered = getRegisteredBrowserTools(pi);
	if (registered.length === 0) return true; // nothing registered → vacuously "enabled"

	const active = new Set(pi.getActiveTools());
	return registered.some((name) => active.has(name));
}

/**
 * Apply a browser-tool state without persisting.
 * @param pi       ExtensionAPI
 * @param enable   true = add browser tools to the active set, false = remove them
 */
function applyBrowserState(pi: ExtensionAPI, enable: boolean): void {
	const registered = new Set(getRegisteredBrowserTools(pi));
	if (registered.size === 0) return;
	_lastToggleState = enable;

	if (enable) {
		// Merge browser tools back into whatever is currently active
		const current = pi.getActiveTools();
		pi.setActiveTools([...new Set([...current, ...registered])]);
	} else {
		// Keep everything that is NOT a browser tool
		const all = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(all.filter((name) => !registered.has(name)));
	}
}

/**
 * Persist the current toggle state into the session for branch-aware
 * restoration across /reload, /resume, /fork, and /tree navigation.
 */
function persistState(pi: ExtensionAPI, state: BrowserToggleState): void {
	pi.appendEntry<BrowserToggleState>("browser-toggle-state", state);
}

// ---- Branch-aware restoration ----------------------------------

/**
 * Migrate a legacy {enabled: boolean} state to the new three-field schema.
 */
function migrateLegacyState(data: unknown): BrowserToggleState | null {
	if (data && typeof data === "object" && "enabled" in data) {
		const enabled = (data as Record<string, unknown>).enabled === true;
		return {
			browserToolsEnabled: enabled,
			learnToolsEnabled: enabled,
			defaultProfile: "none",
		};
	}
	// Also handle the two-boolean schema (missing defaultProfile)
	if (
		data &&
		typeof data === "object" &&
		typeof (data as Record<string, unknown>).browserToolsEnabled === "boolean"
	) {
		return {
			browserToolsEnabled: (data as Record<string, unknown>)
				.browserToolsEnabled as boolean,
			learnToolsEnabled:
				((data as Record<string, unknown>).learnToolsEnabled as boolean) ??
				false,
			defaultProfile:
				((data as Record<string, unknown>).defaultProfile as string) ?? "none",
		};
	}
	return null;
}

function restoreFromBranch(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	const registered = getRegisteredBrowserTools(pi);
	if (registered.length === 0) return false;

	let savedState: BrowserToggleState | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type === "custom" &&
			entry.customType === "browser-toggle-state"
		) {
			const data = entry.data as Record<string, unknown>;
			// Try new schema first, then legacy
			if (data && typeof data.browserToolsEnabled === "boolean") {
				savedState = data as unknown as BrowserToggleState;
			} else {
				savedState = migrateLegacyState(data) ?? undefined;
			}
		}
	}

	if (savedState !== undefined) {
		applyBrowserState(pi, savedState.browserToolsEnabled);
		applyLearnState(pi, savedState.learnToolsEnabled);
		// Restore conversation-scoped default profile
		if (savedState.defaultProfile && savedState.defaultProfile !== "none") {
			_conversationDefaultProfile = savedState.defaultProfile;
		}
		return true;
	}

	return false;
}

/**
 * Apply the config-file default on a fresh session (no branch state found).
 * Reads `browserToggle.defaultEnabled` from pi's settings.json files.
 * Learn always starts disabled by default.
 */
function applyConfigDefault(pi: ExtensionAPI): void {
	const enabled = readBrowserToggleConfig();
	applyBrowserState(pi, enabled);
	applyLearnState(pi, false);
	// Persist so subsequent branch navigation sees this as the initial state
	persistState(pi, {
		browserToolsEnabled: enabled,
		learnToolsEnabled: false,
		defaultProfile: "none",
	});
}

// ---- Unit-test exports -----------------------------------------
// Helper functions are exported for testing while the default export
// wires the toggle into pi-browser's runtime.

/**
 * Return the last known toggle state (true = enabled, false = disabled).
 * Returns true initially at startup (browser tools start enabled).
 */
export function getToggleState(): boolean {
	return _lastToggleState;
}

/** @internal Exported for testing only: reset the toggle tracker to its default */
export function _resetToggleStateForTest(): void {
	_lastToggleState = true;
}

// ---- Config-file support -----------------------------------------

/**
 * Read the browser toggle default from pi's settings.json files.
 *
 * Looks for `browserToggle.defaultEnabled` in:
 *   1. `~/.pi/agent/settings.json` (global)
 *   2. `.pi/settings.json` (project-local, overrides global)
 *
 * Returns the config value, or `true` if unset (backward-compatible default).
 * Silently returns `true` on missing files, parse errors, or type mismatches.
 */
function readBrowserToggleConfig(): boolean {
	const global = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const project = readSettingsFile(PROJECT_SETTINGS_PATH);

	// Project overrides global
	const merged = { ...global, ...project };
	const segment = merged[CONFIG_KEY];

	if (
		segment &&
		typeof segment === "object" &&
		!Array.isArray(segment) &&
		typeof (segment as Record<string, unknown>).defaultEnabled === "boolean"
	) {
		return (segment as Record<string, unknown>).defaultEnabled as boolean;
	}

	return true; // default: enabled
}

/** Read and parse a JSON settings file. Returns {} on any failure. */
function readSettingsFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * Return the subset of LEARN_TOOL_NAMES that are actually registered.
 */
function getRegisteredLearnTools(pi: ExtensionAPI): string[] {
	return pi
		.getAllTools()
		.map((t) => t.name)
		.filter((n) => LEARN_TOOL_NAMES.has(n));
}

/**
 * Check whether learn tools are currently active.
 * Returns true when no learn tools exist (vacuously enabled).
 */
function isLearnEnabled(pi: ExtensionAPI): boolean {
	const registered = getRegisteredLearnTools(pi);
	if (registered.length === 0) return true;
	const active = new Set(pi.getActiveTools());
	return registered.some((name) => active.has(name));
}

/**
 * Apply a learn-tool state without persisting.
 * Uses getActiveTools() (not getAllTools()) to avoid accidentally activating
 * learn tools that are not currently registered.
 */
function applyLearnState(pi: ExtensionAPI, enable: boolean): void {
	const registered = new Set(getRegisteredLearnTools(pi));
	if (registered.size === 0) return;
	if (enable) {
		const current = pi.getActiveTools();
		pi.setActiveTools([...new Set([...current, ...registered])]);
	} else {
		// Remove learn tools from the *currently active* set
		const current = pi.getActiveTools();
		pi.setActiveTools(current.filter((name) => !registered.has(name)));
	}
}

export {
	getRegisteredBrowserTools,
	isBrowserEnabled,
	applyBrowserState,
	persistState,
	restoreFromBranch,
	readBrowserToggleConfig,
	applyConfigDefault,
	getRegisteredLearnTools,
	isLearnEnabled,
	applyLearnState,
	migrateLegacyState,
};
export type { BrowserToggleState };

// ---- Profile management helpers ----------------------------------

import {
	PROFILE_DIR,
	profileFilePath,
	deleteStorageState,
	pruneStaleSessionProfiles,
	isSessionProfile,
	sanitizeProfileName,
	profileDir,
} from "./core/shared/storage-state.js";
import * as router from "./core/router.js";
import { sessionManager } from "./core/shared/session-manager.js";

/**
 * Get a human-readable size description for a profile's storage state.
 * Returns "no state" if the file doesn't exist or is empty.
 */
function profileStateSize(profileName: string): string {
	const path = profileFilePath(profileName);
	try {
		if (!existsSync(path)) return "no state";
		const bytes = statSync(path).size;
		if (bytes === 0) return "empty";
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	} catch {
		return "?";
	}
}

/**
 * List all profiles found on disk.
 * Returns an array of { name, stateSize } objects.
 */
export function listProfiles(): Array<{
	name: string;
	stateSize: string;
}> {
	try {
		if (!existsSync(PROFILE_DIR)) return [];
		const entries = readdirSync(PROFILE_DIR, { withFileTypes: true });
		const profiles = entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => ({
				name: e.name,
				stateSize: profileStateSize(e.name),
			}));
		profiles.sort((a, b) => a.name.localeCompare(b.name));
		return profiles;
	} catch {
		return [];
	}
}

/**
 * Short human-readable label for a profile name.
 * Session-scoped profiles show "📋" instead of the raw `_session-` prefix.
 * Named profiles show as-is.
 */
function profileLabel(name: string): string {
	if (isSessionProfile(name)) return "📋 session";
	return name;
}

/**
 * Set the conversation-scoped default profile.
 * Affects this conversation only; survives /reload, /resume, /fork.
 * "none" resets to the config-file default.
 */
function setConversationDefaultProfile(
	pi: ExtensionAPI,
	profile: string,
): void {
	if (profile === "none") {
		_conversationDefaultProfile = undefined;
	} else {
		_conversationDefaultProfile = profile;
	}

	// Persist so it survives /reload, /resume, /fork
	const currentState = getCurrentState(pi);
	persistState(pi, {
		...currentState,
		defaultProfile: profile,
	});
}

/** Read the current in-memory toggle state. */
function getCurrentState(
	pi: ExtensionAPI,
): Pick<BrowserToggleState, "browserToolsEnabled" | "learnToolsEnabled"> {
	return {
		browserToolsEnabled: isBrowserEnabled(pi),
		learnToolsEnabled: isLearnEnabled(pi),
	};
}

/**
 * Format a profile list as a human-readable string.
 */
export function formatProfileList(
	profiles: ReturnType<typeof listProfiles>,
): string {
	if (profiles.length === 0) {
		return "No profiles found on disk.";
	}
	const lines = [`Profiles (${profiles.length}):`];
	for (const p of profiles) {
		const sessionBadge = isSessionProfile(p.name) ? " 📋" : "";
		lines.push(`  ${profileLabel(p.name)}  (${p.stateSize})${sessionBadge}`);
	}
	return lines.join("\n");
}

// ---- Toggle initializer ----------------------------------------

/**
 * Register the /web command and session-restoration hooks.
 * Called from pi-browser's index.ts entry point.
 */
export default function initBrowserToggle(pi: ExtensionAPI) {
	// ── Commands ──────────────────────────────────────────────

	pi.registerCommand("web", {
		description:
			"Enable/disable browser automation tools. " +
			"Usage: /web on | off | learn | status",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();
			const hasBrowserTools = getRegisteredBrowserTools(pi).length > 0;

			if (!hasBrowserTools) {
				ctx.ui.notify(
					"🌐 pi-browser extension not detected. Nothing to toggle.",
					"warning",
				);
				return;
			}

			if (cmd === "on") {
				applyBrowserState(pi, true);
				applyLearnState(pi, false);
				persistState(pi, {
					browserToolsEnabled: true,
					learnToolsEnabled: false,
					defaultProfile: _conversationDefaultProfile ?? "none",
				});
				ctx.ui.setStatus("browser", "🌐 idle");
				ctx.ui.notify(
					"🌐 Browser tools enabled. /web learn to make web-learn available.",
					"info",
				);
			} else if (cmd === "learn") {
				applyBrowserState(pi, true);
				applyLearnState(pi, true);
				persistState(pi, {
					browserToolsEnabled: true,
					learnToolsEnabled: true,
					defaultProfile: _conversationDefaultProfile ?? "none",
				});
				ctx.ui.setStatus("browser", "🌐 idle");
				ctx.ui.notify(
					"📖 web-learn tool is now available. Agent will save/update guides when asked.",
					"info",
				);
			} else if (cmd === "off") {
				applyBrowserState(pi, false);
				applyLearnState(pi, false);
				persistState(pi, {
					browserToolsEnabled: false,
					learnToolsEnabled: false,
					defaultProfile: _conversationDefaultProfile ?? "none",
				});
				ctx.ui.setStatus("browser", "○ web off");
				ctx.ui.notify(
					"🌐 Browser tools disabled. /web on to re-enable.",
					"info",
				);
			} else if (cmd === "profile" || cmd.startsWith("profile ")) {
				// ── Profile management sub-commands ────────────────────
				const sub = cmd.slice("profile".length).trim();

				// --- list (default) ---
				if (sub === "" || sub === "list") {
					const profiles = listProfiles();
					const formatted = formatProfileList(profiles);
					ctx.ui.notify(formatted, "info");

					// --- mode switches (special keywords) ---
				} else if (sub === "none") {
					setConversationDefaultProfile(pi, "none");
					ctx.ui.notify(
						"Default profile set to 'none' (ephemeral, no persistence).",
						"info",
					);
				} else if (sub === "session") {
					setConversationDefaultProfile(pi, "session");
					ctx.ui.notify(
						"Default profile set to 'session' (persists for this conversation).",
						"info",
					);

					// --- create <name> ---
				} else if (sub === "create" || sub.startsWith("create ")) {
					const name =
						sub === "create" ? "" : sub.slice("create ".length).trim();
					if (!name) {
						ctx.ui.notify(
							"Usage: /web profile create <name>\n" +
								"  Profile names must be alphanumeric, hyphens, and underscores only.\n" +
								"  Reserved names: none, session, create.",
							"warning",
						);
						return;
					}
					try {
						sanitizeProfileName(name);
						mkdirSync(profileDir(name), { recursive: true, mode: 0o700 });
						ctx.ui.notify(
							`Created profile '${name}'. Use browser-navigate profile="${name}" to start.`,
							"info",
						);
					} catch (err) {
						ctx.ui.notify(
							`Invalid profile name: ${err instanceof Error ? err.message : String(err)}`,
							"warning",
						);
					}

					// --- switch to existing named profile ---
				} else if (
					!sub.includes(" ") &&
					sub !== "clear" &&
					sub !== "clear-all"
				) {
					// Single word that isn't a known keyword — try as a named profile switch
					try {
						const targetDir = profileDir(sub);
						if (!existsSync(targetDir)) {
							ctx.ui.notify(
								`Profile '${sub}' does not exist.\n` +
									`  Create it first with /web profile create ${sub}`,
								"warning",
							);
							return;
						}
						setConversationDefaultProfile(pi, sub);
						ctx.ui.notify(
							`Default profile set to '${sub}' (shared across tasks).`,
							"info",
						);
					} catch (err) {
						ctx.ui.notify(
							`Invalid profile name: ${err instanceof Error ? err.message : String(err)}`,
							"warning",
						);
					}

					// --- clear <name> ---
				} else if (sub === "clear" || sub.startsWith("clear ")) {
					const name = sub === "clear" ? "" : sub.slice("clear ".length).trim();
					if (!name) {
						ctx.ui.notify(
							"Usage: /web profile clear <name> — provide a profile name.",
							"warning",
						);
						return;
					}
					const path = profileFilePath(name);
					if (!existsSync(path)) {
						ctx.ui.notify(
							`Profile '${name}' has no saved state. Nothing to clear.`,
							"info",
						);
						return;
					}
					deleteStorageState(name);
					ctx.ui.notify(`Cleared profile '${name}' state.`, "info");

					// --- clear-all [--confirm] ---
				} else if (sub === "clear-all" || sub === "clear-all --confirm") {
					const profiles = listProfiles();
					if (profiles.length === 0) {
						ctx.ui.notify("No profiles to clear.", "info");
						return;
					}
					if (sub === "clear-all") {
						const names = profiles.map((p) => p.name).join(", ");
						ctx.ui.notify(
							`⚠ This will clear ALL profile states: ${names}\n` +
								`  Run /web profile clear-all --confirm to proceed.`,
							"warning",
						);
					} else {
						let cleared = 0;
						for (const p of profiles) {
							deleteStorageState(p.name);
							cleared++;
						}
						ctx.ui.notify(`Cleared ${cleared} profile(s).`, "info");
					}

					// --- prune [--confirm] ---
				} else if (sub === "prune" || sub === "prune --confirm") {
					const result = pruneStaleSessionProfiles();
					if (result.pruned.length === 0) {
						ctx.ui.notify("No stale session profiles to prune.", "info");
						return;
					}
					if (sub === "prune") {
						ctx.ui.notify(
							`Found ${result.pruned.length} stale session profile(s): ${result.pruned.join(", ")}\n` +
								`  Run /web profile prune --confirm to delete.`,
							"warning",
						);
					} else {
						ctx.ui.notify(
							`Pruned ${result.pruned.length} stale session profile(s).`,
							"info",
						);
					}

					// --- unknown ---
				} else {
					ctx.ui.notify(
						`Unknown profile sub-command: "${sub}". ` +
							`Usage: /web profile [list|create <name>|<name>|none|session|clear <name>|clear-all [--confirm]|prune [--confirm]]`,
						"warning",
					);
				}
			} else if (cmd === "cookies" || cmd.startsWith("cookies ")) {
				// ── Cookie inspection sub-commands ──────────────────────
				const sub = cmd.slice("cookies".length).trim();

				// Resolve taskId by looking up piSessionId in active sessions.
				// This matches the taskId assigned by index.ts's monotonic counter
				// (which can't be replicated here), so we look it up instead.
				const resolveTaskId = (): string => {
					const mgr = (ctx as unknown as Record<string, unknown>)
						?.sessionManager as { getSessionId?: () => string } | undefined;
					const piSessionId = mgr?.getSessionId?.();
					if (piSessionId) {
						const found = sessionManager.getTaskIdForPiSessionId(piSessionId);
						if (found) return found;
					}
					// Fallback: use the first active session
					const active = sessionManager.getActiveSessions();
					if (active.length > 0) return active[0]!.taskId;
					return "browser-default";
				};

				if (sub === "" || sub === "list") {
					const result = await router.getCookies(resolveTaskId());
					if (!result.success) {
						ctx.ui.notify(
							`Failed to get cookies: ${result.error ?? "unknown error"}`,
							"warning",
						);
						return;
					}
					if (result.cookies.length === 0) {
						ctx.ui.notify("No cookies found for the current session.", "info");
						return;
					}
					// Format cookies
					const lines = [`Found ${result.cookies.length} cookie(s):`, ""];
					for (const c of result.cookies) {
						const flags = [
							c.httpOnly ? "HttpOnly" : "",
							c.secure ? "Secure" : "",
							c.sameSite || "",
						]
							.filter(Boolean)
							.join(" ");
						const expires =
							c.expires && c.expires > 0
								? new Date(c.expires * 1000).toISOString()
								: "Session";
						lines.push(
							`  ${c.name}=${c.value.slice(0, 80)}${c.value.length > 80 ? "…" : ""}`,
						);
						lines.push(
							`    Domain: ${c.domain ?? "?"}  Path: ${c.path ?? "/"}`,
						);
						lines.push(`    Expires: ${expires}  ${flags}`.trimEnd());
						lines.push("");
					}
					ctx.ui.notify(lines.join("\n"), "info");
				} else if (sub === "clear" || sub === "clear --confirm") {
					if (sub === "clear") {
						ctx.ui.notify(
							"⚠ This will clear ALL cookies for the current session.\n" +
								"  Run /web cookies clear --confirm to proceed.",
							"warning",
						);
						return;
					}
					const result = await router.clearCookies(resolveTaskId());
					if (!result.success) {
						ctx.ui.notify(
							`Failed to clear cookies: ${result.error ?? "unknown error"}`,
							"warning",
						);
						return;
					}
					ctx.ui.notify("Cleared all cookies for the current session.", "info");
				} else {
					ctx.ui.notify(
						`Unknown cookies sub-command: "${sub}". ` +
							`Usage: /web cookies [list|clear [--confirm]]`,
						"warning",
					);
				}
			} else {
				// Default: show status
				const browserStatus = isBrowserEnabled(pi) ? "✅ on" : "❌ off";
				const learnStatus = isLearnEnabled(pi) ? "✅ on" : "❌ off";
				ctx.ui.notify(
					`🌐 Browser tools: ${browserStatus}\n` +
						`📖 Learn mode: ${learnStatus}\n` +
						`   /web profile     manage browser profiles\n` +
						`   /web cookies     inspect or clear session cookies\n` +
						`   /web off         disable all browser tools\n` +
						`   /web on          enable browsing only\n` +
						`   /web learn       enable browsing + guide-saving\n` +
						`   /web             show this status`,
					"info",
				);
			}
		},
	});

	// ── State restoration across session boundaries ────────────
	// Ensures the toggle survives /reload, /resume, /fork, and
	// /tree navigation without "forgetting" whether we're on or off.
	//
	// For fresh sessions (no branch state), falls back to the config
	// default from settings.json (`browserToggle.defaultEnabled`).

	pi.on("session_start", async (_event, ctx) => {
		const restored = restoreFromBranch(pi, ctx);
		if (!restored) {
			// No persisted state in this branch → apply config file default
			applyConfigDefault(pi);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(pi, ctx);
	});
}
