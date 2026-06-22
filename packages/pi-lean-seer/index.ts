/**
 * pi-lean-seer — SearXNG search extension for Pi.
 *
 * Registers the `web-search` tool and a `/searxng-status` diagnostic command.
 * Manages the `search` status bar slot with health-colored glyphs.
 *
 * On session_start, probes SearXNG reachability and updates the search slot:
 *   ● searxng  (accent/blue)  — healthy and reachable
 *   ● searxng  (warning/yellow) — server up but pipeline degraded
 *   ● searxng  (error/red)    — unreachable
 *
 * Portal owns the `search` slot's "off" state: when `/web off` is called,
 * portal writes `○ searxng` (open circle). Seer overrides with the
 * health-colored glyph on session_start.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readSearxngUrl } from "./seer-config.js";
import { webSearchTool } from "./web-search-tool.js";

// ─── Module-level state ───────────────────────────────────────────

/** Cached SearXNG URL (read once at startup, stable mid-session). */
let _searxngUrl: string | undefined;

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
				? combineAbortSignals(signal, controller.signal)
				: (controller.signal as AbortSignal);
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
				? combineAbortSignals(signal, controller.signal)
				: (controller.signal as AbortSignal);
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

/**
 * Combine two AbortSignals into one that aborts when either aborts.
 */
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	for (const sig of signals) {
		if (sig.aborted) {
			controller.abort(sig.reason);
			return controller.signal;
		}
		sig.addEventListener("abort", () => controller.abort(sig.reason), {
			once: true,
		});
	}
	return controller.signal;
}

// ─── Status slot helpers ──────────────────────────────────────────

/**
 * Normalize the SearXNG URL for display (strip protocol prefix for brevity).
 */
function displayUrl(url: string): string {
	return url.replace(/^https?:\/\//, "");
}

/**
 * Set the `search` status slot with a health-colored glyph.
 *
 * Coloring:
 *   - Healthy:   accent (blue) — same as browser on
 *   - Degraded:  warning (yellow/gold) — server up but pipeline broken
 *   - Unhealthy: error (red) — unreachable or unconfigured
 *
 * Portal writes `○ searxng` on /web off; seer overrides here on
 * session_start or /searxng-status.
 */
function setSearchStatus(
	ctx: ExtensionContext,
	healthy: boolean | null,
	degraded: boolean,
): void {
	if (healthy === null) {
		// Unconfigured — no glyph
		try {
			ctx.ui.setStatus("search", "");
		} catch {
			// ctx.ui may be unavailable during shutdown
		}
		return;
	}

	if (!healthy) {
		// Unreachable
		try {
			ctx.ui.setStatus("search", ctx.ui.theme.fg("error", "●") + " searxng");
		} catch {
			// ignore
		}
		return;
	}

	if (degraded) {
		// Server up but pipeline broken
		try {
			ctx.ui.setStatus("search", ctx.ui.theme.fg("warning", "●") + " searxng");
		} catch {
			// ignore
		}
		return;
	}

	// Healthy
	try {
		ctx.ui.setStatus("search", ctx.ui.theme.fg("accent", "●") + " searxng");
	} catch {
		// ignore
	}
}

// ─── Extension entry point ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Read config at startup
	_searxngUrl = readSearxngUrl();

	// ── Register the web-search tool ─────────────────────────
	pi.registerTool(webSearchTool);

	// ── Session start: health probe + status update ──────────
	pi.on("session_start", async (_event, ctx) => {
		// Re-read config in case it changed between sessions
		_searxngUrl = readSearxngUrl();

		if (!_searxngUrl) {
			// Unconfigured — clear the slot
			setSearchStatus(ctx, null, false);
			return;
		}

		// Check if web-search tools are currently active (portal
		// restores toggle state before seer's session_start fires).
		const activeTools = pi.getActiveTools();
		if (!activeTools.includes("web-search")) {
			// Tools are off — don't override portal's ○ searxng
			return;
		}

		const reachable = await checkServerReachable(
			_searxngUrl,
			ctx.signal ?? undefined,
		);

		if (reachable) {
			setSearchStatus(ctx, true, false);
			ctx.ui.notify(
				`🔍 SearXNG at ${displayUrl(_searxngUrl)} is available`,
				"info",
			);
		} else {
			setSearchStatus(ctx, false, false);
			ctx.ui.notify(
				`⚠ SearXNG at ${displayUrl(_searxngUrl)} is unreachable. ` +
					"Web search will degrade gracefully with error messages.",
				"warning",
			);
		}
	});

	// ── Session shutdown: clean up ───────────────────────────
	pi.on("session_shutdown", async (_event, ctx) => {
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
			if (!_searxngUrl) {
				ctx.ui.notify(
					"❌ SearXNG is not configured. " +
						"Set `searxng.url` in your Pi settings.json.",
					"error",
				);
				setSearchStatus(ctx, false, false);
				return;
			}

			// Full pipeline probe (slower, triggers aggregation)
			const searchOk = await checkSearchReachable(
				_searxngUrl,
				ctx.signal ?? undefined,
			);

			if (searchOk) {
				setSearchStatus(ctx, true, false);
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
				setSearchStatus(ctx, true, true); // degraded
				ctx.ui.notify(
					"⚠ SearXNG server is up but the search pipeline " +
						"may be broken (aggregation failed). " +
						"Try /searxng-status again after a moment.",
					"warning",
				);
			} else {
				setSearchStatus(ctx, false, false);
				ctx.ui.notify(
					`❌ SearXNG at ${displayUrl(_searxngUrl)} is not responding. ` +
						"Check that the SearXNG service is running.",
					"error",
				);
			}
		},
	});
}
