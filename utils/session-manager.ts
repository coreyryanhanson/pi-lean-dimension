/**
 * Session manager — tracks browser session lifecycle per task_id.
 *
 * Design: one shared Browser instance (for Level 2/3), one BrowserContext
 * per active taskId. Contexts are created on first use and disposed on
 * task completion or error.
 */

import type { Browser, BrowserContext } from "playwright";

/** Which backend level a session is currently using */
export type BackendLevel = "chromium" | "stealth";

/** Runtime state of a single browsing session */
export interface BrowserSession {
  taskId: string;
  level: BackendLevel;
  /** The URL currently loaded in this session */
  currentUrl?: string;
  /** Page title if available */
  currentTitle?: string;
  /** Timestamp of last activity */
  lastActive: number;
  /** Whether the session has crashed and needs recovery */
  crashed: boolean;
  /** Level 2/3: Playwright browser context (undefined for fetch) */
  context?: BrowserContext;
  /** Level 3: Python bridge process handle (opaque) */
  processHandle?: unknown;
}

/** Stored last navigation for a task (used to auto-escalate fetch→interactive) */
interface LastNavEntry {
  url: string;
  title: string;
}

class SessionManager {
  #sessions = new Map<string, BrowserSession>();
  #playwrightBrowser: Browser | null = null;
  #stealthProcess: unknown = null;
  /** Last navigation URL per task (survives session removal, cleared explicitly) */
  #lastNav = new Map<string, LastNavEntry>();

  createSession(taskId: string, level: BackendLevel): BrowserSession {
    const existing = this.#sessions.get(taskId);
    if (existing) {
      existing.level = level;
      existing.currentUrl = undefined;
      existing.currentTitle = undefined;
      existing.lastActive = Date.now();
      existing.crashed = false;
      return existing;
    }
    const session: BrowserSession = {
      taskId,
      level,
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
    updates: Partial<Pick<BrowserSession, "currentUrl" | "currentTitle" | "level" | "crashed">>,
  ): void {
    const session = this.#sessions.get(taskId);
    if (session) {
      if (updates.currentUrl !== undefined) session.currentUrl = updates.currentUrl;
      if (updates.currentTitle !== undefined) session.currentTitle = updates.currentTitle;
      if (updates.level !== undefined) session.level = updates.level;
      if (updates.crashed !== undefined) session.crashed = updates.crashed;
      session.lastActive = Date.now();
    }
  }

  // ─── Last navigation storage (for fetch→interactive auto-escalation) ───

  setLastNav(taskId: string, url: string, title: string): void {
    this.#lastNav.set(taskId, { url, title });
  }

  getLastNav(taskId: string): { url: string; title: string } | undefined {
    return this.#lastNav.get(taskId);
  }

  clearLastNav(taskId: string): void {
    this.#lastNav.delete(taskId);
  }

  // ─── Session lifecycle ────────────────────────────────────────────────

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
      try { await this.#playwrightBrowser.close(); } catch { /* ok */ }
      this.#playwrightBrowser = null;
    }
  }

  getStatus(): string {
    const active = this.getActiveSessions();
    const crashed = Array.from(this.#sessions.values()).filter((s) => s.crashed);

    if (active.length === 0) {
      if (crashed.length > 0) {
        return `💥 ${crashed.length} session${crashed.length > 1 ? "s" : ""} crashed`;
      }
      return "🌐 idle";
    }
    if (active.length === 1) {
      const s = active[0];
      const domain = s.currentUrl ? extractDomain(s.currentUrl) : undefined;
      const sym = levelToSymbol(s.level);
      let status = domain ? `▶ ${sym}: ${domain}` : `▶ ${sym}`;
      if (crashed.length > 0) {
        status += ` · ${crashed.length} crashed`;
      }
      return status;
    }
    const levels = new Set(active.map((s) => s.level));
    const levelStr = Array.from(levels).map(levelToSymbol).join(",");
    let status = `🌐 ${active.length} active (${levelStr})`;
    if (crashed.length > 0) {
      status += ` · ${crashed.length} crashed`;
    }
    return status;
  }

  getActiveSessions(): BrowserSession[] {
    return Array.from(this.#sessions.values()).filter((s) => s.currentUrl && !s.crashed);
  }

  get activeCount(): number {
    return this.getActiveSessions().length;
  }

  getPlaywrightBrowser(): Browser | null { return this.#playwrightBrowser; }
  setPlaywrightBrowser(b: Browser): void { this.#playwrightBrowser = b; }
  getStealthProcess(): unknown { return this.#stealthProcess; }
  setStealthProcess(p: unknown): void { this.#stealthProcess = p; }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function levelToSymbol(level: BackendLevel): string {
  switch (level) {
    case "chromium": return "PW";
    case "stealth": return "IPW";
  }
}

export const sessionManager = new SessionManager();
