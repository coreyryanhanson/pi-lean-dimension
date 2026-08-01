import type {
	ExtensionAPI,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	defineToolset,
	TOOLSET_EVENTS,
	getDefaultResolutionMode,
} from "pi-tool-masking";
import type { ToolsetSpec } from "pi-tool-masking";
import { readMergedSettings } from "./core/shared/settings-reader.js";

// Focus-mode guard helper. The library's published `DefaultResolutionMode`
// type is `"exclusion" | "inclusion"` (the allowlist mode is unpublished /
// ships in pi-tool-masking 1.2.0), so the string cast is load-bearing: an
// allowlist-capable consumer sharing the `globalThis` module state writes
// `"allowlist"` into it, and this consumer reads that value back at runtime
// even though its own bundled type doesn't name the mode. On published
// versions no caller ever writes `"allowlist"`, so this is a no-op for
// ordinary users — it only activates when an allowlist-capable
// pi-tool-masking consumer is in play.
//
// Cleanup at the ^1.2.0 bump: once `DefaultResolutionMode` names
// `"allowlist"`, drop the `as string` cast here and in pi-lean-search's
// co-activation mirror — the type system can then check the comparison
// directly and the cast becomes a suppressor of a check it should perform.
function isFocusHolding(): boolean {
	const mode = getDefaultResolutionMode() as string;
	return mode === "inclusion" || mode === "allowlist";
}

// ---- Toolset specs -----------------------------------------------

const PORTAL_WEB_SPEC: ToolsetSpec = {
	id: "pi-lean-dimension.web",
	names: new Set([
		"web-fetch",
		"browser-navigate",
		"browser-snapshot",
		"browser-click",
		"browser-type",
		"browser-scroll",
		"browser-back",
		"browser-press",
		"browser-console",
		"browser-inspect",
		"web-guide",
	]),
	persistKey: "toolset-state:pi-lean-dimension.web",
};

const PORTAL_LEARN_SPEC: ToolsetSpec = {
	id: "pi-lean-dimension.web-learn",
	names: new Set(["web-learn"]),
	persistKey: "toolset-state:pi-lean-dimension.web-learn",
	defaultEnabled: false,
	requires: ["pi-lean-dimension.web"],
};

// ---- Status bar cached state (derived from library events) ------

/** @internal Last known web-toggle state for status bar rendering. */
let _lastToggleState = true;

/** @internal Last known learn state for status bar coloring. */
let _lastLearnState = false;

/** @internal Last captured ExtensionContext for event-driven glyph rendering. */
let _lastCtx: ExtensionContext | null = null;

export function getToggleState(): boolean {
	return _lastToggleState;
}

export function getLearnState(): boolean {
	return _lastLearnState;
}

// ---- Conversation-scoped default profile -------------------------

const PROFILE_PERSIST_KEY = "portal-conversation-state";

interface ProfileState {
	defaultProfile: string;
}

let _conversationDefaultProfile: string | undefined;

export function getConversationDefaultProfile(): string | undefined {
	return _conversationDefaultProfile;
}

function persistProfile(pi: ExtensionAPI, profile: string): void {
	pi.appendEntry<ProfileState>(PROFILE_PERSIST_KEY, {
		defaultProfile: profile,
	});
}

function restoreProfile(_pi: ExtensionAPI, ctx: ExtensionContext): void {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === PROFILE_PERSIST_KEY) {
			const data = entry.data as Record<string, unknown> | undefined;
			if (data && typeof data.defaultProfile === "string") {
				_conversationDefaultProfile = data.defaultProfile;
				return;
			}
		}
	}
}

// ---- Test helpers -------------------------------------------------

/** @internal Reset cached state to defaults (test helper). */
function _resetToggleStateForTest(): void {
	_lastToggleState = true;
	_lastLearnState = false;
	_lastCtx = null;
	_conversationDefaultProfile = undefined;
}

/** @internal Reset cached state (called from index.ts on re-entry). */
function resetToggleModuleState(): void {
	_lastToggleState = true;
	_lastLearnState = false;
	_lastCtx = null;
	_conversationDefaultProfile = undefined;
}

// ---- Exports for testing -----------------------------------------

export { _resetToggleStateForTest, resetToggleModuleState };

// ---- Glyph helpers -----------------------------------------------

function renderBrowserGlyph(
	ctx: {
		ui: {
			setStatus: (key: string, label: string) => void;
			theme: { fg: (c: ThemeColor, t: string) => string };
		};
	},
	webEnabled: boolean,
	learnEnabled: boolean,
): void {
	if (!webEnabled) {
		ctx.ui.setStatus("browser", "○ web off");
		return;
	}
	if (learnEnabled) {
		ctx.ui.setStatus("browser", ctx.ui.theme.fg("success", "●") + " idle");
	} else {
		ctx.ui.setStatus("browser", ctx.ui.theme.fg("accent", "●") + " idle");
	}
}

// ---- Legacy settings migration warning ---------------------------
//
// The portal currently seeds the web toolset's fresh-session default from
// `browserToggle.defaultEnabled` in settings.json. An upcoming pi-tool-masking
// release takes over settings-based toolset defaults and reads a new
// `toolsetDefaults` block instead. Warn users who pinned the legacy key so
// they can migrate before the offload lands and the legacy read is removed.
//
// ponytail: warn-only — we still honor the legacy key for backward compat
// until pi-tool-masking owns the settings tier; then delete this helper and
// the `browserToggle` read below. Ceiling: a silent default shift for users
// who ignore the warning; upgrade path is the pi-tool-masking bump.
const TOOLSET_DEFAULTS_MIGRATION_MSG =
	"⚠️ pi-lean-portal: settings-based toolset defaults are moving to the " +
	"pi-tool-masking library. The `browserToggle.defaultEnabled` key in your " +
	"settings.json will stop being read in an upcoming release — migrate to " +
	"the `toolsetDefaults` block now so your default is preserved:\n\n" +
	"{\n" +
	'  "toolsetDefaults": {\n' +
	'    "toolset-state:pi-lean-dimension.web": { "enabled": true },\n' +
	'    "toolset-state:pi-lean-dimension.web-learn": { "enabled": true },\n' +
	'    "toolset-state:pi-lean-dimension.search": { "enabled": true }\n' +
	"  }\n" +
	"}\n" +
	"(omit a key to use the toolset's packaged default; the `search` key " +
	"only applies when pi-lean-search is installed).";

function hasLegacyToolsetDefault(merged: Record<string, unknown>): boolean {
	const seg = merged["browserToggle"];
	if (!seg || typeof seg !== "object" || Array.isArray(seg)) return false;
	return (
		typeof (seg as Record<string, unknown>)["defaultEnabled"] === "boolean"
	);
}

// The new `toolsetDefaults` block the pi-tool-masking offload will read.
// When the user has already migrated the web toolset's default into it,
// the warning is redundant even if the legacy `browserToggle.defaultEnabled`
// key is still sitting on disk — suppress so a migrated settings file stays
// quiet. Only the web persist key gates this: it's the one the legacy key
// controlled, so its presence means the user acted on the migration.
const WEB_TOOLSET_PERSIST_KEY = "toolset-state:pi-lean-dimension.web";
function hasMigratedToolsetDefault(merged: Record<string, unknown>): boolean {
	const td = merged["toolsetDefaults"];
	if (!td || typeof td !== "object" || Array.isArray(td)) return false;
	const entry = (td as Record<string, unknown>)[WEB_TOOLSET_PERSIST_KEY];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	return typeof (entry as Record<string, unknown>)["enabled"] === "boolean";
}

// ---- Toggle initializer ------------------------------------------

export default function initBrowserToggle(pi: ExtensionAPI) {
	const merged = readMergedSettings();
	// Warn only when the legacy key is pinned AND the user hasn't already
	// migrated the web default into `toolsetDefaults`. Once the migrated
	// entry exists, pi-tool-masking will read it directly and the legacy
	// key is dead weight — no need to nag.
	const legacyDefaultPinned =
		hasLegacyToolsetDefault(merged) && !hasMigratedToolsetDefault(merged);
	const browserToggleSegment = (merged as Record<string, unknown>)[
		"browserToggle"
	] as Record<string, unknown> | undefined;
	const webDefault =
		browserToggleSegment &&
		typeof browserToggleSegment["defaultEnabled"] === "boolean"
			? (browserToggleSegment["defaultEnabled"] as boolean)
			: true;

	const webSpec: ToolsetSpec = {
		...PORTAL_WEB_SPEC,
		defaultEnabled: webDefault,
	};
	const webToolset = defineToolset(pi, webSpec);
	const learnToolset = defineToolset(pi, PORTAL_LEARN_SPEC);

	// ── Keep cached state in sync with library events ─────────
	// Re-render the glyph on every change/restore so external callers
	// (e.g. pi-tbox's `/tbox all off`) keep the slot in sync — the cached
	// flags alone don't update the status bar.
	const syncCachedState = () => {
		_lastToggleState = webToolset.isEnabled(pi);
		_lastLearnState = learnToolset.isEnabled(pi);
		if (_lastCtx) {
			renderBrowserGlyph(_lastCtx, _lastToggleState, _lastLearnState);
		}
	};

	pi.events.on(TOOLSET_EVENTS.changed, syncCachedState);
	pi.events.on(TOOLSET_EVENTS.restored, syncCachedState);

	// ── /web command ──────────────────────────────────────────
	pi.registerCommand("web", {
		description:
			"Enable/disable browser automation tools. " +
			"Usage: /web on | off | learn | status",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();

			// Focus-mode guard (§13.2): refuse actuating subcommands while the
			// library holds the line — either inclusion mode or allowlist focus
			// (an upstream pi-tool-masking consumer). Either way a sibling
			// toggle must not write a focus-indistinguishable {enabled} entry.
			// Read-only subcommands (status/profile/cookies/bare /web) stay
			// unguarded, matching the focus controller's treatment of its own
			// read-only commands.
			if (["on", "off", "learn"].includes(cmd) && isFocusHolding()) {
				const inInclusion =
					(getDefaultResolutionMode() as string) === "inclusion";
				ctx.ui.notify(
					inInclusion
						? "Another plugin has active inclusion mode — this toolset can't be toggled while inclusion is holding the line. Deactivate it there first."
						: "Focus mode (allowlist) is active — this toolset can't be toggled while focus is holding the line. Exit focus there first.",
					"warning",
				);
				return;
			}

			if (cmd === "on") {
				webToolset.enable(pi);
				learnToolset.disable(pi);
				ctx.ui.notify(
					"🌐 Browser tools enabled. /web learn to make web-learn available.",
					"info",
				);
			} else if (cmd === "learn") {
				learnToolset.enable(pi); // cascades web on via requires
				ctx.ui.notify(
					"📖 web-learn tool is now available. Agent will save/update guides when asked.",
					"info",
				);
			} else if (cmd === "off") {
				webToolset.disable(pi); // cascades learn off via requires
				ctx.ui.notify(
					"🌐 Browser tools disabled. /web on to re-enable.",
					"info",
				);
			} else if (cmd === "profile" || cmd.startsWith("profile ")) {
				const sub = cmd.slice("profile".length).trim();
				const { handleProfileSubcommand } = await import(
					"./browser-profile.js"
				);
				await handleProfileSubcommand(sub, ctx, pi, (profile: string) => {
					if (profile === "none") {
						_conversationDefaultProfile = undefined;
					} else {
						_conversationDefaultProfile = profile;
					}
					persistProfile(pi, profile);
				});
			} else if (cmd === "cookies" || cmd.startsWith("cookies ")) {
				const sub = cmd.slice("cookies".length).trim();
				const { handleCookiesSubcommand } = await import(
					"./browser-cookies.js"
				);
				await handleCookiesSubcommand(sub, ctx);
			} else if (cmd === "status") {
				const { handleStatusSubcommand } = await import("./browser-status.js");
				handleStatusSubcommand(
					ctx,
					webToolset.isEnabled(pi),
					learnToolset.isEnabled(pi),
				);
			} else {
				// Default: show status
				const webOn = webToolset.isEnabled(pi) ? "✅ on" : "❌ off";
				const learnOn = learnToolset.isEnabled(pi) ? "✅ on" : "❌ off";
				ctx.ui.notify(
					`🌐 Browser tools: ${webOn}\n` +
						`📖 Learn mode: ${learnOn}\n` +
						`   /web profile     manage browser profiles\n` +
						`   /web cookies     inspect or clear session cookies\n` +
						`   /web off         disable all browser tools\n` +
						`   /web on          enable browsing only\n` +
						`   /web learn       enable browsing + guide-saving\n` +
						`   /web status      detailed runtime status (sessions, plugins, profiles)\n` +
						`   /web             show this status`,
					"info",
				);
			}
		},
	});

	// ── Session handlers: restore profile + render glyph ─────
	pi.on("session_start", async (_event, ctx) => {
		restoreProfile(pi, ctx);
		_lastCtx = ctx;
		syncCachedState();
		// One-time-per-session migration warning when the legacy
		// `browserToggle.defaultEnabled` pin is still on disk.
		if (legacyDefaultPinned) {
			ctx.ui.notify(TOOLSET_DEFAULTS_MIGRATION_MSG, "warning");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreProfile(pi, ctx);
		_lastCtx = ctx;
		syncCachedState();
	});

	pi.on("session_shutdown", async () => {
		_lastCtx = null;
	});
}
