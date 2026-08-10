import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	apiGuideTool,
	apiFetchTool,
	apiLearnTool,
	apiProbeTool,
} from "./tools/index.js";
import initApiToggle from "./core/api-toggle.js";
import { registerPortalProjection } from "./core/portal-projection.js";
import { cleanupAllSpill } from "./core/response-spill.js";
import { resetToggleModuleState } from "./core/api-toggle.js";
import { resetDisabledHelpers } from "./core/local-helpers.js";

export default function (pi: ExtensionAPI): void {
	// --- Ensure idempotent re-invocation ----------------------------
	// pi reuses the cached extension factory on /resume (same cwd),
	// which re-invokes this function with the same module-level
	// singletons. Reset them here so the second load is safe.
	resetToggleModuleState();
	resetDisabledHelpers();
	// ── Register tools ───────────────────────────────────────────
	pi.registerTool(apiGuideTool);
	pi.registerTool(apiFetchTool);
	pi.registerTool(apiLearnTool);
	pi.registerTool(apiProbeTool);

	// ── Register /api command and session hooks ─────────────────
	initApiToggle(pi);

	// ── Portal co-install integration ────────────────────────────
	// Register host's guide projection with portal if co-installed.
	// Runtime feature-detect — no static portal import.
	registerPortalProjection();
	// session_start ensures registration even if host loads before portal.
	pi.on("session_start", async () => {
		registerPortalProjection();
	});

	// ── Response spill cleanup ─────────────────────────────────
	pi.on("session_shutdown", async () => {
		cleanupAllSpill();
	});
	// cleanupAllSpill() on shutdown + eviction cap bounds disk use.
	// Add per-session cleanup if cross-conversation leaks are observed.
}
