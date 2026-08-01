/**
 * pi-lean-search — SearXNG search extension for Pi.
 *
 * Registers the `web-search` tool and a `/searxng-status` diagnostic command.
 * Manages the `search` status bar slot with health-colored glyphs.
 *
 * Owns the `pi-lean-dimension.search` toolset (co-activated off `pi-lean-dimension.web`):
 *   ● searxng  (accent/blue)    — healthy and reachable
 *   ● searxng  (warning/yellow)  — server up but pipeline degraded
 *   ● searxng  (error/red)      — unreachable
 *   ○ searxng                    — search tools off
 */

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
import type { ToolsetSpec, ToolsetChangedEvent } from "pi-tool-masking";
import { readSearxngUrl } from "./search-config.js";
import { webSearchTool } from "./web-search-tool.js";

// ─── Toolset spec ────────────────────────────────────────────────

const SEARCH_WEB_SPEC: ToolsetSpec = {
	id: "pi-lean-dimension.search",
	names: new Set(["web-search"]),
	persistKey: "toolset-state:pi-lean-dimension.search",
	defaultEnabled: true,
};

// ─── Module-level state ──────────────────────────────────────────

/** Cached SearXNG URL (read once at startup, stable mid-session). */
let _searxngUrl: string | undefined;

/** Last known pi-lean-dimension.search enabled state (updated by library events). */
let _lastSearchEnabled = true;

/** Last known health state: true=healthy, false=unreachable, null=unconfigured. */
let _lastHealth: boolean | null = null;

/** Whether the search pipeline is degraded (server up, aggregation broken). */
let _lastDegraded = false;

/** Cached ExtensionContext for event-driven glyph rendering. */
let _lastCtx: ExtensionContext | null = null;

// ─── Health probes ───────────────────────────────────────────────

/**
 * Lightweight server probe — fetches the SearXNG root HTML page.
 * Fast (~ms) because it only needs the HTTP response, not the full
 * aggregation pipeline.
 */
async function checkServerReachable(
	url: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 2000);

		let res: Response;
		try {
			const mergedSignal = signal
				? AbortSignal.any([signal, controller.signal])
				: controller.signal;
			res = await fetch(url, { signal: mergedSignal });
		} finally {
			clearTimeout(timeoutId);
		}

		return res.ok && res.status === 200;
	} catch {
		return false;
	}
}

/**
 * Full-pipeline probe — verifies the search API actually works end-to-end.
 * Triggers upstream engine aggregation, so it takes longer (5s timeout).
 */
async function checkSearchReachable(
	url: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const normalized = url.replace(/\/+$/, "");
	const searchUrl = `${normalized}/search?q=ping&format=json`;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		let res: Response;
		try {
			const mergedSignal = signal
				? AbortSignal.any([signal, controller.signal])
				: controller.signal;
			res = await fetch(searchUrl, {
				signal: mergedSignal,
				headers: { Accept: "application/json" },
			});
		} finally {
			clearTimeout(timeoutId);
		}

		if (!res.ok || res.status !== 200) return false;
		const text = await res.text();
		if (!text) return false;
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

// ─── Status slot helpers ─────────────────────────────────────────

/**
 * Normalize the SearXNG URL for display (strip protocol prefix for brevity).
 */
function displayUrl(url: string): string {
	return url.replace(/^https?:\/\//, "");
}

/**
 * Render the `search` status slot based on toolset state + health.
 *
 *   pi-lean-dimension.search off         → ○ searxng
 *   pi-lean-dimension.search on + healthy → ● searxng (accent/blue)
 *   pi-lean-dimension.search on + degraded → ● searxng (warning/yellow)
 *   pi-lean-dimension.search on + unreachable → ● searxng (error/red)
 *   unconfigured           → (clear slot)
 */
function renderSearchGlyph(ctx: {
	ui: {
		setStatus: (key: string, label: string) => void;
		theme: { fg: (c: ThemeColor, t: string) => string };
	};
}): void {
	const safeSetStatus = (text: string) => {
		try {
			ctx.ui.setStatus("search", text);
		} catch {
			/* ctx.ui may be unavailable */
		}
	};

	// Unconfigured — clear slot entirely
	if (_lastHealth === null) {
		safeSetStatus("");
		return;
	}

	// pi-lean-dimension.search disabled — show off state
	if (!_lastSearchEnabled) {
		safeSetStatus("○ searxng");
		return;
	}

	// pi-lean-dimension.search enabled — show health-colored glyph
	if (!_lastHealth) {
		safeSetStatus(ctx.ui.theme.fg("error", "●") + " searxng");
		return;
	}
	if (_lastDegraded) {
		safeSetStatus(ctx.ui.theme.fg("warning", "●") + " searxng");
		return;
	}
	safeSetStatus(ctx.ui.theme.fg("accent", "●") + " searxng");
}

// ─── Test helpers ─────────────────────────────────────────────────

/** @internal Reset cached state to defaults (test helper). */
function _resetStateForTest(): void {
	_lastSearchEnabled = true;
	_lastHealth = null;
	_lastDegraded = false;
	_lastCtx = null;
}

export { _resetStateForTest };

// ─── Extension entry point ───────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Read config at startup
	_searxngUrl = readSearxngUrl();

	// ── Register the web-search tool ─────────────────────────
	pi.registerTool(webSearchTool);

	// ── Define the pi-lean-dimension.search toolset ───────────
	// Registers restore handler on session_start / session_tree.
	const searchToolset = defineToolset(pi, SEARCH_WEB_SPEC);

	// ── Co-activation: mirror pi-lean-dimension.web changed events ─
	// Listen on changed ONLY, not restored (§10.1).
	//
	// Focus-mode guard: while allowlist focus (pi-tbox `/tbox focus`) holds
	// the line, skip co-activation. The focus set is authoritative, so a web
	// `changed` event — including one a stale library `doRestore` emits during
	// resume — must not disable search or write a focus-indistinguishable
	// {enabled} entry. The published `DefaultResolutionMode` type doesn't name
	// `"allowlist"` (it ships in 1.2.0), so the string cast is load-bearing: a
	// newer pi-tbox writes `"allowlist"` into the shared `globalThis` module
	// state and we read it back here. No-op for ordinary users on published
	// versions, where nothing ever writes `"allowlist"`.
	pi.events.on(TOOLSET_EVENTS.changed, (data: unknown) => {
		const event = data as ToolsetChangedEvent;
		if (event.id === "pi-lean-dimension.web") {
			if ((getDefaultResolutionMode() as string) === "allowlist") return;
			if (event.enabled) {
				searchToolset.enable(pi);
			} else {
				searchToolset.disable(pi);
			}
		}
	});

	// ── Keep cached state in sync with library events ────────
	const syncSearchState = (data: unknown) => {
		const event = data as ToolsetChangedEvent;
		if (event.id === "pi-lean-dimension.search") {
			_lastSearchEnabled = event.enabled;
			if (_lastCtx) renderSearchGlyph(_lastCtx);
		}
	};
	pi.events.on(TOOLSET_EVENTS.changed, syncSearchState);
	pi.events.on(TOOLSET_EVENTS.restored, syncSearchState);

	// ── Session start: health probe + glyph ──────────────────
	pi.on("session_start", async (_event, ctx) => {
		_lastCtx = ctx;

		// Re-read config in case it changed between sessions
		_searxngUrl = readSearxngUrl();

		if (!_searxngUrl) {
			_lastHealth = null;
			renderSearchGlyph(ctx);
			return;
		}

		// Note: by now the library's restore handler has already
		// fired (registered by defineToolset), so _lastSearchEnabled
		// reflects the restored toolset state.

		const reachable = await checkServerReachable(
			_searxngUrl,
			ctx.signal ?? undefined,
		);
		_lastHealth = reachable;
		_lastDegraded = false;

		if (reachable) {
			ctx.ui.notify(
				`🔍 SearXNG at ${displayUrl(_searxngUrl)} is available`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`⚠ SearXNG at ${displayUrl(_searxngUrl)} is unreachable. ` +
					"Web search will degrade gracefully with error messages.",
				"warning",
			);
		}

		renderSearchGlyph(ctx);
	});

	// ── Session tree: re-render with cached state ────────────
	pi.on("session_tree", async (_event, ctx) => {
		_lastCtx = ctx;
		renderSearchGlyph(ctx);
	});

	// ── Session shutdown: clean up ───────────────────────────
	pi.on("session_shutdown", async (_event, ctx) => {
		_lastCtx = null;
		try {
			ctx?.ui?.setStatus?.("search", "");
		} catch {
			// ctx.ui may not be available during shutdown
		}
	});

	// ── Manual status check command ──────────────────────────
	pi.registerCommand("searxng-status", {
		description:
			"Test the full SearXNG search pipeline (server + aggregation) " +
			"and update the status bar. Use when web-search returns " +
			"errors or when you've just started/restarted SearXNG.",
		handler: async (_args, ctx) => {
			_lastCtx = ctx;

			if (!_searxngUrl) {
				ctx.ui.notify(
					"❌ SearXNG is not configured. " +
						"Set `searxng.url` in your Pi settings.json.",
					"error",
				);
				_lastHealth = false;
				renderSearchGlyph(ctx);
				return;
			}

			// Full pipeline probe (slower, triggers aggregation)
			const searchOk = await checkSearchReachable(
				_searxngUrl,
				ctx.signal ?? undefined,
			);

			if (searchOk) {
				_lastHealth = true;
				_lastDegraded = false;
				renderSearchGlyph(ctx);
				ctx.ui.notify(
					`✅ SearXNG search pipeline is working at ${displayUrl(_searxngUrl)}`,
					"info",
				);
				return;
			}

			// Distinguish: server down vs pipeline broken
			const serverOk = await checkServerReachable(
				_searxngUrl,
				ctx.signal ?? undefined,
			);

			if (serverOk) {
				_lastHealth = true;
				_lastDegraded = true;
				renderSearchGlyph(ctx);
				ctx.ui.notify(
					"⚠ SearXNG server is up but the search pipeline " +
						"may be broken (aggregation failed). " +
						"Try /searxng-status again after a moment.",
					"warning",
				);
			} else {
				_lastHealth = false;
				_lastDegraded = false;
				renderSearchGlyph(ctx);
				ctx.ui.notify(
					`❌ SearXNG at ${displayUrl(_searxngUrl)} is not responding. ` +
						"Check that the SearXNG service is running.",
					"error",
				);
			}
		},
	});
}
