# Cookie Integration Design Analysis

## 1. Playwright Cookie Capabilities (Both Backends)

Both the TypeScript (Chromium) and Python (chromium-py) backends have **full Playwright cookie support** available — it's simply not wired up today.

### TypeScript (Playwright Node.js)

| API | Signature | Purpose |
|-----|-----------|---------|
| `context.cookies([urls])` | `Promise<Array<Cookie>>` | Get all cookies, or filtered by URL |
| `context.addCookies(cookies)` | `Promise<void>` | Inject cookies into the context |
| `context.clearCookies([options])` | `Promise<void>` | Remove cookies (with optional name/domain/path filter) |
| `context.storageState([options])` | `Promise<{cookies, origins}>` | Snapshot full state (cookies + localStorage + IndexedDB) |
| `newContext({ storageState })` | constructor option | Initialize a new context with saved state |

### Python (Playwright Python)

| API | Signature | Purpose |
|-----|-----------|---------|
| `context.cookies([urls])` | `List[Cookie]` | Get all cookies, or filtered by URL |
| `context.add_cookies(cookies)` | `None` | Inject cookies into the context |
| `context.clear_cookies([options])` | `None` | Remove cookies (with optional name/domain/path filter) |
| `context.storage_state([options])` | `Dict` | Snapshot full state (cookies + localStorage + IndexedDB) |
| `browser.new_context(storage_state=...)` | constructor option | Initialize a new context with saved state |

The cookie shape is identical across both APIs:

```typescript
{
  name: string,
  value: string,
  domain: string,    // e.g. ".example.com" for all subdomains
  path: string,      // e.g. "/"
  expires: number,    // Unix timestamp in seconds
  httpOnly: boolean,
  secure: boolean,
  sameSite: "Strict" | "Lax" | "None"
}
```

**Key insight**: Playwright's `storageState()` / `setStorageState()` APIs are more powerful than just cookies — they also capture `localStorage` and `IndexedDB`. This is critical for sites that store auth tokens in localStorage (e.g., Firebase Auth, JWT-based SPAs).

---

## 2. Current Session Architecture

Understanding the current session model is essential before designing cookie persistence.

### How Sessions Work Today

```
pi session (conversation)
  └── piSessionId (stable for the conversation lifetime)
        └── taskId = "browser-N" (1:1 mapping via _sessionKeys)
              └── BrowserContext (Playwright, created on first navigate)
                    └── Page (single tab per context)
```

**Key facts:**
- `taskId` is derived from `piSessionId` — one taskId per pi session
- A `BrowserContext` is created on first `browser-navigate` and reused for the rest of the pi session
- The context is destroyed on `session_shutdown` (end of conversation) or browser crash
- Within a single pi session, the same Playwright `BrowserContext` persists across multiple navigations and interactions
- `lastNav` stores the last URL for auto-recovery if the context crashes

### What "Handoff to User" Means

The current architecture means:

1. **Within a single pi session**: cookies ARE preserved between navigations. If the agent navigates to `site.com`, accepts cookies, then navigates to `site.com/page2`, the cookies persist — they're in the same BrowserContext.

2. **Between pi sessions**: cookies are LOST. Each new conversation starts with a fresh BrowserContext. This is the core problem — if the user leaves a chat and comes back, they get a completely clean browser.

3. **Browser crash/restart**: cookies are lost (context is recreated from scratch via `lastNav` URL, but no cookie state is restored).

### Critical: The Cleanup Lifecycle

The auto-save hook must be placed carefully. The current shutdown flow is:

```
session_shutdown event (index.ts:1604)
  → for each plugin: plugin.cleanupAll()
    → for each taskId: plugin.cleanup(taskId)   ← ChromiumPlugin.cleanup()
      → context.tracing.stop()                    (if BROWSER_TRACE_DIR set)
      → page.close()                             ← context still alive here
      → context.close()                          ← context is NOW dead
    → browser.close()
  → sessionManager.removeAll()
```

**Once `context.close()` is called, `context.storageState()` will throw.** The auto-save must happen *before* `page.close()` / `context.close()` — i.e., as the first step of `cleanup(taskId)` for sessions that have `persistState: true`. See §9.1 for the design.

---

## 3. The Session Continuity Problem

Every new conversation starts with a blank cookie jar, which means:

- Cookie consent dialogs re-appear on every conversation
- Login sessions are lost between conversations
- Site preferences (language, theme, etc.) reset
- Any site that requires authentication must be re-authenticated from scratch

### The Fundamental Tension

| Goal | Implication |
|------|------------|
| **Clean state** (privacy, predictability) | Fresh context each time, no cookie leakage |
| **Session continuity** (convenience, efficiency) | Persist cookies across conversations |

The right answer is **both**, with the user (or agent) in control.

---

## 4. Design Options

### Option A: Storage State Persistence

**Core idea**: When a session ends, save `storageState()` to disk. When a new session starts for the same domain/user, restore it via `newContext({ storageState })`.

**Pros:** Captures cookies + localStorage + IndexedDB; Playwright-native; works in both backends.
**Cons:** Security surface (plaintext auth tokens on disk); needs a profile concept.

### Option B: Cookie-Only Tools

**Core idea**: Add `browser-cookies` tool that lets the agent read/write/clear cookies. No automatic persistence.

**Pros:** Simple, minimal surface area, agent has full control, no disk security concerns.
**Cons:** Agent must manually manage cookie lifecycle; doesn't capture localStorage/IndexedDB; doesn't solve the "cookie consent every time" problem automatically.

### Option C: Hybrid — Profiles + Tools (Chosen)

**Core idea**: Combine profile-based storage state persistence with explicit cookie management tools.

1. **Named browser profiles** — storage state files persisted to disk
2. **Profile persistence** — auto-save on session end, auto-restore on session start
3. **Cookie tools** — `browser-cookies get/set/clear` for manual control
4. **Session argument** — `browser-navigate session="new"` vs `session="last"` (or a profile name)

---

## 5. Recommended Design: Option C (Hybrid)

### 5.1 Browser Profiles

A **profile** is a named storage state (cookies + localStorage + IndexedDB) persisted to disk at `~/.pi/agent/browser-state/`:

```
~/.pi/agent/browser-state/
├── default/
│   └── storage-state.json    # Auto-saved on session end
├── shopping/
│   └── storage-state.json    # Named profile for e-commerce
└── work/
    └── storage-state.json    # Named profile for work sites
```

**Configuration** in `settings.json`:
```json
{
  "browser": {
    "sessionDefault": "new",
    "profiles": {
      "default": { "persist": true },
      "shopping": { "persist": true },
      "work": { "persist": true }
    },
    "defaultProfile": "default"
  }
}
```

- `sessionDefault`: `"new"` (clean slate) or `"last"` (restore state). **Default: `"new"`** for backward compatibility. Controls the default when `browser-navigate` omits the `session` parameter.
- `defaultProfile`: Which profile to use for `session="last"`. Default: `"default"`.

### 5.2 Session Argument on `browser-navigate`

Add an optional `session` parameter to `browser-navigate`:

```
session: "new"           → Fresh context, no stored state, NOT saved on exit [default]
session: "last"          → Resume last session (restore storageState)
session: "default"       → Load the "default" profile's storageState
session: "shopping"      → Load the "shopping" profile's storageState
```

**Behavior matrix:**

| `session` value | Context creation | Storage state | On session end |
|-----------------|-----------------|---------------|----------------|
| `"new"` (default) | Fresh BrowserContext | Empty | State is discarded |
| `"last"` | Reuse if exists, else restore from `default` profile on disk | Last session's state | Auto-save to `default` profile |
| `"profile-name"` | Fresh BrowserContext with profile state | Profile's stored state | Auto-save to that profile |

**Critical: `session="new"` on an existing context must destroy & recreate.** If a task already has a `BrowserContext` and the agent calls `browser-navigate(url, session="new")`, the old context must be closed and a fresh one created. Simply navigating within the existing context would leave stale cookies/localStorage in place. See §9.2 for implementation details.

### 5.3 New Plugin Methods

Add to `BrowserPlugin` interface:

```typescript
// Cookie management
getCookies(taskId: string, urls?: string[]): Promise<CookieResult>;
addCookies(taskId: string, cookies: Cookie[]): Promise<ResultBase>;
clearCookies(taskId: string, options?: ClearCookiesOptions): Promise<ResultBase>;

// Storage state management
getStorageState(taskId: string): Promise<StorageStateResult>;
```

Where:
```typescript
interface Cookie {
  name: string;
  value: string;
  domain?: string;      // Optional in Playwright's addCookies, required in cookies() output
  path?: string;        // Optional in addCookies, required in output
  expires?: number;     // Unix timestamp in seconds; -1 for session cookies
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";  // Optional — undefined means browser default (Lax)
}

interface CookieResult extends ResultBase {
  cookies: Cookie[];
}

interface ClearCookiesOptions {
  name?: string;
  domain?: string;
  path?: string;
}
// Note: calling clearCookies() with no options clears ALL cookies (Playwright default)

interface StorageStateResult extends ResultBase {
  cookies: Cookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}
```

**Cookie field optionality note**: Playwright's `addCookies()` requires `name`, `value`, `domain`, `path`. Its `cookies()` output always includes all fields including `sameSite`. The `Cookie` interface above uses optional fields to accommodate both directions — when adding cookies, `domain` and `path` are effectively required (Playwright will error without them); when reading cookies, all fields are always populated.

### 5.4 New Agent-Facing Tools

#### `browser-cookies`

```
browser-cookies action="get" [urls=...]          → List cookies (all, or filtered by URL)
browser-cookies action="set" cookies=[...]        → Add cookies
browser-cookies action="clear" [name=...] [domain=...] [path=...] → Clear cookies (all, or filtered)
```

#### `browser-navigate` (enhanced)

```
browser-navigate url="..." session="new"     → Clean slate [default]
browser-navigate url="..." session="last"    → Resume/restore last session
browser-navigate url="..." session="work"    → Load named profile
```

---

## 6. Session Lifecycle with Profiles

### Flow: First Visit (session="new", the default)

```
1. Agent calls browser-navigate(url) — session defaults to "new"
2. No stored state loaded → create fresh BrowserContext
3. Site presents cookie consent dialog
4. Agent dismisses consent → cookies are set in the BrowserContext
5. Agent continues browsing...
6. Pi session ends → state is discarded (persistState is false)
```

### Flow: Return Visit (session="last")

```
1. Agent calls browser-navigate(url, session="last")
2. Stored state exists at default/storage-state.json
3. Create BrowserContext with { storageState: loadedState }
4. Site recognizes prior consent → no dialog
5. Agent continues seamlessly...
6. Pi session ends → auto-save to default/storage-state.json
```

### Flow: Clean Visit (session="new", explicit)

```
1. Agent calls browser-navigate(url, session="new")
2. Fresh BrowserContext, no stored state loaded
3. State is NOT saved on exit (ephemeral)
```

### Flow: Named Profile

```
1. Agent calls browser-navigate(url, session="work")
2. Load storage-state from work/storage-state.json
3. Agent logs into internal tools → auth cookies set
4. Pi session ends → auto-save to work/storage-state.json
5. Next time: agent uses session="work" → still logged in
```

### Flow: Switching session mode mid-conversation

```
1. Agent has been browsing with session="last" (cookies accumulated)
2. Agent calls browser-navigate(url, session="new")
3. Old BrowserContext is closed (cookies lost)
4. New BrowserContext created with no stored state
5. If agent calls browser-navigate(url, session="last") again later:
   → Another new BrowserContext created, this time loading from default/storage-state.json
   → (The auto-save from the first session already wrote to disk on cleanup)
```

**Note on context destruction**: Switching `session` modes destroys the existing `BrowserContext` for that task. Any `@e` refs from the old context become invalid. The agent should expect a fresh accessibility tree after switching.

---

## 7. Implementation Plan

### Phase 1: Cookie Tools (Minimal, Unblocks Immediately)

- Add `getCookies`, `addCookies`, `clearCookies` to `BrowserPlugin` interface
- Implement in ChromiumPlugin (direct Playwright calls)
- Implement in PythonPluginAdapter (JSON-RPC to bridge.py)
- Add bridge.py handlers for the 3 new operations
- Add `browser-cookies` tool to index.ts
- Wire through router.ts

**Effort**: ~250-350 lines across plugin-api.ts, chromium/index.ts, python-adapter.ts, bridge.py, router.ts, index.ts

**Tests needed**: cookie CRUD via plugin contract, router dispatch, tool parameter validation

### Phase 2: Storage State Persistence

- Add `getStorageState` to `BrowserPlugin` interface
- Create `core/shared/storage-state.ts` for file I/O (read/write storage-state JSON)
- Create `core/shared/profile-lock.ts` for advisory locking (see §10)
- Add `persistState` and `profileName` fields to `BrowserSession` in session-manager.ts
- Modify `ChromiumPlugin.cleanup()` to call `getStorageState()` and save before closing the context
- Modify `ChromiumPlugin.getOrCreateContext()` to accept a `storageState` option and pass it to `newContext()`
- Add `session` parameter to `router.ts navigate()` and `NavigateOptions`
- Add `session` parameter to `browser-navigate` tool in `index.ts`
- Handle `session="new"` on existing context: close old context, create new one
- Wire PythonPluginAdapter through JSON-RPC (`browser.getStorageState`, `session` param on navigate)
- Update bridge.py to handle `storageState` on context creation and `getStorageState` operation
- Auto-save on cleanup; auto-restore on context creation; graceful fallback when no state file exists

**Effort**: ~600-800 lines (higher than initial estimate due to: session-manager type changes, lock file module, storage-state I/O module, config reading, Python bridge protocol updates, context destruction/recreation logic, and tests)

**Tests needed**: storage state save/restore round-trip, profile lock contention, session="new" destroys existing context, missing state file graceful fallback, Python bridge parity

### Phase 3: Named Profiles

- Profile configuration in `settings.json` (`browser.profiles` section)
- Profile list/status display via `/browser-status` or `/web profile` command
- Profile validation (name conflicts, invalid characters)
- Default profile creation on first use with `session="last"`

**Effort**: ~250-350 lines

**Tests needed**: profile CRUD, config parsing, multiple profile isolation

---

## 8. Security Considerations

1. **Plaintext storage**: `storage-state.json` contains auth tokens in plaintext. Mitigation: file permissions (0600 on the profile directory and all files within), document the risk in the extension's README.

2. **Cross-contamination**: Named profiles prevent mixing work/personal cookies. Each profile writes to a separate directory.

3. **Stale tokens**: Expired cookies are harmless (browsers ignore them), but localStorage tokens may persist indefinitely. Users can clear via `browser-cookies action="clear"` (which also clears cookies) or by deleting the profile directory. Consider adding a `/web clear-state` command in Phase 3.

4. **SSRF protection**: Cookies are domain-scoped by Playwright — you can't inject a cookie for `example.com` and have it sent to `evil.com`. Playwright enforces this at the network level.

5. **Secret detection in stored state**: Future consideration (not Phase 1 or 2). Could extend `url-safety.ts` heuristics to scan `storageState` files for common token patterns (AWS keys, JWTs, etc.) and warn before saving. This is scope creep for the initial implementation.

---

## 9. Design Decisions

### 9.1 Default session behavior: `session="new"` (backward-compatible)

**Decision**: The default value for the `session` parameter is `"new"`. When `browser.sessionDefault` is not set in `settings.json`, the behavior is identical to today — every conversation starts with a clean BrowserContext.

**Rationale**: Changing the default to `"last"` would be a silent behavioral change. Existing users who expect clean state on every conversation would suddenly get stale cookies, potentially leaking state between conversations they assumed were isolated. Opt-in via `settings.json` or explicit `session="last"` is safer.

```json
// To opt into session continuity:
{
  "browser": {
    "sessionDefault": "last"
  }
}
```

### 9.2 `session="new"` on an existing context: destroy & recreate

**Decision**: If a task already has a `BrowserContext` and the agent calls `browser-navigate(url, session="new")`, the old context is closed and a brand-new one is created with no stored state.

**Rationale**: Simply navigating within the existing context (option B from review) would leave stale cookies, localStorage, and service workers in place — defeating the user's expectation of a "fresh session." The destroy-and-recreate approach is more expensive but semantically correct. The old `@e` refs become invalid; the agent gets a fresh accessibility tree.

**Implementation**: In `ChromiumPlugin.getOrCreateContext()`, when `session="new"` is requested for a task that already has a context:
1. Save tracing (if active)
2. Close the old page and context
3. Clear element cache
4. Create a new context with no `storageState`
5. Return `{ context, page, isNew: true }`

The router must also clear the snapshot cache and reset the session's `cachePopulatedAt` / `lastInteractionAt` timestamps.

### 9.3 Auto-save happens in `cleanup()`, not `session_shutdown`

**Decision**: Storage state is auto-saved as the first step of `ChromiumPlugin.cleanup(taskId)`, before `page.close()` / `context.close()`.

**Rationale**: The shutdown flow is:
```
session_shutdown → plugin.cleanupAll() → plugin.cleanup(taskId)
  → context.tracing.stop()
  → page.close()          ← context still alive
  → context.close()       ← context is NOW dead
```

Once `context.close()` is called, `context.storageState()` throws. The auto-save must happen before `page.close()`. The `cleanup()` method is the right place because it's the single point where the context is torn down, regardless of whether it's triggered by session_shutdown, crash recovery, or explicit cleanup.

**Implementation**: Add a `persistState: boolean` field to `BrowserSession`. Set it during `navigate()` based on the `session` parameter. In `cleanup()`, check this flag before closing the context:

```typescript
async cleanup(taskId: string): Promise<void> {
    const entry = this._contexts.get(taskId);
    if (entry) {
        // Auto-save storage state if session is persistent
        const session = sessionManager.getSession(taskId);
        if (session?.persistState) {
            try {
                const state = await entry.context.storageState();
                await saveStorageState(session.profileName ?? "default", state);
            } catch {
                // Best-effort — don't block cleanup on save failure
            }
        }

        // ... existing tracing/closing logic ...
    }
}
```

### 9.4 Profile storage location: `~/.pi/agent/browser-state/`

**Decision**: Stored alongside `settings.json` at `~/.pi/agent/browser-state/<profile>/storage-state.json`.

**Rationale**: Simple, discoverable, consistent with pi's existing convention of storing config and state under `~/.pi/agent/`. Not XDG-compliant, but pi already uses `~/.pi/agent/` for everything else, so this is the path of least surprise.

### 9.5 No expiration on stored state

**Decision**: Stored state persists indefinitely until explicitly cleared. No TTL, no auto-expiry.

**Rationale**: Users who want a clean slate use `session="new"` or `browser-cookies action="clear"`. Adding expiration would add complexity (cron jobs, timestamp checks) for unclear benefit — expired cookies are already ignored by the browser, and localStorage tokens that expire are a site-level concern.

### 9.6 No cookie support for `web-fetch`

**Decision**: The `web-fetch` backend stays purely stateless. If cookies are needed, the agent must use `browser-navigate` with an appropriate session mode.

**Rationale**: `web-fetch` uses plain `fetch()` — no browser, no Playwright context, no cookie jar. Adding cookie state would require either a custom cookie header injection (fragile, doesn't handle `Set-Cookie`) or a full browser context (defeating the purpose of the stateless path).

### 9.7 Python bridge parity

**Decision**: Required. Phase 1 adds `browser.getCookies`, `browser.addCookies`, `browser.clearCookies` as JSON-RPC methods in `bridge.py`. Phase 2 adds `browser.getStorageState` and the `session` / `storageState` parameters on `browser.navigate`.

### 9.8 Graceful fallback when no state file exists

**Decision**: If `session="last"` or `session="profile-name"` is requested but no `storage-state.json` exists for that profile, create a fresh BrowserContext with no stored state. This is not an error — it's the expected case on first use.

**Rationale**: The first time anyone uses `session="last"`, there is no saved state. This should "just work" rather than requiring the agent to handle a special "no state file" error.

---

## 10. Parallel Sessions & Profile Write Safety

### Existing isolation is solid

The current architecture already isolates parallel sessions correctly. Each `taskId` gets its own Playwright `BrowserContext`, and `BrowserContext` is Playwright's isolation boundary:

- Separate cookie jar
- Separate localStorage / sessionStorage / IndexedDB
- Separate network cache
- Separate set of pages

This is enforced by `ChromiumPlugin._contexts`:

```typescript
private _contexts = new Map<string, { context: BrowserContext; page: Page }>();
//                         ↑ taskId        ↑ completely independent per task
```

Two concurrent subagents with different `piSessionId` values get different `taskId` values (`browser-1`, `browser-2`, …) and never share a `BrowserContext`. Cookie persistence does not change this — a profile is loaded *into* a context at creation, and saved *from* a context at teardown. During a session, cookies are isolated.

### The problem: concurrent writes to the same profile file

The edge case is **two parallel sessions loading the same named profile, then both saving back on exit**. Since each session gets its own `BrowserContext` initialized from the same `storage-state.json`, they diverge during their lifetimes. When both sessions end and try to auto-save:

1. Session A saves its state → `storage-state.json` reflects A's cookies
2. Session B saves its state → `storage-state.json` is overwritten with B's cookies
3. A's cookies are lost from the persisted file

This is the classic "last writer wins" problem.

### Solution: Advisory lock with atomic creation

The profile lock uses `mkdir` as an atomic creation primitive (POSIX guarantees `mkdir` is atomic — it either succeeds as the sole creator, or fails if the directory already exists). This avoids the check-then-act race condition that a file-based lock would have.

**Lock contents**: A JSON file inside the lock directory with PID + taskId + timestamp. Used for diagnostics and staleness detection (not for atomicity — that's handled by `mkdir`).

**Staleness**: Two fallbacks for stale locks:
1. **PID liveness check**: `process.kill(pid, 0)` — works for same-machine, same-user processes
2. **Timestamp-based staleness**: If the lock is older than 1 hour, steal it regardless. This handles cross-container scenarios where PID checks are unreliable.

### Summary matrix

| Scenario | Profile isolation | Cookie isolation | Write conflict? | Behavior |
|----------|------------------|-----------------|----------------|----------|
| Two sessions, different profiles | Different files | Different BrowserContexts | No | Both save independently |
| Two sessions, same profile | Same file | Different BrowserContexts | **Yes** | Advisory lock prevents second load; falls back to `session="new"` |
| Two sessions, both `session="new"` | No file | Different BrowserContexts | No | Neither saves |
| One session, `session="last"` | `default/storage-state.json` | One BrowserContext | No | Normal save on exit |

### Lock file implementation sketch

```typescript
// core/shared/profile-lock.ts
import { mkdirSync, writeFileSync, rmdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOCK_DIR = ".lock";

interface LockInfo {
  pid: number;
  taskId: string;
  acquiredAt: number;  // Date.now()
}

/** How old a lock can be before we steal it (1 hour). */
const STALE_LOCK_MS = 60 * 60 * 1000;

function lockDir(profileDir: string): string {
  return join(profileDir, LOCK_DIR);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);  // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to acquire an advisory lock on a profile directory.
 *
 * Uses mkdir as the atomic creation primitive — POSIX guarantees mkdir
 * either succeeds as the sole creator, or fails if the directory exists.
 * This avoids the check-then-act race condition of file-based locks.
 *
 * Returns true if the lock was acquired, false if it's held by another
 * active session. Stale locks (process dead or older than STALE_LOCK_MS)
 * are stolen automatically.
 */
export function acquireProfileLock(profileDir: string, taskId: string): boolean {
  mkdirSync(profileDir, { recursive: true });
  const ld = lockDir(profileDir);

  // Try atomic mkdir
  try {
    mkdirSync(ld);
    // We got it — write metadata for diagnostics
    const info: LockInfo = { pid: process.pid, taskId, acquiredAt: Date.now() };
    writeFileSync(join(ld, "info.json"), JSON.stringify(info), { mode: 0o600 });
    return true;
  } catch {
    // Directory exists — check if the lock is stale
  }

  // Lock exists — read metadata and check staleness
  try {
    const infoPath = join(ld, "info.json");
    if (!existsSync(infoPath)) {
      // No metadata — steal the lock (directory exists but no info file;
      // likely from a crash during lock acquisition)
      const info: LockInfo = { pid: process.pid, taskId, acquiredAt: Date.now() };
      writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 });
      return true;
    }

    const existing: LockInfo = JSON.parse(readFileSync(infoPath, "utf-8"));

    // Same task — re-acquisition (e.g. after crash recovery)
    if (existing.taskId === taskId) {
      // Update timestamp
      const info: LockInfo = { pid: process.pid, taskId, acquiredAt: Date.now() };
      writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 });
      return true;
    }

    // Different task — check if the holder is still alive
    const age = Date.now() - existing.acquiredAt;
    const processAlive = isProcessAlive(existing.pid);

    if (!processAlive || age > STALE_LOCK_MS) {
      // Stale lock — steal it
      const info: LockInfo = { pid: process.pid, taskId, acquiredAt: Date.now() };
      writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 });
      return true;
    }

    // Lock is held by an active session — fail
    return false;
  } catch {
    // Can't read metadata — assume lock is held
    return false;
  }
}

/**
 * Release an advisory lock on a profile directory.
 * Only releases if the lock belongs to the given taskId.
 */
export function releaseProfileLock(profileDir: string, taskId: string): void {
  const ld = lockDir(profileDir);
  try {
    const infoPath = join(ld, "info.json");
    if (existsSync(infoPath)) {
      const existing: LockInfo = JSON.parse(readFileSync(infoPath, "utf-8"));
      if (existing.taskId === taskId) {
        // Remove lock directory and its contents
        try { rmdirSync(ld, { recursive: true }); } catch { /* best-effort */ }
      }
    }
  } catch {
    /* best-effort */
  }
}
```

The lock is checked in `browser-navigate` when `session` resolves to a named profile, and released in `cleanup()` after the storage state is saved. If acquisition fails, the router returns an error and the agent can retry with `session="new"`.

---

## 11. Review Findings & Open Issues

This section documents issues discovered during code review that must be addressed during implementation.

### 11.1 Auto-save timing (CRITICAL)

**Issue**: The plan originally suggested hooking auto-save into the `session_shutdown` event. But `session_shutdown` fires `plugin.cleanupAll()`, which calls `cleanup(taskId)`, which closes the context. Once `context.close()` is called, `context.storageState()` throws.

**Resolution**: Auto-save must happen as the first step of `cleanup(taskId)`, before `page.close()` / `context.close()`. See §9.3.

### 11.2 Lock file race condition (CRITICAL)

**Issue**: The original lock file sketch used `existsSync` → `readFileSync` → `writeFileSync`, which is a classic check-then-act race condition. Two processes could both observe "no lock file" simultaneously and both write one.

**Resolution**: Use `mkdir` as the atomic creation primitive. POSIX guarantees `mkdir` is atomic — it either succeeds as the sole creator or fails if the directory exists. See §10 for the updated implementation.

### 11.3 `session="new"` on existing context (CRITICAL)

**Issue**: The current `getOrCreateContext()` reuses the existing context for a given `taskId`. If the agent calls `browser-navigate(url, session="new")` on a task that already has a context, the existing context would be reused — old cookies would still be present.

**Resolution**: `session="new"` must close the old context and create a new one. This is a destroy-and-recreate operation. See §9.2.

### 11.4 `persistState` flag needs a home

**Issue**: `cleanup()` needs to know whether to auto-save, but it doesn't currently have access to the `session` parameter that was passed during `navigate()`.

**Resolution**: Add `persistState: boolean` and `profileName?: string` fields to `BrowserSession` in `session-manager.ts`. Set them during `navigate()` based on the `session` parameter. Read them in `cleanup()` to decide whether to save.

### 11.5 Cookie interface optionality

**Issue**: The original plan had all `Cookie` fields as required. But Playwright's `addCookies()` makes `domain` and `path` optional (though they're effectively required — Playwright errors without them). The `sameSite` field defaults to the browser's Lax policy when not set.

**Resolution**: Match Playwright's interface exactly — make `domain`, `path`, `expires`, `httpOnly`, `secure`, and `sameSite` optional in the TypeScript interface. Document that `domain` and `path` are effectively required when calling `addCookies`.

### 11.6 `clearCookies()` with no options clears all

**Issue**: The plan doesn't document the default behavior of `browser-cookies action="clear"` with no filter parameters.

**Resolution**: Calling `clearCookies()` with no `ClearCookiesOptions` clears ALL cookies in the context. This matches Playwright's default behavior and should be documented in the tool description.

### 11.7 Line count estimates revised upward

**Issue**: Phase 2 was estimated at 400-500 lines. This doesn't account for: session-manager type changes, lock file module, storage-state I/O module, config reading for `browser.sessionDefault`, updating `getOrCreateContext()` to accept `storageState`, context destruction/recreation logic for `session="new"`, Python bridge protocol updates (new parameter on navigate, new `getStorageState` operation), and tests.

**Resolution**: Revised estimate to 600-800 lines for Phase 2. See §7.

### 11.8 `process.kill(pid, 0)` doesn't work cross-container

**Issue**: The PID liveness check doesn't work when pi and the browser run in different containers, or when the locking process runs as a different user.

**Resolution**: Added a timestamp-based staleness fallback. If a lock is older than 1 hour, it's stolen regardless of PID liveness. This is a conservative heuristic — if the lock holder is still alive but slow, it'll lose its lock after 1 hour. For the single-machine, single-user case (the common pi deployment), PID checks work fine. See §10.

### 11.9 No migration path for existing sessions

**Issue**: If a user updates pi and `browser-state/default/storage-state.json` doesn't exist yet, the first `session="last"` navigate should gracefully fall back to a fresh context.

**Resolution**: This is already handled by the design — missing state files are not an error, they're the expected case on first use. See §9.8.

### 11.10 `@e` ref invalidation on session switch

**Issue**: Switching `session` modes destroys the existing `BrowserContext`, which invalidates all `@e` refs the agent may be holding.

**Resolution**: Document this in the tool description. The `browser-navigate` return value always includes a fresh accessibility tree, so the agent gets new refs immediately. But it should be warned not to use refs from before the session switch.

### 11.11 Python bridge `storageState` on context creation

**Issue**: The Python bridge creates Playwright contexts via `browser.new_context()`. Currently it passes no `storage_state` parameter. Phase 2 needs to thread the `storageState` parameter through the JSON-RPC `browser.navigate` method.

**Resolution**: Add a `storageState` field to the `browser.navigate` JSON-RPC params. The bridge reads the state from disk (or receives it inline) and passes it to `browser.new_context(storage_state=...)`. The bridge also needs a new `browser.getStorageState` method that calls `context.storage_state()` and returns the result.

**Design choice**: Should the storage state be sent inline in the JSON-RPC request, or should the bridge read it from disk? Sending it inline avoids path coordination but can be large (storage state includes all localStorage entries). Having the bridge read from disk requires the bridge to know the profile directory path. **Recommendation**: Send it inline. Storage state files are typically small (< 100KB), and the bridge shouldn't need to know about the pi agent's directory structure.

---

## 12. Additional Findings from Code Review

This section documents issues discovered by tracing the full source code paths that weren't caught in the initial doc review.

### 12.1 Profile name sanitization (SECURITY)

**Issue**: The doc doesn't discuss sanitizing profile names for filesystem use. A profile name like `"../../etc/passwd"` could escape the `browser-state/` directory via path traversal. Even without malicious intent, names containing slashes, null bytes, or unicode characters could cause filesystem errors.

**Resolution**: Validate profile names before constructing filesystem paths. Enforce a strict allowlist:

```typescript
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function sanitizeProfileName(name: string): string {
    if (!PROFILE_NAME_RE.test(name)) {
        throw new Error(
            `Invalid profile name '${name}'. ` +
            `Profile names must be 1-64 characters, alphanumeric, hyphens, and underscores only.`
        );
    }
    return name;
}
```

This goes in `core/shared/storage-state.ts` and is called whenever a profile name is used to construct a path. The reserved keywords `"new"` and `"last"` should also be rejected as profile names (they're session modes, not profiles).

### 12.2 Reserved keywords: `"new"` and `"last"` are not profile names

**Issue**: The `session` parameter accepts `"new"`, `"last"`, and profile names. But what if a user creates a profile named `"new"` or `"last"`? The doc doesn't address this ambiguity.

**Resolution**: `"new"` and `"last"` are reserved session mode keywords and cannot be used as profile names. The `sanitizeProfileName()` function above should reject them, and the settings.json validation should reject profile configs with these names.

For `session="last"`, the resolution logic is:
1. `"new"` → fresh context, no persistence
2. `"last"` → load from the `default` profile (if `browser.defaultProfile` is unset, or whatever `defaultProfile` specifies)
3. Any other string → load from that named profile

This means `session="last"` and `session="default"` are equivalent when `defaultProfile` is `"default"`. The `"last"` keyword is a convenience alias for "whatever my default profile is."

### 12.3 Auto-recovery must also restore profile state

**Issue**: The router's `requireInteractiveSession()` function (router.ts:86) auto-creates sessions by re-navigating to the `lastNav` URL when a session has crashed or been lost. Currently this calls `plugin.navigate(lastNav.url, taskId, 30_000)` with no `storageState`. After profiles are implemented, this auto-recovery should also restore the profile's storage state — otherwise the recovered session has no cookies.

**Resolution**: The `lastNav` storage in `session-manager.ts` needs to include the `profileName` (or `persistState`) that was active when the navigation occurred. When `requireInteractiveSession()` auto-recovers, it should pass this information to `plugin.navigate()` so the new context is created with the correct `storageState`.

Add to `LastNavEntry`:
```typescript
interface LastNavEntry {
    url: string;
    title: string;
    pluginName: string;
    profileName?: string;  // NEW: which profile was active
}
```

When auto-recovering in `requireInteractiveSession()`:
```typescript
const navOptions: { storageState?: ... } = {};
if (lastNav.profileName) {
    navOptions.storageState = await loadStorageState(lastNav.profileName);
}
const navResult = await plugin.navigate(lastNav.url, taskId, 30_000, navOptions);
```

### 12.4 `BrowserPlugin.navigate()` signature must accept `storageState`

**Issue**: The current `navigate()` signature is:
```typescript
navigate(url: string, taskId: string, timeoutMs: number, options?: { signal?: AbortSignal }): Promise<NavigateResult>;
```

The doc says `session` goes on `browser-navigate` and flows through the router, but doesn't specify how `storageState` reaches the plugin's `getOrCreateContext()`. The router calls `plugin.navigate()`, which internally calls `getOrCreateContext()`. The `storageState` must be threaded through.

**Resolution**: Extend the `options` parameter on `navigate()`:
```typescript
navigate(
    url: string,
    taskId: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal; storageState?: PlaywrightStorageState },
): Promise<NavigateResult>;
```

The `storageState` option is passed through to `getOrCreateContext()`, which passes it to `this._browser.newContext({ storageState, ... })`. This is a non-breaking change — the option is optional, and existing callers that don't pass it continue to work.

For the Python adapter, the `storageState` is serialized and sent as a JSON-RPC param in `browser.navigate`.

### 12.5 `NavigateOptions` in router.ts needs the `session` field

**Issue**: The router's `NavigateOptions` type currently is:
```typescript
export interface NavigateOptions {
    strategy?: string;
    timeout?: number;
    signal?: AbortSignal;
    taskId?: string;
}
```

It needs a `session` field. This is straightforward but the doc should specify it:

```typescript
export interface NavigateOptions {
    strategy?: string;
    timeout?: number;
    signal?: AbortSignal;
    taskId?: string;
    session?: "new" | "last" | string;  // NEW: session mode or profile name
}
```

The router's `navigate()` function parses `session`, resolves it to a profile name, loads `storageState` from disk if applicable, and passes it to `plugin.navigate()` via the `options.storageState` field.

### 12.6 `BrowserSession.updateSession()` Pick type must include new fields

**Issue**: The `session-manager.ts` `updateSession()` method uses a `Pick<BrowserSession, ...>` type that explicitly lists updateable fields:
```typescript
updateSession(taskId: string, updates: Partial<Pick<BrowserSession,
    | "currentUrl"
    | "currentTitle"
    | "pluginName"
    | "crashed"
    | "currentSnapshotFingerprint"
    | "cachePopulatedAt"
    | "lastInteractionAt"
>>): void;
```

When `persistState` and `profileName` are added to `BrowserSession`, they must also be added to this `Pick` type, or the router/plugin won't be able to update them via `updateSession()`.

**Resolution**: Add `"persistState"` and `"profileName"` to the `Pick` type union.

### 12.7 Dual context tracking: `_contexts` vs `session.context`

**Issue**: The `BrowserContext` is tracked in two places:
1. `ChromiumPlugin._contexts` — the plugin's own map (`Map<taskId, {context, page}>`)
2. `sessionManager.getSession(taskId).context` — the session manager's reference

When `session="new"` destroys and recreates a context, both must be updated. Currently, `getOrCreateContext()` sets `session.context = context` for new contexts (chromium/index.ts:185). But when destroying an old context first, the old `session.context` reference becomes stale.

**Resolution**: The destroy-and-recreate flow for `session="new"` should:
1. Close old page + context (via `cleanup()` or inline)
2. Delete from `_contexts` and `_elementCache`
3. Create new context with `this._browser.newContext({ ... })`
4. Update `session.context` to the new context
5. Set new entry in `_contexts`

This is already the pattern used by `getOrCreateContext()` when a page is closed but the context is alive — it just needs extending for the full destroy case.

### 12.8 `sessionManager.removeAll()` double-closes contexts

**Issue**: The `session_shutdown` handler calls:
```typescript
for (const { plugin } of ordered) {
    await plugin.cleanupAll().catch(() => {});  // closes all contexts
}
await sessionManager.removeAll();  // tries to close contexts again
```

`ChromiumPlugin.cleanupAll()` → `cleanup(taskId)` → `context.close()` closes all contexts. Then `sessionManager.removeAll()` iterates all sessions and calls `session.context.close()` again. Since the context is already closed, this throws but is caught by `.catch(() => {})`.

This is harmless today, but with auto-save in `cleanup()`, there's a timing question: the auto-save happens in `cleanup()` (before close), so by the time `removeAll()` runs, the save has already happened. No issue — just worth noting.

**Resolution**: No code change needed. The double-close is caught silently. Could optimize by clearing `session.context = undefined` in `cleanup()`, but it's not necessary.

### 12.9 Large storage state: performance and transport limits

**Issue**: The doc doesn't discuss what happens if `storageState` is very large. Some sites store megabytes of data in IndexedDB (e.g., Google Drive caches, offline web apps). This affects:
- **JSON-RPC transport**: Sending a 5MB storage state over stdin/stdout to the Python bridge is slow but feasible. The Python adapter has a `transportTimeoutMs` (default 60s) that could fire.
- **Disk space**: Accumulated profile files could consume significant space.
- **Auto-save latency**: Serializing + writing a large state during `cleanup()` delays session teardown.
- **Context creation**: Loading a large `storageState` into `newContext()` adds startup latency.

**Resolution**: Add a size limit on stored state. If `context.storageState()` returns data exceeding a configurable threshold (e.g., 5MB), warn and either:
- (a) Save only the cookies portion (discard localStorage/IndexedDB)
- (b) Save the full state but log a warning
- (c) Refuse to save and treat the session as ephemeral

**Recommendation**: Option (b) for Phase 2 (save with warning), with option (a) as a future optimization. Add a `browser.maxStorageStateSize` setting (default: 10MB). If exceeded, log a warning and save anyway. For the Python bridge, the transport timeout should be increased when `storageState` is included in the navigate call.

### 12.10 Auto-save failure notification

**Issue**: If auto-save fails during `cleanup()` (disk full, permissions error, etc.), the doc says "best-effort — don't block cleanup on save failure." But the user gets no feedback — their session state silently disappears. This violates the expectation set by `session="last"`.

**Resolution**: When auto-save fails in `cleanup()`, log a warning to stderr (or the pi event system). The `cleanup()` method doesn't return a result to the agent, so the agent can't be notified. But the user should see a warning in their terminal/logs. Example:

```typescript
if (session?.persistState) {
    try {
        const state = await entry.context.storageState();
        await saveStorageState(session.profileName ?? "default", state);
    } catch (err) {
        console.warn(
            `[pi-browser] Failed to auto-save storage state for profile ` +
            `'${session.profileName ?? "default"}': ${err instanceof Error ? err.message : String(err)}. ` +
            `Session state will be lost.`
        );
    }
}
```

### 12.11 Storage state format versioning

**Issue**: Playwright's `storageState` format is not formally versioned. If the format changes between Playwright versions (e.g., new fields, renamed properties), older saved states might not load correctly. This is a forward-compatibility risk.

**Resolution**: Add a lightweight version header to the saved state file:

```json
{
    "_piVersion": 1,
    "_savedAt": "2026-06-14T12:00:00Z",
    "_playwrightVersion": "1.52.0",
    "cookies": [...],
    "origins": [...]
}
```

The `_piVersion` field is checked on load. If it's higher than the current code understands, warn and proceed (new fields are typically additive). The `_playwrightVersion` is informational for debugging. The `_piVersion` field is NOT passed to `newContext({ storageState })` — Playwright ignores unknown top-level keys.

### 12.12 Python bridge cleanup must also auto-save

**Issue**: The doc focuses on `ChromiumPlugin.cleanup()` for auto-save, but the Python adapter's `cleanup()` method also needs to handle this. Currently, `PythonPluginAdapter.cleanup()` sends a `browser.cleanup` RPC call to the bridge, which closes the browser context in Python. The auto-save must happen in the Python bridge BEFORE the context is closed.

There are two options:
- **(a) Have the Python bridge auto-save**: The bridge reads `persistState` / `profileName` from the incoming params (or from its own session tracking) and calls `context.storage_state()` + writes to disk before closing.
- **(b) Have the TypeScript adapter request the state first**: Before sending `browser.cleanup`, the adapter calls `browser.getStorageState` to retrieve the state, saves it via TypeScript I/O, then sends `browser.cleanup`.

**Resolution**: Option (b) is better. It keeps the Python bridge stateless about profile management and file I/O — the bridge doesn't need to know about `~/.pi/agent/browser-state/` or profile directories. The TypeScript adapter already handles all file I/O.

The modified `PythonPluginAdapter.cleanup()` flow:
```typescript
async cleanup(taskId: string): Promise<void> {
    // Auto-save storage state if session is persistent
    const session = sessionManager.getSession(taskId);
    if (session?.persistState) {
        try {
            const raw = await this._rpcCall("browser.getStorageState", { taskId });
            const state = raw as { cookies: unknown[]; origins: unknown[] };
            await saveStorageState(session.profileName ?? "default", state);
        } catch {
            // Best-effort — log warning
        }
    }

    this._elementCaches.delete(taskId);
    await this._rpcCall("browser.cleanup", { taskId }).catch(() => {});
}
```

This means Phase 1 must add `browser.getStorageState` as a JSON-RPC method in the bridge, even if the TypeScript side doesn't use it yet.

### 12.13 The `navigate()` return value and profile awareness

**Issue**: When `session="last"` is used and the storage state is loaded, the `NavigateResult` should indicate to the agent that a profile was restored. This helps the agent understand why it's already logged in or why cookie consent dialogs don't appear.

**Resolution**: Add a `sessionMode` field to `NavigateResult`:
```typescript
interface NavigateResult extends ResultBase {
    // ... existing fields ...
    sessionMode?: "new" | "restored";  // NEW: indicates whether state was restored
    profileName?: string;              // NEW: which profile was loaded (if any)
}
```

The router sets these fields based on the `session` parameter resolution. The `browser-navigate` tool output in `index.ts` should include them in the header lines shown to the agent:

```
Title: Dashboard
URL: https://app.example.com/dashboard
Backend: chromium
Session: restored (profile: work)
Interactive elements: 42
```

### 12.14 Cross-plugin profile compatibility

**Issue**: The plugin registry supports multiple backends (e.g., both `chromium` and `chromium-py`). A profile created by the Chromium plugin uses Playwright's standard `storageState` format, which is identical across all Playwright backends (TS and Python). So a profile loaded by `chromium-py` can use the same `storage-state.json` file created by `chromium`.

**Resolution**: This is a non-issue — Playwright's `storageState` format is backend-agnostic. But it should be documented as a design property: profiles are portable across all Playwright-based backends. The profile directory doesn't need to track which plugin created it.

### 12.15 The `web-learn` guide interaction with cookies

**Issue**: The existing `cookie-consent` builtin guide (`core/guides.ts`) helps agents dismiss cookie consent dialogs. With persistent profiles, these dialogs become less frequent. The guide system should be aware of profiles — if a session restores state that already includes consent cookies, the cookie-consent guide hint is unnecessary noise.

**Resolution**: This is a nice-to-have, not a blocker. The `dialogPresentInSnapshot()` function already checks for `role="dialog"` in the snapshot, which won't fire if the dialog doesn't appear. The domain-based guide auto-hint may still fire, but it's just a hint, not injected content. No code change needed in Phase 1 or 2. A future optimization could skip guide hints for domains where the profile already has cookies.

---

## 13. Implementation Checklist

Quick reference for the implementation, ordered by dependency.

### Phase 1: Cookie Tools

| Step | File(s) | What |
|------|---------|------|
| 1.1 | `core/plugin-api.ts` | Add `Cookie`, `CookieResult`, `ClearCookiesOptions`, `StorageStateResult` types; add `getCookies`, `addCookies`, `clearCookies`, `getStorageState` methods to `BrowserPlugin` interface |
| 1.2 | `backends/chromium/index.ts` | Implement `getCookies`, `addCookies`, `clearCookies`, `getStorageState` using Playwright `context.cookies()`, `context.addCookies()`, `context.clearCookies()`, `context.storageState()` |
| 1.3 | `backends/python-adapter.ts` | Implement `getCookies`, `addCookies`, `clearCookies`, `getStorageState` via JSON-RPC calls |
| 1.4 | `backends/chromium-py/bridge.py` | Add `browser.getCookies`, `browser.addCookies`, `browser.clearCookies`, `browser.getStorageState` JSON-RPC handlers |
| 1.5 | `core/router.ts` | Add `getCookies`, `addCookies`, `clearCookies` dispatch functions (following existing pattern); add `NavigateOptions.session` field |
| 1.6 | `index.ts` | Add `browser-cookies` tool definition; register tool |
| 1.7 | Tests | Cookie CRUD via plugin contract, router dispatch, tool parameter validation |

### Phase 2: Storage State Persistence

| Step | File(s) | What |
|------|---------|------|
| 2.1 | `core/shared/storage-state.ts` | New file: `loadStorageState(profile)`, `saveStorageState(profile, state)`, `sanitizeProfileName()`, version header, size warning |
| 2.2 | `core/shared/profile-lock.ts` | New file: `acquireProfileLock()`, `releaseProfileLock()` using mkdir atomicity |
| 2.3 | `core/shared/session-manager.ts` | Add `persistState`, `profileName` to `BrowserSession`; add them to `updateSession()` Pick type; add `profileName` to `LastNavEntry` |
| 2.4 | `core/plugin-api.ts` | Add `storageState` option to `navigate()` options; add `sessionMode`, `profileName` to `NavigateResult` |
| 2.5 | `backends/chromium/index.ts` | Accept `storageState` in navigate options → pass to `getOrCreateContext()` → `newContext({ storageState })`; handle `session="new"` destroy-and-recreate; auto-save in `cleanup()` before context.close() |
| 2.6 | `backends/python-adapter.ts` | Thread `storageState` in navigate RPC; auto-save via `browser.getStorageState` RPC before `browser.cleanup` RPC in `cleanup()` |
| 2.7 | `backends/chromium-py/bridge.py` | Accept `storageState` in `browser.navigate` → `browser.new_context(storage_state=...)` |
| 2.8 | `core/router.ts` | Parse `session` param → resolve profile → load storage state → pass to plugin; update `requireInteractiveSession()` to restore profile state on auto-recovery; add `sessionMode`/`profileName` to result |
| 2.9 | `index.ts` | Add `session` parameter to `browser-navigate` tool; show `sessionMode`/`profileName` in output header |
| 2.10 | Tests | Save/restore round-trip, lock contention, session="new" destroys context, missing state file fallback, Python bridge parity, large state handling |

### Phase 3: Named Profiles

| Step | File(s) | What |
|------|---------|------|
| 3.1 | `core/plugin-config.ts` | Parse `browser.profiles`, `browser.sessionDefault`, `browser.defaultProfile` from settings.json |
| 3.2 | `index.ts` | Add `/web profile` command for profile management; extend `/browser-status` to show profiles |
| 3.3 | Tests | Profile CRUD, config parsing, multiple profile isolation, reserved name rejection |
