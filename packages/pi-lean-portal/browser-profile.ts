/**
 * Browser Profile management.
 *
 * Provides profile listing, formatting, and the `/web profile` subcommand
 * handler.  Stateful operations (setting the conversation-scoped default
 * profile) are delegated through a callback to avoid circular dependency
 * with browser-toggle.ts's internal state.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import {
	profileFilePath,
	deleteProfileDir,
	deleteStorageState,
	pruneStaleSessionProfiles,
	isSessionProfile,
	sanitizeProfileName,
	profileExists,
	getProfileLabel,
	ensureProfileDir,
	listNamedProfiles,
} from "./core/shared/storage-state.js";
import { formatBytes } from "./core/shared/paths.js";

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
		return formatBytes(bytes);
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
	return listNamedProfiles({ includeSession: true }).map((name) => ({
		name,
		stateSize: profileStateSize(name),
	}));
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
		lines.push(`  ${getProfileLabel(p.name)}  (${p.stateSize})`);
	}
	return lines.join("\n");
}

// ─── Profile subcommand handler ──────────────────────────────────

/**
 * Sanitize a profile name, notifying the user on failure.
 *
 * Session profiles (`_session-*`) are managed internally — they materialize
 * at save time and are removed by prune — so they are refused here for every
 * subcommand, with a per-subcommand hint on what to do instead.
 */
function sanitizeOrNotify(
	ctx: ExtensionContext,
	name: string,
	sessionHint = 'Use profile="session" instead.',
): boolean {
	if (isSessionProfile(name)) {
		ctx.ui.notify(
			`'${name}' is a session profile. ${sessionHint}`,
			"warning",
		);
		return false;
	}
	try {
		sanitizeProfileName(name);
		return true;
	} catch (err) {
		ctx.ui.notify(
			err instanceof Error ? err.message : String(err),
			"warning",
		);
		return false;
	}
}

/**
 * Handle the `/web profile` subcommand.
 *
 * @param sub     The sub-command text after "profile" (e.g. "", "list", "create shopping")
 * @param ctx     The extension context (for UI notifications)
 * @param setConversationDefaultProfile  Callback setter — accepts "none" or a profile name
 * @param currentConversationDefault  The conversation default before this command ran
 *                                    (used by `delete` to detect it removed the default)
 */
export async function handleProfileSubcommand(
	sub: string,
	ctx: ExtensionContext,
	setConversationDefaultProfile: (profile: string) => void,
	currentConversationDefault?: string,
): Promise<void> {
	// Keywords are case-insensitive; profile-name payloads keep their case.
	const kw = sub.toLowerCase();
	// --- list (default) ---
	if (kw === "" || kw === "list") {
		const profiles = listProfiles();
		const formatted = formatProfileList(profiles);
		ctx.ui.notify(formatted, "info");

		// --- mode switches (special keywords) ---
	} else if (kw === "none") {
		setConversationDefaultProfile("none");
		ctx.ui.notify(
			"Default profile set to 'none' (ephemeral, no persistence).",
			"info",
		);
	} else if (kw === "session") {
		setConversationDefaultProfile("session");
		ctx.ui.notify(
			"Default profile set to 'session' (persists for this conversation).",
			"info",
		);

		// --- create <name> ---
	} else if (kw === "create" || kw.startsWith("create ")) {
		const name = sub === "create" ? "" : sub.slice("create ".length).trim();
		if (!name) {
			ctx.ui.notify(
				"Usage: /web profile create <name>\n" +
					"  Profile names must be alphanumeric, hyphens, and underscores only.\n" +
					"  Reserved names: none, session, create, list, clear, clear-all, delete, prune.",
				"warning",
			);
			return;
		}
		if (!sanitizeOrNotify(ctx, name)) return;
		if (isSessionProfile(name)) {
			ctx.ui.notify(
				`'${name}' is a session profile. Use profile="session" instead.`,
				"warning",
			);
			return;
		}
		try {
			ensureProfileDir(name);
			ctx.ui.notify(
				`Created profile '${name}'. Use browser-navigate profile="${name}" to start.`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(
				`Failed to create profile '${name}': ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}

		// --- prune [--confirm] ---
	} else if (kw === "prune" || kw === "prune --confirm") {
		const result = pruneStaleSessionProfiles();
		if (result.pruned.length === 0) {
			ctx.ui.notify("No stale session profiles to prune.", "info");
			return;
		}
		if (kw === "prune") {
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

		// --- delete <name> ---
	} else if (kw === "delete" || kw.startsWith("delete ")) {
		const name = sub === "delete" ? "" : sub.slice("delete ".length).trim();
		if (!name) {
			ctx.ui.notify(
				"Usage: /web profile delete <name> — provide a profile name.",
				"warning",
			);
			return;
		}
		if (!sanitizeOrNotify(ctx, name, "Use /web profile prune to remove stale session profiles.")) {
			return;
		}
		if (!profileExists(name)) {
			ctx.ui.notify(
				`Profile '${name}' does not exist. Nothing to delete.`,
				"info",
			);
			return;
		}
		try {
			deleteProfileDir(name);
		} catch (err) {
			ctx.ui.notify(
				`Failed to delete profile '${name}': ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return;
		}
		const resetDefault = currentConversationDefault === name;
		if (resetDefault) setConversationDefaultProfile("session");
		ctx.ui.notify(
			`Deleted profile '${name}'.${resetDefault ? " Conversation default reset to 'session'." : ""} Existing sessions using it will re-create it on save — switch any live session off it (profile="none") for this to stick.`,
			"info",
		);

		// --- clear <name> ---
	} else if (kw === "clear" || kw.startsWith("clear ")) {
		const name = sub === "clear" ? "" : sub.slice("clear ".length).trim();
		if (!name) {
			ctx.ui.notify(
				"Usage: /web profile clear <name> — provide a profile name.",
				"warning",
			);
			return;
		}
		if (
			!sanitizeOrNotify(ctx, name, "Use /web profile prune to remove stale session profiles.")
		) {
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
	} else if (kw === "clear-all" || kw === "clear-all --confirm") {
		// Session profiles are GC'd by prune, never bulk-cleared here.
		const profiles = listProfiles().filter((p) => !isSessionProfile(p.name));
		if (profiles.length === 0) {
			ctx.ui.notify(
				"No profiles to clear. (Stale session profiles: /web profile prune.)",
				"info",
			);
			return;
		}
		if (kw === "clear-all") {
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

		// --- switch to existing named profile ---
		// Ordered last: specific subcommands above win by matching first.
	} else if (!sub.includes(" ")) {
		// Single word that didn't match a subcommand — try as a named profile switch
		// Sanitize first so invalid names report "Invalid profile name" rather
		// than the generic missing-profile message.
		if (!sanitizeOrNotify(ctx, sub)) return;
		if (!profileExists(sub)) {
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

		// --- unknown ---
	} else {
		ctx.ui.notify(
			`Unknown profile sub-command: "${sub}". ` +
				`Usage: /web profile [list|create <name>|<name>|none|session|clear <name>|clear-all [--confirm]|delete <name>|prune [--confirm]]`,
			"warning",
		);
	}
}
