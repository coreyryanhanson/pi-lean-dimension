/**
 * Portal co-install integration — host-only boundary-safe runtime feature-detect.
 *
 * Registers host's guide projection with portal's guide-provider registry
 * when portal is co-installed. Detection uses a global probe
 * (globalThis.__piLeanPortalRegisterGuideProvider) — no static portal
 * import, so the host-only boundary test stays green.
 *
 * The registered provider returns a projectToGuide() projection of every
 * loaded ApiGuide, with recipe fields stripped and kind: "api" set. It
 * self-gates — returns {} when /api toggle is off, so no host guide
 * surfaces in portal's footer unless the user has turned the API tools on.
 */

import type { Guide } from "./guide-loader.js";
import { loadAllGuides } from "./guide-store.js";
import { projectToGuide } from "./parse-api-guide.js";
import { getApiToggleState } from "./api-toggle.js";

// The global key portal's index.ts sets at load time.
const PORTAL_REGISTRY_KEY = "__piLeanPortalRegisterGuideProvider";

let _registered = false;

/**
 * Build a snapshot of host's guide projections.
 * Recipe fields are stripped by projectToGuide(); only the presentation
 * slice + kind remain. Self-gates on the /api toggle state.
 */
function buildProjection(): Record<string, Guide> {
 if (!getApiToggleState()) return {};

 const { guides } = loadAllGuides();
 const out: Record<string, Guide> = {};
 for (const [name, guide] of Object.entries(guides)) {
  out[name] = projectToGuide(guide);
 }
 return out;
}

/**
 * Register host's guide projection with portal, if portal is co-installed.
 *
 * Uses runtime feature-detection (global property) instead of a static
 * import — safe for host-only installs. Idempotent: subsequent calls are
 * no-ops after the first successful registration.
 */
export function registerPortalProjection(): void {
 if (_registered) return;

 const fn = (globalThis as Record<string, unknown>)[PORTAL_REGISTRY_KEY];
 if (typeof fn !== "function") {
  // Portal not installed or not yet loaded — no-op.
  return;
 }

 try {
  (fn as (provider: () => Record<string, Guide>) => void)(buildProjection);
  _registered = true;
 } catch {
  // Portal present but registration failed — degrade to host-only.
 }
}

/** @internal Reset registration state (test helper). */
export function _resetPortalProjectionForTest(): void {
 _registered = false;
}
