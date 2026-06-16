# Cookie/Profile Revision: Phased Implementation Plan

> Companion to [COOKIES_REVISION.md](./COOKIES_REVISION.md) — breaks the unified profile model into independently shippable phases with clear boundaries, verification criteria, and rollback points.
>
> Includes guidance for two items not covered in the original document: concurrent shared-context creation safety (§3) and `browser.profile` events for TUI status updates (§4).

---

## Phase Overview

| Phase | Focus | Ships Value? | Depends on | Est. Days |
|-------|-------|-------------|------------|-----------|
| **0** | Type & vocabulary migration (`session` → `profile`) | No (mechanical) | None | 0.5 |
| **1** | Storage-state session-profile helpers + staleness detection | No (library) | Phase 0 | 0.5 |
| **2** | Chromium shared-context tracking + ref counting | Yes (shared profiles) | Phase 1 | 1.5 |
| **3** | Router profile resolution + lock removal | Yes (end-to-end) | Phase 2 | 1 |
| **4** | Tool/command surface (`browser-navigate profile`, `/web` sub-commands, `browser.profile` event) | Yes (user-visible) | Phase 3 | 1 |
| **5** | Python bridge parity | Yes (full backend parity) | Phase 3 | 1 |
| **6** | Remove `browser-cookies` tool + deprecated shims | Yes (cleanup) | Phase 4 | 0.5 |
| **7** | Integration testing | Yes (confidence) | Phase 5 | 1 |

**Total: ~6 days**

Each phase ends with a verification gate (tests pass, no regressions). Phases 2–5 each ship incremental value — the system is never broken between phases.

---

## Phase 0: Type & Vocabulary Migration

**Goal:** Replace the `session` parameter/field naming with `profile` across type definitions and internal plumbing. No behavioral changes — just renaming and deprecation shims.

**Why first:** Every subsequent phase touches these types. Doing the rename once, up front, avoids messy `session`/`profile` aliasing in every file.

### Changes

| File | What |
|------|------|
| `core/plugin-api.ts` | `NavigateOptions.session` → `NavigateOptions.profile`; `NavigateResult.sessionMode` → `NavigateResult.profileMode`; add deprecated `session` alias with `@deprecated` JSDoc |
| `core/shared/session-manager.ts` | `BrowserSession.profileName` → keep as-is (already correct); add `piSessionId?: string` field |
| `core/plugin-config.ts` | `BrowserConfig.sessionDefault` → `BrowserConfig.defaultProfile` (type changes to `"none" \| "session" \| string`); keep `sessionDefault` as deprecated alias; update validation |
| `index.ts` | `browser-navigate` tool param: rename `session` → `profile`; add runtime shim that maps `session` → `profile` with `console.warn` |

### Deprecation shim pattern

```typescript
// In router.ts or plugin-api.ts:
export interface NavigateOptions {
    /** @deprecated Use `profile` instead */
    session?: "new" | "last" | string;
    profile?: "none" | "session" | string;
    // ... other fields
}

// At resolution point:
const profileInput = options.profile ?? mapSessionToProfile(options.session);
```

```typescript
function mapSessionToProfile(session?: string): "none" | "session" | string | undefined {
    if (session === undefined) return undefined;
    if (session === "new") {
        console.warn('[pi-browser] session="new" is deprecated, use profile="none"');
        return "none";
    }
    if (session === "last") {
        console.warn('[pi-browser] session="last" is deprecated, use profile="session" or a named profile');
        return "session";
    }
    console.warn(`[pi-browser] session="${session}" is deprecated, use profile="${session}"`);
    return session;
}
```

### Verification

- [ ] All existing tests pass with deprecation warnings (not errors)
- [ ] New `profile` param on `browser-navigate` is accepted
- [ ] Old `session` param still works with `console.warn`
- [ ] `BrowserConfig.defaultProfile` reads from `settings.json`
- [ ] `piSessionId` field exists on `BrowserSession` (not yet populated)

---

## Phase 1: Storage-State Session-Profile Helpers

**Goal:** Add the session-profile naming convention, staleness detection, and prune utilities to `storage-state.ts`. No consumers yet — pure library work.

### Changes

| File | What |
|------|------|
| `core/shared/storage-state.ts` | Add `SESSION_PROFILE_PREFIX`, `SESSIONS_DIR`, `isSessionProfile()`, `sessionProfileName()`, `isSessionStale()`, `pruneStaleSessionProfiles()`; update `sanitizeProfileName()` to allow `_session-` prefixed names with validation |

### Key functions

```typescript
export const SESSION_PROFILE_PREFIX = "_session-";
export const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

export function isSessionProfile(name: string): boolean {
    return name.startsWith(SESSION_PROFILE_PREFIX);
}

export function sessionProfileName(piSessionId: string): string {
    // Validate: non-empty, no path traversal
    if (!piSessionId || /[/\\..]/.test(piSessionId)) {
        throw new Error(`Invalid piSessionId for session profile: '${piSessionId}'`);
    }
    return `${SESSION_PROFILE_PREFIX}${piSessionId}`;
}

export function isSessionStale(profileName: string): boolean {
    if (!isSessionProfile(profileName)) return false;
    const sessionId = profileName.slice(SESSION_PROFILE_PREFIX.length);
    return !existsSync(join(SESSIONS_DIR, `${sessionId}.json`));
}

export function pruneStaleSessionProfiles(): { pruned: string[]; kept: string[] } {
    const result = { pruned: [] as string[], kept: [] as string[] };
    if (!existsSync(PROFILE_DIR)) return result;

    for (const entry of readdirSync(PROFILE_DIR)) {
        if (!isSessionProfile(entry)) continue;
        if (isSessionStale(entry)) {
            try {
                rmSync(join(PROFILE_DIR, entry), { recursive: true, force: true });
                result.pruned.push(entry);
            } catch { /* best-effort */ }
        } else {
            result.kept.push(entry);
        }
    }
    return result;
}
```

### `sanitizeProfileName` update

Allow `_session-` prefixed names to bypass the normal alphanumeric regex, but validate the embedded session ID:

```typescript
export function sanitizeProfileName(name: string): string {
    if (typeof name !== "string" || name.length === 0) {
        throw new Error("Profile name must be a non-empty string");
    }

    // Session profiles: validate the embedded session ID
    if (name.startsWith(SESSION_PROFILE_PREFIX)) {
        const sessionId = name.slice(SESSION_PROFILE_PREFIX.length);
        if (!sessionId || /[/\\..\s]/.test(sessionId)) {
            throw new Error(
                `Invalid session profile name '${name}': embedded session ID must be non-empty ` +
                `and must not contain path traversal characters.`
            );
        }
        return name; // Bypass normal regex
    }

    // Normal profile names
    if (!PROFILE_NAME_RE.test(name)) {
        throw new Error(
            `Invalid profile name '${name}'. ` +
            "Profile names must be 1-64 characters, alphanumeric, hyphens, and underscores only."
        );
    }
    if (RESERVED_PROFILE_NAMES.has(name)) {
        throw new Error(`'${name}' is a reserved keyword and cannot be used as a profile name.`);
    }
    return name;
}
```

### Verification

- [ ] `sessionProfileName("abc123")` returns `"_session-abc123"`
- [ ] `isSessionProfile("_session-abc123")` returns `true`
- [ ] `isSessionProfile("work")` returns `false`
- [ ] `sanitizeProfileName("_session-abc123")` passes
- [ ] `sanitizeProfileName("_session-")` throws (empty session ID)
- [ ] `sanitizeProfileName("_session-../etc")` throws (path traversal)
- [ ] `isSessionStale()` correctly checks session file existence
- [ ] `pruneStaleSessionProfiles()` deletes stale and keeps active
- [ ] Existing `sanitizeProfileName` tests still pass (no regression)

---

## Phase 2: Chromium Shared-Context Tracking + Ref Counting

**Goal:** Refactor `ChromiumPlugin` from one-context-per-task to shared-context-for-named-profiles. This is the core architectural change.

### Changes

| File | What |
|------|------|
| `backends/chromium/index.ts` | Replace `_contexts` map with `_pages` + `_sharedContexts`; add ref counting; update `getOrCreateContext()`, `cleanup()`, `cleanupAll()`; add auto-save storage state |

### 2.1 New data structures

```typescript
/** Per-taskId page tracking (page's context may be shared with other tasks) */
private _pages = new Map<string, {
    context: BrowserContext;
    page: Page;
    profileName?: string;
    isSharedContext: boolean;
}>();

/** Shared BrowserContexts for named profiles, with reference counting */
private _sharedContexts = new Map<string, {
    context: BrowserContext;
    refCount: number;
}>();
```

### 2.2 Concurrent shared-context creation safety

**The problem:** If two tasks call `getOrCreateContext()` with the same named profile concurrently, both may see no entry in `_sharedContexts`, both create a new `BrowserContext`, and one overwrites the other — leaking an orphaned context.

**The fix: Promise-map singleton pattern.** Store in-progress context creations as promises so the second caller awaits the same creation rather than starting its own.

```typescript
/** In-progress shared context creations — prevents concurrent double-creation */
private _sharedContextCreations = new Map<string, Promise<{
    context: BrowserContext;
    refCount: number;
}>>();

private async getOrCreateContext(
    taskId: string,
    options?: { storageState?: unknown; profileName?: string; profileMode?: string },
): Promise<{ context: BrowserContext; page: Page; isNew: boolean }> {
    // 1. Check if task already has a page
    const existing = this._pages.get(taskId);
    if (existing && !existing.page.isClosed()) {
        return { context: existing.context, page: existing.page, isNew: false };
    }
    // (dead page recovery logic follows existing pattern — omitted for brevity)

    // 2. Named profile → try to reuse shared context
    if (options?.profileMode === "named" && options.profileName) {
        const profileName = options.profileName;

        // Check for existing shared context
        const shared = this._sharedContexts.get(profileName);
        if (shared) {
            try {
                // Verify context is still alive
                const pages = shared.context.pages();
                if (pages !== undefined) {
                    const page = await shared.context.newPage();
                    shared.refCount++;
                    this._pages.set(taskId, {
                        context: shared.context,
                        page,
                        profileName,
                        isSharedContext: true,
                    });
                    installDialogHandlers(taskId, page);
                    this._elementCache.set(taskId, new Map());
                    return { context: shared.context, page, isNew: true };
                }
            } catch {
                // Context is dead — remove stale reference and fall through
                this._sharedContexts.delete(profileName);
            }
        }

        // No existing shared context — check if creation is already in progress
        const inProgress = this._sharedContextCreations.get(profileName);
        if (inProgress) {
            // Another task is creating this context — wait for it
            const sharedEntry = await inProgress;
            const page = await sharedEntry.context.newPage();
            sharedEntry.refCount++;
            this._pages.set(taskId, {
                context: sharedEntry.context,
                page,
                profileName,
                isSharedContext: true,
            });
            installDialogHandlers(taskId, page);
            this._elementCache.set(taskId, new Map());
            return { context: sharedEntry.context, page, isNew: true };
        }

        // We're the first — create the shared context and store the creation promise
        const creationPromise = this._createSharedContext(taskId, profileName, options.storageState);
        this._sharedContextCreations.set(profileName, creationPromise);

        try {
            const sharedEntry = await creationPromise;
            // The creating task's page is already set inside _createSharedContext
            return { context: sharedEntry.context, page: this._pages.get(taskId)!.page, isNew: true };
        } finally {
            this._sharedContextCreations.delete(profileName);
        }
    }

    // 3. Ephemeral or session profile — create isolated context
    return this._createEphemeralContext(taskId, options?.storageState);
}

/** Create a shared BrowserContext for a named profile. */
private async _createSharedContext(
    taskId: string,
    profileName: string,
    storageState?: unknown,
): Promise<{ context: BrowserContext; refCount: number }> {
    const context = await this._createBrowserContext(storageState);
    const page = await context.newPage();

    const sharedEntry = { context, refCount: 1 };
    this._sharedContexts.set(profileName, sharedEntry);

    this._pages.set(taskId, {
        context,
        page,
        profileName,
        isSharedContext: true,
    });
    installDialogHandlers(taskId, page);
    this._elementCache.set(taskId, new Map());

    const session = sessionManager.getSession(taskId);
    if (session) session.context = context;

    return sharedEntry;
}

/** Create an isolated (ephemeral or session) BrowserContext. */
private async _createEphemeralContext(
    taskId: string,
    storageState?: unknown,
): Promise<{ context: BrowserContext; page: Page; isNew: boolean }> {
    const context = await this._createBrowserContext(storageState);
    const page = await context.newPage();

    this._pages.set(taskId, {
        context,
        page,
        profileName: undefined,
        isSharedContext: false,
    });
    installDialogHandlers(taskId, page);
    this._elementCache.set(taskId, new Map());

    const session = sessionManager.getSession(taskId);
    if (session) session.context = context;

    return { context, page, isNew: true };
}

/** Shared BrowserContext creation helper (viewport, UA, tracing). */
private async _createBrowserContext(storageState?: unknown): Promise<BrowserContext> {
    // Lazy-init shared browser (same as current getOrCreateContext)
    if (!this._browser) { /* ... existing browser launch logic ... */ }

    const contextOptions: Record<string, unknown> = {
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0 ...",
    };
    if (storageState !== undefined) {
        contextOptions.storageState = storageState;
    }

    const context = await this._browser!.newContext(contextOptions);

    // Tracing setup (same as current)
    const traceDir = process.env.BROWSER_TRACE_DIR;
    if (traceDir) {
        try {
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        } catch { /* best-effort */ }
    }

    return context;
}
```

### 2.3 Updated `cleanup()`

```typescript
async cleanup(taskId: string): Promise<void> {
    const entry = this._pages.get(taskId);
    if (!entry) return;

    const { context, page, profileName, isSharedContext } = entry;

    // Auto-save storage state BEFORE closing anything
    const session = sessionManager.getSession(taskId);
    if (session?.persistState) {
        try {
            const state = await context.storageState();
            saveStorageState(session.profileName ?? "default", state);
        } catch (err) {
            console.warn(
                `[pi-browser] Failed to auto-save storage state for profile ` +
                `'${session.profileName ?? "default"}': ${err instanceof Error ? err.message : String(err)}. ` +
                `Session state will be lost.`
            );
        }
    }

    if (isSharedContext && profileName) {
        // Shared context: close page only, decrement ref count
        try { await page.close(); } catch { /* best-effort */ }
        this._pages.delete(taskId);
        this._elementCaches.delete(taskId);

        const shared = this._sharedContexts.get(profileName);
        if (shared) {
            shared.refCount--;
            if (shared.refCount <= 0) {
                // Last page closed — close the shared context
                try { await context.close(); } catch { /* best-effort */ }
                this._sharedContexts.delete(profileName);
            }
        }
    } else {
        // Ephemeral or session context: close page + context
        try { await page.close(); } catch { /* best-effort */ }
        try { await context.close(); } catch { /* best-effort */ }
        this._pages.delete(taskId);
        this._elementCaches.delete(taskId);
    }
}
```

### 2.4 Updated `cleanupAll()`

```typescript
async cleanupAll(): Promise<void> {
    // Close all pages (respects shared context ref counts via cleanup())
    for (const taskId of [...this._pages.keys()]) {
        await this.cleanup(taskId).catch(() => {});
    }

    // Safety net: any remaining shared contexts (should be empty after all pages close)
    for (const [name, entry] of this._sharedContexts) {
        console.warn(`[pi-browser] Orphaned shared context '${name}' during cleanupAll — closing`);
        try { await entry.context.close(); } catch { /* best-effort */ }
    }
    this._sharedContexts.clear();
    this._sharedContextCreations.clear();
    this._elementCaches.clear();

    if (this._browser) {
        try { await this._browser.close(); } catch { /* best-effort */ }
        this._browser = null;
    }
}
```

### 2.5 Update all methods referencing `_contexts`

Every method that does `this._contexts.get(taskId)` becomes `this._pages.get(taskId)` and accesses `.page` or `.context` from the new entry shape. This is a mechanical rename — the entry still has `context` and `page` fields.

Key methods: `snapshot()`, `click()`, `type()`, `scroll()`, `goBack()`, `press()`, `screenshot()`, `getImages()`, `getConsoleMessages()`, `clearConsole()`, `evaluate()`, `getCookies()`, `addCookies()`, `clearCookies()`, `getStorageState()`.

For cookie methods, operate on `entry.context` instead of `entry.context`:
```typescript
async getCookies(taskId: string, urls?: string[]): Promise<CookieResult> {
    const entry = this._pages.get(taskId);
    if (!entry) return { success: false, error: "No active session", cookies: [] };
    const cookies = await entry.context.cookies(urls);
    return { success: true, cookies };
}
```

### 2.6 Tracing in shared contexts

**Known limitation:** Playwright tracing is per-`BrowserContext`, not per-`Page`. When two tasks share a named profile, tracing captures both pages' activity. This is acceptable for debugging (you can see cross-task interactions), but worth documenting.

**Implementation:** Start tracing on the context in `_createBrowserContext()` (same as today). For shared contexts, the first task to create the context starts tracing; subsequent tasks joining the same context inherit the active trace. On `cleanup()`, stop tracing only when the last page closes (refCount hits 0).

### Verification

- [ ] Single task, `profile="none"` — ephemeral context, no sharing
- [ ] Single task, `profile="session"` — per-session context, storage state saved on cleanup
- [ ] Two tasks, `profile="work"` — same BrowserContext, separate Pages, shared cookies
- [ ] Ref count: second task cleanup only closes Page, not Context
- [ ] Ref count: last task cleanup closes both Page and Context
- [ ] Concurrent `getOrCreateContext()` with same named profile — only one BrowserContext created (no orphan)
- [ ] `_sharedContextCreations` map is always cleaned up (no memory leak)
- [ ] Dead context detection: if shared context's browser crashes, stale entry removed
- [ ] `cleanupAll()` safety net fires only for orphaned contexts
- [ ] All existing tests pass (mechanical rename, no behavioral change for `profile="none"`)

---

## Phase 3: Router Profile Resolution + Lock Removal

**Goal:** Wire the `profile` parameter through the router, replace the `session` resolution block with `profile` resolution, and remove `profile-lock.ts` (locks are no longer needed with shared contexts).

### Changes

| File | What |
|------|------|
| `core/router.ts` | Replace `session` resolution block with `profile` resolution (per COOKIES_REVISION.md §4.8); remove all `acquireProfileLock`/`releaseProfileLock` calls and imports |
| `core/shared/profile-lock.ts` | **DELETE ENTIRELY** |
| `core/plugin-api.ts` | Add `profileName`, `profileMode`, `piSessionId` to `NavigateOptions` (replacing `session`); update `NavigateResult` fields |

### Router profile resolution logic

This follows COOKIES_REVISION.md §4.8 exactly, with one addition: when `profile="session"` is requested but `piSessionId` is unavailable, log a warning instead of silently falling back.

```typescript
// ── Resolve profile ─────────────────────────────────────────
let persistState = false;
let resolvedProfileName: string | undefined;
let profileMode: "none" | "session" | "named" | undefined;
let storageState: unknown;

const existingSession = sessionManager.getSession(taskId);
const browserConfig = loadBrowserConfig();
const profileInput = options.profile ?? browserConfig.defaultProfile;

if (profileInput === "none") {
    if (existingSession) {
        await plugin.cleanup(taskId).catch(() => {});
        sessionManager.removeSession(taskId);
        removeSnapshotFiles(taskId);
    }
    profileMode = "none";
    persistState = false;
} else if (profileInput === "session") {
    const piSessionId = options.piSessionId;
    if (!piSessionId) {
        // Can't resolve session profile without piSessionId — fall back with warning
        console.warn(
            "[pi-browser] profile='session' requested but piSessionId unavailable. " +
            "Falling back to profile='none'. This may occur during extension reload."
        );
        profileMode = "none";
        persistState = false;
    } else {
        resolvedProfileName = sessionProfileName(piSessionId);
        profileMode = "session";
        persistState = true;

        if (existingSession && existingSession.profileName !== resolvedProfileName) {
            await plugin.cleanup(taskId).catch(() => {});
            sessionManager.removeSession(taskId);
            removeSnapshotFiles(taskId);
        }

        const loaded = loadStorageState(resolvedProfileName);
        storageState = loaded ?? undefined;
    }
} else {
    // Named profile
    try {
        sanitizeProfileName(profileInput);
    } catch (err) {
        return { success: false, url: normalizedUrl, /* ... */, error: `Invalid profile name: ${...}` };
    }
    resolvedProfileName = profileInput;
    profileMode = "named";
    persistState = true;

    if (existingSession && existingSession.profileName !== resolvedProfileName) {
        await plugin.cleanup(taskId).catch(() => {});
        sessionManager.removeSession(taskId);
        removeSnapshotFiles(taskId);
    }

    const loaded = loadStorageState(resolvedProfileName);
    storageState = loaded ?? undefined;
}
```

### Why locks are removed

The old lock model prevented two tasks from loading the same named profile into separate BrowserContexts (last-writer-wins on the `storage-state.json` file). With shared contexts, both tasks use the *same* BrowserContext — there's only one cookie jar, so there's no write conflict. Playwright serializes cookie access internally.

Session profiles (`_session-*`) are per-piSessionId, so they're inherently isolated.

### Verification

- [ ] `profile="none"` creates ephemeral context, no state saved
- [ ] `profile="session"` with valid `piSessionId` creates/resumes session profile
- [ ] `profile="session"` without `piSessionId` falls back to `"none"` with warning
- [ ] `profile="work"` creates/resumes named profile
- [ ] Invalid profile names rejected with error
- [ ] Profile switching mid-conversation destroys old context, creates new one
- [ ] No `profile-lock.ts` imports remain anywhere
- [ ] All existing router tests pass (updated for `profile` param)
- [ ] Auto-recovery via `requireInteractiveSession()` restores profile state

---

## Phase 4: Tool/Command Surface + `browser.profile` Event

**Goal:** Update the user-facing and agent-facing surface to use the new `profile` parameter. Add `/web` sub-commands for profile management. Emit a `browser.profile` event for TUI status updates.

### 4.1 `browser-navigate` tool update

| File | What |
|------|------|
| `index.ts` | Replace `session` param with `profile` param on the tool definition; update output header to show profile info; pass `piSessionId` to router |

```typescript
profile: Type.Optional(
    Type.Union([
        StringEnum(["none", "session"]),
        Type.String(),
    ]),
    "Profile mode: 'none' (clean slate, default), 'session' (persist for this conversation), " +
    "or a named profile (e.g. 'shopping', 'work'). " +
    "Named profiles share cookies across subagents like browser tabs."
)
```

Output header update:
```
Profile: session (this conversation)
Profile: work (shared)
Profile: none
```

### 4.2 `/web` sub-commands

| File | What |
|------|------|
| `browser-toggle.ts` | Add `profile create`, `profile list`, `profile clear`, `profile prune`, `cookies`, `cookies clear` sub-commands |

See COOKIES_REVISION.md §4.10 for the full command reference.

### 4.3 `browser.profile` event for TUI status updates

**The problem:** When a profile is created, switched, or a shared context gains/loses a member, the TUI status bar should reflect the current state. Currently `sessionManager.getStatus()` knows nothing about profile mode or shared contexts — it only shows idle/active/crashed counts.

**The fix:** Add a `browser.profile` event emitted by the router on profile lifecycle changes. The extension's `index.ts` listens for this event and updates the TUI status bar. Additionally, extend `sessionManager.getStatus()` to include profile information.

#### Event definition

```typescript
// Emitted by the router after profile resolution
export interface ProfileEvent {
    type: "profile_changed" | "profile_created" | "profile_pruned" | "context_joined" | "context_left";
    taskId: string;
    profileName?: string;
    profileMode?: "none" | "session" | "named";
    /** For context_joined/context_left: number of tasks now sharing this context */
    sharedRefCount?: number;
}
```

#### Emission points in `router.ts`

```typescript
// After successful profile resolution in navigate():
if (resolvedProfileName) {
    this._emitProfileEvent({
        type: "profile_changed",
        taskId,
        profileName: resolvedProfileName,
        profileMode: profileMode!,
    });
}

// In plugin shared-context creation (Phase 2 adds a callback):
// When a task joins a shared context:
this._emitProfileEvent({
    type: "context_joined",
    taskId,
    profileName,
    profileMode: "named",
    sharedRefCount: shared.refCount,
});

// When a task leaves a shared context (in cleanup):
this._emitProfileEvent({
    type: "context_left",
    taskId,
    profileName,
    profileMode: "named",
    sharedRefCount: shared.refCount - 1,  // about to decrement
});
```

#### Listener in `index.ts`

```typescript
// During extension registration:
router.onProfileEvent((event) => {
    // Update TUI status bar
    ctx.ui.setStatus("browser", sessionManager.getStatus());

    // Optional: show profile change notification in the conversation
    if (event.type === "context_joined" && event.sharedRefCount === 2) {
        // First time a second task joins this shared context — notable
        ctx.log?.(`[browser] Profile '${event.profileName}' is now shared by ${event.sharedRefCount} tasks`);
    }
});
```

#### Extend `sessionManager.getStatus()`

```typescript
getStatus(): string {
    const active = this.getActiveSessions();
    const crashed = Array.from(this.#sessions.values()).filter((s) => s.crashed);

    if (active.length === 0) {
        if (crashed.length > 0) return `💥 ${crashed.length} crashed`;
        return "🌐 idle";
    }
    if (active.length === 1) {
        const s = active[0]!;
        const domain = s.currentUrl ? extractDomain(s.currentUrl) : undefined;
        const sym = this.pluginSymbol(s.pluginName);
        const profileTag = s.profileName
            ? ` [${s.profileName}${s.persistState ? "" : " ⚡"}]`
            : "";
        let status = domain ? `▶ ${sym}: ${domain}${profileTag}` : `▶ ${sym}${profileTag}`;
        if (crashed.length > 0) status += ` · ${crashed.length} crashed`;
        return status;
    }

    // Multiple active sessions — group by profile
    const byProfile = new Map<string, number>();
    for (const s of active) {
        const key = s.profileName ?? "ephemeral";
        byProfile.set(key, (byProfile.get(key) ?? 0) + 1);
    }
    const profileParts = Array.from(byProfile.entries())
        .map(([name, count]) => count > 1 ? `${name}×${count}` : name);
    const sym = this.pluginSymbol(active[0]!.pluginName);

    let status = `🌐 ${active.length} active (${sym}): ${profileParts.join(", ")}`;
    if (crashed.length > 0) status += ` · ${crashed.length} crashed`;
    return status;
}
```

Example TUI status strings:

| State | Old | New |
|-------|-----|-----|
| One task browsing example.com | `▶ PW: example.com` | `▶ PW: example.com [work]` |
| One task, ephemeral | `▶ PW: example.com` | `▶ PW: example.com` |
| Two tasks, shared "work" profile | `🌐 2 active (PW)` | `🌐 2 active (PW): work×2` |
| Two tasks, one shared + one ephemeral | `🌐 2 active (PW)` | `🌐 2 active (PW): work, ephemeral` |
| One task, session profile | `▶ PW: example.com` | `▶ PW: example.com [📋 session]` |

### 4.4 `/web` status output

Update the `/web` (no args) output to show current profile:

```
🌐 Browser: on
Profile: session (this conversation)
Backend: chromium
Sessions: 1 active
```

### Verification

- [ ] `browser-navigate profile="work"` shows `Profile: work (shared)` in output
- [ ] `browser-navigate profile="session"` shows `Profile: session (this conversation)`
- [ ] `browser-navigate profile="none"` shows `Profile: none`
- [ ] TUI status bar updates when profile is switched
- [ ] `browser.profile` event fires on profile_changed, context_joined, context_left
- [ ] `sessionManager.getStatus()` includes profile name and shared count
- [ ] `/web profile list` shows named profiles
- [ ] `/web profile list --all` shows session profiles with 📋 badge
- [ ] `/web profile prune --confirm` removes stale session profiles
- [ ] `/web cookies` shows cookie table for current session
- [ ] `/web cookies clear` clears all cookies and confirms
- [ ] Old `session` param still works with deprecation warning

---

## Phase 5: Python Bridge Parity

**Goal:** Implement shared-context support in the Python adapter and bridge, mirroring the Chromium plugin's `_pages` + `_sharedContexts` model.

### Changes

| File | What |
|------|------|
| `backends/python-adapter.ts` | Add `_pages` and `_sharedBridgeContexts` maps; update `navigate()` for shared contexts; update `cleanup()` for ref counting + auto-save |
| `backends/chromium-py/bridge.py` | Add `_profile_contexts` dict; add `browser.newPage` and `browser.closePage` RPC handlers; update `do_navigate()` for named profiles; update `do_cleanup()` for shared contexts |

Follow COOKIES_REVISION.md §§4.6 and 4.7 for the detailed implementation.

### Key concern: adapter-bridge consistency

The Python adapter tracks shared contexts on the TypeScript side (`_sharedBridgeContexts`) while the actual Playwright contexts live in the Python bridge process. If the bridge crashes, the adapter's ref counts become stale.

**Mitigation:** On any RPC call failure (bridge crash), clear `_sharedBridgeContexts` and `_pages` for the crashed bridge. The bridge recreates contexts on next navigate. This is the same crash-recovery pattern as the current code — the adapter's in-memory state is transient.

### Verification

- [ ] Python bridge `browser.newPage` creates a page in an existing shared context
- [ ] Python bridge `browser.closePage` closes one page without closing the context
- [ ] Adapter `cleanup()` decrements ref count; last cleanup closes context
- [ ] Auto-save via `browser.getStorageState` RPC before cleanup
- [ ] Bridge crash recovery clears adapter's in-memory tracking
- [ ] All Chromium-plugin shared-context tests have Python-bridge equivalents

---

## Phase 6: Remove `browser-cookies` Tool + Deprecated Shims

**Goal:** Clean up the deprecated `session` parameter and remove the `browser-cookies` tool entirely.

### Changes

| File | What |
|------|------|
| `index.ts` | Remove `browser-cookies` tool registration; remove `session` → `profile` deprecation shim; remove `session` param from `browser-navigate` |
| `core/plugin-api.ts` | Remove `session` field from `NavigateOptions`; remove `sessionMode` from `NavigateResult` |
| `core/plugin-config.ts` | Remove `sessionDefault` alias from `BrowserConfig` |
| `core/router.ts` | Remove `mapSessionToProfile()` helper; remove all `session` → `profile` mapping code |

### Migration note

This is a **breaking change** for any external tool or extension that calls `browser-navigate` with `session="..."`. The deprecation shim from Phase 0 has been warning since that phase, so users have had multiple phases to update.

### Verification

- [ ] `browser-navigate` only accepts `profile` param (not `session`)
- [ ] `browser-cookies` tool is not registered
- [ ] No `sessionDefault` references remain
- [ ] No `sessionMode` references remain
- [ ] All tests updated and passing
- [ ] AGENTS.md updated to reflect new tool set (13 tools instead of 14)

---

## Phase 7: Integration Testing

**Goal:** Comprehensive testing of the full profile model, especially concurrent shared-context scenarios.

### New test files

| File | What |
|------|------|
| `shared-context.test.ts` | Ref counting, multi-page same profile, cleanup on last page close, profile switching mid-conversation, concurrent creation |
| `router-profile.test.ts` | (Rename of `router-session.test.ts`) Profile resolution, `profile="none"/"session"/"named"`, invalid names, missing `piSessionId` |
| `python-bridge-shared.test.ts` | `browser.newPage`/`browser.closePage` RPC, shared context ref counting, cleanup (auto-skip if bridge unavailable) |

### Critical concurrent test scenario

This is the integration test that exercises the core shared-context promise — two tasks navigating to different URLs in the same named profile simultaneously:

```typescript
test("concurrent tasks share context but have independent pages", async () => {
    const plugin = new ChromiumPlugin();
    await plugin.init();

    // Task A navigates to site A with profile="work"
    const navA = plugin.navigate("https://site-a.com", "task-a", 30_000, {
        profileName: "work",
        profileMode: "named",
    });

    // Task B navigates to site B with profile="work" (same profile, concurrent)
    const navB = plugin.navigate("https://site-b.com", "task-b", 30_000, {
        profileName: "work",
        profileMode: "named",
    });

    const [resultA, resultB] = await Promise.all([navA, navB]);

    // Both succeed
    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);

    // Both use the same BrowserContext (same cookie jar)
    const pageA = plugin.getPage("task-a")!;
    const pageB = plugin.getPage("task-b")!;
    expect(pageA.context()).toBe(pageB.context());

    // But have different pages (independent navigation)
    expect(pageA).not.toBe(pageB);
    expect(pageA.url()).toContain("site-a");
    expect(pageB.url()).toContain("site-b");

    // Cookies set by site-a are visible in site-b's context
    const cookies = await pageA.context().cookies();
    // (site-a and site-b may set different cookies, but they share the jar)

    // Cleanup: task-a closes page only, context stays alive
    await plugin.cleanup("task-a");
    expect(pageB.isClosed()).toBe(false); // task-b's page unaffected

    // Cleanup: task-b closes last page, context is destroyed
    await plugin.cleanup("task-b");
    // Shared context entry removed from _sharedContexts

    await plugin.cleanupAll();
});
```

### Existing test updates

| File | Changes |
|------|---------|
| `router-session.test.ts` → `router-profile.test.ts` | Update all `session` → `profile` tests; add `profile="session"` tests; remove lock tests |
| `router-cookies.test.ts` | Remove (tool removed in Phase 6) |
| `browser-toggle.test.ts` | Add `profile create`, `prune`, `cookies` sub-command tests |
| `plugin-config-browser.test.ts` | Update `sessionDefault` → `defaultProfile` tests |
| `plugin-contract.test.ts` | Update navigate contract for `profile` param; remove `browser-cookies` contract tests |
| `storage-state` unit tests | Add `isSessionProfile`, `sessionProfileName`, `isSessionStale`, `pruneStaleSessionProfiles` tests |

### Verification

- [ ] All 527+ existing tests pass (with updates for renamed params)
- [ ] Concurrent shared-context test passes reliably (run 20x)
- [ ] Profile switching mid-conversation test passes
- [ ] Session profile staleness + prune test passes
- [ ] Python bridge parity test passes (when bridge available)
- [ ] No flaky test regressions

---

## Appendix A: Shared-Context Concurrency Guidance

This section provides detailed guidance for the concurrent shared-context creation scenario identified in the review.

### The race condition

```
Timeline:
  Task A: getOrCreateContext("work") → _sharedContexts.get("work") → undefined
  Task B: getOrCreateContext("work") → _sharedContexts.get("work") → undefined  (RACE!)
  Task A: creates BrowserContext-1, sets _sharedContexts.set("work", { context: BrowserContext-1, refCount: 1 })
  Task B: creates BrowserContext-2, sets _sharedContexts.set("work", { context: BrowserContext-2, refCount: 1 })  (OVERWRITE!)
  Result: BrowserContext-1 is orphaned (never closed, never referenced)
```

### The fix: Promise-map singleton

Store in-progress creations as `Promise` entries in a separate map. The second caller `await`s the same promise:

```
Timeline:
  Task A: getOrCreateContext("work")
    → _sharedContexts.get("work") → undefined
    → _sharedContextCreations.get("work") → undefined
    → Creates Promise P1, stores in _sharedContextCreations
    → Starts creating BrowserContext...

  Task B: getOrCreateContext("work")
    → _sharedContexts.get("work") → undefined
    → _sharedContextCreations.get("work") → Promise P1  (FOUND!)
    → await P1  (waits for Task A's creation)

  Task A: ...BrowserContext created
    → _sharedContexts.set("work", { context, refCount: 1 })
    → _sharedContextCreations.delete("work")
    → Returns to Task A

  Task B: P1 resolves
    → Creates new Page in the shared context
    → refCount: 2
    → Returns to Task B

  Result: Both tasks share one BrowserContext. No orphans.
```

### Edge cases

| Scenario | Behavior |
|----------|----------|
| Creation fails (Playwright error) | Promise rejects; second caller gets the rejection; `_sharedContextCreations` is cleaned in `finally` |
| Browser disconnects during creation | The `disconnected` handler clears both maps; callers get errors |
| Three concurrent callers | All three await the same Promise; on resolution, two create new Pages in the shared context |
| Caller arrives after creation completes | `_sharedContexts` has the entry; `_sharedContextCreations` is empty; normal reuse path |

### Testing the race

Use explicit Promise timing control rather than relying on scheduler nondeterminism:

```typescript
test("concurrent getOrCreateContext with same profile creates exactly one BrowserContext", async () => {
    const plugin = new ChromiumPlugin();
    await plugin.init();

    // Deliberately slow down context creation to ensure both tasks
    // enter getOrCreateContext before either completes
    const originalNewContext = plugin._browser!.newContext.bind(plugin._browser!);
    let creationCount = 0;
    plugin._browser!.newContext = async (...args) => {
        creationCount++;
        // Delay to let the second task enter getOrCreateContext
        await new Promise(r => setTimeout(r, 50));
        return originalNewContext(...args);
    };

    // Fire two concurrent getOrCreateContext calls
    const [ctxA, ctxB] = await Promise.all([
        plugin.getOrCreateContext("task-a", { profileName: "work", profileMode: "named" }),
        plugin.getOrCreateContext("task-b", { profileName: "work", profileMode: "named" }),
    ]);

    // Only ONE BrowserContext was created
    expect(creationCount).toBe(1);

    // Both pages are in the same context
    expect(ctxA.context).toBe(ctxB.context);

    // Two separate pages
    expect(ctxA.page).not.toBe(ctxB.page);

    await plugin.cleanupAll();
});
```

---

## Appendix B: `browser.profile` Event Specification

### Event types

| Type | When emitted | Payload |
|------|-------------|---------|
| `profile_changed` | After a task's profile is resolved in `navigate()` | `{ taskId, profileName?, profileMode }` |
| `profile_created` | After a new named profile directory is created via `/web profile create` | `{ taskId, profileName, profileMode: "named" }` |
| `profile_pruned` | After stale session profiles are deleted via `/web profile prune` | `{ taskId, pruned: string[] }` |
| `context_joined` | When a task's page joins a shared BrowserContext | `{ taskId, profileName, profileMode: "named", sharedRefCount }` |
| `context_left` | When a task's page leaves a shared BrowserContext (cleanup) | `{ taskId, profileName, profileMode: "named", sharedRefCount }` |

### Consumer: TUI status bar

The primary consumer is the TUI status bar. On any `browser.profile` event, call `ctx.ui.setStatus("browser", sessionManager.getStatus())` to refresh the display.

### Consumer: Logging / debugging

The events are also useful for debugging. In `BROWSER_DEBUG=1` mode, the router should log all profile events:

```
[browser] profile_changed: task=browser-1 profile=work mode=named
[browser] context_joined: task=browser-2 profile=work refCount=2
[browser] context_left: task=browser-1 profile=work refCount=1
[browser] context_left: task=browser-2 profile=work refCount=0 (context closed)
```

### Implementation: event emitter on the router

The router doesn't currently have an event emitter. The simplest approach is a callback registration:

```typescript
// In router.ts:
type ProfileEventCallback = (event: ProfileEvent) => void;

class Router {
    private _profileEventCallbacks: ProfileEventCallback[] = [];

    onProfileEvent(cb: ProfileEventCallback): void {
        this._profileEventCallbacks.push(cb);
    }

    private _emitProfileEvent(event: ProfileEvent): void {
        for (const cb of this._profileEventCallbacks) {
            try { cb(event); } catch { /* best-effort */ }
        }
    }
}
```

This avoids a dependency on an event emitter library and keeps the router simple. The `index.ts` extension registers a callback during setup.

### Future: `pi.emit` integration

If pi adds a general-purpose event bus (`pi.emit("browser.profile", event)`), the router callback can be updated to emit on that bus as well. For now, the callback approach is sufficient and doesn't require changes to the pi SDK.
