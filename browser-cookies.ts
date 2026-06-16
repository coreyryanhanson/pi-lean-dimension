/**
 * Browser Cookies management — extracted from browser-toggle.ts.
 *
 * Provides the `/web cookies` subcommand handler for inspecting and
 * clearing session cookies via the router.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as router from "./core/router.js";
import { sessionManager } from "./core/shared/session-manager.js";

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Resolve the taskId for the current pi session.
 *
 * This matches the taskId assigned by index.ts's monotonic counter
 * (which can't be replicated here), so we look it up from the session
 * manager instead.
 */
function resolveTaskId(ctx: ExtensionContext): string {
	const mgr = (ctx as unknown as Record<string, unknown>)?.sessionManager as
		| { getSessionId?: () => string }
		| undefined;
	const piSessionId = mgr?.getSessionId?.();
	if (piSessionId) {
		const found = sessionManager.getTaskIdForPiSessionId(piSessionId);
		if (found) return found;
	}
	// Fallback: use the first active session
	const active = sessionManager.getActiveSessions();
	if (active.length > 0) return active[0]!.taskId;
	return "browser-default";
}

// ─── Handler ─────────────────────────────────────────────────────

/**
 * Handle the `/web cookies` subcommand.
 *
 * @param sub  The sub-command text after "cookies" (e.g. "", "list", "clear --confirm")
 * @param ctx  The extension context (for UI notifications)
 */
export async function handleCookiesSubcommand(
	sub: string,
	ctx: ExtensionContext,
): Promise<void> {
	if (sub === "" || sub === "list") {
		const result = await router.getCookies(resolveTaskId(ctx));
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
			lines.push(`    Domain: ${c.domain ?? "?"}  Path: ${c.path ?? "/"}`);
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
		const result = await router.clearCookies(resolveTaskId(ctx));
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
}
