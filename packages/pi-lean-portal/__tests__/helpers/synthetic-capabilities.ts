/**
 * Synthetic test/eval capabilities — conservative Python backend baseline
 * (no AbortSignal support, engine-agnostic default).
 *
 * Used by the contributed runner and the MiniWoB parity helper as the
 * baseline fallback when no user-provided capabilities override is
 * available. The only difference from {@link DEFAULT_CAPABILITIES} is
 * `supportsAbortSignal: false` — JSON-RPC transport doesn't support it.
 */

import { DEFAULT_CAPABILITIES } from "../../core/plugin-api.js";
import type { PluginCapabilities } from "../../core/plugin-api.js";

export const SYNTHETIC_CAPABILITIES: PluginCapabilities = {
	...DEFAULT_CAPABILITIES,
	supportsAbortSignal: false,
};
