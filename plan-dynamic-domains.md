# Implementation Plan: Dynamic Domain Mapping & `web-learn` Tool

> Builds on the existing guide system (`core/guides.ts`, `web-guide` tool,
> presence resolution). Closes the gap where user-authored guides couldn't
> trigger auto-hints, and adds an agent-facing tool for saving and updating
> navigation patterns.
>
> Total new code: ~300 lines across 5 files + tests (~130 lines).

---

## Overview

Three changes:

1. **Dynamic domain lookup** — replaces the static `DOMAIN_MAP` lookup with a
   lazy-cache built from each guide's frontmatter `domains` field. Users who
   drop a guide file into `guides/` automatically get domain hints without
   editing source code.

2. **`web-learn` tool** — tool for saving and updating navigation guides in
   `guides/`, invoked in response to a user request. Handles file writing,
   frontmatter generation, and cache invalidation. Gated behind `/web learn` —
   when the toggle is off, the tool isn't in the active tool set (see change 3).

3. **Two-state `/web` command, extended** — `/web on` (browsing only),
   `/web learn` (browsing + `web-learn` tool available), `/web off` (none).
   Internally stores two independent booleans (`browserToolsEnabled`,
   `learnToolsEnabled`) so the semantics are unambiguous. Legacy `{enabled}`
   entries from the old two-state toggle map both booleans to the same value.
   The agent never calls `web-learn` unprompted — it only saves or updates
   guides in response to the user's explicit or contextual request.

---

## Step 1: Add `domains` to the Guide Interface (`core/guides.ts`)

**File:** `core/guides.ts`

Add an optional `domains` field to `Guide`:

```typescript
export interface Guide {
  content: string;
  updated: string;
  category: GuideCategory;
  source: GuideSource;
  /** Domain name(s) this site guide applies to. Pattern guides leave this empty. */
  domains?: string[];
  /** Pattern guides only; site guides use domains or DOMAIN_MAP. */
  trigger?: GuideTrigger;
}
```

**Acceptance:** `domains` is optional — existing builtin guides compile
without changes. `domains: reddit.com, www.reddit.com` parses to
`["reddit.com", "www.reddit.com"]`.

**Depends on:** Nothing.

---

## Step 2: Parse `domains` from YAML Frontmatter (`core/guides.ts`)

**File:** `core/guides.ts` — modify `parseGuideContent`

Add parsing of a comma-separated `domains` field:

```typescript
const rawDomains = meta["domains"];
const domains: string[] | undefined = rawDomains
  ? rawDomains.split(",").map((d) => d.trim()).filter(Boolean)
  : undefined;
```

Include in the returned Guide:

```typescript
return [
  name,
  {
    category,
    source: "user" as GuideSource,
    updated,
    content: content.trim(),
    domains,
    ...(trigger ? { trigger } : {}),
  },
];
```

**Acceptance:**
- `domains: reddit.com, www.reddit.com` → `["reddit.com", "www.reddit.com"]`
- Missing field → `undefined`
- Trailing commas filtered, whitespace trimmed
- Existing builtin guides without `domains` still parse correctly

**Depends on:** Step 1.

---

## Step 3: Add `getGuideContent` / `invalidateGuideContent` (`core/guides.ts`)

**File:** `core/guides.ts`

Convert the module-level `GUIDE_CONTENT` const to a lazy getter so newly
created guides appear mid-session without a reload. This step must come
before the dynamic domain map (Step 4) because `buildDomainMap()` derives
from `getGuideContent()`.

**Change 1 — replace the const:**

```typescript
// Remove:
export const GUIDE_CONTENT: Record<string, Guide> = {
  ...BUILTIN_GUIDES,
  ...loadUserGuides(),
};

// Add:
let _guideContentCache: Record<string, Guide> | null = null;

export function getGuideContent(): Record<string, Guide> {
  if (!_guideContentCache) {
    _guideContentCache = {
      ...BUILTIN_GUIDES,
      ...loadUserGuides(),
    };
  }
  return _guideContentCache;
}

export function invalidateGuideContent(): void {
  _guideContentCache = null;
}
```

**Change 2 — export `GUIDES_DIR`** (needed by `web-learn` in Step 5):

```typescript
// Already defined as:
// const GUIDES_DIR = join(__dirname, "..", "guides");
// Change to:
export const GUIDES_DIR = join(__dirname, "..", "guides");
```

**Change 3 — update all internal references:**

| Location | Before | After |
|----------|--------|-------|
| `formatGuideList()` — iterate | `Object.entries(GUIDE_CONTENT)` | `Object.entries(getGuideContent())` |
| `resolveGuidePresence()` — bot-detection | `GUIDE_CONTENT["bot-detection"]` | `getGuideContent()["bot-detection"]` |
| `resolveGuidePresence()` — dialog | `GUIDE_CONTENT["cookie-consent"]` | `getGuideContent()["cookie-consent"]` |
| `resolveGuidePresence()` — domain | `GUIDE_CONTENT[entry.guide]` | `getGuideContent()[entry.guide]` |

**Change 4 — update `index.ts`:**

```typescript
// Import:
import {
  ...
  getGuideContent,
} from "./core/guides.js";

// In web-guide tool execute handler:
const entry = getGuideContent()[guide];
// Also in error message:
Object.keys(getGuideContent()).join(", ")
```

**Change 5 — update `__tests__/web-guides.test.ts`:**

The test file currently imports `GUIDE_CONTENT` as a const and uses it in
assertions. All references must be updated:

```typescript
// Replace import:
//   GUIDE_CONTENT,
// With:
   getGuideContent,

// Replace all GUIDE_CONTENT[x] with getGuideContent()[x]
// Replace all Object.keys(GUIDE_CONTENT) with Object.keys(getGuideContent())
// Replace all Object.entries(GUIDE_CONTENT) with Object.entries(getGuideContent())
```

Specific test cases to update:
- `"all DOMAIN_MAP guide references exist in GUIDE_CONTENT"` → uses `GUIDE_CONTENT[entry.guide]`
- `"contains all builtin guides"` → uses `GUIDE_CONTENT[name]`
- `"builtin guides maintain trigger in GUIDE_CONTENT"` → uses `GUIDE_CONTENT["bot-detection"]`
- The `GUIDE_CONTENT merge` describe block → rename to `getGuideContent merge`

**Acceptance:** After `invalidateGuideContent()`, the next `web-guide` call or
presence resolution picks up newly created/user-authored guides. Test file
compiles and all existing tests pass with the getter.

**Depends on:** Step 2.

---

## Step 4: Build Dynamic Domain Map (`core/guides.ts`)

**File:** `core/guides.ts` — add lazy-cache functions

```typescript
// ── Dynamic Domain Map ──────────────────────────────────────────

let _domainMapCache: Record<string, DomainEntry> | null = null;

/**
 * Build a domain map from DOMAIN_MAP (static base) + all guides returned
 * by getGuideContent() that have a `domains` field. Derives from the
 * single source of truth (getGuideContent) rather than calling
 * loadUserGuides() independently — this keeps both caches consistent.
 */
export function buildDomainMap(): Record<string, DomainEntry> {
  const map: Record<string, DomainEntry> = { ...DOMAIN_MAP };
  for (const [name, guide] of Object.entries(getGuideContent())) {
    if (guide.category === "site" && guide.domains && guide.domains.length > 0) {
      for (const domain of guide.domains) {
        map[domain] = { guide: name };
      }
    }
  }
  return map;
}

export function getDomainMap(): Record<string, DomainEntry> {
  if (!_domainMapCache) {
    _domainMapCache = buildDomainMap();
  }
  return _domainMapCache;
}

export function invalidateDomainMap(): void {
  _domainMapCache = null;
}
```

> **Cache coherence note:** `buildDomainMap()` derives the domain map from
> `getGuideContent()`, not from `loadUserGuides()`. This means the domain map
> and guide content always agree — there is one source of truth. When
> `web-learn` writes a new guide, both `invalidateGuideContent()` and
> `invalidateDomainMap()` are called; the next `buildDomainMap()` call reads
> the freshly-built guide content, which already includes the new file.

**Wire into `resolveGuidePresence`** — replace the static `DOMAIN_MAP` lookup:

```typescript
  // 3. Domain-based hint
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  const entry = getDomainMap()[hostname];
  if (entry?.guide && getGuideContent()[entry.guide]) {
    let text = `💡 A web guide is available for ${hostname}.\n   Call web-guide guide="${entry.guide}" for navigation tips.`;
    if (entry.strategy) {
      text += `\n   This site often requires a stealth browser — try strategy="${entry.strategy}".`;
    }
    return { type: "hint", guideName: entry.guide, text };
  }
```

**Acceptance:**
- First `getDomainMap()` call builds from `getGuideContent()` and caches
- Subsequent calls hit cache (zero I/O)
- After `invalidateDomainMap()`, next call rescans
- Builtin `DOMAIN_MAP` fixture always included as base
- Pattern guides (no `domains` field) excluded from map
- `buildDomainMap()` derives from `getGuideContent()`, not `loadUserGuides()` — both caches stay consistent

**Depends on:** Step 3 (reads `getGuideContent()`).

---

## Step 5: Add `web-learn` Tool (`index.ts`)

**File:** `index.ts` — add tool definition and registration

The tool creates a new guide file or **updates an existing one** in response
to a user request. Guarded by `/web learn` — when off, the tool isn't in the
active tool set and incurs zero token cost.

The tool description is deliberately brief: it describes *what* the tool does
(save/update guide files) but not *when* to call it. The agent decides when
to invoke `web-learn` based on ordinary conversation context — if the user
asks to save a site's patterns or update an existing guide, the agent connects
the dots.

```typescript
// Static imports (alongside existing):
import {
  invalidateDomainMap,
  invalidateGuideContent,
  getGuideContent,
  GUIDES_DIR,
} from "./core/guides.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Tool: web-learn
// ============================================================
const webLearnTool = defineTool({
  name: "web-learn",
  label: "Learn Navigation Patterns",
  description:
    "Save or update a navigation guide for a site. " +
    "Creates a new guide file for the given domain, or updates an existing one with new content and date. " +
    "The guide becomes available immediately via web-guide and auto-hints on future navigations. " +
    "Requires /web learn to be active.",
  parameters: Type.Object({
    domain: Type.String({
      description: "Primary domain (e.g. 'reddit.com'). Used as the filename.",
    }),
    content: Type.String({
      description: "Markdown guidance content describing the site's navigation patterns, page structure, consent dialogs, and known quirks.",
    }),
    domains: Type.Optional(
      Type.String({
        description: "Comma-separated additional domains (e.g. 'www.reddit.com, old.reddit.com'). Omit if only the primary domain applies.",
      }),
    ),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { domain, content, domains } = params as {
      domain: string;
      content: string;
      domains?: string;
    };

    // ── Validation ────────────────────────────────────────────
    if (!domain.includes(".")) {
      return {
        content: [{ type: "text", text: `'${domain}' doesn't look like a domain. Use the full domain (e.g. 'reddit.com').` }],
      };
    }

    if (!content || content.trim().length < 20) {
      return {
        content: [{ type: "text", text: "Content too short. Provide at least a few sentences of guidance." }],
      };
    }

    // ── File path ─────────────────────────────────────────────
    // Reuse GUIDES_DIR from core/guides.ts — ensures the same directory
    // that loadUserGuides() reads from is where we write new guides.
    mkdirSync(GUIDES_DIR, { recursive: true });
    const filename = `${domain}.md`;
    const filepath = join(GUIDES_DIR, filename);

    // ── Build frontmatter ─────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const allDomains = [domain];
    if (domains) {
      for (const d of domains.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!allDomains.includes(d)) allDomains.push(d);
      }
    }

    const frontmatter = [
      "---",
      "category: site",
      `domains: ${allDomains.join(", ")}`,
      `updated: ${today}`,
      "---",
    ].join("\n");

    const fileContent = frontmatter + "\n\n" + content.trim() + "\n";

    // ── Detect whether this is a create or update ──────────────
    const isUpdate = existsSync(filepath);
    writeFileSync(filepath, fileContent, "utf-8");

    // ── Invalidate caches ────────────────────────────────────
    invalidateDomainMap();
    invalidateGuideContent();

    const verb = isUpdate ? "Updated" : "Created";
    return {
      content: [{
        type: "text",
        text: `📖 ${verb} guide at guides/${filename}\n` +
              `  Domains: ${allDomains.join(", ")}\n` +
              `  Call web-guide guide="${domain}" to view it.\n` +
              `  Auto-hints will fire when navigating to ${allDomains[0]}.`,
      }],
      details: {
        filePath: filepath,
        domains: allDomains,
        guideName: domain,
        isUpdate,
      },
    };
  },

  renderCall(args, theme, _context) {
    const parts: string[] = [
      theme.fg("toolTitle", theme.bold("web-learn ")),
    ];
    parts.push(theme.fg("accent", `"${args.domain}"`));
    return new Text(parts.join(" "), 0, 0);
  },
});
```

**Registration** — add alongside the other `pi.registerTool(...)` calls:

```typescript
pi.registerTool(webLearnTool);
```

**Acceptance:**
- `web-learn` is registered and appears in tool listing
- Calling with invalid domain returns error
- Calling with too-short content returns error
- First call for a domain creates the file and invalidates both caches
- Second call updates the file (new content, new `updated` date)
- Both caches reflect the change immediately after each write

**Depends on:** Step 4 (for `invalidateDomainMap`), Step 3 (for `invalidateGuideContent`).

---

## Agent Workflow: User-Initiated Learning

The `web-learn` tool is available when `/web learn` is active, but the agent
never calls it unprompted. The learning workflow is entirely user-initiated:

```
User asks: "save the patterns you found on this site"
                 │
                 ▼
Agent calls web-learn with domain + content + optional domains
                 │
                 ▼
Guide file created/updated → caches invalidated
                 │
                 ▼
Next browser-navigate to that domain → auto-hint fires
```

**What triggers the agent to call web-learn:**

- **Explicit ask:** "save this site's layout", "create a guide for reddit"
- **Update request:** "update the reddit guide with that consent dialog trick"
- **Implicit context:** the user has been exploring a site and says "note that down"
  or "remember this for next time"

The agent uses ordinary task reasoning to decide when `web-learn` is the
right tool — no special behavioral flags, prompts, or auto-decision logic.

---

## Step 6: Three-State `/web` Command (`browser-toggle.ts`)

**File:** `browser-toggle.ts`

Extend the existing two-state toggle to three states (`on`/`off`/`learn`) with
two internal booleans for unambiguous persistence.

### Persistence schema

```typescript
interface BrowserToggleState {
  browserToolsEnabled: boolean;
  learnToolsEnabled: boolean;
}
```

Legacy `{enabled: boolean}` entries (from the old two-state toggle) map both
booleans to the same value:

```typescript
function migrateLegacyState(data: unknown): BrowserToggleState | null {
  if (data && typeof data === "object" && "enabled" in data) {
    const enabled = (data as any).enabled === true;
    return { browserToolsEnabled: enabled, learnToolsEnabled: enabled };
  }
  return null;
}
```

### Command handler

```typescript
if (cmd === "on") {
  applyBrowserState(pi, true);
  applyLearnState(pi, false);
  persistState(pi, { browserToolsEnabled: true, learnToolsEnabled: false });
  ctx.ui.notify("🌐 Browser tools enabled. /web learn to make web-learn available.", "info");
} else if (cmd === "learn") {
  applyBrowserState(pi, true);
  applyLearnState(pi, true);
  persistState(pi, { browserToolsEnabled: true, learnToolsEnabled: true });
  ctx.ui.notify("📖 web-learn tool is now available. Agent will save/update guides when asked.", "info");
} else if (cmd === "off") {
  applyBrowserState(pi, false);
  applyLearnState(pi, false);
  persistState(pi, { browserToolsEnabled: false, learnToolsEnabled: false });
  ctx.ui.notify("🌐 Browser tools disabled. /web on to re-enable.", "info");
} else {
  // Status
  const browserStatus = isBrowserEnabled(pi) ? "✅ on" : "❌ off";
  const learnStatus = isLearnEnabled(pi) ? "✅ on" : "❌ off";
  ctx.ui.notify(
    `🌐 Browser tools: ${browserStatus}\n` +
    `📖 Learn mode: ${learnStatus}\n` +
    `   /web off     disable all browser tools\n` +
    `   /web on      enable browsing only\n` +
    `   /web learn   enable browsing + guide-saving\n` +
    `   /web         show this status`,
    "info",
  );
}
```

### New helpers

```typescript
const LEARN_TOOL_NAMES = new Set(["web-learn"]);

function getRegisteredLearnTools(pi: ExtensionAPI): string[] {
  return pi
    .getAllTools()
    .map((t) => t.name)
    .filter((n) => LEARN_TOOL_NAMES.has(n));
}

function isLearnEnabled(pi: ExtensionAPI): boolean {
  const registered = getRegisteredLearnTools(pi);
  if (registered.length === 0) return true; // no learn tools → vacuously enabled
  const active = new Set(pi.getActiveTools());
  return registered.some((name) => active.has(name));
}

function applyLearnState(pi: ExtensionAPI, enable: boolean): void {
  const registered = new Set(getRegisteredLearnTools(pi));
  if (registered.size === 0) return;
  if (enable) {
    const current = pi.getActiveTools();
    pi.setActiveTools([...new Set([...current, ...registered])]);
  } else {
    // Remove learn tools from the *currently active* set (not from all
    // registered tools) — same pattern as applyBrowserState.
    const current = pi.getActiveTools();
    pi.setActiveTools(current.filter((name) => !registered.has(name)));
  }
}
```

### State restoration and legacy compat

In `restoreFromBranch`:

```typescript
function restoreFromBranch(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const registered = getRegisteredBrowserTools(pi);
  if (registered.length === 0 && getRegisteredLearnTools(pi).length === 0) return false;

  let savedState: BrowserToggleState | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "browser-toggle-state") {
      // Try new schema first, then legacy
      const data = entry.data as Record<string, unknown>;
      if (data && typeof data.browserToolsEnabled === "boolean") {
        savedState = data as BrowserToggleState;
      } else {
        savedState = migrateLegacyState(data);
      }
    }
  }

  if (savedState) {
    applyBrowserState(pi, savedState.browserToolsEnabled);
    applyLearnState(pi, savedState.learnToolsEnabled);
    return true;
  }
  return false;
}
```

In `applyConfigDefault`, default both booleans:

```typescript
function applyConfigDefault(pi: ExtensionAPI): void {
  const enabled = readBrowserToggleConfig(); // still reads browserToggle.defaultEnabled
  applyBrowserState(pi, enabled);
  applyLearnState(pi, false); // learn always starts disabled by default
  persistState(pi, { browserToolsEnabled: enabled, learnToolsEnabled: false });
}
```

**Acceptance:**
- `/web on` → browsing tools active, `web-learn` hidden
- `/web learn` → browsing tools + `web-learn` active
- `/web off` → all inactive
- `/web status` shows both states
- State survives `/reload`, `/resume`, `/fork` (branch preservation)
- Existing branches with old `{enabled: boolean}` restore correctly (both booleans = enabled)
- `getToggleState()` returns `boolean` for backward compat with UI status bar — returns `browserToolsEnabled` only (the status bar shows 🌐 idle vs ○ web off based on whether browsing is available; learn mode is orthogonal)

**Depends on:** Step 5 (for the `web-learn` tool existence).

---

## Step 7: Update AGENTS.md

**File:** `AGENTS.md`

### Tools section

Update registered tools list — add `web-learn`:

```
web-fetch, browser-navigate, browser-snapshot, browser-click, browser-type,
browser-scroll, browser-screenshot, browser-get-images, browser-back,
browser-press, browser-console, browser-inspect, web-guide, web-learn
```

### Commands section

```
/web on|off|learn|status       — /web on (browsing only), /web off (all disabled),
                                 /web learn (browsing + guide-saving via web-learn),
                                 /web (show current state)
```

### New tool entry in the Key Tools table:

```
| `web-learn` | Save or update navigation guidance for a site | Stateless | Instant |
```

### New subsection in the Guides architecture section:

```
### Guide Creation (web-learn tool)

Guides are saved or updated via the `web-learn` tool, invoked in response to
a user request (explicit or contextual). The tool creates a `.md` file with YAML
frontmatter in `guides/`, including a `domains` field that automatically triggers
domain hints on future navigations. Calling `web-learn` again on the same domain
updates the existing file (new content, new date).

The `/web learn` command must be active or the tool isn't in the active tool set.
Default is `/web on` (browsing only).
```

### Update the DOMAIN_MAP constraint:

```
- **Domain map is built dynamically from guide files**: the only static entry
  is the test-only fixture (`_internal-test.example`). Any guide in `guides/`
  with a `domains` frontmatter field automatically contributes domain hints.
  Caches invalidate on `web-learn` tool calls — no reload needed.
```

### Constraint additions

```
- **Learn mode toggle**: `/web learn` adds `web-learn` to the active tool set;
  `/web on` removes it. The agent never calls `web-learn` unprompted — it only
  saves or updates guides when the user asks or the context implies it.
  State is persisted per-session-branch. Internally stores two independent booleans.
  Legacy `/web on|off` branches restore correctly.
  Learn mode defaults to off on fresh sessions.
```

**Depends on:** Steps 1–6.

---

## Step 8: Update Tests

### File: `__tests__/web-guides.test.ts` — add test groups

| Group | Cases |
|-------|-------|
| **domains frontmatter parsing** | Single domain, multiple (comma-separated), missing field → `undefined`, trailing comma filtered, whitespace trimmed |
| **buildDomainMap** | Builtin fixture always present; user guide with `domains` added to map; guides without `domains` excluded; pattern guides excluded; derives from `getGuideContent()` not `loadUserGuides()` |
| **getDomainMap / invalidateDomainMap** | First call builds cache; subsequent calls hit cache; after invalidation, next call rescans |
| **resolveGuidePresence with dynamic map** | User guide with `domains: ["test.example"]` triggers hint for `test.example`; cache invalidation picks up changes |
| **getGuideContent / invalidateGuideContent** | Returns builtin + user guides; after invalidation, reflects new content |
| **formatGuideList with dynamic content** | After invalidation, listing picks up new guides |

### File: `__tests__/browser-toggle.test.ts` — add test groups

| Group | Cases |
|-------|-------|
| **Mode transitions** | `/web off` → both disabled; `/web on` → browser on, learn off; `/web learn` → both on; `/web on` after `/web learn` → learn off |
| **State persistence** | Two-boolean state survives `persistState`/`restoreFromBranch` |
| **Legacy compatibility** | Old `{enabled: true}` → `{browserToolsEnabled: true, learnToolsEnabled: true}`; old `{enabled: false}` → both `false` |
| **getToggleState** | Returns `browserToolsEnabled` only (not learn); `/web learn` → `getToggleState()` returns `true` because `browserToolsEnabled` is `true` |

**Acceptance:** `npx vitest run` passes all tests. No Chromium required.

**Depends on:** Steps 1–4, 6.

---

## Dependency Graph

```
Step 1 (domains on Guide)
  └── Step 2 (parse domains from frontmatter)
        └── Step 3 (getGuideContent / invalidateGuideContent)
              └── Step 4 (buildDomainMap / getDomainMap / invalidateDomainMap)
                    ├── Step 5 (web-learn tool)
                    │     └── Step 6 (three-state /web command)
                    │           ├── Step 7 (AGENTS.md)
                    │           └── Step 8 (tests)
                    └── Step 8 (tests — getGuideContent group)
```

---

## Summary of File Changes

| File | Action | Lines |
|------|--------|-------|
| `core/guides.ts` | **Modify** — add `domains` to Guide (~1 line), parse in `parseGuideContent` (~4 lines), `getGuideContent`/`invalidateGuideContent` (~15 lines), `buildDomainMap`/`getDomainMap`/`invalidateDomainMap` (~25 lines, simpler without `userGuides` param), export `GUIDES_DIR`, wire dynamic map into `resolveGuidePresence` (~2 lines), update internal `GUIDE_CONTENT` refs (~4 lines) | ~56 |
| `index.ts` | **Modify** — add `web-learn` tool definition (~80 lines, includes `renderCall`), imports (~7 lines), update `web-guide` to use `getGuideContent()` (~3 lines) | ~90 |
| `browser-toggle.ts` | **Modify** — three-state handler, `BrowserToggleState` with two booleans, `migrateLegacyState`, `applyLearnState`, `getRegisteredLearnTools`, `isLearnEnabled`, updated `restoreFromBranch`, `applyConfigDefault`, legacy compat | ~65 |
| `__tests__/web-guides.test.ts` | **Modify** — update `GUIDE_CONTENT` → `getGuideContent()` imports and assertions, add groups for domains parsing, buildDomainMap, cache invalidation, getGuideContent, dynamic map presence | ~80 |
| `__tests__/browser-toggle.test.ts` | **Modify** — add groups for three-state transitions, persist/restore, legacy compat | ~60 |
| `AGENTS.md` | **Modify** — update tools, commands, guides section, DOMAIN_MAP constraint, add learn-mode constraint | ~40 |

**Total: ~381 lines across 6 files.**

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **`web-learn` handles both create and update** | The agent discovers patterns iteratively. On a second visit it may find more structure. Requiring manual edits for updates would defeat the purpose of an agent-facing tool. |
| **No overwrite guard in `web-learn`** | The `/web learn` toggle IS the guard. If the user doesn't want the agent modifying guides, they keep the toggle on `/web on`. No heuristic fragility. |
| **User-initiated learning** | The agent never calls `web-learn` unprompted — it waits for an explicit or contextual request. This avoids invasive side-effects and meta-work crowding out the user's actual goal. The tool description is deliberately brief; the agent figures out *when* to use it from conversation context like any other tool. |
| **Two internal booleans, one string command** | The command interface is simple for users (`/web on|off|learn`). The internal state is unambiguous (two independent booleans). Legacy `{enabled}` maps both booleans to the same value — zero-migration for existing branches. |
| **Learn defaults to off on fresh sessions** | Fresh sessions are the common case (new task). The agent's default tool set is browsing-only. The user explicitly opts in via `/web learn`. |
| **Lazy caches with explicit invalidation** | Both domain map and guide content are cached until `web-learn` writes to disk. Between writes, zero I/O during navigation. Correct and efficient. `buildDomainMap()` derives from `getGuideContent()` so both caches stay coherent — one source of truth. |
| **`getGuideContent()` replaces `GUIDE_CONTENT` const** | The module-level const was computed once at import. Newly created guides would be invisible until reload. The getter rebuilds on invalidation, making `web-guide` and presence resolution instantly reflect the new file. |
