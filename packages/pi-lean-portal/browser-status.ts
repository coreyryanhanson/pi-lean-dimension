/**
 * Browser Status — /web status subcommand.
 *
 * Combines toggle state (browser on/off, learn on/off) with runtime state
 * (backend health, active sessions, plugins, profiles on disk).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionManager } from "./core/shared/session-manager.js";
import { pluginRegistry } from "./core/plugin-registry.js";
import { listProfiles } from "./browser-profile.js";
import { isSessionProfile } from "./core/shared/storage-state.js";

/**
 * Show detailed browser runtime status.
 *
 * @param browserOn - whether browser tools are currently active in context
 * @param learnOn   - whether learn tools are currently active in context
 */
export function handleStatusSubcommand(
	ctx: ExtensionContext,
	browserOn: boolean,
	learnOn: boolean,
): void {
	const status = sessionManager.getStatus();
	const active = sessionManager.getActiveSessions();

	let msg = `🌐 Browser tools: ${browserOn ? "✅ on" : "❌ off"}`;
	msg += `  |  📖 Learn mode: ${learnOn ? "✅ on" : "❌ off"}`;
	msg += `\n────────────────────────────────────────`;
	msg += `\nStatus: ${status}`;

	// List available plugins
	const allPlugins = pluginRegistry.availableAll();
	const backendLines: string[] = [];
	for (const p of allPlugins) {
		if (p.enabled) {
			backendLines.push(p.name);
		} else {
			backendLines.push(`${p.name} (disabled)`);
		}
	}
	msg += `\nPlugins: ${backendLines.join(", ")}`;
	msg += `\nUse web-fetch for stateless HTTP fetches.`;

	if (active.length > 0) {
		msg += `\nActive sessions: ${active.length}`;
		for (const s of active) {
			const sym = sessionManager.pluginSymbol(s.pluginName);
			msg += `\n  ${sym} [${s.pluginName}] ${s.currentUrl || "(pending)"}`;
			if (s.currentTitle) msg += ` — ${s.currentTitle}`;
			if (s.profileName) msg += ` [profile: ${s.profileName}]`;
		}
	}

	// Profiles section
	// Session profiles (auto-generated `_session-*`) are ephemeral and
	// not user-named — they clutter the dashboard, so they are collapsed
	// into a single summary line. Named profiles get full rows. Use
	// `/web profile list` to inspect individual session profiles.
	const profiles = listProfiles();
	const named = profiles.filter((p) => !isSessionProfile(p.name));
	const session = profiles.filter((p) => isSessionProfile(p.name));
	const activeProfile = active.find((s) => s.profileName)?.profileName;

	if (named.length > 0) {
		const lines = [`\nProfiles: ${named.length} on disk (named)`];
		for (const p of named) {
			const current = p.name === activeProfile ? " ← active" : "";
			lines.push(`  ${p.name}  (${p.stateSize})${current}`);
		}
		msg += lines.join("\n");
	} else if (session.length === 0) {
		msg += `\nProfiles: none`;
	}

	if (session.length > 0) {
		const activeSession = session.some((p) => p.name === activeProfile);
		const tag = activeSession ? " (active)" : "";
		msg += `\nSession profiles: ${session.length}${tag} (manage with /web profile)`;
	}

	ctx.ui.notify(msg, "info");
}
