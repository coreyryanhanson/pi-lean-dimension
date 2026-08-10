/**
 * API Toggle — independent peer toggle for pi-lean-host.
 *
 * Provides /api on, /api off, /api learn, /api status, and /api helpers
 * commands to enable/disable API tools in the system prompt.
 *
 * Three states: on (api-guide + api-fetch), learn (on + api-learn + api-probe),
 * off (all three disabled).
 *
 * Starts enabled (api-guide + api-fetch on, api-learn + api-probe off), mirroring
 * portal's browser toggle. Both defaults are overridable via the
 * `toolsetDefaults` settings tier read by pi-tool-masking. The /api toggle
 * is an independent peer: it composes freely with /web (portal's toggle)
 * by using additive-on / filter-off semantics.
 *
 * Persistence: handled by the pi-tool-masking library via ToolsetSpec.persistKey.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	defineToolset,
	TOOLSET_EVENTS,
	getDefaultResolutionMode,
} from "pi-tool-masking";
import type { ToolsetSpec } from "pi-tool-masking";
import { handleHelpersSubcommand } from "./helpers-command.js";
import { loadAllGuides } from "./guide-store.js";
import { getAllHelpers, getDisabledHelperDomains } from "./local-helpers.js";

// Focus-mode guard: refuse actuating subcommands while the library holds the
// line — inclusion mode or allowlist focus (an upstream pi-tool-masking
// consumer). Either way a sibling toggle must not write a focus-
// indistinguishable {enabled} entry.
function isFocusHolding(): boolean {
	const mode = getDefaultResolutionMode();
	return mode === "inclusion" || mode === "allowlist";
}

// ---- Toolset specs -----------------------------------------------

const HOST_API_SPEC: ToolsetSpec = {
	id: "pi-lean-dimension.api",
	names: new Set(["api-guide", "api-fetch"]),
	persistKey: "toolset-state:pi-lean-dimension.api",
};

const HOST_API_LEARN_SPEC: ToolsetSpec = {
	id: "pi-lean-dimension.api-learn",
	names: new Set(["api-learn", "api-probe"]),
	persistKey: "toolset-state:pi-lean-dimension.api-learn",
	defaultEnabled: false,
	requires: ["pi-lean-dimension.api"],
};

// ---- Status bar cached state (derived from library events) ------

/** @internal Last known api-tools toggle state for status bar rendering. */
let _lastToggleState = false;

/** @internal Last known learn state for status bar coloring. */
let _lastLearnState = false;

/** @internal Last captured ExtensionContext for event-driven glyph rendering. */
let _lastCtx: ExtensionContext | null = null;

export function getApiToggleState(): boolean {
	return _lastToggleState;
}

/** @internal Test-only read access to live learn state. */
export function _getApiLearnStateForTest(): boolean {
	return _lastLearnState;
}

// ---- Test helpers -------------------------------------------------

/** @internal Reset cached state to defaults (test helper). */
export function _resetToggleStateForTest(): void {
	_lastToggleState = false;
	_lastLearnState = false;
	_lastCtx = null;
}

/** @internal Set cached state for test purposes only. */
export function _setToggleStateForTest(apiOn: boolean, learnOn: boolean): void {
	_lastToggleState = apiOn;
	_lastLearnState = learnOn;
}

/** @internal Reset cached state (called from index.ts on re-entry). */
function resetToggleModuleState(): void {
	_lastToggleState = false;
	_lastLearnState = false;
	_lastCtx = null;
}

export { resetToggleModuleState };

// ---- Glyph helpers -----------------------------------------------

function renderApiGlyph(
	ctx: {
		ui: {
			setStatus: (key: string, label: string) => void;
			theme: { fg: (c: ThemeColor, t: string) => string };
		};
	},
	apiEnabled: boolean,
	learnEnabled: boolean,
): void {
	if (!apiEnabled) {
		ctx.ui.setStatus("api", "○ api");
		return;
	}
	const color: ThemeColor = learnEnabled ? "success" : "accent";
	const dot = ctx.ui.theme?.fg(color, "●") ?? "●";
	ctx.ui.setStatus("api", `${dot} api`);
}

// ---- /api status command ------------------------------------------

function handleStatusSubcommand(
	apiOn: boolean,
	learnOn: boolean,
	ctx: ExtensionCommandContext,
): void {
	let state: string;
	if (apiOn) {
		state = learnOn ? "learn" : "on";
	} else {
		state = "off";
	}
	const learnFlag = learnOn
		? "✅ on (api-learn + api-probe available)"
		: "❌ off";

	const allGuides = loadAllGuides();
	const guideCount = Object.keys(allGuides.guides).length;
	const domainList = Object.values(allGuides.guides)
		.flatMap((g) => g.domains ?? [])
		.filter(Boolean);
	const uniqueDomains = [...new Set(domainList)];

	const helpers = getAllHelpers();
	const disabled = getDisabledHelperDomains();

	const lines: string[] = [
		`📡 API status`,
		`  State: ${state}`,
		`  Learn: ${learnFlag}`,
		``,
		`  Guides: ${guideCount} active`,
	];

	if (uniqueDomains.length > 0) {
		lines.push(`  Domains: ${uniqueDomains.join(", ")}`);
	} else {
		lines.push(`  Domains: (none — write a guide via api-learn)`);
	}

	lines.push(`  Helpers: ${helpers.length} present`);
	if (disabled.length > 0) {
		lines.push(`  ⚠ Disabled: ${disabled.join(", ")}`);
	}
	if (helpers.length > 0) {
		lines.push(`  Run /api helpers to list them.`);
	}

	lines.push(
		``,
		`  /api on      enable api-guide + api-fetch`,
		`  /api learn   enable all four tools (adds api-learn + api-probe)`,
		`  /api off     disable all API tools`,
	);

	ctx.ui.notify(lines.join("\n"), "info");
}

// ---- Extension factory -------------------------------------------

export default function initApiToggle(pi: ExtensionAPI): void {
	// Settings-based toolset defaults (`toolsetDefaults` tier) are read by
	// pi-tool-masking itself inside defineToolset/restore — pass the packaged
	// spec straight through.
	const apiToolset = defineToolset(pi, HOST_API_SPEC);
	const learnToolset = defineToolset(pi, HOST_API_LEARN_SPEC);

	// ── Keep cached state in sync with library events ─────────
	const syncCachedState = () => {
		_lastToggleState = apiToolset.isEnabled(pi);
		_lastLearnState = learnToolset.isEnabled(pi);
		if (_lastCtx) {
			renderApiGlyph(_lastCtx, _lastToggleState, _lastLearnState);
		}
	};

	pi.events.on(TOOLSET_EVENTS.changed, syncCachedState);
	pi.events.on(TOOLSET_EVENTS.restored, syncCachedState);

	// ── /api command ──────────────────────────────────────────
	pi.registerCommand("api", {
		description:
			"Enable/disable API tools. " +
			"Usage: /api on | off | learn | status | helpers [domain]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0]?.toLowerCase() ?? "";
			const rest = parts.slice(1).join(" ");

			// Focus-mode guard: refuse actuating subcommands while the library
			// holds the line — either inclusion mode or allowlist focus (an
			// upstream pi-tool-masking consumer). Either way a sibling toggle
			// must not write a focus-indistinguishable {enabled} entry.
			// Read-only subcommands (status/helpers/bare /api) stay unguarded.
			if (["on", "off", "learn"].includes(sub) && isFocusHolding()) {
				const inInclusion = getDefaultResolutionMode() === "inclusion";
				ctx.ui.notify(
					inInclusion
						? "Another plugin has active inclusion mode — this toolset can't be toggled while inclusion is holding the line. Deactivate it there first."
						: "Focus mode (allowlist) is active — this toolset can't be toggled while focus is holding the line. Exit focus there first.",
					"warning",
				);
				return;
			}

			switch (sub) {
				case "on": {
					apiToolset.enable(pi);
					learnToolset.disable(pi);
					ctx.ui.notify(
						"📡 API tools enabled. /api learn to make api-learn + api-probe available.",
						"info",
					);
					return;
				}

				case "off": {
					apiToolset.disable(pi); // cascades learn off via requires
					ctx.ui.notify("📡 API tools disabled. /api on to re-enable.", "info");
					return;
				}

				case "learn": {
					learnToolset.enable(pi); // cascades api on via requires
					ctx.ui.notify(
						"📖 api-learn + api-probe tools are now available. " +
							"Agent will discover shapes and save/update guides when asked.",
						"info",
					);
					return;
				}

				case "status": {
					handleStatusSubcommand(
						apiToolset.isEnabled(pi),
						learnToolset.isEnabled(pi),
						ctx,
					);
					return;
				}

				case "helpers": {
					await handleHelpersSubcommand(rest, ctx);
					return;
				}

				default: {
					const apiStatus = apiToolset.isEnabled(pi) ? "✅ on" : "❌ off";
					const learnStatus = learnToolset.isEnabled(pi) ? "✅ on" : "❌ off";

					const lines: string[] = [
						`📡 API tools: ${apiStatus}`,
						`📖 Learn mode: ${learnStatus}`,
						``,
						`   /api on           enable api-guide + api-fetch`,
						`   /api learn        enable all four tools (adds api-learn + api-probe)`,
						`   /api off          disable all API tools`,
						`   /api status       detailed status (guides, helpers)`,
						`   /api helpers      list local helpers`,
						`   /api              show this status`,
					];

					if (sub) {
						lines.unshift(`Unknown /api subcommand: "${sub}".`, "");
					}

					ctx.ui.notify(lines.join("\n"), "info");
				}
			}
		},
	});

	// ── Session handlers: restore profile + render glyph ─────
	pi.on("session_start", async (_event, ctx) => {
		_lastCtx = ctx;
		syncCachedState();
	});

	pi.on("session_tree", async (_event, ctx) => {
		_lastCtx = ctx;
		syncCachedState();
	});

	pi.on("session_shutdown", async () => {
		_lastCtx = null;
	});
}
