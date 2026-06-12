# Snapshot Cache & Query Plan

> Date: 2026-06-12
> Status: **Draft** — implementation plan for disk-cached snapshots + structured querying
> Prerequisite: none (independent of web-guides proposal)

---

## 1. Problem

When `compactSnapshot()` truncates the accessibility tree to ~2500 chars, every element past the cut line vanishes from the agent's context. The agent cannot click links it can't see, cannot fill forms it doesn't know exist, and cannot dismiss dialogs whose buttons were truncated away.

The current escape hatch is `full=true` on `browser-snapshot`, which returns the entire tree — but on a complex page (Reddit, GitHub, news sites), the full tree can be 15–25KB. Dumping that into context is often worse than the truncation it avoids.

Two distinct problems need solving:

| Problem | Example |
|---------|---------|
| **Information loss** — elements exist but are invisible to the agent | "I know there's a submit button but I can't see its @e ref" |
| **Element discovery** — agent needs to find specific elements without scanning the whole tree | "Find all links on this page" or "What buttons are in this dialog?" |

---

## 2. Approach: Two Complementary Features

### Feature A — Snapshot Disk Cache

Following the `web-fetch` pattern: truncate the snapshot inline, write the full untruncated tree to a temp file, tell the agent where to find it.

**Key insight:** `@e` refs in the cached file are still valid for interaction. The `elements` Map is stored in the session (in-memory, keyed by taskId). When the agent calls `browser-click ref="@e42"`, the router resolves `e42` from the session's element cache — not from whatever text the agent last saw. The agent only needs the `@e` ref string; it doesn't matter whether it found that ref in the inline snapshot or by reading the cached file.

### Feature B — `browser-query` Tool

A purpose-built tool that queries the in-memory `elements` Map from the active browser session. Supports filtering by role, name, ref lookup, and subtree scoping. Returns structured results with `@e` refs the agent can immediately use for interaction.

**Key insight:** This queries the live session data, not a stale disk file. No staleness issues. No external tool dependencies (`jq`, `rg`). The agent just calls the tool with the filters it needs.

---

## 3. Feature A: Snapshot Disk Cache

### 3.1 How `web-fetch` Does It (Existing Pattern)

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

### 3.2 Adaptation for Snapshots

The snapshot case differs from fetch in two ways:

1. **Snapshots are always produced** (even short ones), so we should only cache when truncation actually happened (snapshot > `COMPACT_SNAPSHOT_NO_TRUNCATE` = 2800 chars)
2. **The truncation hint text matters** — it should tell the agent about `@e` refs being valid, not just that the file exists

### 3.3 New Code: `core/shared/snapshot-cache.ts`

A self-contained module following the same pattern as fetch-backend's temp file logic:

```typescript
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const SNAPSHOT_TEMP_DIR = `${tmpdir()}/pi-browser`;

/** Tracks active snapshot temp files per task */
const activeSnapshotFiles = new Map<string, string[]>();

interface CachedSnapshot {
  /** The inline (potentially truncated) snapshot text */
  inline: string;
  /** Path to temp file with full snapshot (only when truncation occurred) */
  filePath?: string;
  /** Total chars before truncation */
  totalChars: number;
}

/**
 * Cache a full snapshot to disk if truncation occurred.
 * Returns the inline text (unchanged if no truncation) and optional file path.
 */
function cacheSnapshot(
  snapshot: string,
  taskId: string,
  wasTruncated: boolean,
): CachedSnapshot {
  const totalChars = snapshot.length;

  if (!wasTruncated) {
    return { inline: snapshot, totalChars };
  }

  // Write full snapshot to temp file
  mkdirSync(SNAPSHOT_TEMP_DIR, { recursive: true });
  const hash = createHash("sha256").update(snapshot).digest("hex").slice(0, 8);
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9-]/g, "_");
  const filePath = `${SNAPSHOT_TEMP_DIR}/snapshot-${safeTaskId}-${hash}.txt`;
  writeFileSync(filePath, snapshot, "utf-8");

  // Track and clean up stale files for this task
  const existing = activeSnapshotFiles.get(taskId) ?? [];
  for (const oldPath of existing) {
    try { rmSync(oldPath, { force: true }); } catch { /* best-effort */ }
  }
  activeSnapshotFiles.set(taskId, [filePath]);

  return { inline: snapshot, filePath, totalChars };
}

/** Remove all snapshot temp files for a task (called on session cleanup) */
function removeSnapshotFiles(taskId: string): void { ... }

/** Remove all snapshot temp files (called on shutdown) */
function removeAllSnapshotFiles(): void { ... }
```

### 3.4 Integration into `compactSnapshot()`

**Current signature:**
```typescript
export function compactSnapshot(snapshot: string, elementCount: number): string
```

**New signature:**
```typescript
export function compactSnapshot(
  snapshot: string,
  elementCount: number,
  options?: CompactOptions,
): CompactResult

interface CompactOptions {
  /** Agent-requested max chars for inline content. undefined = auto. 0 = no truncation. */
  maxChars?: number;
  /** Task ID for disk caching */
  taskId?: string;
}

interface CompactResult {
  /** The inline (potentially truncated) snapshot text */
  text: string;
  /** Path to temp file with full snapshot (only when truncation occurred) */
  filePath?: string;
  /** Total chars before truncation */
  totalChars: number;
  /** Whether truncation occurred */
  wasTruncated: boolean;
}
```

**Logic flow:**

```
1. Apply truncation logic (auto or maxChars-controlled) → get truncated text
2. If truncation occurred AND taskId is provided:
     cache full snapshot to disk, get filePath
     append cache notice to truncated text
3. Return CompactResult
```

**Cache notice format (appended to inline text):**

```
📄 Full snapshot saved to /tmp/pi-browser/snapshot-default-a3f2b1c8.txt (11KB).
   Use read with offset/limit to find specific elements — @e refs in the file are still valid for interaction.
```

~120 chars. Small compared to the ~2500 char snapshot. Only appears when truncation actually happened.

### 3.5 Integration into Router

#### `navigate()` in `core/router.ts`

The navigate function currently calls `compactSnapshot()` in two places:
1. The normal path (line ~174) — compact the snapshot
2. The bot-detected path — pass through unmodified

For the normal path, pass `taskId` from `options.taskId`:

```typescript
const compacted = compactSnapshot(result.snapshot, result.elementCount, {
  taskId: options.taskId,
});
// compacted.text — the inline text (with cache notice if truncated)
// compacted.filePath — the temp file path (if truncated)
```

For the bot-detected path: **no caching.** Bot-detected snapshots pass through unmodified, and we don't want to cache a potentially misleading snapshot.

#### `snapshot()` in `core/router.ts`

Same integration. Pass `taskId` from the function argument.

#### `compactInteractionResult()` helper

This helper applies compaction to auto-snapshots in interaction results (click, type, etc.). These should **not** cache to disk — interaction results are follow-up snapshots, not primary navigation results. The agent already has the full context from the initial navigate. Only the primary navigate/snapshot should cache.

This means `compactInteractionResult()` calls `compactSnapshot()` without `taskId`, so no disk caching occurs.

### 3.6 Integration into `index.ts`

#### `browser-navigate` tool

After getting the `CompactResult`, check if `filePath` is set:

```typescript
// Build the output lines
const lines = [
  `Title: ${result.title || "(no title)"}`,
  `URL: ${result.url}`,
  `Backend: ${result.backendUsed}`,
  result.elementCount !== undefined ? `Interactive elements: ${result.elementCount}` : "",
  "",
  compacted.text,  // includes cache notice if truncated
];
```

The safety-net cap (the `contentText.length > 8000` block around line 140) should be removed — `compactSnapshot()` now handles all truncation and caching centrally. That block was a secondary safety net that's redundant with the new system.

**Tool details:** add `filePath` to `details` so the TUI renderer can show it differently.

#### `browser-snapshot` tool

Same integration. The `filePath` from `CompactResult` is surfaced in the tool output.

### 3.7 Cleanup

- `sessionManager.removeSession()` → call `removeSnapshotFiles(taskId)`
- `sessionManager.removeAll()` → call `removeAllSnapshotFiles()`
- Process exit → `removeAllSnapshotFiles()` (best-effort, temp dir is cleaned by OS)

### 3.8 Temp File Format

The cached file is the **full, untruncated snapshot** — the same formatted text the agent would see with `full=true`. It includes:

- All `@e` refs (up to `maxElements` = 500)
- Role icons and names
- Indentation showing hierarchy
- Property annotations (`[level=1]`, `[checked]`, etc.)

Example (first 20 lines of a cached file):

```
  @e1 ⚠ dialog "Data Protection Consent"
    @e2 🔘 button "Reject All"
    @e3 🔘 button "Accept All"
  📄 main
    📌 heading "Popular near you" [level=2]
    📰 article
      🔗 link "TIL that honey never spoils"
      🔗 link "542 comments"
    📰 article
      🔗 link "Why do cats purr?"
      🔗 link "189 comments"
    📰 article
      🔗 link "The oldest living tree"
      🔗 link "97 comments"
  📄 contentinfo
    🔗 link "Privacy Policy"
    🔗 link "Terms"
    🔗 link "Help"
```

The agent can use `rg` to search it:

```bash
# Find all links
rg "🔗 link" /tmp/pi-browser/snapshot-default-a3f2b1c8.txt

# Find a specific button
rg "button.*Submit" /tmp/pi-browser/snapshot-default-a3f2b1c8.txt

# What's @e42?
rg "@e42 " /tmp/pi-browser/snapshot-default-a3f2b1c8.txt
```

Or `read` with offset/limit to browse sections.

---

## 4. Feature B: `browser-query` Tool

### 4.1 Tool Definition

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

### 4.2 Implementation

The tool queries the in-memory `elements` Map from the active session's plugin. The key data structure is already there — `AriaCachedNode` has `ref`, `role`, `name`, `props`, `depth`.

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

  const plugin = pluginRegistry.get(session.pluginName) as ChromiumPlugin | undefined;
  if (!plugin) {
    return {
      content: [{ type: "text", text: `Plugin '${session.pluginName}' not available.` }],
    };
  }

  // Get the element cache from the plugin
  const elements = plugin.getElementCache(tid);

  // Single ref lookup
  if (ref) {
    const node = elements.get(ref.replace("@", ""));
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

  // If subtree specified, find the subtree root(s) and their depth range
  let subtreeRoots: AriaCachedNode[] = [];
  let subtreeDepths = new Map<number, number>(); // depth → count of open subtree roots
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

    // Subtree filter
    if (subtree) {
      const isInsideSubtree = subtreeRoots.some(root => {
        if (node === root) return true; // include the root itself
        return node.depth > root.depth; // must be deeper than root
        // Note: this is approximate — doesn't check that the node is
        // actually a descendant of THIS root vs. a sibling at the same depth.
        // For typical pages this works well. Edge cases: multiple dialogs
        // at the same depth with different content.
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

### 4.3 Subtree Query Semantics

The subtree filter works by:

1. Finding all elements matching the subtree role (e.g. all `dialog` elements)
2. Including those root elements AND all elements with a greater depth than the root

This is **approximate** — it assumes that elements deeper in the tree are descendants of the subtree root. This works well for typical page structures where a `dialog` or `navigation` element contains its children at greater depth.

**Known limitation:** If two containers with the same role are siblings at the same depth, and one closes before the other opens, the depth-based approach may include elements from the second container in a query scoped to the first. This is an edge case that doesn't arise in practice for the main use cases (dialogs, navigation, main content area).

**Future improvement:** If this proves insufficient, we can track parent-child relationships in `AriaCachedNode` by adding an optional `parentRef` field. This requires changes to `parseSnapshot()` but would enable exact subtree queries.

### 4.4 Plugin API Change

To support `browser-query`, we need a way to access the element cache from outside the plugin. Currently, the cache is private to `ChromiumPlugin`.

**Option A (minimal):** Add a `getElementCache(taskId)` method to `BrowserPlugin` interface.

**Option B (decoupled):** Store the `AriaParseResult` (or just the `elements` Map) in the `BrowserSession` object in `session-manager.ts`, rather than in the plugin. The plugin writes to the session on each snapshot; `browser-query` reads from the session.

**Recommendation: Option B.** The session is already the coordination point between tools and the plugin. Storing the element cache there:
- Makes it accessible to any tool without reaching into the plugin
- Survives plugin restarts (the session persists)
- Is consistent with how `currentUrl`, `currentTitle`, `currentSnapshotFingerprint` are already stored on the session

Changes to `BrowserSession`:

```typescript
interface BrowserSession {
  // ... existing fields ...
  /** Cached element map from last snapshot (ref → AriaCachedNode) */
  elementCache: Map<string, AriaCachedNode>;
}
```

The plugin writes to `session.elementCache` after each `snapshot()` call (in `takeSnapshot()`). The `browser-query` tool reads from `session.elementCache`.

### 4.5 `maxChars` Parameter (Bonus)

With the caching infrastructure in place, adding `maxChars` to `browser-navigate` and `browser-snapshot` is trivial:

- Pass `maxChars` through `CompactOptions` to `compactSnapshot()`
- The disk cache always stores the full snapshot regardless of `maxChars`
- The inline text is truncated to `maxChars` (or auto if undefined)
- `maxChars=0` means "no truncation" — but the disk cache is still written for complex pages

This gives the agent fine-grained control over inline content size while preserving the disk cache safety net.

### 4.6 `full` Parameter Deprecation

With `maxChars` available:
- `full=true` → equivalent to `maxChars=0`
- `full=false` (default) → equivalent to `maxChars=undefined` (auto)
- Add deprecation note to `full` param description
- Keep `full` working for backward compatibility
- If both `full` and `maxChars` are passed, `maxChars` wins

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
| **`core/shared/snapshot-cache.ts`** | New file — temp file management, `cacheSnapshot()`, cleanup | ~80 |
| **`core/shared/accessibility-tree.ts`** | Export `roleIcon` (currently private) for `browser-query` formatting | ~3 |
| **`core/router.ts`** | Update `compactSnapshot()` signature + return type. Update callers (`navigate`, `snapshot`, `compactInteractionResult`). Add `maxChars` support. | ~40 |
| **`core/shared/session-manager.ts`** | Add `elementCache` to `BrowserSession`. Cleanup snapshot temp files on session removal. | ~15 |
| **`backends/chromium/index.ts`** | Write `parsed.elements` to `session.elementCache` after each snapshot. | ~5 |
| **`index.ts`** | Register `browser-query` tool. Add `maxChars` param to navigate + snapshot. Surface cache notice. Remove safety-net cap in navigate. | ~120 |
| **`__tests__/router-dispatch.test.ts`** | Tests for `compactSnapshot()` with `maxChars` + disk caching | ~60 |
| **`__tests__/snapshot-cache.test.ts`** | New file — temp file creation, cleanup, tracking | ~50 |
| **`__tests__/browser-query.test.ts`** | New file — role filter, name filter, ref lookup, subtree filter | ~70 |
| **`AGENTS.md`** | Document `browser-query` tool, disk caching, `maxChars` parameter | ~20 |

**Total new/changed code: ~463 lines**

---

## 7. Implementation Order

### Phase 1: Disk Cache (Foundation)

The disk cache is the highest-priority change — it eliminates information loss entirely and requires no new tools or parameters.

1. **Create `core/shared/snapshot-cache.ts`** — `cacheSnapshot()`, `removeSnapshotFiles()`, `removeAllSnapshotFiles()`
2. **Update `compactSnapshot()` in `core/router.ts`** — new `CompactOptions`/`CompactResult` types, integrate caching
3. **Update `navigate()` in `core/router.ts`** — pass `taskId` to `compactSnapshot()`, surface `filePath`
4. **Update `snapshot()` in `core/router.ts`** — same
5. **Update `index.ts`** — surface cache notice in navigate/snapshot output, add `filePath` to details, remove safety-net cap
6. **Wire cleanup** — `sessionManager.removeSession()` → `removeSnapshotFiles()`, `removeAll()` → `removeAllSnapshotFiles()`
7. **Write tests** — `snapshot-cache.test.ts`, update `router-dispatch.test.ts`
8. **Run full test suite** — all 422 existing tests + new ones pass

### Phase 2: `browser-query` Tool

Builds on the session element cache from Phase 1 (or rather, the existing plugin cache that we'll migrate to the session).

1. **Add `elementCache` to `BrowserSession`** in `session-manager.ts`
2. **Update `ChromiumPlugin.takeSnapshot()`** — write `parsed.elements` to `session.elementCache`
3. **Export `roleIcon()` from `accessibility-tree.ts`** — for query result formatting
4. **Create `browser-query` tool** in `index.ts` — parameter definition, execute logic, rendering
5. **Register tool** in `index.ts` — add to `registerTools()` call
6. **Write tests** — `browser-query.test.ts` with mock plugin
7. **Run full test suite**

### Phase 3: `maxChars` Parameter

Trivial addition once the `CompactOptions` type exists from Phase 1.

1. **Add `maxChars` parameter** to `browser-navigate` and `browser-snapshot` in `index.ts`
2. **Wire through** to `CompactOptions` → `compactSnapshot()`
3. **Update hint text** — replace `"use full=true for complete tree"` with `"use maxChars=0 for full snapshot"` in `compactSnapshot()` tail text
4. **Deprecate `full`** — add deprecation note to param description
5. **Write tests** — `maxChars` variants in `router-dispatch.test.ts`
6. **Run full test suite**

---

## 8. What Does NOT Change

| Layer | Why It Stays |
|-------|-------------|
| `extractDialogBlocks()` | Dialog visibility detection in truncated snapshots. Orthogonal to caching. |
| Snapshot fingerprint warnings | Detect SPA transitions. Caching doesn't affect this. |
| `browser_finetuning.md` | Occlusion/dialog methodology. Unchanged. |
| `checkOcclusion()` | Runtime occlusion detection. Unchanged. |
| `verifyClick` fallback | Runtime safety net. Unchanged. |
| `url-safety.ts` | Security boundary. Unchanged. |
| `bot-detection.ts` | Bot detection. Bot-detected snapshots are not cached. |
| Plugin API (13 operations) | Unchanged — element cache migration is additive. |
| `compactInteractionResult()` | Interaction results don't cache to disk. Unchanged logic. |

---

## 9. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Stale cached file after page mutation** | Low | Cache notice says "@e refs in the file are still valid" but agent should re-snapshot after mutations. Fingerprint warnings already detect DOM changes. |
| **Subtree queries are approximate (depth-based)** | Low | Works for all common patterns (dialog, navigation, main). Exact parent tracking can be added later if needed. |
| **`browser-query` adds ~100–150 tokens/turn** | Low | Fixed cost. Savings from avoiding full snapshots (15–25KB) far exceed overhead. Agent that doesn't need query pays nothing (tool is not called). |
| **Temp files accumulate** | Low | Per-task tracking + cleanup on session removal. Best-effort on process crash; OS cleans /tmp. |
| **Element cache on session vs. plugin** | Medium | Migration is mechanical — just move where the Map lives. Plugin still populates it; session just stores it. |
| **`maxChars=0` convention is confusing** | Low | Parameter description explicitly states meaning. Disk cache makes `maxChars=0` less necessary (agent can always find elements via cache or query). |

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
Agent: browser-navigate "reddit.com"  → compact snapshot + cache notice
Agent: read /tmp/pi-browser/snapshot-default-a3f2b1c8.txt offset=30 limit=20
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
