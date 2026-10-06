import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { updateFooterStatus, getLastCtx, setLastCtx } from "./tools/utils.js";
import {
	defineToolset,
	toggleBatch,
	getRegisteredToolsets,
	TOOLSET_EVENTS,
} from "pi-tool-masking";
import type { ToolsetSpec, BatchOp } from "pi-tool-masking";

// Catch AllowlistModeError by name, never `instanceof` — the handle may come
// from a different library copy via the shared registry. Returns true when
// the toggle ran, false when it was refused (nothing changed).
function refuseOnAllowlist(ctx: ExtensionContext, toggle: () => unknown): boolean {
	try {
		toggle();
		return true;
	} catch (err) {
		if ((err as { name?: string } | undefined)?.name === "AllowlistModeError") {
			ctx.ui.notify(
				"Focus mode (allowlist) is active — this toolset can't be toggled while focus is holding the line. Exit focus there first.",
				"warning",
			);
			return false;
		}
		throw err;
	}
}

// ---- Toolset specs -----------------------------------------------

const WEB_TOOLSET_ID = "pi-lean-dimension.web";
const LEARN_TOOLSET_ID = "pi-lean-dimension.web-learn";
// The one new coupling line: portal names search's toolset id as a string
// constant (search imports nothing back — see /web handler below).
const SEARCH_TOOLSET_ID = "pi-lean-dimension.search";

const PORTAL_WEB_SPEC: ToolsetSpec = {
	id: WEB_TOOLSET_ID,
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
	id: LEARN_TOOLSET_ID,
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

// ---- /web batch ops ----------------------------------------------

/** toggleBatch throws on an explicit unregistered op — on a portal-only
 *  install the search id isn't registered, so filter it out. Only the search
 *  op can ever drop out; web and web-learn are registered by this factory. */
function registeredOps(ops: readonly BatchOp[]) {
	const registered = new Set(
		getRegisteredToolsets().map((entry) => entry.spec.id),
	);
	return ops.filter((op) => registered.has(op.id));
}

/** Run one /web batch. `ran` is false only when the allowlist refusal
 *  aborted the subcommand (nothing changed). `searchDelta` is the direction
 *  of the search delta the batch produced — "on" when a separately-disabled
 *  search was just switched back on, "off" when search was just disabled —
 *  and undefined when search didn't drift (already in desired state, or the
 *  op was filtered out on a portal-only install). */
function applyWebBatch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	ops: readonly BatchOp[],
): { ran: boolean; searchDelta?: "on" | "off" | undefined } {
	let searchDelta: "on" | "off" | undefined;
	const ran = refuseOnAllowlist(ctx, () => {
		const hit = toggleBatch(pi, ctx.sessionManager, registeredOps(ops)).find(
			(r) => r.id === SEARCH_TOOLSET_ID,
		);
		searchDelta = hit ? (hit.enabled ? "on" : "off") : undefined;
	});
	return { ran, searchDelta };
}

// ---- Toggle initializer ------------------------------------------

// Unsubscribers for the glyph-sync listeners — pi re-invokes the factory
// per load pass, so drain the previous pair before re-registering.
let _offSync: (() => void)[] = [];

export default function initBrowserToggle(pi: ExtensionAPI) {
	for (const off of _offSync) off();
	_offSync = [];
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

	_offSync = [
		pi.events.on(TOOLSET_EVENTS.changed, syncCachedState),
		pi.events.on(TOOLSET_EVENTS.restored, syncCachedState),
	];

	// ── /web command ──────────────────────────────────────────
	pi.registerCommand("web", {
		description:
			"Enable/disable browser automation tools. " +
			"Usage: /web on | off | learn | install | status",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();

			if (cmd === "on") {
				// One batch = the whole web workflow: web on, search dragged
				// along unconditionally, learn explicitly off (the historic
				// semantic — not leaned on the requires cascade).
				const { ran, searchDelta } = applyWebBatch(pi, ctx, [
					{ id: WEB_TOOLSET_ID, desired: true },
					{ id: SEARCH_TOOLSET_ID, desired: true },
					{ id: LEARN_TOOLSET_ID, desired: false },
				]);
				if (!ran) return;
				ctx.ui.notify(
					"🌐 Browser tools enabled. /web learn to make web-learn available." +
						(searchDelta === "on" ? " Search re-enabled." : ""),
					"info",
				);
			} else if (cmd === "learn") {
				// web-learn's requires cascades web on; search co-activates
				// unconditionally (no drift required).
				const { ran, searchDelta } = applyWebBatch(pi, ctx, [
					{ id: LEARN_TOOLSET_ID, desired: true },
					{ id: SEARCH_TOOLSET_ID, desired: true },
				]);
				if (!ran) return;
				ctx.ui.notify(
					"📖 web-learn tool is now available. Agent will save/update guides when asked." +
						(searchDelta === "on" ? " Search re-enabled." : ""),
					"info",
				);
			} else if (cmd === "off") {
				// web-learn follows web off via its requires cascade inside
				// the batch.
				const { ran, searchDelta } = applyWebBatch(pi, ctx, [
					{ id: WEB_TOOLSET_ID, desired: false },
					{ id: SEARCH_TOOLSET_ID, desired: false },
				]);
				if (!ran) return;
				ctx.ui.notify(
					"🌐 Browser tools disabled. /web on to re-enable." +
						(searchDelta === "off" ? " Search disabled." : ""),
					"info",
				);
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
