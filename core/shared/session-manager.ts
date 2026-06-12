/**
 * Session manager — tracks browser session lifecycle per task_id.
 *
 * Design: one shared Browser instance, one BrowserContext per active taskId.
 * Contexts are created on first use and disposed on task completion or error.
 *
 * v2 change: Sessions use `pluginName: string` instead of a backend-level enum.
 * The `processHandle` field has been removed.
 */

import type { Browser, BrowserContext } from "playwright";

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
	/** Playwright browser context (undefined for fetch) */
	context?: BrowserContext;
}

/** Stored last navigation for a task (used to auto-recover sessions) */
interface LastNavEntry {
	url: string;
	title: string;
	/** Plugin name that was used for the original navigation */
	pluginName: string;
}

class SessionManager {
	#sessions = new Map<string, BrowserSession>();
	#playwrightBrowser: Browser | null = null;
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
			session.lastActive = Date.now();
		}
	}

	// ─── Last navigation storage (for session auto-recovery) ───

	setLastNav(
		taskId: string,
		url: string,
		title: string,
		pluginName: string,
	): void {
		this.#lastNav.set(taskId, { url, title, pluginName });
	}

	getLastNav(taskId: string): LastNavEntry | undefined {
		return this.#lastNav.get(taskId);
	}

	clearLastNav(taskId: string): void {
		this.#lastNav.delete(taskId);
	}

	// ─── Session lifecycle ────────────────────────────────────────────

	removeSession(taskId: string): void {
		const session = this.#sessions.get(taskId);
		if (session?.context) {
			session.context.close().catch(() => {});
		}
		this.#sessions.delete(taskId);
		this.#lastNav.delete(taskId);
	}

	async removeAll(): Promise<void> {
		const closePromises: Promise<void>[] = [];
		for (const [, session] of this.#sessions) {
			if (session.context) {
				closePromises.push(session.context.close().catch(() => {}));
			}
		}
		await Promise.all(closePromises);
		this.#sessions.clear();
		this.#lastNav.clear();
		if (this.#playwrightBrowser) {
			try {
				await this.#playwrightBrowser.close();
			} catch {
				/* browser may already be closed */
			}
			this.#playwrightBrowser = null;
		}
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
			let status = domain ? `▶ ${sym}: ${domain}` : `▶ ${sym}`;
			if (crashed.length > 0) {
				status += ` · ${crashed.length} crashed`;
			}
			return status;
		}
		const plugins = new Set(active.map((s) => s.pluginName));
		const pluginStr = Array.from(plugins)
			.map((p) => this.pluginSymbol(p))
			.join(",");
		let status = `🌐 ${active.length} active (${pluginStr})`;
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

	getPlaywrightBrowser(): Browser | null {
		return this.#playwrightBrowser;
	}
	setPlaywrightBrowser(b: Browser | null): void {
		this.#playwrightBrowser = b;
	}
}

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export const sessionManager = new SessionManager();
