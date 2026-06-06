# pi-browser Extension — Plugin Architecture Analysis

> Date: 2026-06-05  
> Updated: 2026-06-06 (Phase 1a — fetch decoupling implemented)  
> Scope: `startup_scripts/firecracker/config/pi/extensions/pi-browser/`  
> Status: Partially Implemented (Phase 1a fetch decoupling done; Phases 1b–4 planned)

---

## 1. File Inventory & Sizes

| File | Lines | Role |
|------|-------|------|
| `index.ts` | 1212 | Tool definitions (11 tools + 1 command), extension entry point, session lifecycle |
| `backend/router.ts` | 764 | Auto-escalation logic: chromium → stealth dispatch (**fetch removed**) |
| `backend/playwright-backend.ts` | 689 | Standard Playwright Chromium backend ("Level 2") |
| `backend/stealth-backend.ts` | 749 | Invisible Playwright stealth via JSON-RPC Python subprocess ("Level 3") |
| `backend/fetch-backend.ts` | 463 | **Decoupled** HTTP fetch → Markdown with `webFetch()` entry point, URL safety, JS detection, bot detection, content capping |
| `backend/stealth_bridge.py` | ~200 | Python JSON-RPC bridge to `invisible_playwright` (Firefox) |
| `utils/accessibility-tree.ts` | 335 | Parse Playwright's YAML a11y tree → @e refs + cached node lookup |
| `utils/bot-detection.ts` | 104 | Cloudflare/CAPTCHA/heuristics (shared by fetch & browser) |
| `utils/cdp-supervisor.ts` | 155 | Chrome DevTools Protocol console capture (chromium backend only) |
| `utils/session-manager.ts` | 204 | Session lifecycle with `BackendLevel = "chromium" \| "stealth"` (no "fetch") |
| `utils/url-safety.ts` | 161 | URL validation (block localhost/loopback, validate scheme) |
| `__tests__/url-safety.test.ts` | 188 | 46 tests: SSRF, scheme, secret, malformed URL validation |
| `__tests__/fetch-backend.test.ts` | 382 | 24 tests: `webFetch()` core fetch, JS detection, bot detection, content capping |
| `__tests__/helpers/test-server.ts` | 38 | HTTP test server helper for deterministic fixtures |
| `package.json` | ~10 | Dependencies: `node-html-parser`, `playwright`, `turndown`, `vitest` (dev) |

**Total**: ~5054 lines of TypeScript + Python bridge + tests.

---

## 2. Current Architecture — No Abstraction Exists Today

### 2.1 Tool Definitions → Router (index.ts)

Each tool in `index.ts` delegates to `router.ts`:

```typescript
// index.ts - browser-navigate tool calls router directly
async execute(_toolCallId, params, signal, _onUpdate, ctx) {
  const tid = taskId(ctx);
  const result = await router.navigate(url, { strategy, timeout, signal, taskId: tid });
  // ... renders result.content, checks result.details.botDetectionWarning
}
```

Same pattern for all 10 interactive tools (navigate, snapshot, click, type, scroll, screenshot, getImages, back, press, console). A separate `web-fetch` tool (see `index.ts` — `webFetchTool`) calls `fetch-backend.webFetch()` directly, bypassing the router entirely.

**Note (updated June 2026)**: Fetch has been decoupled into a separate `web-fetch` tool as described in Section 11. The `browser-navigate` tool no longer handles `strategy="fetch"` — that option has been removed from the strategy enum.

### 2.2 Router Dispatch — Hand-Written if/else per Backend Type

From `backend/router.ts` (fetch dispatch removed):

```typescript
// Level 2 dispatch
if (strategy === "chromium" || strategy === "auto") {
  sessionManager.createSession(taskId, "chromium");
  const result = await playwrightBackend.navigate(normalizedUrl, taskId, timeoutMs);
  
  // Bot detected? Try stealth escalation
  if (result.botDetected && strategy === "auto") {
    return escalateToStealthIfAuto(result, strategy, taskId, timeoutMs);
  }
}

// Level 3 dispatch
if (strategy === "stealth") {
  const result = await stealthBackend.navigate(normalizedUrl, taskId, timeoutMs);
}
```

The same if/else pattern repeats for **every operation** (click, type, scroll, screenshot, goBack, press, getImages, getConsoleMessages, evaluate). There are ~13 operation dispatchers, each with 2 backend branches (chromium/stealth only — fetch removed by Phase 1a).

### 2.3 Each Backend Defines Its Own Result Types

Chromium result (`playwright-backend.ts`):
```typescript
export interface PlaywrightNavigateResult {
  success: boolean; url: string; title: string;
  snapshot: string; elementCount: number;
  backend: "chromium"; botDetected?: boolean; error?: string;
}
```

Stealth result (`stealth-backend.ts`):
```typescript
export interface StealthNavigateResult {
  success: boolean; url: string; title: string;
  snapshot: string; elementCount: number;
  backend: "stealth"; error?: string;
}
```

Same structural shape but **different types**, different discriminant values. The router normalizes these into unified `NavigateResult`, `SnapshotResult`, etc. — but the duplication lives in each backend module.

### 2.4 Stealth Backend Architecture

The stealth backend (`stealth-backend.ts` + `stealth_bridge.py`) works differently from chromium:

1. **Process model**: Each task gets its own Python subprocess running `stealth_bridge.py`
2. **Communication**: JSON-RPC over stdin/stdout (line-delimited JSON)
3. **Bridge commands** (`stealth_bridge.py`): navigate, snapshot, click, type, scroll, screenshot, goBack, press, evaluate, ping, cleanup
4. **Element lookup**: The TS wrapper parses the YAML a11y snapshot from `stealth-backend.ts`, caches `{@eref → {role, name, level}}` in `_elementCaches`, then builds JSON-RPC params for interactions

Key divergence: stealth backend communicates with an external process via JSON-RPC (error-prone, requires careful error handling), while chromium talks directly to Playwright's Node API.

---

## 3. Plugin Interface Definition — The Canonical Operation Surface

Every **interactive browser** backend must implement these **13 operations**. Inputs/outputs unified:

> **Design decision (post-oracle review)**: The `BrowserPlugin` interface is exclusively for interactive browser backends (chromium, stealth, community plugins). Fetch is **not** a browser backend — it's a stateless document retriever. It does not implement this interface. See Section 11 for the fetch decoupling rationale and architecture.

| # | Operation | Input | Canonical Output Type |
|---|-----------|-------|---------------------|
| 1 | `navigate(url, opts)` | `{url, timeoutMs?, waitUntil?, signal?}` | `{success, url, title, snapshot, elementCount, botDetected?, error?}` |
| 2 | `snapshot(taskId)` | `string taskId` | `{success, snapshot, elementCount, error?}` |
| 3 | `click(taskId, ref)` | `string taskId, string @eref` | `{success, error?, newUrl?, newTitle?, snapshot?, elementCount?}` |
| 4 | `type(taskId, ref, text)` | `string taskId, string @eref, string text` | `{success, error?, snapshot?, elementCount?}` (no navigation typically) |
| 5 | `scroll(taskId, dir)` | `string taskId, "up"\|"down"` | Same as click |
| 6 | `screenshot(taskId, opts?)` | `string taskId, {fullPage?, quality?, format?}?` | `{success, dataUri, error?}` |
| 7 | `goBack(taskId)` | `string taskId` | `{success, error?, newUrl?, newTitle?, snapshot?, elementCount?}` |
| 8 | `press(taskId, key)` | `string taskId, string key` | Same as click |
| 9 | `getImages(taskId)` | `string taskId` | `{success, images: {src, alt, width, height}[], error?}` |
| 10 | `getConsoleMessages(taskId)` | `string taskId` | `{messages: {type, text}[] }` |
| 11 | `clearConsole(taskId)` | `string taskId` | `Promise<void>` |
| 12 | `evaluate(taskId, expr)` | `string taskId, string jsExpression` | `{success, result?: unknown, error?}` |
| 13 | `cleanup(taskId)` / `cleanupAll()` | — | `Promise<void>` |

**Key design principle**: The router normalizes all backend outputs into these shapes. Backend internals are free to differ; the contract is what matters for tool definitions.

---

## 4. Plugin API Divergence — The Quirks Problem

### 4.1 Where Backends Actually Diverge

| Aspect | Chromium (PW) | Stealth (IPW/Firefox) | Fetch (via `web-fetch`) |
|--------|---------------|----------------------|-------------------------|
| **Output** | a11y tree with @e refs | a11y tree with @e refs | Markdown text |
| **State** | Stateful session | Stateful session | Stateless (one-shot) |
| **Interactivity** | click, type, scroll, press | click, type, scroll, press | None |
| **Screenshot format** | PNG (default) | JPEG at 80% quality | N/A |
| **Full-page screenshot** | Supported (`{fullPage: true}`) | NOT supported (bridge has no `full_page` param) | N/A |
| **Scroll method** | `page.mouse.wheel(0, delta)` — native wheel event | Same API but Firefox implementation differs | N/A |
| **Wait strategy** | `waitUntil: "networkidle"` or "load" | Same via JSON-RPC params | N/A |
| **Process model** | Single shared Browser, per-task Contexts | Per-task subprocess (JSON-RPC bridge) | HTTP client |
| **Console capture** | CDP session-based (`cdp-supervisor.ts`) | N/A — no CDP in Firefox; not implemented yet | N/A |
| **Bot detection signal** | Response headers + a11y analysis | Same heuristics, checked post-snapshot | Body text heuristics (inline) |

### 4.2 Proposed Quirks Interface

```typescript
interface BrowserPlugin {
  name: string;
  
  // --- 13 standard operations ---
  navigate(url: string, opts: NavOpts): Promise<NavResult>;
  snapshot(taskId: string): Promise<SnapResult>;
  click(taskId: string, ref: string): Promise<IntResult>;
  type(taskId: string, ref: string, text: string): Promise<IntResult>;
  scroll(taskId: string, dir: "up" | "down"): Promise<IntResult>;
  screenshot(taskId: string, opts?: ScreenshotOpts): Promise<SnapResult>;
  goBack(taskId: string): Promise<IntResult>;
  press(taskId: string, key: string): Promise<IntResult>;
  getImages(taskId: string): Promise<ImagesResult>;
  getConsoleMessages(taskId: string): Promise<{ messages: ConsoleMsg[] }>;
  clearConsole(taskId: string): Promise<void>;
  evaluate(taskId: string, expr: string): Promise<{ result?: unknown }>;
  cleanup(taskId: string): Promise<void>;
  
  // --- Optional quirks (bounded set) ---
  quirks?: {
    /** Whether full-page screenshots are supported */
    supportsFullPageScreenshot?: boolean;
    /** Default screenshot format (png vs jpeg) */
    screenshotFormat?: "png" | "jpeg";
    /** How scroll is implemented — affects precision expectations */
    wheelMethod?: "native" | "evaluate";
    /** Whether console capture is available */
    supportsConsoleCapture?: boolean;
    /** Max time to wait for role-based locators (ms) */
    maxWaitForRoleLocator?: number;
  };
}
```

### 4.3 Adapter Pattern for Quirks

The router adapts known quirks transparently:

```typescript
// In router.ts — screenshot with quirk adaptation
async function screenshot(taskId: string, opts?: { fullPage?: boolean }): Promise<ScreenshotResult> {
  const plugin = getPluginForSession(session);
  
  let adaptedOpts: ScreenshotOpts = {};
  if (opts?.fullPage && !plugin.quirks?.supportsFullPageScreenshot) {
    // Steath doesn't support fullPage — apply workaround or inform caller
    await scroll(taskId, "down");
    adaptedOpts.fullPageFallback = true;
  }
  
  return plugin.screenshot(taskId, adaptedOpts);
}
```

**Design constraint**: Keep the quirks list explicit and bounded.

**Quirk promotion criteria**: A quirk is promoted from the optional `quirks` field to a core interface property when **2+ plugins share the same quirk pattern**. This prevents quirks from becoming an untyped dumping ground while keeping the core interface stable. Examples:
- If both chromium and a future webkit plugin lack full-page screenshots → promote `supportsFullPageScreenshot` to a required boolean on the interface
- If only one plugin lacks console capture → it stays as a quirk

**What is NOT a quirk**: Category-level capability differences (e.g., "doesn't support interactivity") are not quirks — they indicate the backend belongs to a different abstraction entirely. Fetch is the canonical example: it cannot implement `click()`, `type()`, etc., so it must not implement `BrowserPlugin`.

> **Post-implementation confirmation (June 2026)**: Fetch has been decoupled into its own `web-fetch` tool, with a `WebFetchResult` type that has no overlap with `NavigateResult` or any `BrowserPlugin` interface. This confirms the architectural decision — fetch is categorically different, not a "quirky" browser backend.

---

## 5. Shared Code That Would Be Centralized

Currently duplicated or referenced from multiple backends:

### 5.1 `utils/accessibility-tree.ts` (242 lines)

Shared by **both** chromium and stealth backends:
- `parseSnapshot(snap)` — parses YAML a11y tree into `{text, elements: Map<eref, AriaCachedNode>, count}`
- `buildLocator(node)` — converts cached node to Playwright locator params `{role, name?, exact?, level?}`
- `AriaCachedNode` type definition
- `INTERACTIVE_ROLES` set

This would move to `core/shared/accessibility-tree.ts`.

### 5.2 `utils/bot-detection.ts` (104 lines)

Used by chromium backend (`playwright-backend.ts`) and referenced in router for escalation:
- `BLOCK_SIGNALS` — array of strings ("please verify you are human", "cloudflare", etc.)
- `checkBodyText()`, `checkHeaders()`, `checkPage()`
- Returns `{isBlocked, confidence, signal?}`

This would move to `core/shared/bot-detection.ts`.

### 5.3 `utils/session-manager.ts` (178 lines)

Shared across **interactive** backends only:
- `SessionManager` class with session CRUD, crash detection
- `BackendLevel` type (`"chromium" | "stealth"` — would become `string` for plugins)
- Session status display logic (icons, domain extraction)

This stays mostly as-is but the union type expands. **Note**: Fetch does not create sessions. Under the decoupled architecture, `BackendLevel` no longer includes `"fetch"` — sessions are exclusively for interactive browser backends.

### 5.4 `utils/url-safety.ts` (161 lines)

Used by both the router and the fetch tool for URL validation before dispatch:
- Validates scheme (http/https only)
- Blocks loopback/local addresses
- Returns `{safe, reason?}`

This stays in shared because both the interactive router and the fetch backend consume it.

### 5.5 `utils/cdp-supervisor.ts` (155 lines)

Used **only** by chromium backend for CDP console capture:
- Creates CDP sessions per Page
- Captures log entries (console.log/warn/error/info)
- Returns `{type, text, location?}` messages

This stays with the chromium plugin only — not shared. Stealth has no CDP equivalent.

---

## 6. Maintenance Burden Analysis

### 6.1 Adding a New Operation (current state)

**Interactive operation** — touched 3 files (fetch backend excluded):

| File | Lines Added/Modified | What Changed |
|------|---------------------|--------------|
| `index.ts` | ~80 | Tool definition, parameter schema, execute handler, renderers |
| `router.ts` | ~40 | `getConsoleMessages()`, `clearConsole()` functions + dispatch per backend level |
| `backend/playwright-backend.ts` | ~60 | Implementation |
| `backend/stealth-backend.ts` | ~30 | Implementation (may be partial/stub) |

**Total**: ~210 lines across 4 files. The router dispatch grows by ~4-8 lines per new backend type.

**Stateless operation** (`web-fetch` was the example):

| File | Lines Added/Modified | What Changed |
|------|---------------------|--------------|
| `index.ts` | ~80 | Tool definition, parameter schema, execute handler, renderers |
| `backend/fetch-backend.ts` | ~50 | New export function, no router involvement |

**Total**: ~130 lines across 2 files. No router dispatch needed.

### 6.2 With Plugin Architecture

| File | Lines Added/Modified | What Changed |
|------|---------------------|--------------|
| `index.ts` | ~80 | **Unchanged** — tool calls `router.*` which calls `plugin.*` |
| `router.ts` | ~5-10 | Single dispatch line: `plugin.getConsoleMessages(taskId)` |
| Per plugin | ~50-80 | Each plugin implements the operation natively |

**Total for 2 plugins**: ~170-210 lines (comparable).  
**Total for 3+ plugins**: Plugin architecture wins because router cost is amortized.

### 6.3 When Plugin Architecture Pays Off

| # of Plugins | Current Cost | Plugin Cost | Net Delta |
|-------------|--------------|-------------|-----------|
| 1 | 700 (one backend) | 700 + 150 (layer overhead) | -150 (more work) |
| 2 | 1400 (two backends) | 1400 + 150 | -150 (slightly more) |
| 3 | 2100 | 2100 + 150 | -150 (comparable) |
| 4+ | 2800+ | 2800+ + 150 | **savings compound** — router dispatch shrinks |

The real benefit isn't line count — it's **contribution friction reduction**. With a plugin interface, someone adding a 3rd backend only needs to understand one interface and their engine's API, without reading the other backends or touching the router.

---

## 7. Proposed Directory Structure

```
pi-browser/
├── index.ts                     # Tool definitions — browser-* tools + web-fetch tool
├── package.json                 # dependencies: node-html-parser, playwright, turndown, typescript
├── tsconfig.json
│
├── core/                        # New: shared plugin infrastructure
│   ├── plugin-api.ts            # BrowserPlugin interface + unified result types (~200 lines)
│   ├── router.ts                # Dispatch → pluginMap.get(level).method() — interactive backends only
│   └── plugin-loader.ts         # Typed registry + discovery (simple static map for now)
│
├── core/shared/                 # New: shared utilities (moved from utils/)
│   ├── accessibility-tree.ts    # Parse a11y → @e refs, cached node lookup
│   ├── bot-detection.ts         # Cloudflare/CAPTCHA heuristics
│   ├── session-manager.ts       # Session lifecycle (BackendLevel = string for plugins, no "fetch")
│   └── url-safety.ts            # URL validation (shared by router AND fetch)
│
├── backends/
│   ├── chromium/                # Interactive backend — implements BrowserPlugin
│   │   ├── chromium-plugin.ts    # Standard Playwright implementation (renamed from playwright-backend.ts)
│   │   └── package.json         # dep: playwright
│   │
│   ├── stealth/                 # Interactive backend — implements BrowserPlugin
│   │   ├── stealth-plugin.ts     # JSON-RPC wrapper in BrowserPlugin shape (renamed from stealth-backend.ts)
│   │   ├── stealth-bridge.py    # Python subprocess (invisible_playwright)
│   │   └── package.json         # no additional Node deps
│   │
│   └── community/              # Future: 3rd-party plugins go here
│       └── README.md            # "Create your own plugin — see template"
│
├── fetch/                       # Decoupled from browser backends entirely
│   ├── fetch-backend.ts         # HTTP fetch with JS detection — standalone tool, not a BrowserPlugin
│   └── README.md                # Documents why fetch is separate (see Section 11)
│
├── utils/                       # Deprecated re-exports (NOT symlinks — see deprecation note below)
│   ├── accessibility-tree.ts    # re-export with deprecation warning
│   ├── bot-detection.ts         # re-export with deprecation warning
│   ├── session-manager.ts       # re-export with deprecation warning
│   └── url-safety.ts            # re-export with deprecation warning
```

> **Deprecation strategy**: `utils/` files should use **re-exports with `console.warn`** during the transition period, not silent symlinks. Silent symlinks mask stale imports — a developer updating `utils/accessibility-tree.ts` directly wouldn't realize they're editing a symlink target in `core/shared/`. Re-exports make the deprecation visible:
> ```typescript
> // utils/accessibility-tree.ts (deprecated shim)
> console.warn('[pi-browser] Import from core/shared/accessibility-tree instead of utils/accessibility-tree');
> export * from '../core/shared/accessibility-tree';
> ```
> Remove the shims once all consumers are migrated.

> **Post-implementation note (June 2026)**: Phase 1a did not include directory restructuring — all files remain in their original locations (`backend/`, `utils/`). The `__tests__/` directory is the only new top-level addition.

---

## 8. Router Transformation — Before vs After

### Current (scattered conditionals):

```typescript
// ~13 separate functions, each with 2-3 if/else branches
export async function click(taskId: string | undefined, ref: string): Promise<InteractionResult> {
  const sr = await requireInteractiveSession(tid);
  if (!sr) return { success: false, error: "..." };
  return refBasedInteractionOrSnapshot(tid, sr.wasAutoEscalated, async () => {
    if (sr.session.level === "chromium") 
      return compactInteractionResult(await playwrightBackend.click(tid, ref));
    if (sr.session.level === "stealth") 
      return compactInteractionResult(await stealthBackend.click(tid, ref));
    return { success: false, error: "Unknown session level" };
  });
}

// Same pattern repeated for type(), scroll(), goBack(), press(), screenshot(), 
// getImages(), getConsoleMessages(), clearConsole(), evaluate() — 10 more functions.
```

### After (registry dispatch):

```typescript
const pluginMap = new Map<string, BrowserPlugin>([
  ["chromium", chromiumPlugin],
  ["stealth", stealthPlugin],
]);

// Typed registration — validates plugin names at registration time
function registerPlugin(name: string, plugin: BrowserPlugin): void {
  if (pluginMap.has(name)) {
    throw new Error(`[pi-browser] Plugin "${name}" is already registered`);
  }
  pluginMap.set(name, plugin);
}

function getPlugin(session: BrowserSession): BrowserPlugin {
  const plugin = pluginMap.get(session.level);
  if (!plugin) throw new Error(`[pi-browser] No plugin registered for level "${session.level}"`);
  return plugin;
}

export async function click(taskId: string | undefined, ref: string): Promise<InteractionResult> {
  const sr = await requireInteractiveSession(tid);
  if (!sr) return { success: false, error: "..." };
  return refBasedInteractionOrSnapshot(tid, sr.wasAutoEscalated, async () => {
    const plugin = getPlugin(sr.session);
    return compactInteractionResult(await plugin.click(tid, ref));
  });
}

// One shared dispatch function. Adding a plugin only requires registering it in the map.
```

This reduces router code by ~35% (from ~767 to ~500 lines). The reduction is less than 50% because the escalation logic (bot detection checks, auto-escalation paths, session creation on demand) remains even after dispatch is simplified. The conditional sprawl per operation disappears, but the orchestration logic stays.

---

## 9. Build Pipeline Impact (init_base.sh)

The firecracker base image build (`init_base.sh` lines 438-557) copies the extension into the chroot:

```bash
# Line ~506-520: Playwright install
EXT_DIR="$HOME/.pi/agent/extensions/pi-browser"
cd "$EXT_DIR" && npm install   # <-- currently runs here
```

**With new structure**: `npm install` would be run from the extension root, which already has a single `package.json`. The subdirectory structure (`backends/*`) is just code organization — no additional npm installs needed since all deps are declared in the root `package.json`.

The Python stealth backend (`stealth_bridge.py` + `uv venv /opt/ipw-pyenv`) is **completely independent** of the Node/TypeScript plugin system. It stays as-is in `init_base.sh`:
- `uv venv /opt/ipw-pyenv` (line 536)
- `uv pip install -e /opt/invisible_playwright_src` (line 542)
- Firefox binary extraction (line 547)

No changes needed to the Python build pipeline.

---

## 10. Honest Assessment & Recommendation

### Against Full Refactor Now:
- You have exactly **2 active backends**. At this scale, the plugin layer (~150 lines of abstraction) adds overhead for marginal benefit.
- The current code is well-understood and straightforward. Every developer who touches it already knows "add an operation → touch these N files."
- Your opinionated build pipeline (`init_base.sh`) copies the entire extension directory into the chroot. Subdirectories add minor complexity to what's currently a simple `cp -r`.

### For Building the Foundation Now:
- **You explicitly want external contributors** to add stealth plugins (mitmproxy-injected Firefox, custom patches, etc.). A clean plugin interface is a prerequisite — currently someone would need to copy-paste your entire 596-line `stealth-backend.ts` just to change the browser engine.
- The bot-detection + escalation chain in `router.ts` (767 lines of complex if/else) would shrink significantly, making the code easier to reason about and less error-prone.
- Building the interface **now** costs roughly 200 lines of new code + adapters; waiting means repeating that effort later when a community plugin arrives and people are already frustrated by the friction.

### Recommended Incremental Approach:

**Phase 1a — Fetch decoupling (✅ DONE):**
1. ✅ Decouple fetch into a separate `web-fetch` tool (see Section 11, `FETCH_DECOUPLING_PLAN.md`)
2. ✅ Remove `"fetch"` strategy from `browser-navigate` and the router
3. ✅ Add `webFetch()` entry point in `fetch-backend.ts` with URL safety, JS detection, bot detection, content capping
4. ✅ Add test infrastructure (Vitest) with 70 tests for URL safety and fetch-backend
5. ✅ Remove deprecated `BackendUsed` alias and `navigate()` backward-compat export

**Phase 1b — BrowserPlugin interface (pending):**
6. Extract `BrowserPlugin` interface from existing code (~80 lines in `core/plugin-api.ts`)
7. Define unified result types (consolidate `PlaywrightNavigateResult`, `StealthNavigateResult`, etc.)
8. Define error handling contract for plugins (see Section 12)
9. Add `init()` lifecycle hook to `BrowserPlugin` (see Section 12)
10. Add thin adapter wrappers so both existing backends satisfy the interface
11. Replace scattered if/else in router with a typed registry map

**Phase 2 — Shared code consolidation:**
- Move `accessibility-tree.ts` and `bot-detection.ts` to `core/shared/` (they're already identical between backends)
- Update import paths in both backends
- Add deprecated re-exports (with `console.warn`) in `utils/` — not silent symlinks

**Phase 3 — Quirks support:**
- Add the `quirks` optional interface with current known quirks (screenshot format, fullPage not supported)
- Router wraps known quirks transparently
- Document quirk promotion criteria (promote when 2+ plugins share the same quirk pattern)

**Phase 4 — Community readiness (when a 3rd plugin arrives):**
- Full directory restructuring per proposed layout
- Remove deprecated `utils/` re-exports once all consumers migrated
- Document contribution guide in `backends/community/README.md`
- Create `BrowserPlugin` test harness for community contributors (see Section 12)

### Bottom Line:
Build the interface **now** but keep Phase 1 minimal (interface + adapters + registry map + fetch decoupling). Don't do the full directory restructuring until a 3rd plugin is imminent or you have a concrete community contributor ready to go. The plugin architecture solves a real problem when you move past 2 backends, and starting now means the work compounds rather than creating technical debt to refactor later.

**✅ Fetch decoupling is done (Phase 1a, June 2026)** — it resolved the plan's biggest contradiction (fetch being "Level 1" but not implementing BrowserPlugin) and simplified both the router and the agent's mental model. The remaining Phase 1 work (BrowserPlugin interface extraction) is now cleaner to tackle.

---

## 11. Fetch Decoupling — Architectural Decision

> **Status**: ✅ **Implemented** (Phase 1a, June 2026)
> **Decision**: Decouple fetch into a separate `web-fetch` tool within the same extension. Fetch is NOT a BrowserPlugin, NOT a Level 1 backend, and NOT part of the browser escalation chain.
>
> **Implementation details**: See `FETCH_DECOUPLING_PLAN.md` for the original plan, `STATE.md` for implementation tracking, and the actual code in `backend/fetch-backend.ts` and `index.ts` (the `web-fetch` tool).
>
> **Test coverage**: 46 URL safety tests + 24 fetch-backend tests using Vitest (70 total).

### 11.1 The Problem

The original plan had an unresolved contradiction:
- **Section 3** defined 13 canonical operations every backend "must implement," implying fetch would need `click()`, `type()`, etc.
- **Section 7** explicitly said fetch "does NOT implement BrowserPlugin"
- **Section 8** showed only chromium and stealth in the pluginMap — fetch was absent
- **Appendix B** showed fetch as part of the navigate dispatch chain: `strategy === "fetch"` → `fetchBackend.navigate()`

Fetch was categorized as "Level 1" in the escalation chain, but calling fetch→chromium "escalation" is misleading. It's not upgrading the same capability — it's **switching to a different capability entirely**:

| Aspect | Fetch | Chromium / Stealth |
|--------|-------|-------------------|
| **Output** | Markdown text | a11y tree with `@e` refs |
| **State** | Stateless (one-shot) | Stateful sessions |
| **Interactivity** | None | click, type, scroll, press |
| **Process model** | HTTP client | Playwright browser / subprocess |
| **Bot detection** | JS-required heuristics | Cloudflare / CAPTCHA detection |

A fetch result is not a "degraded browser snapshot." It's a fundamentally different representation. The agent can't "continue" a fetch session by clicking `@e` refs because fetch produces no `@e` refs. Every fetch→chromium transition is a fresh start, not an escalation.

### 11.2 Why Fetch Should NOT Implement BrowserPlugin

If fetch implemented `BrowserPlugin` with quirks, **11 of 13 operations** would be no-ops or throw "not supported." That's not a plugin — it's a contract violation. The `BrowserPlugin` interface would no longer mean "something that can browse" — it would mean "something that can maybe browse, maybe not, check quirks."

`supportsInteractivity: boolean` is not a quirk — it's a fundamental capability classification. Once you admit category-level differences into quirks, the quirks field becomes a type system unto itself, which defeats its purpose as a lightweight optional annotation.

### 11.3 Why Fetch Should NOT Stay in the Router

The router's job is "given a session, dispatch the operation to the right plugin." Fetch doesn't have sessions. Having the router handle fetch means it maintains two completely different codepaths: one for stateless document retrieval and one for stateful interactive browsing. This is exactly the complexity the refactor is trying to eliminate.

### 11.4 Decoupled Architecture

```
pi-browser extension/
├── tools/
│   ├── browser-navigate, browser-click, ...   # Interactive browser tools
│   │   └── router → BrowserPlugin dispatch (chromium, stealth, community)
│   │
│   └── web-fetch                               # Stateless document retrieval
│       └── fetch-backend.ts directly (no router, no session)
│
├── core/
│   ├── plugin-api.ts          # BrowserPlugin interface (13 operations, interactive only)
│   ├── router.ts              # Only handles interactive backends
│   └── shared/                # accessibility-tree, bot-detection, url-safety, session-manager
│
├── backends/
│   ├── chromium/              # Implements BrowserPlugin
│   ├── stealth/               # Implements BrowserPlugin
│   └── community/
│
└── fetch/
    └── fetch-backend.ts       # Standalone — shares bot-detection & url-safety only
```

Key design points:

1. **`web-fetch` is a separate tool** registered in `index.ts` alongside the browser tools. It has its own parameter schema and execute handler.
2. **`fetch-backend.ts` stays in the same extension** (not a separate package) because it shares `bot-detection.ts` and `url-safety.ts` with the browser path.
3. **The router only handles interactive backends** — cleaner contract, simpler code, no session/no-session branching.
4. **The "auto" strategy for `browser-navigate` simplifies**: always start with chromium, escalate to stealth on bot detection. No fetch step in the chain.
5. **The agent decides** when to use `web-fetch` vs. `browser-navigate`. This is better than the router deciding opaquely because the agent has context about whether it will need to interact with the page.

### 11.5 Impact on `strategy` Parameter

The `strategy` parameter on `browser-navigate` changes semantics:

| Strategy | Before | After |
|----------|--------|-------|
| `"auto"` | fetch → chromium → stealth | chromium → stealth |
| `"fetch"` | Use fetch backend | **Removed** ✅ — use `web-fetch` tool instead |
| `"chromium"` | Use chromium | Unchanged |
| `"stealth"` | Use stealth | Unchanged |

The `"fetch"` strategy value has been removed from `browser-navigate`. Agents that want the fast path call `web-fetch` explicitly. This is a **breaking change for existing tool callers** — the agent prompt was updated to recommend `web-fetch` for content-retrieval tasks.

### 11.6 Hybrid Alternative: Router Pre-Check

If you want to preserve the latency optimization of trying fetch first in `"auto"` mode, you can implement it as a **pre-check** in the router rather than a backend level:

```typescript
// In router.navigate, when strategy === "auto":
const fetchResult = await fetchBackend.navigate(url, opts);
if (!fetchResult.botDetected && !fetchResult.jsRequired) {
  return fetchResult; // Fast path: simple page, no browser needed
}
// Otherwise fall through to chromium → stealth escalation
```

This keeps fetch outside the `BrowserPlugin` interface while still allowing the router to use it as an optimization. However, this approach still conflates two different output types (Markdown vs. a11y tree) in the same tool response, which can confuse the agent. **The recommended approach is full decoupling** (separate tool), with the hybrid as a fallback if latency measurements show a significant regression.

### 11.7 Risk: Latency Regression

Removing fetch from the `"auto"` strategy means `browser-navigate` always spins up chromium, which is slower and more resource-intensive than a simple HTTP fetch. For simple content-retrieval tasks, this is a regression.

**Mitigation**: Ensure the agent prompt clearly distinguishes between `web-fetch` (fast, read-only) and `browser-navigate` (slower, interactive). The agent should default to `web-fetch` for content-retrieval tasks and only use `browser-navigate` when interaction is needed.

**Actual outcome**: Prompt guidelines were updated in the `web-fetch` tool definition and the `browser-navigate` tool definition to cross-reference each other. The startup notification now says: `"Browser extension loaded (web-fetch → chromium → stealth). Try: web-fetch for static pages or browser-navigate for interactive browsing."`

---

## 12. Gap Fixes — Post-Oracle Review Additions

These gaps were identified during the architecture review and should be addressed in the appropriate phases.

### 12.1 Error Handling Contract (Phase 1)

The plan defines success-path result types but doesn't specify how plugins signal errors. This matters because the router needs consistent error handling across plugins, and a community plugin author needs to know the contract.

**Proposed contract**:
- Operations return typed result objects with `{success: boolean, error?: string}` — **never throw** for expected failures (bot detection, navigation error, element not found).
- Operations **may throw** for unexpected infrastructure failures (Playwright crash, subprocess died, out of memory). The router catches these and normalizes them to error results.
- Error messages are human-readable strings. Structured error codes can be added later if needed.

```typescript
// In plugin-api.ts
export interface PluginError {
  success: false;
  error: string;           // Human-readable description
  recoverable?: boolean;   // Hint to router: can we retry with a different backend?
  backendError?: unknown;  // Opaque original error for logging
}
```

### 12.2 Lifecycle Hooks (Phase 1)

The plan mentions `cleanup(taskId)` but doesn't discuss initialization. The stealth backend already does lazy initialization (spawns Python subprocess on first use). This should be formalized:

```typescript
interface BrowserPlugin {
  name: string;
  
  // --- Lifecycle ---
  /** Called once when the plugin is registered. Use for expensive setup (e.g., launching a browser process). */
  init?(): Promise<void>;
  /** Called when a session using this plugin is being torn down. */
  cleanup(taskId: string): Promise<void>;
  /** Called on extension shutdown. Clean up all resources. */
  cleanupAll(): Promise<void>;
  
  // --- 13 standard operations ---
  // ...
}
```

The router should call `init()` on first use (lazy) or at registration time (eager), and handle failures gracefully (mark the plugin as unavailable, log the error, skip it in auto-escalation).

### 12.3 Typed Plugin Registry (Phase 1)

The router transformation uses `pluginMap.get(session.level)` where `session.level` is a string. This is flexible but untyped — a typo like `"chromuim"` fails silently. The registry should validate plugin names at registration time:

```typescript
class PluginRegistry {
  private plugins = new Map<string, BrowserPlugin>();
  
  register(name: string, plugin: BrowserPlugin): void {
    if (this.plugins.has(name)) {
      throw new Error(`[pi-browser] Plugin "${name}" is already registered`);
    }
    // Validate that the plugin implements the required operations
    for (const op of REQUIRED_OPERATIONS) {
      if (typeof (plugin as any)[op] !== 'function') {
        throw new Error(`[pi-browser] Plugin "${name}" missing required operation: ${op}`);
      }
    }
    this.plugins.set(name, plugin);
  }
  
  get(level: string): BrowserPlugin | undefined {
    return this.plugins.get(level);
  }
  
  availableLevels(): string[] {
    return [...this.plugins.keys()];
  }
}
```

### 12.4 Test Harness for BrowserPlugin (Phase 4)

A `BrowserPlugin` test harness that exercises the 13-operation contract against any plugin would be valuable — both for internal quality and for community contributors to validate their plugins. This is a Phase 4 deliverable but should be designed alongside the interface.

**Minimum test surface**:
- Navigate to a known page → verify result shape matches `NavResult`
- Snapshot → verify `@e` refs are present and parseable
- Click a known element → verify `IntResult` shape
- Type into an input → verify `IntResult` shape
- Screenshot → verify `dataUri` is valid
- Evaluate JS → verify result returned
- Cleanup → verify no leaked processes/contexts

### 12.5 Symlink vs. Re-export Deprecation Strategy (Phase 2)

The original plan proposed symlinks from `utils/` → `core/shared/`. This risks masking stale imports — a developer editing `utils/accessibility-tree.ts` directly wouldn't realize they're editing a symlink target in `core/shared/`.

**Recommended approach**: Use re-exports with deprecation warnings during the transition period. Remove the shims once all consumers are migrated. See the directory structure in Section 7 for the implementation pattern.

---

## Appendix A: File-by-File Integration Map

| File | Imports From | Imports In | Key Dependencies |
|------|-------------|------------|------------------|
| `index.ts` | `./backend/router`, `./backend/fetch-backend`, `./backend/playwright-backend`, `./backend/stealth-backend`, `./utils/session-manager` | pi-agent SDK (`@earendil-works/pi-coding-agent`) | Pi tool registration, session lifecycle hooks; 11 tools (10 interactive + 1 web-fetch) |
| `router.ts` | 2 backend modules (chromium + stealth only), `../utils/accessibility-tree`, `../utils/session-manager`, `../utils/url-safety` | index.ts (via interactive browser tools) | No temp file management (moved to fetch-backend) |
| `playwright-backend.ts` | `../utils/accessibility-tree`, `../utils/cdp-supervisor`, `../utils/session-manager` | router.ts, cleanup in index.ts | Node `playwright` package, CDP protocol |
| `stealth-backend.ts` | `../utils/accessibility-tree`, `../utils/session-manager` | router.ts, cleanup in index.ts | `node:child_process` (spawn), JSON-RPC protocol |
| `fetch-backend.ts` | `node:fs`, `node:crypto`, `node:os`, `node-html-parser`, `turndown`, `../utils/url-safety`, `../utils/bot-detection` | **index.ts directly** (via `webFetchTool.execute()`), not router | HTTP `fetch()`, HTML→Markdown conversion; owns temp file lifecycle |
| `stealth_bridge.py` | `invisible_playwright` (pip package) | spawned by stealth-backend.ts via `child_process.spawn()` | Python virtualenv at `/opt/ipw-pyenv` |
| `accessibility-tree.ts` | (none — pure utilities) | playwright-backend, stealth-backend, shoulder (cacheSnapshot), router.ts (compactSnapshot) | None |
| `bot-detection.ts` | (none — pure utilities) | playwright-backend (used by router), **fetch-backend** (inline bot detection), index.ts | None |
| `cdp-supervisor.ts` | (none) | playwright-backend only | Chrome DevTools Protocol |
| `session-manager.ts` | (none — class with helpers) | All backends, index.ts | `Browser`, `BrowserContext` types from playwright |
| `url-safety.ts` | (none — pure utilities) | **router.ts** and **fetch-backend.ts** (both call `validateUrl()` before navigation/fetch) | None |
| `__tests__/url-safety.test.ts` | `../utils/url-safety`, `../__tests__/helpers/test-server` | — (test file) | Vitest, 46 tests |
| `__tests__/fetch-backend.test.ts` | `../backend/fetch-backend` | — (test file) | Vitest, `vi.spyOn(global, 'fetch')`, 24 tests |

---

## Appendix B: Operation Call Trace for Each Tool

### `web-fetch` tool:
1. `index.ts` → `fetchBackend.webFetch({url, timeout, signal})` **directly** (no router, no session)
2. `fetch-backend.ts` → full pipeline: URL safety → HTTP fetch → HTML→Markdown conversion → JS-shell detection → bot detection (inline) → content capping + temp file spill
3. Returns `WebFetchResult {success, url, title, content (Markdown), needsJavaScript?, botDetected?, statusCode?, filePath?, totalChars?}`
4. If the agent detects `needsJavaScript` or `botDetected` in the result, it can follow up with `browser-navigate` to get an interactive session

### `browser-navigate` tool:
1. `index.ts` → `router.navigate(url, {strategy, timeout, taskId})`
2. `router.ts` → determines level based on strategy + auto-escalation logic:
   - `strategy === "chromium"` or `"auto"` → `playwrightBackend.navigate()` → returns a11y snapshot
     - If bot detected + auto → tries `stealthBackend.navigate()` as escalation
   - `strategy === "stealth"` → `stealthBackend.navigate()` → spawns JSON-RPC subprocess
   - `strategy === "fetch"` → **removed** ✅ — use `web-fetch` tool instead
3. Returns `NavigateResult {success, url, title, content (a11y tree), backendUsed (chromium|stealth), elementCount?, botDetectionWarning?}`

> **Note**: `"auto"` strategy means chromium→stealth (no fetch step). The agent should call `web-fetch` directly when it only needs to read page content.

### `browser-click` / `browser-type` / `browser-scroll` / `browser-press`:
1. `index.ts` → `router.click(tid, ref)` (or type/scroll/press)
2. `router.ts` → `requireInteractiveSession(tid)` — finds or creates session
3. If no session exists but lastNav available → auto-escalation via chromium then stealth fallback
4. Dispatches to appropriate backend based on `session.level`
5. After interaction → auto-captures snapshot, updates element cache

### `browser-screenshot`:
1. `index.ts` → `router.screenshot(tid, fullPage)`
2. `router.ts` → requires interactive session (same escalation logic as click)
3. Dispatches to backend-level screenshot method
4. Converts result to `{dataUri}` for pi image attachment

### `browser-console`:
1. `index.ts` → `router.evaluate()` OR `router.getConsoleMessages()` OR `router.clearConsole()`
2. Dispatches by session level (chromium uses CDP, stealth has stubs)
3. Console messages formatted as `[type] text` array in pi response

### `/browser-status` command:
1. `index.ts` → reads `sessionManager.getStatus()` + backend availability checks
2. Checks `/opt/ipw-pyenv/bin/python` exists for stealth availability
3. Displays active sessions with per-session level emoji (🔧 chromium, 🦊 stealth)
4. Fetch availability is shown separately as a hint: "Use web-fetch for stateless HTTP fetches."

---

*End of document.*
