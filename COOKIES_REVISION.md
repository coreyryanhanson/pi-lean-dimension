# Cookie/Profile Revision: Unified Profile Model

> Replaces the `session="new"/"last"/"profile-name"` vocabulary with a unified `profile` parameter, removes the `browser-cookies` tool, adds shared BrowserContexts for named profiles (Firefox-tab model), and maintains full Python bridge parity.

---

## 1. Core Concept

Profiles work like Firefox: same profile = shared cookie jar, multiple tabs (Pages). Different profile = isolated cookie jar.

| Profile value | BrowserContext | Cookie sharing | On-disk name | Visibility |
|---|---|---|---|---|
| `"none"` | Ephemeral, per taskId | None | (none) | N/A |
| `"session"` | Per `piSessionId` | Within this conversation | `_session-<piSessionId>` | Hidden from `/web profile list` |
| Named (`"work"`) | **Shared** across taskIds | **Shared** (like Firefox tabs) | `work` | Visible |

### Navigation is always independent

Each subagent gets its own `Page` within a `BrowserContext`. Navigation state (URL, DOM, scroll position) is per-Page. Cookies are per-Context. So:

- Two subagents with `profile="work"` → same BrowserContext, separate Pages, **shared cookies**
- Two subagents with `profile="session"` → different BrowserContexts (different `piSessionId`), separate Pages, **isolated cookies**
- Two subagents with `profile="none"` → different ephemeral BrowserContexts, separate Pages, **isolated cookies**

---

## 2. Architecture: Shared BrowserContexts

### Current model (Phase 2)

```
taskId-1 → BrowserContext A (isolated) → Page A
taskId-2 → BrowserContext B (isolated) → Page B
```

Lock prevents concurrent access to the same named profile. Second subagent falls back to ephemeral.

### New model

```
Named profile "work":
  BrowserContext (shared) → Page A (taskId-1)
                        → Page B (taskId-2)
                        → refCount: 2

Session profile "_session-abc":
  BrowserContext (per-session) → Page C (taskId-3)

profile="none":
  BrowserContext (ephemeral) → Page D (taskId-4)
```

No locks needed. Playwright serializes cookie jar access internally (same as a real browser).

---

## 3. Session Profiles: Lifecycle & Cleanup

### Naming convention

Session profiles are stored on disk as `_session-<piSessionId>`. The `_session-` prefix marks them as auto-generated and hidden from profile listings.

### No auto-cleanup

Session profiles persist on disk until the user prunes them. We don't delete cookies on the user's behalf — they may want to resume old conversations.

### Lazy staleness detection

Since pi does not emit a `session_delete` event when a user deletes a chat, we detect stale session profiles by checking whether the corresponding session file still exists at `~/.pi/agent/sessions/<id>.json`.

- `/web profile prune` checks staleness for all `_session-*` profiles and deletes the stale ones (with `--confirm`)
- `/web profile list --all` shows session profiles with a `📋 session` badge (stale ones get `🗑️ stale`)

---

## 4. Changes by File

### 4.1 `core/shared/profile-lock.ts` — **DELETE ENTIRELY**

No locks needed. Shared contexts handle concurrency natively. The lock module's atomic `mkdir` approach was correct for the previous architecture but is unnecessary now.

---

### 4.2 `core/shared/storage-state.ts`

**Add:**

- `SESSION_PROFILE_PREFIX = "_session-"`
- `SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions")`
- `isSessionProfile(name: string): boolean` — checks `_session-` prefix
- `sessionProfileName(piSessionId: string): string` — returns `_session-<id>`
- `isSessionStale(profileName: string): boolean` — extracts session ID, checks `~/.pi/agent/sessions/<id>.json` existence
- `pruneStaleSessionProfiles(): { pruned: string[]; kept: string[] }` — deletes stale `_session-` profile directories, returns results

**Update:**

- `sanitizeProfileName()` — allow `_session-` prefixed names (they bypass the normal regex but are validated: the embedded session ID must be non-empty and not contain path traversal characters)

---

### 4.3 `core/shared/session-manager.ts`

**Add:**

- `piSessionId?: string` to `BrowserSession` — so the router and plugin can derive the session profile name
- Update `updateSession()` Pick type to include `piSessionId`

---

### 4.4 `core/plugin-api.ts`

**Replace** `NavigateOptions.session` with `NavigateOptions.profile`:

```typescript
export interface NavigateOptions {
    strategy?: string;
    timeout?: number;
    signal?: AbortSignal;
    taskId?: string;
    profile?: "none" | "session" | string;  // replaces session
    piSessionId?: string;                    // needed for session profile resolution
    storageState?: unknown;
}
```

**Update** `NavigateResult` — replace `sessionMode`/`profileName` with cleaner fields:

```typescript
profileMode?: "none" | "session" | "named";  // what kind of profile is active
profileName?: string;                          // resolved profile name
```

**Keep** `session` as deprecated alias in `NavigateOptions` for backward compat (mapped internally with `console.warn`).

---

### 4.5 `backends/chromium/index.ts` — **Major refactor: shared context tracking**

**Replace** single-context-per-task model:

```typescript
private _contexts = new Map<string, { context: BrowserContext; page: Page }>();
```

**With** page-level tracking + shared context pool:

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

**Update `getOrCreateContext()`:**

```typescript
async getOrCreateContext(
    taskId: string,
    options?: { storageState?: unknown; profileName?: string; profileMode?: string },
): Promise<{ context: BrowserContext; page: Page; isNew: boolean }> {
    // 1. Check if task already has a page
    const existing = this._pages.get(taskId);
    if (existing && !existing.page.isClosed()) {
        return { context: existing.context, page: existing.page, isNew: false };
    }

    // 2. Named profile → try to reuse shared context
    if (options?.profileMode === "named" && options.profileName) {
        const shared = this._sharedContexts.get(options.profileName);
        if (shared) {
            // Verify context is still alive
            try {
                const pages = shared.context.pages();
                if (pages !== undefined) {
                    // Reuse existing shared context — create new page (tab)
                    const page = await shared.context.newPage();
                    shared.refCount++;
                    this._pages.set(taskId, {
                        context: shared.context,
                        page,
                        profileName: options.profileName,
                        isSharedContext: true,
                    });
                    return { context: shared.context, page, isNew: true };
                }
            } catch {
                // Context is dead — remove stale reference
                this._sharedContexts.delete(options.profileName);
            }
        }
        // No shared context yet → fall through to create one
    }

    // 3. Create new BrowserContext
    const contextOptions: Record<string, unknown> = {};
    if (options?.storageState) {
        contextOptions.storageState = options.storageState;
    }
    const context = await this._browser!.newContext(contextOptions);
    const page = await context.newPage();

    const isShared = options?.profileMode === "named" && !!options?.profileName;
    this._pages.set(taskId, {
        context,
        page,
        profileName: options?.profileName,
        isSharedContext: isShared,
    });

    if (isShared && options!.profileName) {
        this._sharedContexts.set(options!.profileName!, {
            context,
            refCount: 1,
        });
    }

    return { context, page, isNew: true };
}
```

**Update `cleanup(taskId)`:**

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
        // (existing tracing/closing logic)
        try { await page.close(); } catch { /* best-effort */ }
        try { await context.close(); } catch { /* best-effort */ }
        this._pages.delete(taskId);
        this._elementCaches.delete(taskId);
    }
}
```

**Update `cleanupAll()`:**

```typescript
async cleanupAll(): Promise<void> {
    // Close all pages first (respects shared context ref counts)
    for (const [taskId] of [...this._pages]) {
        await this.cleanup(taskId).catch(() => {});
    }
    // Safety net: any remaining shared contexts
    for (const [, entry] of this._sharedContexts) {
        try { await entry.context.close(); } catch { /* best-effort */ }
    }
    this._sharedContexts.clear();
    this._elementCaches.clear();

    if (this._browser) {
        try { await this._browser.close(); } catch { /* best-effort */ }
        this._browser = null;
    }
}
```

**Update `navigate()`:**
- Accept `profileName`, `profileMode`, `piSessionId` in options
- Pass them through to `getOrCreateContext()`
- When `profile="none"` is requested for a task that already has a page in a shared context: close the page (decrement ref count), create new ephemeral context

**Update all other methods** that reference `_contexts`:
- `snapshot()`, `click()`, `type()`, etc. — look up the task's `Page` from `_pages` instead of `_contexts`
- `getCookies()`, `addCookies()`, `clearCookies()` — operate on the `context` from `_pages[taskId].context`
- `getStorageState()` — operate on the `context` from `_pages[taskId].context`

---

### 4.6 `backends/python-adapter.ts` — **Shared context via bridge RPC**

The Python adapter must support shared contexts for named profiles. This requires new RPC methods in the bridge and a context-sharing map in the adapter.

**Add shared context tracking:**

```typescript
/** Shared BrowserContext references for named profiles in the Python bridge */
private _sharedBridgeContexts = new Map<string, {
    profileName: string;
    refCount: number;
}>();
```

**Update `navigate()`:**

When a named profile is requested and a shared context already exists for that profile in the bridge:

```typescript
// In navigate(), after profile resolution:
if (profileMode === "named" && resolvedProfileName) {
    const shared = this._sharedBridgeContexts.get(resolvedProfileName);
    if (shared) {
        // Reuse existing shared context — tell bridge to create a new page
        const result = await this._rpcCall("browser.newPage", {
            taskId,
            profileName: resolvedProfileName,
        });
        shared.refCount++;
        // ... handle result
    } else {
        // First use of this named profile — create context via normal navigate
        // The bridge will track the profile name for future reuse
        const navResult = await this._rpcCall("browser.navigate", {
            url, taskId, timeoutMs,
            storageState: options.storageState,
            profileName: resolvedProfileName,
            profileMode: "named",
        });
        this._sharedBridgeContexts.set(resolvedProfileName, {
            profileName: resolvedProfileName,
            refCount: 1,
        });
    }
}
```

**Update `cleanup()`:**

```typescript
async cleanup(taskId: string): Promise<void> {
    const pageEntry = this._pages.get(taskId);

    // Auto-save storage state BEFORE cleanup
    const session = sessionManager.getSession(taskId);
    if (session?.persistState) {
        try {
            const raw = await this._rpcCall("browser.getStorageState", { taskId });
            const state = raw as { cookies: unknown[]; origins: unknown[] };
            saveStorageState(session.profileName ?? "default", state);
        } catch (err) {
            console.warn(
                `[pi-browser] Failed to auto-save storage state for profile ` +
                `'${session.profileName ?? "default"}' via Python bridge: ` +
                `${err instanceof Error ? err.message : String(err)}.`
            );
        }
    }

    // Check if this is a shared context page
    if (pageEntry?.isSharedContext && pageEntry.profileName) {
        const shared = this._sharedBridgeContexts.get(pageEntry.profileName);
        if (shared) {
            shared.refCount--;
            if (shared.refCount <= 0) {
                // Last page — close the whole context
                this._sharedBridgeContexts.delete(pageEntry.profileName);
                await this._rpcCall("browser.cleanup", { taskId }).catch(() => {});
            } else {
                // Just close this page, keep the context alive
                await this._rpcCall("browser.closePage", { taskId, profileName: pageEntry.profileName }).catch(() => {});
            }
        }
    } else {
        // Ephemeral or session — close everything
        await this._rpcCall("browser.cleanup", { taskId }).catch(() => {});
    }

    this._elementCaches.delete(taskId);
    this._pages.delete(taskId);
}
```

**Add page tracking map** (analogous to chromium's `_pages`):

```typescript
private _pages = new Map<string, {
    profileName?: string;
    isSharedContext: boolean;
}>();
```

---

### 4.7 `backends/chromium-py/bridge.py` — **Shared context support**

**Add shared context tracking:**

```python
# At module/class level in the bridge:
_profile_contexts: Dict[str, Dict] = {}  # profile_name → { browser_context, ref_count }
```

**Add `browser.newPage` RPC handler:**

```python
async def do_newPage(self, params: dict) -> dict:
    """Create a new Page in an existing shared context for a named profile."""
    task_id = params["taskId"]
    profile_name = params["profileName"]

    shared = self._profile_contexts.get(profile_name)
    if not shared:
        return {"success": False, "error": f"No shared context for profile '{profile_name}'"}

    context = shared["context"]
    page = await context.new_page()
    shared["ref_count"] += 1

    # Store page reference for this taskId
    self._pages[task_id] = {
        "page": page,
        "context": context,
        "profile_name": profile_name,
        "is_shared": True,
    }

    return {"success": True}
```

**Add `browser.closePage` RPC handler:**

```python
async def do_closePage(self, params: dict) -> dict:
    """Close a single Page in a shared context without closing the context."""
    task_id = params["taskId"]
    profile_name = params["profileName"]

    page_entry = self._pages.pop(task_id, None)
    if page_entry and page_entry.get("page"):
        try:
            await page_entry["page"].close()
        except Exception:
            pass

    shared = self._profile_contexts.get(profile_name)
    if shared:
        shared["ref_count"] -= 1
        if shared["ref_count"] <= 0:
            # Last page — close the context
            try:
                await shared["context"].close()
            except Exception:
                pass
            del self._profile_contexts[profile_name]

    return {"success": True}
```

**Update `do_navigate()`:**

When `profileMode: "named"` is passed, register the context in `_profile_contexts`:

```python
async def do_navigate(self, params: dict) -> dict:
    # ... existing url/taskId/timeout parsing ...

    profile_name = params.get("profileName")
    profile_mode = params.get("profileMode")
    storage_state = params.get("storageState")

    # Create context config
    context_config = params.get("config", {})
    if storage_state:
        context_config["storage_state"] = storage_state

    context = await self.browser.new_context(**context_config)
    page = await context.new_page()

    # Navigate
    response = await page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
    title = await page.title()

    # Track shared context for named profiles
    if profile_mode == "named" and profile_name:
        self._profile_contexts[profile_name] = {
            "context": context,
            "ref_count": 1,
        }

    # Store page reference
    self._pages[task_id] = {
        "page": page,
        "context": context,
        "profile_name": profile_name,
        "is_shared": profile_mode == "named",
    }

    # ... return result ...
```

**Update `do_cleanup()`:**

```python
async def do_cleanup(self, params: dict) -> dict:
    task_id = params["taskId"]
    page_entry = self._pages.pop(task_id, None)

    if page_entry:
        page = page_entry.get("page")
        context = page_entry.get("context")
        profile_name = page_entry.get("profile_name")
        is_shared = page_entry.get("is_shared", False)

        if is_shared and profile_name:
            shared = self._profile_contexts.get(profile_name)
            if shared:
                shared["ref_count"] -= 1
                # Close just the page
                if page:
                    try:
                        await page.close()
                    except Exception:
                        pass
                if shared["ref_count"] <= 0:
                    # Last page — close context too
                    try:
                        await context.close()
                    except Exception:
                        pass
                    del self._profile_contexts[profile_name]
            else:
                # No shared tracking — close everything
                if page:
                    try:
                        await page.close()
                    except Exception:
                        pass
                if context:
                    try:
                        await context.close()
                    except Exception:
                        pass
        else:
            # Ephemeral/session — close page + context
            if page:
                try:
                    await page.close()
                except Exception:
                    pass
            if context:
                try:
                    await context.close()
                except Exception:
                    pass

    return {"success": True}
```

**Update `do_getStorageState()`:**

No changes needed — already calls `context.storage_state()` on the task's context.

---

### 4.8 `core/router.ts` — **Profile resolution logic**

**Replace** the `session` resolution block with `profile` resolution:

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
    // Clean slate — destroy existing context if any
    if (existingSession) {
        await plugin.cleanup(taskId).catch(() => {});
        sessionManager.removeSession(taskId);
        removeSnapshotFiles(taskId);
    }
    profileMode = "none";
    persistState = false;
} else if (profileInput === "session") {
    // Session-scoped profile — persist for this conversation
    const piSessionId = options.piSessionId;
    if (!piSessionId) {
        // Can't resolve session profile without piSessionId — fall back to none
        profileMode = "none";
        persistState = false;
    } else {
        resolvedProfileName = sessionProfileName(piSessionId);
        profileMode = "session";
        persistState = true;

        // If existing session uses a different profile, destroy context
        if (existingSession && existingSession.profileName !== resolvedProfileName) {
            await plugin.cleanup(taskId).catch(() => {});
            sessionManager.removeSession(taskId);
            removeSnapshotFiles(taskId);
        }

        // Load storage state (null = first use, graceful)
        const loaded = loadStorageState(resolvedProfileName);
        storageState = loaded ?? undefined;
    }
} else {
    // Named profile
    try {
        sanitizeProfileName(profileInput);
    } catch (err) {
        return {
            success: false,
            url: normalizedUrl,
            title: "",
            snapshot: "",
            elementCount: 0,
            error: `Invalid profile name: ${err instanceof Error ? err.message : String(err)}`,
            backendUsed: plugin.name,
        } as NavigateResult & { backendUsed: string; botDetectionWarning?: boolean };
    }
    resolvedProfileName = profileInput;
    profileMode = "named";
    persistState = true;

    // If existing session uses a different profile, switch
    if (existingSession && existingSession.profileName !== resolvedProfileName) {
        await plugin.cleanup(taskId).catch(() => {});
        sessionManager.removeSession(taskId);
        removeSnapshotFiles(taskId);
    }

    // For named profiles, try loading state. If a shared context already exists
    // in the plugin, the plugin will reuse it (ignoring storageState).
    const loaded = loadStorageState(resolvedProfileName);
    storageState = loaded ?? undefined;
}
```

**Update** `navigate()` call to plugin — pass `profileName`, `profileMode`:

```typescript
const navOptions: {
    signal?: AbortSignal;
    storageState?: unknown;
    profileName?: string;
    profileMode?: string;
    piSessionId?: string;
} = {};
if (options.signal) navOptions.signal = options.signal;
if (storageState !== undefined) navOptions.storageState = storageState;
if (resolvedProfileName) navOptions.profileName = resolvedProfileName;
if (profileMode) navOptions.profileMode = profileMode;
if (options.piSessionId) navOptions.piSessionId = options.piSessionId;
```

**Update** result fields — `profileMode` and `profileName` replace `sessionMode` and `profileName`.

**Update** `requireInteractiveSession()` — use `profile` field for auto-recovery.

**Remove** all lock acquire/release calls and imports from `profile-lock.ts`.

---

### 4.9 `index.ts`

- **Remove** `browser-cookies` tool registration entirely
- **Update** `browser-navigate` tool definition:
  - Replace `session` param with `profile` param:
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
  - Pass `piSessionId` to router via `NavigateOptions.piSessionId`
  - Map deprecated `session` param to `profile` with `console.warn`
  - Update output header:
    ```
    Profile: session (this conversation)
    Profile: work (shared)
    Profile: none
    ```
- **Update** TUI renderer for new `profileMode`/`profileName` fields
- **Update** `session_shutdown` handler — remove lock release calls

---

### 4.10 `browser-toggle.ts`

**Add new sub-commands:**

```
/web profile create <name>        Create a named profile (creates directory, optionally sets defaultProfile)
/web profile list [--all]         List profiles (hide _session- by default, show with --all)
/web profile clear <name>         Delete a profile's state
/web profile clear-all [--confirm] Delete all profile states
/web profile prune [--confirm]    Delete stale session profiles

/web cookies                      Show cookies for current session
/web cookies clear                Clear all cookies for current session
```

**Update `/web profile list`:**
- Filter out `_session-` profiles by default
- With `--all`, show session profiles with a `📋 session` badge
- Stale session profiles get `🗑️ stale` badge
- Named profiles with active shared contexts get `👥 shared` badge

**Update `/web` (no args) status:**
- Show current profile: `Profile: session (this conversation)` / `Profile: work (shared)` / `Profile: none`

**`/web profile create <name>` implementation:**
- Validates the name via `sanitizeProfileName()`
- Creates the profile directory and an empty `storage-state.json` with version headers
- Optionally accepts `--default` flag to set `browser.defaultProfile` in settings.json

**`/web profile prune` implementation:**
- Calls `pruneStaleSessionProfiles()` from `storage-state.ts`
- Without `--confirm`: shows count of stale profiles and their names
- With `--confirm`: deletes them all, reports results

**`/web cookies` implementation:**
- Requires an active browser session (checks `sessionManager.getActiveSessions()`)
- Calls `plugin.getCookies(taskId)` to retrieve cookies
- Formats them as a readable table: name, domain, path, expires, secure, httpOnly, sameSite

**`/web cookies clear` implementation:**
- Requires an active browser session
- Calls `plugin.clearCookies(taskId)` to clear all cookies
- Shows confirmation message

---

### 4.11 `core/plugin-config.ts`

- **Rename** `sessionDefault` → `defaultProfile` in `loadBrowserConfig()`
  - Keep `sessionDefault` as deprecated alias (mapped to `defaultProfile` with `console.warn`)
- **Update** validation — accept `"none"`, `"session"`, or a named profile string
- **Update** default: `"none"` (backward-compatible, same as current `"new"`)
- **Update** `defaultProfile` — previously `defaultProfile` pointed to a profile name; now it can be `"none"`, `"session"`, or a named profile

---

## 5. Settings.json Config

```json
{
  "browser": {
    "defaultProfile": "none",
    "profiles": {
      "work": { "persist": true },
      "shopping": { "persist": true }
    }
  }
}
```

- `defaultProfile`: `"none"` (default), `"session"`, or a named profile string
- When `"session"`, every conversation auto-persists cookies to its own `_session-` profile
- When a named profile, every conversation loads that profile and shares the BrowserContext
- Deprecated: `browser.sessionDefault` → mapped to `browser.defaultProfile`

---

## 6. `/web` Command Reference

```
/web                              Show status (tools, current profile)
/web on                           Enable browser tools
/web off                          Disable browser tools
/web learn                        Enable browsing + web-learn

/web profile                      List named profiles (hides session profiles)
/web profile list [--all]         List profiles (session profiles with --all)
/web profile create <name>       Create a named profile
/web profile clear <name>         Delete a profile's state
/web profile clear-all [--confirm] Delete all profile states
/web profile prune [--confirm]    Delete stale session profiles

/web cookies                      Show cookies for current session
/web cookies clear                Clear all cookies for current session
```

---

## 7. Migration / Deprecation

| Old | New | Notes |
|---|---|---|
| `session="new"` on `browser-navigate` | `profile="none"` | Maps internally, `console.warn` on first use |
| `session="last"` | `profile=<defaultProfile>` | Maps internally, `console.warn` on first use |
| `session="work"` | `profile="work"` | Maps internally, `console.warn` on first use |
| `browser.sessionDefault` in settings | `browser.defaultProfile` | Mapped with `console.warn` |
| `browser-cookies` tool | Removed | Use `/web cookies` command |
| `profile-lock.ts` | Deleted | No locks needed |
| `sessionMode` in `NavigateResult` | `profileMode` | Renamed, old field deprecated |

---

## 8. Test Updates

| Test file | Changes |
|---|---|
| **`router-session.test.ts`** → rename to `router-profile.test.ts` | Update all `session` → `profile` tests; add `profile="session"` tests; remove lock tests |
| **`router-cookies.test.ts`** | Remove (tool removed) |
| **`browser-toggle-profile.test.ts`** | Add `create`, `prune`, `cookies` sub-command tests; update `list --all` tests |
| **`plugin-config-browser.test.ts`** | Update `sessionDefault` → `defaultProfile` tests |
| **New: `shared-context.test.ts`** | Test shared context ref counting, multi-page same profile, cleanup on last page close, profile switching mid-conversation |
| **`plugin-contract.test.ts`** | Remove `browser-cookies` contract tests; update navigate contract for `profile` param |
| **`storage-state` unit tests** | Add `isSessionProfile`, `sessionProfileName`, `isSessionStale`, `pruneStaleSessionProfiles` tests |
| **New: `python-bridge-shared.test.ts`** | Test `browser.newPage`/`browser.closePage` RPC, shared context ref counting, cleanup |

---

## 9. Implementation Order

| Step | What | Files | Depends on |
|---|---|---|---|
| 1 | Storage-state session profile helpers + staleness + prune | `core/shared/storage-state.ts` | None |
| 2 | Add `piSessionId` to `BrowserSession` | `core/shared/session-manager.ts` | None |
| 3 | Replace `session` with `profile` in types | `core/plugin-api.ts` | None |
| 4 | `defaultProfile` setting | `core/plugin-config.ts` | None |
| 5 | Chromium shared context tracking + ref counting + cleanup | `backends/chromium/index.ts` | Steps 1-3 |
| 6 | Python adapter shared context support | `backends/python-adapter.ts` | Steps 1-3 |
| 7 | Python bridge shared context RPC methods | `backends/chromium-py/bridge.py` | Step 6 |
| 8 | Profile resolution logic, remove locks | `core/router.ts` | Steps 1-5 |
| 9 | Remove `browser-cookies` tool, update `browser-navigate` | `index.ts` | Steps 3, 8 |
| 10 | Add `/web` sub-commands (create, prune, cookies) | `browser-toggle.ts` | Steps 1, 8 |
| 11 | Delete `profile-lock.ts` | `core/shared/profile-lock.ts` | Step 8 (all references removed) |
| 12 | Update mock plugin for new interface | `__tests__/helpers/mock-plugin.ts` | Steps 3, 5 |
| 13 | Tests | Various | Steps 1-12 |

---

## 10. Key Design Decisions

### 10.1 Why no locks?

Playwright's `BrowserContext` is thread-safe for concurrent page operations. When two subagents share a named profile, they share one `BrowserContext` with separate `Page` objects — exactly like tabs in a real browser. Playwright serializes cookie jar access internally. There is no last-writer-wins problem because there is only one jar.

### 10.2 Why session profiles are still per-context

Session profiles (`_session-<piSessionId>`) are per-conversation, not per-profile. Each subagent has a different `piSessionId`, so each gets its own BrowserContext. This prevents cookie leakage between unrelated subagents. If you want cookie sharing, use a named profile.

### 10.3 Why no auto-cleanup for session profiles

Users may want to resume old conversations. Deleting cookies on their behalf would violate the principle of user control. Instead, we provide lazy staleness detection via `/web profile prune` so users can clean up when they choose.

### 10.4 Why `profile` instead of `session`

The word "session" is overloaded — it means pi session, Playwright session, browser session, cookie session. "Profile" maps directly to the browser concept (Firefox profiles, Chrome profiles) and clearly communicates "a named cookie jar."

### 10.5 Why `/web cookies` is a command, not a tool

Cookie management should be user-initiated, not agent-initiated. The agent's primary cookie need (persistence across conversations) is handled by the `profile` parameter. Inspection and clearing are debugging tasks best left to the user via commands, reducing the agent's context complexity by one tool.

### 10.6 Python bridge parity is required

Both backends (Chromium and chromium-py) must support the shared context model. The Python bridge gets `browser.newPage` and `browser.closePage` RPC methods alongside the existing `browser.navigate` and `browser.cleanup`. The adapter tracks shared context ref counts on the TypeScript side, mirroring the Chromium plugin's `_sharedContexts` map.
