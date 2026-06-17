/**
 * Session manager — tracks browser session lifecycle per task_id.
 *
 * Design: sessions track metadata; browsers and contexts are managed
 * entirely by the plugin. The session manager is Playwright-agnostic.
 */

/** Runtime state of a single browsing session */
export interface BrowserSession {
	taskId: string;
	/** Name of the plugin this session is bound to (set once, never changes) */
	pluginName: string;
	/** The URL currently loaded in this session */
	currentUrl?: string;
	/** Page title if available */
	currentTitle?: string;
	/** Stable hash of the last snapshot's accessibility tree (for DOM-change detection) */
	currentSnapshotFingerprint?: string;
	/** Timestamp when element cache was last populated (for staleness detection) */
	cachePopulatedAt?: number;
	/** Timestamp of the last interaction that may have mutated the DOM */
	lastInteractionAt?: number;
	/** Timestamp of last activity */
	lastActive: number;
	/** Whether the session has crashed and needs recovery */
	crashed: boolean;
	/** Whether to auto-save storage state on cleanup */
	persistState?: boolean;
	/** Profile name used for this session (undefined = default) */
	profileName?: string;
	/** pi session ID for session-scoped profiles */
	piSessionId?: string;
}

/** Stored last navigation for a task (used to auto-recover sessions) */
interface LastNavEntry {
	url: string;
	title: string;
	/** Plugin name that was used for the original navigation */
	pluginName: string;
	/** Profile name active during this navigation (for restoring state on recovery) */
	profileName?: string;
}

class SessionManager {
	#sessions = new Map<string, BrowserSession>();
	/** Last navigation URL per task (survives session removal, cleared explicitly) */
	#lastNav = new Map<string, LastNavEntry>();

	createSession(taskId: string, pluginName: string): BrowserSession {
		const existing = this.#sessions.get(taskId);
		if (existing) {
			existing.pluginName = pluginName;
			delete existing.currentUrl;
			delete existing.currentTitle;
			existing.lastActive = Date.now();
			existing.crashed = false;
			return existing;
		}
		const session: BrowserSession = {
			taskId,
			pluginName,
			lastActive: Date.now(),
			crashed: false,
		};
		this.#sessions.set(taskId, session);
		return session;
	}

	getSession(taskId: string): BrowserSession | undefined {
		return this.#sessions.get(taskId);
	}

	updateSession(
		taskId: string,
		updates: Partial<
			Pick<
				BrowserSession,
				| "currentUrl"
				| "currentTitle"
				| "pluginName"
				| "crashed"
				| "currentSnapshotFingerprint"
				| "cachePopulatedAt"
				| "lastInteractionAt"
				| "persistState"
				| "profileName"
				| "piSessionId"
			>
		>,
	): void {
		const session = this.#sessions.get(taskId);
		if (session) {
			if (updates.currentUrl !== undefined)
				session.currentUrl = updates.currentUrl;
			if (updates.currentTitle !== undefined)
				session.currentTitle = updates.currentTitle;
			if (updates.pluginName !== undefined)
				session.pluginName = updates.pluginName;
			if (updates.crashed !== undefined) session.crashed = updates.crashed;
			if (updates.currentSnapshotFingerprint !== undefined)
				session.currentSnapshotFingerprint = updates.currentSnapshotFingerprint;
			if (updates.cachePopulatedAt !== undefined)
				session.cachePopulatedAt = updates.cachePopulatedAt;
			if (updates.lastInteractionAt !== undefined)
				session.lastInteractionAt = updates.lastInteractionAt;
			if (updates.persistState !== undefined)
				session.persistState = updates.persistState;
			if (updates.profileName !== undefined)
				session.profileName = updates.profileName;
			if (updates.piSessionId !== undefined)
				session.piSessionId = updates.piSessionId;
			session.lastActive = Date.now();
		}
	}

	// ─── Last navigation storage (for session auto-recovery) ───

	setLastNav(
		taskId: string,
		url: string,
		title: string,
		pluginName: string,
		profileName?: string,
	): void {
		const entry: LastNavEntry = { url, title, pluginName };
		if (profileName !== undefined) {
			entry.profileName = profileName;
		}
		this.#lastNav.set(taskId, entry);
	}

	getLastNav(taskId: string): LastNavEntry | undefined {
		return this.#lastNav.get(taskId);
	}

	clearLastNav(taskId: string): void {
		this.#lastNav.delete(taskId);
	}

	// ─── Session lifecycle ────────────────────────────────────────────

	removeSession(taskId: string): void {
		this.#sessions.delete(taskId);
		this.#lastNav.delete(taskId);
	}

	async removeAll(): Promise<void> {
		this.#sessions.clear();
		this.#lastNav.clear();
	}

	/**
	 * Get a display symbol for a plugin name.
	 * Known plugins get short symbols; unknown plugins get the first 3 chars.
	 */
	pluginSymbol(pluginName: string): string {
		switch (pluginName) {
			case "chromium":
				return "PW";
			default:
				// Return up to 3 uppercase chars for custom plugins
				return pluginName.slice(0, 3).toUpperCase();
		}
	}

	getStatus(): string {
		const active = this.getActiveSessions();
		const crashed = Array.from(this.#sessions.values()).filter(
			(s) => s.crashed,
		);

		if (active.length === 0) {
			if (crashed.length > 0) {
				return `💥 ${crashed.length} session${crashed.length > 1 ? "s" : ""} crashed`;
			}
			return "🌐 idle";
		}
		if (active.length === 1) {
			const s = active[0]!;
			const domain = s.currentUrl ? extractDomain(s.currentUrl) : undefined;
			const sym = this.pluginSymbol(s.pluginName);
			const profileTag = s.profileName
				? ` [${profileDisplayName(s.profileName)}]`
				: "";
			let status = domain
				? `▶ ${sym}: ${domain}${profileTag}`
				: `▶ ${sym}${profileTag}`;
			if (crashed.length > 0) {
				status += ` · ${crashed.length} crashed`;
			}
			return status;
		}
		// Multiple active sessions — group by profile
		const byProfile = new Map<string, number>();
		for (const s of active) {
			const key = s.profileName ?? "ephemeral";
			byProfile.set(key, (byProfile.get(key) ?? 0) + 1);
		}
		const profileParts = Array.from(byProfile.entries()).map(([name, count]) =>
			count > 1
				? `${profileDisplayName(name)}×${count}`
				: profileDisplayName(name),
		);
		const sym = this.pluginSymbol(active[0]!.pluginName);
		let status = `🌐 ${active.length} active (${sym}): ${profileParts.join(", ")}`;
		if (crashed.length > 0) {
			status += ` · ${crashed.length} crashed`;
		}
		return status;
	}

	getActiveSessions(): BrowserSession[] {
		return Array.from(this.#sessions.values()).filter(
			(s) => s.currentUrl && !s.crashed,
		);
	}

	get activeCount(): number {
		return this.getActiveSessions().length;
	}

	/**
	 * Find the taskId for a given pi session ID.
	 * Used by command handlers (like `/web cookies`) to resolve the correct
	 * taskId without duplicating index.ts's monotonic counter logic.
	 */
	getTaskIdForPiSessionId(piSessionId: string): string | undefined {
		for (const [taskId, session] of this.#sessions.entries()) {
			if (session.piSessionId === piSessionId) return taskId;
		}
		return undefined;
	}
}

/**
 * Short display name for a profile in the TUI status bar.
 * Session-scoped profiles render as a "📋 session" badge;
 * named profiles show their name;
 * "ephemeral" (no profile) label shows as-is.
 */
function profileDisplayName(name: string): string {
	if (name.startsWith("_session-")) return "📋 session";
	if (name === "ephemeral") return "ephemeral";
	return name;
}

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export const sessionManager = new SessionManager();
