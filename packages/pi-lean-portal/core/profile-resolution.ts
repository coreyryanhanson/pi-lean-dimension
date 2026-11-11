import {
	ensureProfileDir,
	isSessionProfile,
	listNamedProfiles,
	sanitizeProfileName,
	sessionProfileName,
} from "./shared/storage-state.js";

/** Result of profile resolution for a navigate call: the resolved profile
 * name (absent = none — session/named mode is derivable from the name, so it
 * is not carried separately), or a refusal. Failure classification (the
 * errorKind tag) is applied by the caller — the router owns the taxonomy. */
type ProfileResolution =
	| { profileName?: string }
	| {
			refusal: { error: string };
	  };

/** How a caller treats an unresolvable piSessionId in "session" mode:
 * "refuse" surfaces it as a refusal; "fallback-none" warns and proceeds
 * without persistence. */
export type UnresolvableSessionPolicy = "refuse" | "fallback-none";

/** Result of resolving which profile an operation acts on: a resolved
 * profile name, `mode: "none"` (the caller owns the none policy — navigate
 * proceeds without persistence, import refuses), or a refusal. */
export type ActiveProfileResolution =
	| { profileName: string }
	| { mode: "none" }
	| { refusal: { error: string } };

/** Merge the profile-precedence tiers shared by every profile-consuming
 * operation: explicit parameter > live-session profile > conversation
 * default > settings default (`browser.defaultProfile`). Pure — callers
 * read the settings default themselves so tests stay deterministic. */
export function mergeProfilePrecedence(tiers: {
	explicit?: string | undefined;
	liveSessionProfile?: string | undefined;
	conversationDefault?: string | undefined;
	settingsDefault?: string | undefined;
}): string | undefined {
	return (
		tiers.explicit ??
		tiers.liveSessionProfile ??
		tiers.conversationDefault ??
		tiers.settingsDefault
	);
}

/** Shared mode-resolution core for "which profile does this operation act
 * on": none / session / named, including the foreign-`_session-*` refusal.
 * The caller merges the precedence tiers via `mergeProfilePrecedence` and
 * owns the none policy. */
export function resolveActiveProfile(
	profileInput: string | undefined,
	piSessionId: string | undefined,
	onUnresolvableSession: UnresolvableSessionPolicy,
): ActiveProfileResolution {
	const input = profileInput?.trim();

	if (input === undefined || input === "none") {
		return { mode: "none" };
	}
	if (input === "session") {
		try {
			return { profileName: sessionProfileName(piSessionId ?? "") };
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			if (onUnresolvableSession === "refuse") {
				return {
					refusal: {
						error:
							`Cannot resolve the session profile: ${detail}. ` +
							`Set a named profile instead: /web profile <name>.`,
					},
				};
			}
			// Can't resolve session profile without piSessionId — fall back with warning
			console.warn(
				"[pi-lean-portal] profile='session' requested but piSessionId unavailable. " +
					"Falling back to profile='none'.",
			);
			return { mode: "none" };
		}
	}

	// Named profile
	let name: string;
	try {
		name = sanitizeProfileName(input);
	} catch (err) {
		return {
			refusal: {
				error: err instanceof Error ? err.message : String(err),
			},
		};
	}
	if (isSessionProfile(name)) {
		// `_session-*` names are internal. Accept only the one this
		// conversation owns — any other would adopt another conversation's
		// cookies. Session dirs materialize at save time; a missing dir just
		// yields fresh state.
		if (piSessionId && name === sessionProfileName(piSessionId)) {
			return { profileName: name };
		}
		return {
			refusal: {
				error:
					`Profile '${name}' is managed internally. ` +
					`Use profile="session" to persist for this conversation, ` +
					`or profile="none" for a clean slate.`,
			},
		};
	}
	return { profileName: name };
}

/**
 * Resolve the profile for a navigate call. `profileInput` is the merged
 * precedence result — explicit param > conversation default > settings
 * default (browser.defaultProfile) — computed by the caller (the router).
 * `profileSource` says who supplied it: "agent" names are refused when the
 * profile dir doesn't exist, "conversation" names (any default) are
 * materialized. Validation failures and refusals return `refusal` —
 * navigate() turns that into a navFailure without touching session state.
 */
export function resolveNavigateProfile(
	profileInput: string | undefined,
	profileSource: "agent" | "conversation",
	piSessionId: string | undefined,
): ProfileResolution {
	const resolution = resolveActiveProfile(profileInput, piSessionId, "fallback-none");
	if ("refusal" in resolution) {
		return resolution;
	}
	if ("mode" in resolution) {
		return {};
	}
	const name = resolution.profileName;
	if (isSessionProfile(name)) {
		// Own session profile — no existence enforcement (the core refused
		// foreign `_session-*` names; dirs materialize at save time).
		return { profileName: name };
	}
	const names = listNamedProfiles();
	if (!names.includes(name)) {
		if (profileSource === "agent") {
			// Agent-typed name — refuse rather than lazy-create a likely typo.
			return {
				refusal: {
					error: formatProfileRefusal(name, names),
				},
			};
		}
		// Conversation default or settings default — a user-declared profile
		// materializes on first use (e.g. a dotfile-synced settings.json on a
		// fresh machine, or a /web profile default whose dir lapsed).
		try {
			ensureProfileDir(name);
		} catch (err) {
			console.warn(
				`[pi-lean-portal] Failed to create directory for default profile '${name}' — falling back: ${err instanceof Error ? err.message : String(err)}`,
			);
			// Mirror the session/none selection used when 'session' can't resolve.
			if (piSessionId) {
				return { profileName: sessionProfileName(piSessionId) };
			}
			return {};
		}
	}
	return { profileName: name };
}

/** Agent-actionable refusal for a nonexistent named profile. The profile
 * list is capped at 10; the session/none fallback is listed last so it
 * doesn't read as the recommended move. */
export function formatProfileRefusal(name: string, names: string[]): string {
	const shown = names.slice(0, 10);
	const more = names.length - shown.length;
	return [
		`Profile '${name}' does not exist.`,
		names.length === 0
			? "No named profiles exist yet."
			: `Existing profiles: ${shown.join(", ")}${more > 0 ? ` …and ${more} more` : ""}`,
		`To use this profile, ask the user to create it first: /web profile create ${name}`,
		`To browse now without it, retry with profile="session" or profile="none" — cookies will NOT be saved to '${name}'.`,
	].join("\n");
}

