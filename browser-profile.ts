/**
 * Browser Profile management — extracted from browser-toggle.ts.
 *
 * Provides profile listing, formatting, and the `/web profile` subcommand
 * handler.  Stateful operations (setting the conversation-scoped default
 * profile) are delegated through a callback to avoid circular dependency
 * with browser-toggle.ts's internal state.
 */

import type {
	ExtensionContext,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import {
	PROFILE_DIR,
	profileFilePath,
	deleteStorageState,
	pruneStaleSessionProfiles,
	isSessionProfile,
	sanitizeProfileName,
	profileDir,
} from "./core/shared/storage-state.js";

// ─── Profile helpers ─────────────────────────────────────────────

/**
 * Get a human-readable size description for a profile's storage state.
 * Returns "no state" if the file doesn't exist or is empty.
 */
export function profileStateSize(profileName: string): string {
	const path = profileFilePath(profileName);
	try {
		if (!existsSync(path)) return "no state";
		const bytes = statSync(path).size;
		if (bytes === 0) return "empty";
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	} catch {
		return "?";
	}
}

/**
 * List all profiles found on disk.
 * Returns an array of { name, stateSize } objects.
 */
export function listProfiles(): Array<{
	name: string;
	stateSize: string;
}> {
	try {
		if (!existsSync(PROFILE_DIR)) return [];
		const entries = readdirSync(PROFILE_DIR, { withFileTypes: true });
		const profiles = entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => ({
				name: e.name,
				stateSize: profileStateSize(e.name),
			}));
		profiles.sort((a, b) => a.name.localeCompare(b.name));
		return profiles;
	} catch {
		return [];
	}
}

/**
 * Short human-readable label for a profile name.
 * Session-scoped profiles show "📋" instead of the raw `_session-` prefix.
 * Named profiles show as-is.
 */
export function profileLabel(name: string): string {
	if (isSessionProfile(name)) return "📋 session";
	return name;
}

/**
 * Format a profile list as a human-readable string.
 */
export function formatProfileList(
	profiles: ReturnType<typeof listProfiles>,
): string {
	if (profiles.length === 0) {
		return "No profiles found on disk.";
	}
	const lines = [`Profiles (${profiles.length}):`];
	for (const p of profiles) {
		const sessionBadge = isSessionProfile(p.name) ? " 📋" : "";
		lines.push(`  ${profileLabel(p.name)}  (${p.stateSize})${sessionBadge}`);
	}
	return lines.join("\n");
}

// ─── Profile subcommand handler ──────────────────────────────────

/**
 * Handle the `/web profile` subcommand.
 *
 * @param sub     The sub-command text after "profile" (e.g. "", "list", "create shopping")
 * @param ctx     The extension context (for UI notifications)
 * @param pi      The ExtensionAPI (for tool state queries)
 * @param setConversationDefaultProfile  Callback setter — accepts "none" or a profile name
 */
export async function handleProfileSubcommand(
	sub: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	setConversationDefaultProfile: (profile: string) => void,
): Promise<void> {
	// --- list (default) ---
	if (sub === "" || sub === "list") {
		const profiles = listProfiles();
		const formatted = formatProfileList(profiles);
		ctx.ui.notify(formatted, "info");

		// --- mode switches (special keywords) ---
	} else if (sub === "none") {
		setConversationDefaultProfile("none");
		ctx.ui.notify(
			"Default profile set to 'none' (ephemeral, no persistence).",
			"info",
		);
	} else if (sub === "session") {
		setConversationDefaultProfile("session");
		ctx.ui.notify(
			"Default profile set to 'session' (persists for this conversation).",
			"info",
		);

		// --- create <name> ---
	} else if (sub === "create" || sub.startsWith("create ")) {
		const name = sub === "create" ? "" : sub.slice("create ".length).trim();
		if (!name) {
			ctx.ui.notify(
				"Usage: /web profile create <name>\n" +
					"  Profile names must be alphanumeric, hyphens, and underscores only.\n" +
					"  Reserved names: none, session, create.",
				"warning",
			);
			return;
		}
		try {
			sanitizeProfileName(name);
			mkdirSync(profileDir(name), { recursive: true, mode: 0o700 });
			ctx.ui.notify(
				`Created profile '${name}'. Use browser-navigate profile="${name}" to start.`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(
				`Invalid profile name: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}

		// --- switch to existing named profile ---
	} else if (!sub.includes(" ") && sub !== "clear" && sub !== "clear-all") {
		// Single word that isn't a known keyword — try as a named profile switch
		try {
			const targetDir = profileDir(sub);
			if (!existsSync(targetDir)) {
				ctx.ui.notify(
					`Profile '${sub}' does not exist.\n` +
						`  Create it first with /web profile create ${sub}`,
					"warning",
				);
				return;
			}
			setConversationDefaultProfile(sub);
			ctx.ui.notify(
				`Default profile set to '${sub}' (shared across tasks).`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(
				`Invalid profile name: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}

		// --- clear <name> ---
	} else if (sub === "clear" || sub.startsWith("clear ")) {
		const name = sub === "clear" ? "" : sub.slice("clear ".length).trim();
		if (!name) {
			ctx.ui.notify(
				"Usage: /web profile clear <name> — provide a profile name.",
				"warning",
			);
			return;
		}
		const path = profileFilePath(name);
		if (!existsSync(path)) {
			ctx.ui.notify(
				`Profile '${name}' has no saved state. Nothing to clear.`,
				"info",
			);
			return;
		}
		deleteStorageState(name);
		ctx.ui.notify(`Cleared profile '${name}' state.`, "info");

		// --- clear-all [--confirm] ---
	} else if (sub === "clear-all" || sub === "clear-all --confirm") {
		const profiles = listProfiles();
		if (profiles.length === 0) {
			ctx.ui.notify("No profiles to clear.", "info");
			return;
		}
		if (sub === "clear-all") {
			const names = profiles.map((p) => p.name).join(", ");
			ctx.ui.notify(
				`⚠ This will clear ALL profile states: ${names}\n` +
					`  Run /web profile clear-all --confirm to proceed.`,
				"warning",
			);
		} else {
			let cleared = 0;
			for (const p of profiles) {
				deleteStorageState(p.name);
				cleared++;
			}
			ctx.ui.notify(`Cleared ${cleared} profile(s).`, "info");
		}

		// --- prune [--confirm] ---
	} else if (sub === "prune" || sub === "prune --confirm") {
		const result = pruneStaleSessionProfiles();
		if (result.pruned.length === 0) {
			ctx.ui.notify("No stale session profiles to prune.", "info");
			return;
		}
		if (sub === "prune") {
			ctx.ui.notify(
				`Found ${result.pruned.length} stale session profile(s): ${result.pruned.join(", ")}\n` +
					`  Run /web profile prune --confirm to delete.`,
				"warning",
			);
		} else {
			ctx.ui.notify(
				`Pruned ${result.pruned.length} stale session profile(s).`,
				"info",
			);
		}

		// --- unknown ---
	} else {
		ctx.ui.notify(
			`Unknown profile sub-command: "${sub}". ` +
				`Usage: /web profile [list|create <name>|<name>|none|session|clear <name>|clear-all [--confirm]|prune [--confirm]]`,
			"warning",
		);
	}
}
