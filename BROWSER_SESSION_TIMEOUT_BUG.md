# Bug Report: Browser Session Times Out Between Messages

## Symptom
Every time a user sends a new message during a conversation using the browser extension, the browser session "times out" — returning `No active session` and forcing the agent to re-navigate from scratch on every tool call.

## Root Cause Analysis

### Primary Issue: In-Memory Session Key Map (`_sessionKeys`) Loses State Between Agent Turns

**File:** `index.ts`, lines 146-158

```typescript
const _sessionKeys = new Map<string, string>();   // ← IN-MEMORY ONLY
let _sessionCounter = 0;

function taskId(ctx): string {
    const piSessionId = ctx?.sessionManager?.getSessionId?.();
    if (piSessionId) {
        if (!_sessionKeys.has(piSessionId)) {
            _sessionKeys.set(piSessionId, `browser-${++_sessionCounter}`);
        }
        return _sessionKeys.get(piSessionId)!;
    }
    return "browser-default";   // ← Fallback when key is missing
}
```

**Problem:** `_sessionKeys` maps a pi session ID to a browser task ID (e.g. `browser-1`). This map lives only in the extension's in-memory state. When the agent's context grows large enough to trigger:

- TUI memory pressure / context window limits, **or**
- An implicit extension reload between turns,

the entire `_sessionKeys` map is discarded while the pi conversation continues. The same `piSessionId` now produces no entry in the empty map, so `taskId()` returns `"browser-default"`.

The router then calls `requireInteractiveSession("browser-default")`, which finds no session → **"No active session"** error → agent must re-navigate.

### Secondary Issue: `session_shutdown` Tears Down Everything Aggressively

**File:** `index.ts`, lines 1724-1745

```typescript
pi.on("session_shutdown", async (_event, ctx) => {
    if (piSessionId) {
        _sessionKeys.delete(piSessionId);           // ← Wipes the map entry
    }
    for (const plugin of ordered) {
        await plugin.cleanupAll().catch(() => {});   // ← CLOSING ALL PAGES + BROWSER
    }
    await sessionManager.removeAll();                // ← REMOVES ALL SESSIONS
});
```

This handler runs on `session_shutdown`. If this event fires at any point between agent turns (not just when the conversation truly ends), it:

1. **Deletes** the `_sessionKeys` entry — breaking future task resolution
2. **Closes all Playwright pages and browser contexts** — destroying session state
3. **Removes all sessions from `sessionManager`** — making recovery impossible

### Why This Causes Per-Message Timeouts

The flow looks like this in practice:

```
User message 1 → _sessionKeys has "conv-001" → taskId = "browser-1" → navigate succeeds ✅
─────────── (context pressure / reload triggers cleanup) ───────────
User message 2 → _sessionKeys.empty() → taskId = "browser-default" → requireInteractiveSession("browser-default") → NO SESSION ❌
                 ↓
                 router.navigate creates browser-2, navigates again (wasteful)
─────────── (same cycle repeats) ───────────
User message 3 → taskId = "browser-default" AGAIN → navigate succeeds as browser-2
...
```

### Why the Agent Reports "No active session" Instead of Auto-Recovery

In `router.ts`, `requireInteractiveSession()` only auto-recovers when:
1. The `_sessionKeys` map returns a valid taskId (e.g. `"browser-1"`), AND  
2. A `lastNav` entry exists for that taskId, AND  
3. The task's page was closed but the context is still alive

When `taskId()` returns `"browser-default"`, there's no matching `lastNav` entry and no recovery path — it always fails with "No active session".

## Affected Scenarios

- **Long conversations**: After ~5-10 tool calls, context pressure may trigger implicit reloads
- **TUI memory pressure**: The pi TUI may internally restart extensions when memory is high
- **Agent subagent nesting**: Subagents may share the same pi session ID but create different agent turns, each with their own execution context

## Suggested Fix

### Option A: Persist `_sessionKeys` to Disk

Store the mapping in a JSON file under `~/.pi/agent/browser-state/_task-id-mapping.json` and load it on extension startup. This survives reloads.

### Option B: Derive taskId from piSessionId Directly (No Counter)

Instead of a counter + map, always derive a deterministic taskId:

This is deterministic — the same `piSessionId` always maps to the same taskId. No map needed. Session recovery works automatically because `requireInteractiveSession()` finds the session by taskId.

**Caveat:** Shared named profiles still need a consistent counter-based key for `_sharedContexts`.

### Option C: Guard `session_shutdown` from Firing Mid-Conversation

Investigate whether `session_shutdown` fires unexpectedly during normal agent operation (tool execution, context refresh, etc.) vs only at true conversation boundaries. If it's firing too early, the fix is in pi-core, not this extension.

## Severity: High

This breaks the core browsing workflow for any session lasting more than a handful of tool calls. The browser becomes essentially unusable for multi-step tasks.
