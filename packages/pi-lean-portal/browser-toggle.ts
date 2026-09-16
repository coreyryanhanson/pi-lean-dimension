import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { updateFooterStatus, getLastCtx, setLastCtx } from "./tools/utils.js";
import {
	defineToolset,
	TOOLSET_EVENTS,
	getDefaultResolutionMode,
} from "pi-tool-masking";
import type { ToolsetSpec } from "pi-tool-masking";

// Focus-mode guard: refuse actuating subcommands while allowlist focus is
// holding the line (an upstream pi-tool-masking consumer).
function isFocusHolding(): boolean {
	return getDefaultResolutionMode() === "allowlist";
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
	// getBranch() is chronological root→leaf, so keep walking and the last
	// entry wins (newest /web profile choice on /reload, /resume, /tree).
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === PROFILE_PERSIST_KEY) {
			const data = entry.data as Record<string, unknown> | undefined;
			if (data && typeof data.defaultProfile === "string") {
				_conversationDefaultProfile = data.defaultProfile;
			}
		}
	}
}

/**
 * Reset cached module state to defaults.
 *
 * Called from index.ts on re-entry (pi reuses the cached module factory,
 * e.g. during /resume) and from tests.
 */
export function resetToggleModuleState(): void {
	_lastToggleState = true;
	_lastLearnState = false;
	_conversationDefaultProfile = undefined;
}

// ---- Toggle initializer ------------------------------------------

export default function initBrowserToggle(pi: ExtensionAPI) {
	// Settings-based toolset defaults (`toolsetDefaults` tier) are read by
	// pi-tool-masking itself inside defineToolset/restore — pass the packaged
	// spec straight through.
	const webToolset = defineToolset(pi, PORTAL_WEB_SPEC);
	const learnToolset = defineToolset(pi, PORTAL_LEARN_SPEC);

	// ── Keep cached state in sync with library events ─────────
	// Re-render the status bar on every change/restore so external callers
	// (e.g. pi-tbox's `/tbox all off`) keep the slot in sync — the cached
	// flags alone don't update the status bar.
	const syncCachedState = () => {
		_lastToggleState = webToolset.isEnabled(pi);
		_lastLearnState = learnToolset.isEnabled(pi);
		const ctx = getLastCtx();
		if (ctx) {
			updateFooterStatus(ctx);
		}
	};

	pi.events.on(TOOLSET_EVENTS.changed, syncCachedState);
	pi.events.on(TOOLSET_EVENTS.restored, syncCachedState);

	// ── /web command ──────────────────────────────────────────
	pi.registerCommand("web", {
		description:
			"Enable/disable browser automation tools. " +
			"Usage: /web on | off | learn | install | status",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();

			// Focus-mode guard: refuse actuating subcommands while allowlist
			// focus holds the line (an upstream pi-tool-masking consumer) —
			// a sibling toggle must not write a focus-indistinguishable
			// {enabled} entry.
			// Read-only subcommands (status/profile/cookies/bare /web) stay
			// unguarded, matching the focus controller's treatment of its own
			// read-only commands.
			if (["on", "off", "learn"].includes(cmd) && isFocusHolding()) {
				ctx.ui.notify(
					"Focus mode (allowlist) is active — this toolset can't be toggled while focus is holding the line. Exit focus there first.",
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
				ctx.ui.notify("🌐 Browser tools disabled. /web on to re-enable.", "info");
			} else if (cmd === "profile" || cmd.startsWith("profile ")) {
				const sub = cmd.slice("profile".length).trim();
				const { handleProfileSubcommand } = await import("./browser-profile.js");
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
				const { handleCookiesSubcommand } = await import("./browser-cookies.js");
				await handleCookiesSubcommand(sub, ctx);
			} else if (cmd === "install" || cmd.startsWith("install ")) {
				const sub = cmd.slice("install".length).trim();
				const { handleInstallSubcommand } = await import("./browser-install.js");
				await handleInstallSubcommand(sub, ctx);
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
						`   /web install     install browser binaries (bundled playwright CLI)\n` +
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

	// ── Session handlers: restore profile + render status bar ─
	pi.on("session_start", async (_event, ctx) => {
		restoreProfile(pi, ctx);
		setLastCtx(ctx);
		syncCachedState();
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreProfile(pi, ctx);
		setLastCtx(ctx);
		syncCachedState();
	});

	pi.on("session_shutdown", async () => {
		setLastCtx(null);
	});
}
