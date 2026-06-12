# Snapshot Cache & Query Plan v2

> Date: 2026-06-12
> Status: **Approved** — revised implementation plan incorporating oracle review + Python parity
> Supersedes: `snapshot-cache-query-plan.md` (v1 draft)

---

## 0. Decisions from Oracle Review

The v1 draft was reviewed by an adversarial oracle. The following decisions were made:

| # | v1 Position | Oracle Finding | Decision |
|---|-------------|---------------|----------|
| 1 | Element cache → `BrowserSession` (Option B) | Violates plugin encapsulation; couples `session-manager.ts` to `accessibility-tree.ts` | **Use Option A** — add `getElementCache(taskId)` to `BrowserPlugin` interface, keep the Map in each plugin |
| 2 | Remove safety-net cap in `index.ts` | Eliminates defense-in-depth; no guarantee every future code path goes through `compactSnapshot()` | **Keep it** — add a comment explaining its role |
| 3 | Never cache interaction results | When a click navigates to a new page, the auto-snapshot IS the primary content for that page | **Cache interaction results that produce a new URL** — check `result.newUrl !== session.currentUrl` |
| 4 | `compactSnapshot()` becomes impure (disk I/O inside) | Complicates testing; `web-fetch` keeps caching in a wrapper, not the compaction function | **Keep `compactSnapshot()` pure** — caching lives in the caller (router.ts) |
| 5 | Subtree depth-based approximation is fine | Untested on real pages with multiple sibling dialogs | **Test on real pages before Phase 2 ships**; add `parentRef` to `AriaCachedNode` if depth-based fails |
| 6 | No disk I/O error handling | `writeFileSync` throws on ENOSPC/EACCES — surfaces as unhandled exception | **Add try-catch** — graceful degradation (inline only, no file) |
| 7 | One cached file per task, deleted on next snapshot | Agent loses before/after comparison; race condition on concurrent snapshots | **Timestamped filenames, keep last 2 per task** |
| 8 | Cache notice says "@e refs are still valid" | Too optimistic — SPA mutations invalidate refs without navigation | **Add fingerprint to cache notice** — warn agent that refs are valid for current page state only |
| 9 | No mention of `browser-query` in cache notice | Agent doesn't discover the query tool when it's most relevant | **Add `browser-query` hint to cache notice** |
| 10 | Python backend not considered | Python bridge keeps element cache in subprocess; no JSON-RPC method exposes it | **Add `browser.getElementCache` JSON-RPC method** to Python bridge + adapter |
| 11 | `maxChars=0` and `full=true` coexist | Two params for the same thing is confusing | **Deprecate `full`** — add note in param description, `maxChars` wins if both set |

---

## 1. Problem (unchanged from v1)

When `compactSnapshot()` truncates the accessibility tree to ~2500 chars, every element past the cut line vanishes from the agent's context. The agent cannot click links it can't see, cannot fill forms it doesn't know exist, and cannot dismiss dialogs whose buttons were truncated away.

Two distinct problems:

| Problem | Example |
|---------|---------|
| **Information loss** — elements exist but are invisible to the agent | "I know there's a submit button but I can't see its @e ref" |
| **Element discovery** — agent needs to find specific elements without scanning the whole tree | "Find all links on this page" or "What buttons are in this dialog?" |

---

## 2. Approach: Two Complementary Features (unchanged from v1)

### Feature A — Snapshot Disk Cache

Following the `web-fetch` pattern: truncate the snapshot inline, write the full untruncated tree to a temp file, tell the agent where to find it.

**Key insight:** `@e` refs in the cached file are still valid for interaction. The `elements` Map is stored in the plugin's per-taskId cache (in-memory). When the agent calls `browser-click ref="@e42"`, the router resolves `e42` from the plugin's element cache — not from whatever text the agent last saw. The agent only needs the `@e` ref string; it doesn't matter whether it found that ref in the inline snapshot or by reading the cached file.

**Important caveat:** @e refs are valid only for the current page state. SPA mutations can invalidate refs without a new navigation. The cache notice includes the snapshot fingerprint so the agent can check staleness.

### Feature B — `browser-query` Tool

A purpose-built tool that queries the in-memory `elements` Map from the active browser session's plugin. Supports filtering by role, name, ref lookup, and subtree scoping. Returns structured results with `@e` refs the agent can immediately use for interaction.

**Key insight:** This queries the live session data via the plugin's `getElementCache()` method, not a stale disk file. No staleness issues. No external tool dependencies (`jq`, `rg`). The agent just calls the tool with the filters it needs.

**Python parity:** The `PythonPluginAdapter` will implement `getElementCache()` via a new `browser.getElementCache` JSON-RPC method, so `browser-query` works identically for Python backends.

---

## 3. Feature A: Snapshot Disk Cache

### 3.1 How `web-fetch` Does It (Existing Pattern — unchanged)

`web-fetch` already caches large fetch results to disk:

```
COMPACT_FETCH_LIMIT = 4000   // inline content cap
FETCH_SPILL_THRESHOLD = 5000 // only cache to disk if content exceeds this

→ Content < 5000 chars: inline only, no file
→ Content ≥ 5000 chars: inline (truncated to ~4000) + temp file with full content
→ Agent sees: "📄 Full content saved to /tmp/pi-browser/fetch-default-a3f2b1c8.md (11KB). Use read with offset/limit to access specific sections."
```

Key implementation details:
- `writeFetchTempFile()` writes to `/tmp/pi-browser/fetch-<taskId>-<hash>.md`
- `trackFetchFile()` tracks per-task files, deletes stale ones on new fetch
- `capFetchContent()` returns `{ inline, filePath, totalChars }`
- Cleanup on session shutdown via `removeAllFetchFiles()`

### 3.2 Adaptation for Snapshots (revised from v1)

The snapshot case differs from fetch in three ways:

1. **Snapshots are always produced** (even short ones), so we should only cache when truncation actually happened (snapshot > `COMPACT_SNAPSHOT_NO_TRUNCATE` = 2800 chars)
2. **The truncation hint text matters** — it should tell the agent about @e ref validity, the fingerprint, and the `browser-query` tool
3. **Interaction results that navigate to a new page should also be cached** — they represent the primary content for the new page

### 3.3 New Code: `core/shared/snapshot-cache.ts`

A self-contained module following the same pattern as fetch-backend's temp file logic. **Disk I/O stays here, not in `compactSnapshot()`** — the compaction function remains pure.

```typescript
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const SNAPSHOT_TEMP_DIR = `${tmpdir()}/pi-browser`;

/** Maximum cached snapshot files retained per task */
const MAX_FILES_PER_TASK = 2;

/** Tracks active snapshot temp files per task (newest last) */
const activeSnapshotFiles = new Map<string, string[]>();

export interface CachedSnapshot {
  /** The inline (potentially truncated) snapshot text — unmodified from compactSnapshot() */
  inline: string;
  /** Path to temp file with full snapshot (only when truncation occurred) */
  filePath?: string;
  /** Total chars before truncation */
  totalChars: number;
}

/**
 * Cache a full snapshot to disk if truncation occurred.
 * Returns the inline text (unchanged) and optional file path.
 *
 * This is the ONLY function that performs disk I/O for snapshot caching.
 * compactSnapshot() stays pure — this wrapper handles the file side.
 */
export function cacheSnapshot(
  snapshot: string,
  taskId: string,
  wasTruncated: boolean,
): CachedSnapshot {
  const totalChars = snapshot.length;

  if (!wasTruncated) {
    return { inline: snapshot, totalChars };
  }

  try {
    // Write full snapshot to temp file
    mkdirSync(SNAPSHOT_TEMP_DIR, { recursive: true });
    const hash = createHash("sha256").update(snapshot).digest("hex").slice(0, 8);
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9-]/g, "_");
    const ts = Date.now();
    const filePath = `${SNAPSHOT_TEMP_DIR}/snapshot-${safeTaskId}-${hash}-${ts}.txt`;
    writeFileSync(filePath, snapshot, "utf-8");

    // Track and clean up stale files for this task (keep last MAX_FILES_PER_TASK)
    const existing = activeSnapshotFiles.get(taskId) ?? [];
    const updated = [...existing, filePath];
    while (updated.length > MAX_FILES_PER_TASK) {
      const oldPath = updated.shift()!;
      try { rmSync(oldPath, { force: true }); } catch { /* best-effort */ }
    }
    activeSnapshotFiles.set(taskId, updated);

    return { inline: snapshot, filePath, totalChars };
  } catch {
    // Disk write failed — graceful degradation: inline only, no file
    return { inline: snapshot, totalChars };
  }
}

/** Remove all snapshot temp files for a task (called on session cleanup) */
export function removeSnapshotFiles(taskId: string): void {
  const files = activeSnapshotFiles.get(taskId);
  if (!files) return;
  for (const f of files) {
    try { rmSync(f, { force: true }); } catch { /* best-effort */ }
  }
  activeSnapshotFiles.delete(taskId);
}

/** Remove all snapshot temp files (called on shutdown) */
export function removeAllSnapshotFiles(): void {
  for (const [, files] of activeSnapshotFiles) {
    for (const f of files) {
      try { rmSync(f, { force: true }); } catch { /* best-effort */ }
    }
  }
  activeSnapshotFiles.clear();
}
```

### 3.4 `compactSnapshot()` — Remains Pure (revised from v1)

**Current signature stays unchanged:**

```typescript
export function compactSnapshot(
  snapshot: string,
  elementCount: number,
): string
```

The function remains pure — no disk I/O, no `taskId`, no side effects. The caller (router.ts) is responsible for:
1. Calling `compactSnapshot()` to get the truncated inline text
2. Determining whether truncation occurred (compare lengths)
3. Calling `cacheSnapshot()` to write the full snapshot to disk if needed

This preserves testability and keeps the caching concern separate from the compaction concern — consistent with how `web-fetch` keeps caching in `capFetchContent()` (a wrapper), not inside the fetch function itself.

### 3.5 Integration into Router

#### `navigate()` in `core/router.ts`

The navigate function currently calls `compactSnapshot()` in the normal path. After compaction, add disk caching:

```typescript
// Current:
const snapshotContent = result.snapshot
  ? (botWarn
      ? result.snapshot
      : compactSnapshot(result.snapshot, result.elementCount)) +
    `\nfingerprint:${fp}`
  : "";

// New (normal path only — bot-detected path unchanged):
if (!botWarn && result.snapshot) {
  const fullSnapshot = result.snapshot;
  const compacted = compactSnapshot(fullSnapshot, result.elementCount);
  const wasTruncated = compacted.length < fullSnapshot.length;
  const cached = cacheSnapshot(fullSnapshot, taskId, wasTruncated);

  let snapshotContent = compacted + `\nfingerprint:${fp}`;
  if (cached.filePath) {
    snapshotContent += formatCacheNotice(cached.filePath, cached.totalChars, fp);
  }
  // ... use snapshotContent
}
```

For the **bot-detected path**: **no caching.** Bot-detected snapshots pass through unmodified, and we don't want to cache a potentially misleading snapshot.

#### `snapshot()` in `core/router.ts`

Same integration. After `compactSnapshot()`, check if truncation occurred and call `cacheSnapshot()`.

#### `compactInteractionResult()` — Cache When URL Changes (revised from v1)

**v1 said:** "Interaction results should NOT cache to disk."

**Revision:** When an interaction result contains `newUrl` that differs from `session.currentUrl`, the auto-snapshot is for a *new page* — it IS primary navigation content and should be cached.

```typescript
function compactInteractionResult(
  taskId: string,
  result: InteractionResult,
): InteractionResult {
  if (result.success && result.snapshot && result.elementCount !== undefined) {
    const fullSnapshot = result.snapshot;
    const compacted = compactSnapshot(fullSnapshot, result.elementCount);
    const newFingerprint = snapshotFingerprint(fullSnapshot);
    const wasTruncated = compacted.length < fullSnapshot.length;

    // Cache to disk if truncation occurred AND the interaction navigated to a new page
    let filePath: string | undefined;
    const session = sessionManager.getSession(taskId);
    if (wasTruncated && session && result.newUrl && result.newUrl !== session.currentUrl) {
      const cached = cacheSnapshot(fullSnapshot, taskId, wasTruncated);
      filePath = cached.filePath;
    }

    result.snapshot = compacted + `\nfingerprint:${newFingerprint}`;
    if (filePath) {
      result.snapshot += formatCacheNotice(filePath, fullSnapshot.length, newFingerprint);
    }

    if (session) {
      session.currentSnapshotFingerprint = newFingerprint;
    }
  }
  return result;
}
```

For same-page interactions (no `newUrl` or `newUrl === session.currentUrl`), no disk caching occurs — these are follow-up snapshots where the agent already has context from the initial navigate.

### 3.6 Cache Notice Format

**New format (revised from v1):**

```
📄 Full snapshot saved to /tmp/pi-browser/snapshot-default-a3f2b1c8-1718200000.txt (11KB).
   Use read with offset/limit to find elements — @e refs are valid for this page state (fingerprint: XXXXX).
💡 Use browser-query to find elements by role or name (e.g., browser-query role="button").
```

~200 chars. Only appears when truncation actually happened. Includes:
- File path with size hint
- @e ref validity note scoped to page state (not unconditional)
- Fingerprint for staleness checking
- `browser-query` discovery hint

**New helper function** (in `snapshot-cache.ts` or inline in router.ts):

```typescript
function formatCacheNotice(
  filePath: string,
  totalChars: number,
  fingerprint: string,
): string {
  const sizeHint = totalChars > 1024
    ? `${(totalChars / 1024).toFixed(0)}KB`
    : `${totalChars} chars`;
  return (
    `\n\n📄 Full snapshot saved to ${filePath} (${sizeHint}).` +
    `\n   Use read with offset/limit to find elements — @e refs are valid for this page state (fingerprint: ${fingerprint}).` +
    `\n💡 Use browser-query to find elements by role or name (e.g., browser-query role="button").`
  );
}
```

### 3.7 Integration into `index.ts`

#### `browser-navigate` tool

After getting the router result, the snapshot text already contains the cache notice (appended by the router). No special handling needed in `index.ts` — the notice is part of the snapshot string.

**Safety-net cap (index.ts ~line 136): KEEP.** Add a comment:

```typescript
// Defense-in-depth: catches content that wasn't routed through compactSnapshot().
// Do not remove — this is a safety net, not the primary truncation mechanism.
if (result.elementCount !== undefined && contentText.length > 8000) {
  let cut = contentText.lastIndexOf("\n", 4000);
  // ...
}
```

**Tool details:** add `filePath` to `details` if available, so the TUI renderer can show it differently.

#### `browser-snapshot` tool

Same — cache notice is already in the snapshot text from the router.

### 3.8 Cleanup

- `sessionManager.removeSession()` → call `removeSnapshotFiles(taskId)`
- `sessionManager.removeAll()` → call `removeAllSnapshotFiles()`
- Process exit → `removeAllSnapshotFiles()` (best-effort, temp dir is cleaned by OS)

### 3.9 Temp File Format (unchanged from v1)

The cached file is the **full, untruncated snapshot** — the same formatted text the agent would see with `full=true`. It includes all `@e` refs (up to `maxElements` = 500), role icons and names, indentation showing hierarchy, and property annotations.

---

## 4. Feature B: `browser-query` Tool

### 4.1 `BrowserPlugin` Interface Change — Option A

Add `getElementCache()` to the `BrowserPlugin` interface:

```typescript
// In core/plugin-api.ts
export interface BrowserPlugin {
  // ... existing methods ...

  /**
   * Get the element cache for a task session.
   * Returns a Map of ref string → AriaCachedNode for the current page state.
   * Used by browser-query to find elements without scanning the full snapshot.
   */
  getElementCache(taskId: string): Map<string, AriaCachedNode>;
}
```

This preserves plugin encapsulation — each plugin owns its element cache and decides how to populate it. The session remains a lightweight state holder. `session-manager.ts` does NOT gain a dependency on `accessibility-tree.ts`.

### 4.2 TypeScript Backend (`ChromiumPlugin`)

The private `getElementCache()` method already exists (line 210). Change it from `private` to `public` — it already returns `Map<string, AriaCachedNode>`. This is a one-word change.

### 4.3 Python Backend (`PythonPluginAdapter`)

The Python bridge (`backends/python-base/pi_browser_bridge/bridge.py`) keeps `element_caches` in the subprocess. The TypeScript `PythonPluginAdapter` needs to access it via a new JSON-RPC method.

#### New JSON-RPC method: `browser.getElementCache`

**Python bridge handler** (add to `handle_command()` in `bridge.py`):

```python
if method == "browser.getElementCache":
    task_id = self._require_param(params, "taskId", str, cmd_id)
    cache = self.get_element_cache(task_id)
    if cache is None:
        return make_success_response(cmd_id, {"elements": {}})
    # Serialize element cache: dict of ref → node dict
    elements = {}
    for ref, node in cache.elements.items():
        elements[ref] = {
            "ref": node.ref,
            "role": node.role,
            "name": node.name,
            "props": node.props,
            "depth": node.depth,
            "raw": node.raw,
            "occurrenceIndex": node.occurrence_index,
        }
    return make_success_response(cmd_id, {"elements": elements})
```

**TypeScript adapter method** (add to `PythonPluginAdapter` in `python-adapter.ts`):

```typescript
getElementCache(taskId: string): Map<string, AriaCachedNode> {
  // Synchronous return from locally-cached data.
  // We populate _localElementCache from navigate/snapshot responses,
  // and also support an on-demand RPC fetch.
  if (this._localElementCache.has(taskId)) {
    return this._localElementCache.get(taskId)!;
  }
  // Fall back to empty — async RPC in a sync interface is not safe.
  // The cache will be populated on next navigate/snapshot.
  return new Map();
}
```

**Better approach: populate local cache from existing RPC responses.** The Python bridge already returns `snapshot` text in every `navigate` and `snapshot` response. We can parse that snapshot text with `parseSnapshot()` on the TypeScript side to populate the element cache, avoiding an extra RPC call.

Wait — this would duplicate parsing work. The Python bridge already parses the snapshot internally. A cleaner approach:

**Approach: serialize elements in the RPC response.** Extend the Python bridge's `navigate` and `snapshot` responses to include a serialized `elements` map. The `PythonPluginAdapter` deserializes it and stores it locally.

**Changes to Python bridge responses** (in `bridge.py` `do_navigate()` and `do_snapshot()`):

```python
# After parsing snapshot:
parsed = parse_snapshot(snap_text)
self.set_element_cache(task_id, parsed)

# In the response dict, include serialized elements:
result = {
    "success": True,
    "url": page.url,
    "title": page.title,
    "snapshot": snap_text,
    "elementCount": parsed.count,
    "elements": {
        ref: {
            "ref": node.ref,
            "role": node.role,
            "name": node.name,
            "props": node.props,
            "depth": node.depth,
            "raw": node.raw,
            "occurrenceIndex": node.occurrence_index,
        }
        for ref, node in parsed.elements.items()
    },
}
```

**TypeScript adapter changes** (in `python-adapter.ts`):

```typescript
// New field on the class
private _elementCache = new Map<string, Map<string, AriaCachedNode>>();

// In navigate() and snapshot() methods, after parsing the RPC result:
const elementsMap = new Map<string, AriaCachedNode>();
if (result.elements && typeof result.elements === "object") {
  for (const [ref, node] of Object.entries(result.elements as Record<string, AriaCachedNode>)) {
    elementsMap.set(ref, node);
  }
}
this._elementCache.set(taskId, elementsMap);

// Implement interface method:
getElementCache(taskId: string): Map<string, AriaCachedNode> {
  return this._elementCache.get(taskId) ?? new Map();
}

// Cleanup: in cleanup() method
this._elementCache.delete(taskId);
```

**Also add `browser.getElementCache` as a standalone RPC method** for on-demand fetching (e.g., after a click that refreshes the element cache). This is useful when the agent calls `browser-query` after an interaction that didn't return elements in its response:

**Python bridge** — add to `handle_command()`:
```python
if method == "browser.getElementCache":
    task_id = self._require_param(params, "taskId", str, cmd_id)
    cache = self.get_element_cache(task_id)
    elements = {}
    if cache:
        for ref, node in cache.elements.items():
            elements[ref] = {
                "ref": node.ref,
                "role": node.role,
                "name": node.name,
                "props": node.props,
                "depth": node.depth,
                "raw": node.raw,
                "occurrenceIndex": node.occurrence_index,
            }
    return make_success_response(cmd_id, {"elements": elements})
```

**TypeScript adapter** — add async helper:
```typescript
private async _fetchElementCache(taskId: string): Promise<Map<string, AriaCachedNode>> {
  try {
    const raw = await this._rpcCall("browser.getElementCache", { taskId });
    const result = raw as Record<string, unknown>;
    const elementsMap = new Map<string, AriaCachedNode>();
    if (result.elements && typeof result.elements === "object") {
      for (const [ref, node] of Object.entries(result.elements as Record<string, AriaCachedNode>)) {
        elementsMap.set(ref, node);
      }
    }
    this._elementCache.set(taskId, elementsMap);
    return elementsMap;
  } catch {
    return this._elementCache.get(taskId) ?? new Map();
  }
}
```

**Important:** `getElementCache()` on the interface must be synchronous. The Python adapter returns the locally-cached version (populated from navigate/snapshot responses). The on-demand `_fetchElementCache()` is async and can be called by the router to refresh the cache before a `browser-query` call if needed.

**Decision: `getElementCache()` returns the synchronous local cache.** This means:
- After `navigate` or `snapshot`, the cache is always fresh (populated from the response).
- After `click`/`type`/etc., the cache may be stale (the Python bridge updates its internal cache, but the adapter's local copy is not refreshed).
- For `browser-query`, call `_fetchElementCache()` first to refresh, then return the result. This is handled in the router.

Alternative: Have `getElementCache()` be async in the interface. But this would require making all callers async, including the ChromiumPlugin which has synchronous access. The async refresh is better handled at the router level.

**Final decision: `getElementCache()` is synchronous, returns local cache.** The router calls `_fetchElementCache()` for Python plugins before executing `browser-query`. For the ChromiumPlugin (local, synchronous), no refresh is needed.

### 4.4 Tool Definition

```typescript
const browserQueryTool = defineTool({
  name: "browser-query",
  label: "Query Page Elements",
  description:
    "Search the current page's accessibility tree for elements by role, name, or @e ref. " +
    "Use to find specific elements without reading the full snapshot. " +
    "Requires an active browser session (navigate first).",
  promptSnippet: "Find specific elements on the current page",
  promptGuidelines: [
    "Use browser-query to find elements by role (e.g. all links, all buttons) without loading the full snapshot.",
    "Use the subtree parameter to scope queries to a section (e.g. 'dialog', 'navigation', 'main').",
    "Results include @e refs that can be used directly with browser-click and browser-type.",
    "This queries the live session — results reflect the current page state, not a cached snapshot.",
  ],
  parameters: Type.Object({
    role: Type.Optional(
      Type.String({
        description:
          "Filter by ARIA role. Common values: link, button, textbox, searchbox, combobox, " +
          "checkbox, heading, dialog, navigation, list, table, img. " +
          "Multiple roles can be comma-separated: 'link,button'.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Filter by accessible name (case-insensitive substring match). " +
          'E.g. "submit" matches "Submit Form", "Submit", etc.',
      }),
    ),
    ref: Type.Optional(
      Type.String({
        description:
          "Look up a specific element by its @e ref (e.g. 'e5' or 'e42'). " +
          "Returns the element's role, name, and properties.",
      }),
    ),
    subtree: Type.Optional(
      Type.String({
        description:
          "Scope results to elements inside a specific container role. " +
          "E.g. subtree='dialog' returns only elements inside a dialog. " +
          "Common values: dialog, navigation, main, form, table, list, search, banner.",
      }),
    ),
  }),
  // ...
});
```

### 4.5 Implementation

The tool queries the active session's plugin element cache via `getElementCache()`.

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const { role, name, ref, subtree } = params as {
    role?: string;
    name?: string;
    ref?: string;
    subtree?: string;
  };

  const tid = taskId(ctx);
  const session = sessionManager.getSession(tid);
  if (!session) {
    return {
      content: [{
        type: "text",
        text: "No active session — use browser-navigate to visit a page first.",
      }],
    };
  }

  const plugin = pluginRegistry.get(session.pluginName) as BrowserPlugin | undefined;
  if (!plugin) {
    return {
      content: [{ type: "text", text: `Plugin '${session.pluginName}' not available.` }],
    };
  }

  // For Python plugins, refresh the element cache before querying
  if ("_fetchElementCache" in plugin) {
    await (plugin as any)._fetchElementCache(tid);
  }

  const elements = plugin.getElementCache(tid);

  // Single ref lookup
  if (ref) {
    const refKey = ref.replace("@", "");
    const node = elements.get(refKey);
    if (!node) {
      return {
        content: [{ type: "text", text: `No element found for @${ref}.` }],
      };
    }
    return {
      content: [{
        type: "text",
        text: `@${node.ref} ${roleIcon(node.role)}${node.role} "${node.name}"${node.props.length ? ` [${node.props.join(", ")}]` : ""}`,
      }],
    };
  }

  // Build role filter set
  const roleSet = role
    ? new Set(role.split(",").map(r => r.trim().toLowerCase()))
    : undefined;

  // If subtree specified, find subtree root(s)
  let subtreeRoots: AriaCachedNode[] = [];
  if (subtree) {
    const subtreeRole = subtree.toLowerCase();
    for (const [, node] of elements) {
      if (node.role === subtreeRole) {
        subtreeRoots.push(node);
      }
    }
  }

  // Filter elements
  const results: AriaCachedNode[] = [];
  for (const [eref, node] of elements) {
    // Role filter
    if (roleSet && !roleSet.has(node.role)) continue;

    // Name filter (case-insensitive substring)
    if (name && !node.name.toLowerCase().includes(name.toLowerCase())) continue;

    // Subtree filter (depth-based approximation)
    if (subtree) {
      const isInsideSubtree = subtreeRoots.some(root => {
        if (node === root) return true; // include the root itself
        return node.depth > root.depth; // must be deeper than root
      });
      if (!isInsideSubtree) continue;
    }

    results.push(node);
  }

  if (results.length === 0) {
    const filters = [
      role ? `role=${role}` : null,
      name ? `name~=${name}` : null,
      subtree ? `subtree=${subtree}` : null,
    ].filter(Boolean).join(", ");
    return {
      content: [{ type: "text", text: `No elements found matching: ${filters}` }],
    };
  }

  // Format results
  const lines = results.map(node => {
    const propStr = node.props.length ? ` [${node.props.join(", ")}]` : "";
    return `  @${node.ref} ${roleIcon(node.role)}${node.role} "${node.name}"${propStr}`;
  });

  const header = `Found ${results.length} element${results.length === 1 ? "" : "s"}:`;
  return {
    content: [{ type: "text", text: header + "\n" + lines.join("\n") }],
  };
}
```

### 4.6 Subtree Query Semantics (unchanged from v1 — with testing gate)

The subtree filter uses depth-based approximation:
1. Find all elements matching the subtree role (e.g. all `dialog` elements)
2. Include those root elements AND all elements with a greater depth than the root

**Known limitation:** If two containers with the same role are siblings at the same depth, elements from both may be included in a query scoped to either. This is acceptable for common patterns (single dialog, single navigation area).

**Testing gate:** Before Phase 2 ships, test on 5-10 real-world pages with multiple dialogs/frames. If depth-based approximation fails on any real page, add `parentRef` to `AriaCachedNode` (requires changes to both `accessibility-tree.ts` and `accessibility.py` parser) and implement exact subtree queries.

### 4.7 Export `roleIcon` from `accessibility-tree.ts`

Currently a private function. Export it for `browser-query` formatting:

```typescript
// In core/shared/accessibility-tree.ts
// Change:
function roleIcon(role: string): string { ... }
// To:
export function roleIcon(role: string): string { ... }
```

This creates a de facto public API. Any change to the icon set affects tool output. This is acceptable — the icons are stable and the function is already used consistently.

### 4.8 `maxChars` Parameter (Bonus — unchanged from v1)

With the caching infrastructure in place, adding `maxChars` to `browser-navigate` and `browser-snapshot` is trivial:

- Pass `maxChars` through to `compactSnapshot()` — but wait, we decided to keep `compactSnapshot()` pure. So `maxChars` is handled in the router: the router truncates to `maxChars` (or auto if undefined) after calling `compactSnapshot()`, then caches the full text via `cacheSnapshot()`.
- The disk cache always stores the full snapshot regardless of `maxChars`
- `maxChars=0` means "no truncation" — but the disk cache is still written for complex pages
- **Deprecate `full`** — add note to param description, `maxChars` wins if both set

**Implementation detail:** Rather than adding `maxChars` logic to the router's inline truncation (which already calls `compactSnapshot()`), add it as a post-processing step:

```typescript
let inlineText = compactSnapshot(fullSnapshot, elementCount);
if (maxChars !== undefined && maxChars > 0 && inlineText.length > maxChars) {
  let cut = inlineText.lastIndexOf("\n", maxChars);
  if (cut < maxChars / 2) cut = maxChars;
  inlineText = inlineText.slice(0, cut) + `\n… ${inlineText.length - cut} more chars`;
}
// If maxChars === 0, no truncation — use full snapshot
if (maxChars === 0) {
  inlineText = fullSnapshot;
}
```

This keeps `compactSnapshot()` pure and puts `maxChars` handling in the router where it belongs.

---

## 5. Tool Registration

### New Tool

| Tool | Registered In | Token Cost |
|------|--------------|------------|
| `browser-query` | `index.ts` | ~100–150 tokens/turn (schema) |

### Updated Tools

| Tool | Changes |
|------|---------|
| `browser-navigate` | Add `maxChars` param. Output includes cache notice when truncated. |
| `browser-snapshot` | Add `maxChars` param. Deprecate `full` param. Output includes cache notice when truncated. |

---

## 6. File Changes Summary

| File | Changes | Lines (est.) |
|------|---------|-------------|
| **`core/shared/snapshot-cache.ts`** | New file — `cacheSnapshot()`, `removeSnapshotFiles()`, `removeAllSnapshotFiles()`, `formatCacheNotice()`, error handling | ~90 |
| **`core/shared/accessibility-tree.ts`** | Export `roleIcon()` | ~3 |
| **`core/plugin-api.ts`** | Add `getElementCache(taskId)` to `BrowserPlugin` interface | ~6 |
| **`core/router.ts`** | Add disk caching after `compactSnapshot()` calls in `navigate()`, `snapshot()`, `compactInteractionResult()`. Add `formatCacheNotice()` usage. Add `maxChars` post-processing. | ~60 |
| **`core/shared/session-manager.ts`** | Add `removeSnapshotFiles()` call on session removal | ~5 |
| **`backends/chromium/index.ts`** | Change `getElementCache()` from `private` to `public` | ~1 |
| **`backends/python-adapter.ts`** | Add `_elementCache` field, populate from navigate/snapshot responses, implement `getElementCache()`, add `_fetchElementCache()` async helper | ~55 |
| **`backends/python-base/pi_browser_bridge/bridge.py`** | Add `browser.getElementCache` RPC handler | ~15 |
| **`backends/chromium-py/bridge.py`** | No changes (inherits from `python-base`) | 0 |
| **`index.ts`** | Register `browser-query` tool. Add `maxChars` param to navigate + snapshot. Keep safety-net cap with comment. Surface cache notice via `filePath` in details. | ~130 |
| **`__tests__/snapshot-cache.test.ts`** | New file — temp file creation, cleanup, tracking, error handling, MAX_FILES_PER_TASK | ~60 |
| **`__tests__/router-dispatch.test.ts`** | Tests for disk caching in navigate/snapshot/interaction results | ~50 |
| **`__tests__/browser-query.test.ts`** | New file — role filter, name filter, ref lookup, subtree filter, Python adapter cache | ~80 |
| **`AGENTS.md`** | Document `browser-query` tool, disk caching, `maxChars` parameter, Python parity | ~25 |

**Total new/changed code: ~580 lines**

---

## 7. Implementation Order

### Phase 1: Disk Cache (Foundation)

The disk cache is the highest-priority change — it eliminates information loss entirely and requires no new tools or parameters.

1. **Create `core/shared/snapshot-cache.ts`** — `cacheSnapshot()`, `removeSnapshotFiles()`, `removeAllSnapshotFiles()`, `formatCacheNotice()`, try-catch on writeFileSync, timestamped filenames, MAX_FILES_PER_TASK = 2
2. **Update `navigate()` in `core/router.ts`** — call `cacheSnapshot()` after `compactSnapshot()`, append `formatCacheNotice()` when file created
3. **Update `snapshot()` in `core/router.ts`** — same integration
4. **Update `compactInteractionResult()` in `core/router.ts`** — cache when `result.newUrl !== session.currentUrl`
5. **Update `index.ts`** — add comment to safety-net cap (keep it!), add `filePath` to details
6. **Wire cleanup** — `sessionManager.removeSession()` → `removeSnapshotFiles()`, `removeAll()` → `removeAllSnapshotFiles()`
7. **Write tests** — `snapshot-cache.test.ts`, update `router-dispatch.test.ts`
8. **Run full test suite** — all 422 existing tests + new ones pass

### Phase 2: `browser-query` Tool + Python Parity

Builds on the plugin element cache access pattern.

1. **Export `roleIcon()` from `accessibility-tree.ts`**
2. **Add `getElementCache(taskId)` to `BrowserPlugin` interface** in `plugin-api.ts`
3. **Make `ChromiumPlugin.getElementCache()` public** — change `private` to `public`
4. **Extend Python bridge responses** — add `elements` dict to `navigate` and `snapshot` responses
5. **Add `browser.getElementCache` RPC method** to Python bridge (`bridge.py`)
6. **Add `_elementCache` + `getElementCache()` + `_fetchElementCache()`** to `PythonPluginAdapter`
7. **Create `browser-query` tool** in `index.ts` — parameter definition, execute logic, rendering
8. **Register tool** in `index.ts` — add to `registerTools()` call
9. **Test subtree depth approximation** on 5-10 real pages — if it fails, add `parentRef` to `AriaCachedNode`
10. **Write tests** — `browser-query.test.ts` with mock plugin + Python adapter cache
11. **Run full test suite**

### Phase 3: `maxChars` Parameter

Trivial addition once the caching infrastructure exists from Phase 1.

1. **Add `maxChars` parameter** to `browser-navigate` and `browser-snapshot` in `index.ts`
2. **Wire through** to router — add `maxChars` to navigate/snapshot options, apply as post-processing after `compactSnapshot()`
3. **Deprecate `full`** — add deprecation note to param description
4. **Update hint text** — replace `"use full=true for complete tree"` with `"use maxChars=0 for full snapshot"` in `compactSnapshot()` tail text
5. **Write tests** — `maxChars` variants in `router-dispatch.test.ts`
6. **Run full test suite**

---

## 8. What Does NOT Change

| Layer | Why It Stays |
|-------|-------------|
| `extractDialogBlocks()` | Dialog visibility detection in truncated snapshots. Orthogonal to caching. |
| Snapshot fingerprint warnings | Detect SPA transitions. Caching uses fingerprints in notices, doesn't change the mechanism. |
| `browser_finetuning.md` | Occlusion/dialog methodology. Unchanged. |
| `checkOcclusion()` | Runtime occlusion detection. Unchanged. |
| `verifyClick` fallback | Runtime safety net. Unchanged. |
| `url-safety.ts` | Security boundary. Unchanged. |
| `bot-detection.ts` | Bot detection. Bot-detected snapshots are not cached. |
| `compactSnapshot()` function signature | Stays pure — `(snapshot, elementCount) → string`. No disk I/O. |
| `compactInteractionResult()` same-page behavior | No disk caching for same-page interaction results. Unchanged logic. |
| Python `parse_snapshot()` | No changes — the parser and `AriaCachedNode` shape are identical to TypeScript. |
| 13 core `BrowserPlugin` operations | Unchanged — `getElementCache()` is additive. |

---

## 9. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Stale cached file after SPA mutation** | Medium | Cache notice includes fingerprint and scoped validity warning. Agent should re-snapshot after mutations. |
| **Interaction navigations uncached** (v1 gap) | ~~Medium~~ Fixed | `compactInteractionResult()` now caches when `result.newUrl !== session.currentUrl`. |
| **Subtree queries are approximate** (depth-based) | Low-Med | Test on real pages before Phase 2 ships. Add `parentRef` if depth-based fails. |
| **Disk I/O exceptions** | Low | try-catch in `cacheSnapshot()` — graceful degradation to inline-only. |
| **Element cache on Python adapter is stale after interactions** | Low | `_fetchElementCache()` async refresh called by router before `browser-query`. |
| **`browser-query` adds ~100-150 tokens/turn** | Low | Fixed schema cost. Savings from avoiding full snapshots (15-25KB) far exceed overhead. |
| **Temp files accumulate** | Low | Per-task tracking, MAX_FILES_PER_TASK=2, cleanup on session removal. |
| **Plugin encapsulation** (v1 Option B concern) | ~~Medium~~ Fixed | Using Option A — `getElementCache()` on the interface, Map stays in each plugin. |
| **`maxChars=0` convention** | Low | Parameter description explicitly states meaning. Disk cache makes `maxChars=0` less necessary. |
| **Python bridge response size increase** (elements in navigate/snapshot) | Low | Elements map is typically small (a few hundred entries × ~6 fields). Estimated ~5-15KB increase per response, negligible compared to snapshot text. |
| **`roleIcon` export creates API surface** | Low | Icon set is stable. Acceptable tradeoff for DRY formatting. |
| **Concurrent snapshot caching race** | Low | Tool calls are serialized per turn. Timestamped filenames prevent collisions. |

---

## 10. Example Workflows

### Before (Current)

Agent visits Reddit, sees 5 of 87 elements. Wants to click "Submit a new post" link but it's past the truncation boundary.

```
Agent: browser-snapshot full=true     → 15KB into context
Agent: (scans 15KB of text, finds @e42)
Agent: browser-click ref="@e42"
```

Cost: ~15,000 tokens of snapshot context.

### After — Disk Cache

```
Agent: browser-navigate "reddit.com"  → compact snapshot + cache notice + fingerprint
Agent: read /tmp/pi-browser/snapshot-default-a3f2b1c8-1718200000.txt offset=30 limit=20
Agent: (finds @e42 "Submit a new post")
Agent: browser-click ref="@e42"
```

Cost: ~2,500 tokens inline + ~500 tokens read fragment.

### After — `browser-query`

```
Agent: browser-navigate "reddit.com"  → compact snapshot + cache notice
Agent: browser-query role="link" name="submit"
       → Found 1 element:
           @e42 🔗 link "Submit a new post"
Agent: browser-click ref="@e42"
```

Cost: ~2,500 tokens inline + ~100 tokens query result.

### After — Dialog Discovery

```
Agent: browser-navigate "reddit.com"  → compact snapshot + cache notice
Agent: browser-query role="button" subtree="dialog"
       → Found 2 elements:
           @e2 🔘 button "Reject All"
           @e3 🔘 button "Accept All"
Agent: browser-click ref="@e2"
Agent: browser-snapshot              → fresh compact snapshot
```

Cost: ~2,500 + ~100 + ~2,500 = ~5,100 tokens total. No full snapshots needed.

### After — Interaction That Navigates

```
Agent: browser-click ref="@e5"        → click triggers navigation to new page
       → compact snapshot of new page + cache notice (if truncated)
Agent: browser-query role="button" name="back"
       → Found 1 element:
           @e12 🔘 button "Go Back"
```

Cost: Automatic — no need for a separate snapshot to discover elements on the new page.

---

## 11. Python Backend Parity Details

### What's Already Aligned

| Aspect | TypeScript (chromium) | Python (chromium-py) |
|--------|----------------------|---------------------|
| Snapshot API | `page.ariaSnapshot()` | `page.aria_snapshot()` |
| Parser | `parseSnapshot()` in `accessibility-tree.ts` | `parse_snapshot()` in `accessibility.py` |
| `AriaCachedNode` shape | `ref, role, name, props, depth, raw, occurrenceIndex` | `ref, role, name, props, depth, raw, occurrence_index` |
| Element cache location | `ChromiumPlugin._elementCache` (private Map) | `BrowserBridge.element_caches` (dict in subprocess) |
| Dialog prioritization | Same algorithm | Same algorithm (mirrored) |
| Role icon mapping | `_ROLE_ICONS` in `accessibility-tree.ts` | `_ROLE_ICONS` in `accessibility.py` |

### What Needs Work

| Change | TypeScript Side | Python Side |
|--------|----------------|-------------|
| `getElementCache()` on interface | Add to `BrowserPlugin` | N/A (interface only) |
| Public `getElementCache()` | Make existing method public | N/A (handled by adapter) |
| Element cache in responses | N/A (direct access) | Serialize `elements` dict in navigate/snapshot responses |
| `browser.getElementCache` RPC | N/A | Add handler in `bridge.py` |
| Adapter local cache | N/A | Add `_elementCache` + `_fetchElementCache()` to `PythonPluginAdapter` |
| `roleIcon` export | Export from `accessibility-tree.ts` | N/A (already has `_role_icon()` in Python) |

### No Changes Required To

- `accessibility.py` parser or `AriaCachedNode` shape (already identical)
- `chromium-py/bridge.py` (inherits from `python-base/`, which gets the new RPC handler)
- Python bridge's 13 core operations (they continue to work as before)
