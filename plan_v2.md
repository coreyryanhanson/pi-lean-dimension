# pi-browser — Plugin Architecture v2 (Simplified)

> Date: 2026-06-08
> Status: **Proposed** — supersedes Phases 1b–4 of `plan.md` for the plugin system.
> Motivation: The `invisible_playwright` outage taught us that dependency on a single stealth backend is a risk.
> Goal: Make the pi-browser extension backend-agnostic — users configure their preferred browser plugins
> (Node or Python, Chromium or Firefox, official or stealth) with per-plugin config. The agent selects
> which plugin to use via the `strategy` parameter; there is no automatic escalation.

---

## 1. Problem Statement

### What broke

The router hardcodes two backends (`chromium` and `stealth`) with `if/else` dispatch across all 13 operations. When `invisible_playwright` went offline, there was no way to swap in an alternative (e.g., Camoufox) without modifying source code.

### What we want

1. **Named, user-configurable plugins** — Users register backends in `settings.json`; the first enabled plugin is the default
2. **Support both Node and Python backends** — Auto-detected from plugin directory contents, not a config field
3. **Agent-controlled plugin selection** — No automatic escalation; the agent decides which plugin to use via `strategy` param or retry
4. **Backend-agnostic shared core** — URL safety, bot detection, accessibility tree, session management stay shared
5. **Testable dispatch logic** — Unit-test plugin selection and dispatch without real browsers or Python interpreters

### What stays the same

- **`web-fetch`** remains a separate stateless tool, not a browser plugin (Phase 1a done)
- **`browser-toggle.ts`** infrastructure persists
- **Shared utilities** stay in the TypeScript core
- **The 13 interactive operations** — navigate, snapshot, click, type, scroll, screenshot, goBack, press, getImages, getConsoleMessages, clearConsole, evaluate, cleanup
- **Lifecycle hooks** — `init(config)` and `cleanupAll()` are optional lifecycle hooks outside the 13 core operations. `ping` is an internal detail of `PythonPluginAdapter`, not part of the plugin interface.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      pi-browser extension                   │
│                                                             │
│  index.ts  ─── tool definitions (browser-*, web-fetch)      │
│       │                                                     │
│       ├── browser-*  → router → plugin registry dispatch    │
│       └── web-fetch  → fetch-backend.ts directly           │
│                                                             │
│  core/                                                      │
│  ├── plugin-api.ts        BrowserPlugin interface + types   │
│  ├── plugin-registry.ts  Typed registry, default plugin selection   │
│  ├── router.ts            Unified dispatch via registry     │
│  └── shared/              accessibility-tree, bot-detect,  │
│                            session-manager, url-safety      │
│                                                             │
│  backends/                                                  │
│  ├── chromium/            Native Node (Playwright npm)      │
│  ├── python-base/         Shared Python bridge library      │
│  │   └── pi_browser_bridge/  (reusable package)            │
│  ├── stealth/             Ported to use PythonPluginAdapter  │
│  ├── camoufox/            Minimal bridge (reuses python-base)│
│  ├── invisible-pw/        Minimal bridge (reuses python-base)│
│  └── community/           Future 3rd-party plugins          │
│                                                             │
│  fetch/                                                     │
│  └── fetch-backend.ts    Standalone, not a BrowserPlugin     │
└─────────────────────────────────────────────────────────────┘
```

**Design constraints:**

- **Fetch is NOT a BrowserPlugin** — it's a stateless document retriever, stays as a separate tool
- **WebKit is not a target** — no scraper worth maintaining targets only Apple browsers
- **Python plugins communicate via JSON-RPC** — same proven pattern as current stealth bridge, generalized into a reusable adapter
- **Stealth is a property of the plugin, not the language** — a Node-based stealth plugin (e.g., `playwright-extra`) would be registered identically to the Chromium plugin

---

## 3. Core Abstractions

### BrowserPlugin interface

Every interactive backend implements this interface with the 13 interactive operations plus optional lifecycle hooks. Key points:

- **Identity**: `name` (unique string, e.g., "chromium", "camoufox") — stable identifier used in strategy param, session tracking, and error messages
- **Lifecycle hooks** (outside the 13 operations):
  - `init(config?)` — optional. Called once at plugin registration. Receives the `config` bag from `settings.json`.
  - `cleanupAll()` — required. Called on extension shutdown. Cleans up all sessions and resources.
- **Interactive operations** (the 13):
  - **Navigation & state**: `navigate()`, `snapshot()`
  - **Interaction**: `click()`, `type()`, `scroll()`, `goBack()`, `press()`
  - **Media**: `screenshot()`, `getImages()`
  - **Console & eval**: `getConsoleMessages()`, `clearConsole()`, `evaluate()`
  - **Cleanup**: `cleanup(taskId)` — per-task teardown
- **Capabilities**: read-only `PluginCapabilities` object advertising what the backend supports

> **Why `init`/`cleanupAll` are hooks, not operations**: They are called once (at startup/shutdown), not per-interaction. Counting them as operations would blur the line between "things the agent triggers" and "things the framework triggers." The 13 operations map 1:1 to agent-facing tool calls. `ping` is internal to `PythonPluginAdapter` only — it's not in the interface at all.

### Unified result types

Each operation returns a typed result (e.g., `NavigateResult`, `InteractionResult`, `ScreenshotResult`). All share a common pattern:

- `success: boolean` — always present
- `error?: string` — present on failure
- Operation-specific fields (e.g., `snapshot`, `elementCount`, `dataUri`)

**Error contract**: Operations return `{success: false, error}` for expected failures (bot detection, element not found). They **may throw** for infrastructure failures (process crash, OOM). The router catches throws and normalizes them.

**Post-processing contract**: Plugins return raw results. The router is responsible for cross-cutting transformations that apply regardless of backend:
- `compactSnapshot()` — truncates snapshots to ~2500 chars inline (with temp file spill for large content)
- `compactInteractionResult()` — truncates auto-snapshot content on interaction results
- Adding `count` fields (e.g., `GetImagesResult.count`) — the router wraps backend results to add these
- `botDetected` signal pass-through — if a plugin returns `botDetected: true`, the router includes it in the result with a warning suggesting alternative strategies (see §4)
- URL safety validation — runs before any plugin is called
- Session management — `createSession`, `updateSession`, `setLastNav`, `removeSession` are router-level concerns that surround every dispatch

> With auto-escalation removed, the router reduction is **~25–30%**. The if/else dispatch blocks (~80–100 lines) and the escalation logic (`escalateToStealthIfAuto()`, escalation loop, session transition handling) are all eliminated. The remaining orchestration (session management, truncation, URL safety, `lastNav` recovery) survives.

### PluginRegistry

A typed registry that holds all registered plugins. Supports:

- `register(name, plugin)` — with validation that all 13 operations exist
- `get(name)` → `BrowserPlugin | undefined`
- `getDefault()` → first enabled plugin from the configured `plugins` array
- `getOrdered()` → all enabled plugins in array order (with stealth level indices), for generating tool descriptions and warnings
- `available()` → list of registered plugin names

---

## 4. Plugin Selection Semantics

**Rule: Agent decides, no automatic escalation**

The router does not automatically try multiple plugins on failure. Instead, it reports results (including
signals like `botDetected`) and lets the agent decide what to do next. This is a deliberate design choice
for an agent-facing tool: explicit > implicit.

### Why no auto-escalation?

1. **Session discontinuity** — Escalation requires re-navigating in a new browser, destroying all session state (cookies, form data, scroll position, navigation history). The agent's mental model of "I'm on page 3" breaks silently.
2. **Agent can reason** — Unlike a human end-user who wants transparent fallback, the AI agent can understand the failure and choose a recovery strategy. It might interact with a Cloudflare challenge, fall back to `web-fetch`, or retry with a different plugin.
3. **Cost awareness** — Each stealth backend launch is expensive (Python subprocess, browser binary, network request). The agent should know the cost and opt in.
4. **Multiple stealth backends** — Users may chain several stealth browsers. Auto-escalation could silently cascade through all of them, burning latency, and the agent never knows which one it ended up in.
5. **Partial usability** — Bot detection is heuristic. The page may be usable despite the signal. The agent should see the warning and decide, not have the session silently replaced.

### How plugin selection works

1. User-configured plugins are registered from the `plugins` array, filtered to `enabled !== false`
2. On `browser-navigate` with `strategy="auto"`: use the first enabled plugin in the array. No iteration, no fallback.
3. On `strategy="<name>"` (explicit): use only that plugin.
4. On navigation failure (`success: false`): return the error to the agent. The agent can retry with a different `strategy`.
5. On bot detection (`botDetected: true`): return the result with a `warning` field suggesting alternative strategies. The agent decides whether to continue in the current session or retry.
6. Session stores `pluginName: string` — set once at creation, never changes. No session transitions.
7. **Console and `getImages` on stealth**: `getConsoleMessages`/`clearConsole` return empty results silently when `supportsConsoleCapture: false`. `getImages` on stealth depends on `evaluate` being available — if a plugin marks `supportsJavaScriptEvaluate: false`, `getImages` must be reimplemented.

### Stealth levels and plugin ordering

The `plugins` array order is more than just a default selection — it defines an implicit **stealth level**
for each plugin. Position 0 is the least stealthy (typically standard Chromium), and each subsequent
position represents increasing anti-detection capability. This ordering is surfaced to the agent so it
can reason about what alternatives are available without guesswork.

**How stealth levels are communicated:**

1. **Tool description** — The `strategy` parameter description on `browser-navigate` is dynamically
   generated from the registered plugins array, listing each plugin with its stealth level:
   ```
   strategy: Select browser plugin.
     "auto" — default (chromium)
     "chromium" — standard Playwright Chromium (stealth level 0)
     "camoufox" — stealth Firefox (stealth level 1)
     "invisible-playwright" — invisible Playwright Firefox (stealth level 2)
   ```

   The agent reads this every turn in the tool schema, so it always knows what's available and how
   the plugins relate to each other in terms of stealth capability.

2. **`botDetected` warning** — When bot detection fires, the warning lists only plugins at **higher**
   stealth levels than the current one, so the agent knows what's "more powerful" without noise:
   ```
   "Bot/anti-automation detection triggered (stealth level 0). The page may be partially usable.
    Higher-stealth alternatives: camoufox (level 1), invisible-playwright (level 2)."
   ```

3. **`/browser-status` command** — Shows all registered plugins with their stealth levels and enabled status.

**Why levels, not ordinals, as the parameter?** The agent always selects a plugin by `strategy` name
(e.g., `"camoufox"`), not by level number. Level numbers are metadata for reasoning — they tell the
agent "camoufox is more stealthy than chromium" — not an input to the function. Using names is
self-documenting in conversation history, stable across config changes (reordering the array doesn't
silently remap what `strategy="camoufox"` means), and resistant to errors from disabled plugins.

### `botDetected` signaling

Only plugins with `supportsBotDetection: true` return `botDetected` as a boolean. Plugins without bot
detection return `botDetected: undefined`. The router passes this through to the agent without acting
on it — `undefined` simply means "no signal" and the result omits the field entirely.

When `botDetected: true`, the router adds a `warning` to the result that includes the current plugin's
stealth level and lists higher-stealth alternatives (see example above in "Stealth levels and plugin ordering").

### `strategy` parameter values

The `strategy` parameter on `browser-navigate` is dynamically populated from registered plugins.
The parameter description lists each plugin with its stealth level (see "Stealth levels and plugin ordering"
for the full format). Valid values:

- `"auto"` — always present; uses the first enabled plugin (lowest stealth level)
- `"<pluginName>"` — one entry per registered, enabled plugin

This replaces the current hardcoded `StringEnum(["auto", "chromium", "stealth"])`.

---

## 5. User-Configurable Plugin List

### Config schema (settings.json)

The `plugins` array defines registered plugins and their stealth ordering. **The first enabled plugin is
the default** (used when `strategy="auto"`). **Array position defines stealth level** — position 0 is
level 0 (least stealthy), position 1 is level 1, and so on. Users should order plugins from least to
most stealthy so that the agent can reason about escalation options (see §4, "Stealth levels and plugin ordering").

```jsonc
{
  "browser": {
    "plugins": [
      {
        "name": "chromium",
        "dir": "chromium"
      },
      {
        "name": "invisible-playwright",
        "dir": "stealth",
        "config": {
          "pythonBin": "/opt/ipw-pyenv/bin/python"
        }
      },
      {
        "name": "camoufox",
        "dir": "camoufox",
        "enabled": false,
        "config": {
          "pythonBin": "/home/user/.camoufox/venv/bin/python",
          "binary": "/home/user/.camoufox/bin/camoufox"
        }
      }
    ]
  }
}
```

### Plugin entry fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | ✅ | — | Stable identifier. Used in `strategy` param, session tracking, error messages. Must be unique across the array. |
| `dir` | ✅ | — | Directory name under `backends/` containing the plugin code. The loader inspects this directory to determine the plugin type. |
| `enabled` | ❌ | `true` | Set to `false` to skip this plugin without removing it from the config. |
| `config` | ❌ | `{}` | Plugin-specific overrides passed to `init()`. Each plugin documents its own config keys and defaults. |

### Plugin type auto-detection

The `type` (Node vs Python) is **not** a config field — it is auto-detected from the plugin directory contents:

- `backends/<dir>/index.ts` exists → **Node plugin**. Loaded via `import()`. Implements `BrowserPlugin` directly.
- `backends/<dir>/bridge.py` exists → **Python plugin**. Spawned as a subprocess. Wrapped by `PythonPluginAdapter`.

This eliminates an entire class of user errors (e.g., setting `type: "node"` on a Python plugin and getting a confusing import error instead of a clear diagnostic).

**Ambiguity rule**: If a plugin directory contains **both** `index.ts` and `bridge.py`, the loader **fails fast** with a clear error: `"Plugin dir '<dir>' is ambiguous: both index.ts and bridge.py found. Remove one."` This prevents silent misconfiguration where the wrong plugin type is loaded.

### Config ownership: plugin code owns defaults, user config owns overrides

Each plugin's code defines sensible defaults for its own config (standard install paths, module names, etc.).
The `config` bag in `settings.json` overrides those defaults. This means:

- **Plugin code is version-controlled and self-documenting** — it defines defaults and documents what keys it accepts
- **Users don't touch plugin code** — they override paths in `settings.json`, which is personal/local
- **No git dirty state** — the user's Python binary path isn't sitting in a tracked file
- **Plugin authors decide their own config surface** — Chromium doesn't need `pythonBin`, Camoufox doesn't need `browserArgs`. Each plugin documents what it accepts.

### Default fallback

If no `browser.plugins` config exists, default to a single Chromium plugin — identical to today's behavior. Backward compatible.

**Only Chromium ships as a default dependency.** Playwright is already in `package.json` and `npx playwright install chromium` is a one-liner. This gives every user a working browser out of the box with zero configuration. Stealth backends (Python virtualenvs, custom browser binaries, etc.) are user-installed with documented setup guides. The extension does not attempt to manage Python environments or download stealth browser binaries — that's a package manager's job, not a browser extension's job.

---

## 6. Backend Types

### 6.1 Native Node Plugin

A TypeScript module that implements `BrowserPlugin` directly using the Playwright npm package. The current `playwright-backend.ts` becomes `backends/chromium/index.ts` implementing the interface.

**Detection**: loader finds `backends/<dir>/index.ts` → `import()` it.

**Registration**: imported and registered at extension startup.

**Config**: receives the `config` bag from `settings.json` in `init(config)`. Chromium's default config is empty — no overrides needed.

### 6.2 Python Plugin via Generic Adapter

**Detection**: loader finds `backends/<dir>/bridge.py` → spawn it.

**TypeScript side**: `PythonPluginAdapter` implements `BrowserPlugin`. It handles:
- Process lifecycle (spawn, crash recovery, restart)
- JSON-RPC command dispatch (translates each `BrowserPlugin` method to a JSON-RPC call)
- Passes the `config` bag from `settings.json` through to the bridge on init

**Python side**: A shared base library (`pi_browser_bridge`) provides:
- JSON-RPC transport (stdin/stdout, error wrapping, timeouts) — ~40–50 lines of genuinely shared code
- Browser session lifecycle (init, context/page creation, cleanup)
- Role-based locator helpers (wait_for patterns, click, fill)
- Generic command handlers for all 13 operations
- Shutdown lifecycle (SIGTERM, resource release)

> **Realistic savings estimate**: The original estimate of "~240 lines of boilerplate per plugin" was overstated. The current `stealth_bridge.py` handlers are mostly 3–8 lines each; the real shared code is JSON-RPC transport + lifecycle (~40–50 lines). A plugin author still provides a compact bridge script, but "~20 lines" is optimistic — expect ~30–50 lines including imports, session creation, and error handling.

**What a plugin author provides**: A bridge script (~30–50 lines) that imports `pi_browser_bridge`, overrides `create_browser_session()` with the stealth-specific init. Example: Camoufox and Invisible Playwright bridges differ in the import line, init kwargs, and browser session creation.

**Element cache**: `PythonPluginAdapter` uses the shared `parseSnapshot()` from `accessibility-tree.ts` to produce `AriaCachedNode` objects — the same representation as Chromium. The adapter then extracts `role`/`name`/`level` from `AriaCachedNode` for JSON-RPC calls to the Python bridge. This provides a single source of truth for `@e` ref parsing and eliminates the current stealth-specific simplified cache.

> **Current state**: Chromium stores full `AriaCachedNode` objects (with `ref, role, name, props[], depth, raw`), while stealth stores simplified `{role, name, level}`. The stealth code manually extracts `level` from `props` strings in `cacheSnapshot()` — redundant with `parseSnapshot()` but producing a different shape. The refactor consolidates both to use `parseSnapshot()`.

**Bridge protocol**: Line-delimited JSON-RPC over stdin/stdout (same as current stealth bridge). Each command maps to a `BrowserPlugin` method name with matching params/result shapes.

---

## 7. Quirks System

Capabilities that differ between backends are advertised via `PluginCapabilities`. The router respects these transparently.

| Capability | Chromium | Camoufox | Invisible PW |
|---|---|---|---|
| `supportsFullPageScreenshot` | ✅ | ? | ❌ |
| `supportsConsoleCapture` | ✅ (CDP) | ❌ | ❌ |
| `supportsJavaScriptEvaluate` | ✅ | ❌ (read-only) | ✅ |
| `supportsBotDetection` | ✅ | ❌ | ❌ |
| `supportsDialogAutoDismissal` | ✅ (CDP) | ❌ | ❌ |
| `supportsAbortSignal` | ✅ | ❌ | ❌ |
| `engine` | "chromium" | "firefox" | "firefox" |

> **Notable dependency**: Stealth's `getImages()` calls `bridge.call("evaluate", ...)` — it runs JavaScript to extract image data. If a future plugin sets `supportsJavaScriptEvaluate: false`, `getImages` must be reimplemented or will break. Document this dependency in the plugin author guide.

**Promotion rule**: If 2+ plugins share a quirk pattern, it gets promoted to a core capability field.

**Router adaptation**: Before calling an operation, the router checks capabilities:
- `fullPage` screenshot requested but `supportsFullPageScreenshot: false` → fall back to viewport screenshot, include a note in the result
- `getConsoleMessages` called but `supportsConsoleCapture: false` → return empty result with `{success: true, messages: [], note: "Console capture not supported by this plugin"}`
- `evaluate` called but `supportsJavaScriptEvaluate: false` → return `{success: false, error: "JavaScript evaluation not supported by plugin 'X'. Retry with a different strategy."}`
- `botDetected` only meaningful when `supportsBotDetection: true` — plugins without bot detection always return `botDetected: undefined`, which the router passes through as-is (no signal = omitted from result). The router adds a `warning` suggesting alternative strategies only when `botDetected: true`.

---

## 8. Test Strategy

### 8.1 Plugin selection and dispatch tests (MockPlugin)

A `MockPlugin` fixture implements `BrowserPlugin` with configurable behavior:
- Simulate navigate failure or bot detection
- Track call counts per operation
- Callbacks for asserting call order

Key test scenarios:
- `strategy="auto"` selects the first enabled plugin
- `strategy="<name>"` selects the named plugin
- Disabled plugins are skipped; `auto` uses the next enabled one
- `botDetected: true` is passed through in the result with a warning
- Navigation failure returns the error to the caller (no fallback)
- Session `pluginName` is set once at creation and never changes

### 8.2 Plugin contract tests (Test Harness)

A reusable test suite that any plugin can run against to verify it satisfies the `BrowserPlugin` contract:
- Navigate returns correct result shape with `@e` refs
- Click/type/scroll return `InteractionResult` with auto-snapshot
- Screenshot returns valid data URI
- All 13 operations tested against a local test server

Usage: plugin-specific test file creates the plugin instance and passes it to the harness.

### 8.3 Plugin implementation tests

Each plugin also has its own integration tests for specifics:
- Python adapter: connection, heartbeat, crash recovery
- Chromium: full-page screenshots, CDP console capture, JS evaluate
- Stealth (ported): existing interaction patterns through the adapter

---

## 9. Phased Implementation Plan

### Phase 1a — Fetch decoupling ✅ DONE

### Phase 1b — Core plugin infrastructure

| Step | What | Key Files |
|---|---|---|
| 1 | Extract `BrowserPlugin` interface + unified result types | `core/plugin-api.ts` |
| 2 | Build `PluginRegistry` with typed registration + validation | `core/plugin-registry.ts` |
| 3 | Build plugin config loader (reads `browser.plugins` from settings.json, validates entries, detects plugin type, fails fast on ambiguous dirs) | New `core/plugin-config.ts` |
| 4 | Build shared Python bridge library (`pi_browser_bridge` package) | `backends/python-base/` |
| 5 | Build `PythonPluginAdapter` (TypeScript side, uses shared `parseSnapshot()` for element cache) | `backends/python-adapter.ts` |
| 6 | Port `playwright-backend.ts` → `ChromiumPlugin` class | `backends/chromium/` |
| 7 | Port `stealth-bridge.py` → use shared bridge base | `backends/stealth/` |
| 8 | Port `stealth-backend.ts` → use `PythonPluginAdapter` | `backends/stealth/` |
| 9 | Simplify router → registry-based dispatch (~25–30% reduction with auto-escalation removed — escalation loop, session transition logic, stale-ref detection all eliminated) | `core/router.ts` |
| 10 | Widen `BackendLevel` to `string` + update all consumers (see §11.5) | `core/shared/session-manager.ts`, `index.ts`, `browser-toggle.ts` |
| 11 | Remove unused `processHandle` field from `BrowserSession` | `core/shared/session-manager.ts` |
| 12 | Make `browser-navigate` strategy parameter dynamic (populated from registered plugins with stealth levels, not hardcoded) | `index.ts` |
| 13 | Update `/browser-status` command for dynamic plugin list with stealth levels | `index.ts` |
| 14 | Build `MockPlugin` fixture + plugin selection/dispatch tests | `__tests__/` |
| 15 | Build plugin contract test harness | `__tests__/` |

### Phase 2 — Python adapter productionization

- Crash recovery: auto-restart Python bridge on unexpected exit
- Ping/heartbeat to detect unresponsive bridges
- Python binary path configured via `config.pythonBin` (remove hardcoded `/opt/ipw-pyenv/bin/python`)
- Temp file management for large content spill
- Bridge stdout/stderr logging for debugging
- Clear error messages when a plugin is not configured (e.g., "Plugin 'camoufox' is not configured. See <docs> for setup instructions.")

### Phase 3 — Camoufox & Invisible Playwright plugin configs

Each needs only a ~20-line bridge script and a `settings.json` entry:
- Write bridge scripts (import `pi_browser_bridge`, override `create_browser_session`)
- Add as entries in the `plugins` array with `dir` pointing to the backend directory
- Contract-test both against the plugin test harness
- Update `browser-navigate` strategy help text
- Document the bridge protocol
- Write setup guides for each stealth backend (Python venv, binary paths, config keys)
- Document the `getImages`-depends-on-`evaluate` constraint in the plugin author guide

### Phase 4 — Community readiness

- Deprecated re-exports in `utils/` (with `console.warn`)
- Directory restructuring (optional — only if a 3rd plugin arrives)
- Contribution guide at `backends/community/README.md`
- Extract test harness to npm package (optional, deferred until demand)

---

## 10. Open Questions & Future Work

### Cross-session plugin persistence

**Decision**: No migration. Sessions stay bound to their original plugin (set once at creation, never changes). If that plugin is no longer registered, the router returns a clear error listing available plugins. The LLM adapts from conversation context.

### Plugin discovery & defaults

**Decision**: Explicit registration only (no auto-discovery). Default fallback: if no `browser.plugins` config exists, single Chromium plugin — same as today.

### Python dependency management

**Decision**: User responsibility. Only Chromium ships as a default dependency (Playwright npm + `npx playwright install chromium`). All stealth backends require user-installed Python environments and browser binaries. Document prerequisites with clear setup guides. Auto-install is future work.

This boundary is intentional: pi-browser owns the plugin *framework*. Plugin authors own their *installation*. The extension does not manage Python virtualenvs or download stealth browser binaries.

### Error recovery semantics

If a bridge process crashes mid-operation: detect exit, attempt restart, return `{success: false, error: "Bridge crashed; retry the operation"}`.

### Plugin capabilities negotiation

**Decision**: Return error if current plugin can't satisfy the operation (e.g., JS evaluate on read-only backend). Let the agent decide whether to retry with a different plugin. Auto-escalation by capability is out of scope — the agent controls plugin selection.

---

## 11. Codebase Audit Findings & Design Decisions

> Results from a thorough audit of plan_v2.md against the current codebase (2026-06-07).
> Each finding includes the issue, its impact, and the decision made.

### 11.1 Operation count: lifecycle hooks vs interactive operations

**Finding**: The original plan listed `init` and `cleanupAll` alongside the 13 interactive operations without clearly distinguishing them. The Python bridge also has a `ping` command for liveness checks that wasn't mentioned.

**Impact**: If lifecycle methods are counted as operations, the `PluginRegistry` validation logic becomes confusing — `init` is called once at startup, `cleanup(taskId)` is called per-task, and `cleanupAll()` is called at shutdown. These are fundamentally different call patterns from the 13 agent-facing operations.

**Decision**: `init(config?)` and `cleanupAll()` are **optional lifecycle hooks** outside the 13 core operations. `ping` is **internal to `PythonPluginAdapter`** — not part of the interface at all. The 13 operations map 1:1 to agent-facing tool calls; lifecycle hooks are framework-triggered.

### 11.2 Result type unification has cross-cutting concerns

**Finding**: Several result type details the plan omitted:
- `compactSnapshot()` and `compactInteractionResult()` run in the router on all backend results — they can't move to plugins
- The router adds `count` fields (e.g., `GetImagesResult.count`) that backends don't return
- Stealth's `getConsoleMessages` returns a raw array; the router wraps it into `{success, messages}`
- `botDetected` is only returned by Chromium; stealth never sets it
- Stealth silently drops `fullPage` screenshot requests; the plan didn't specify fallback behavior

**Impact**: If plugins are expected to return "final" result shapes, the adapter layer becomes complex. The router must continue doing post-processing regardless of which plugin is used.

**Decision**: Plugins return **raw results**. The router is responsible for cross-cutting transformations (truncation, count fields, result wrapping). This is explicit in the interface documentation (§3, "Post-processing contract"). `botDetected: true` is passed through as a warning to the agent (see §4). `fullPage` screenshot fallback to viewport is documented in quirks (§7).

### 11.3 Router reduction estimate corrected

**Finding**: The plan implied ~35% router reduction. In reality, the if/else dispatch blocks are only ~80–100 lines of the ~764-line router. The remaining ~600+ lines are orchestration that survives the refactor: `requireInteractiveSession()`, `refBasedInteractionOrSnapshot()`, `compactSnapshot()`/`compactInteractionResult()`, session management integration, URL safety validation, and `lastNav` tracking. The auto-escalation logic (`escalateToStealthIfAuto()`, escalation loop, session transition handling) has been removed by design (see §4), which eliminates additional complexity.

**Impact**: Underestimating router complexity risks insufficient planning for the refactor step. The "simplify router → registry-based dispatch" step appears simple but is the highest-risk change in the plan.

**Decision**: With auto-escalation removed, the router reduction is **~25–30%**. The if/else dispatch blocks (~80–100 lines) plus the eliminated escalation logic are both gone. The remaining orchestration (session management, truncation, URL safety, `lastNav` recovery) survives but is simpler without session transitions.

### 11.4 Element cache divergence resolved

**Finding**: Chromium stores full `AriaCachedNode` objects (with `ref, role, name, props[], depth, raw`), while stealth stores simplified `{role, name, level}`. The stealth code manually extracts `level` from `props` strings in `cacheSnapshot()` — redundant with `parseSnapshot()` but producing a different shape.

**Impact**: If `PythonPluginAdapter` uses a different cache representation than Chromium, element interaction becomes inconsistent across backends. If it uses the same representation, there's an extra parsing step to extract role/name/level for JSON-RPC.

**Decision**: `PythonPluginAdapter` uses the **shared `parseSnapshot()`** from `accessibility-tree.ts` to produce `AriaCachedNode` objects. The adapter extracts `role`/`name`/`level` from `AriaCachedNode` for JSON-RPC calls. Single source of truth for `@e` ref parsing.

### 11.5 `BackendLevel` widening has cascading effects

**Finding**: Widening `BackendLevel` from `"chromium" | "stealth"` to `string` touches more than just `session-manager.ts`:
- `session-manager.ts`: `levelToSymbol()` uses a switch statement — needs a general mapping strategy
- `index.ts`: `browser-navigate` tool's `strategy` parameter uses `StringEnum(["auto", "chromium", "stealth"])` (hardcoded) — must become dynamic
- `browser-toggle.ts`: Status bar display shows "PW" / "IPW" — must support arbitrary plugin names
- `/browser-status` command: Hardcodes chromium/stealth availability checks

**Impact**: If any of these consumers are missed during the refactor, the extension breaks in confusing ways (e.g., a registered plugin that can't be selected via `strategy` param).

**Decision**: Added explicit steps in Phase 1b (steps 10, 12, 13) to update all consumers. `levelToSymbol()` becomes a registry-driven lookup. The `strategy` parameter is populated from registered plugin names at tool definition time, with stealth level labels in the description (see §4).

### 11.6 Config module design

**Finding**: The plan proposed `browser.plugins` in `settings.json` but didn't specify who reads it, when, or how errors are handled. The current config mechanism (`browser-toggle.ts`) uses simple `existsSync + readFileSync + JSON.parse`.

**Impact**: Without a clear config loading strategy, plugin registration order and error handling are ambiguous.

**Decision**: A new `core/plugin-config.ts` module (Phase 1b step 3) is responsible for:
- Reading `browser.plugins` from `settings.json` at extension load time
- Validating entries (required `name`/`dir`, unique names, valid dirs)
- Detecting plugin type from directory contents (with fail-fast on ambiguous dirs)
- Returning a typed `PluginConfig[]` array to the registration process
- Providing clear error messages for misconfigured plugins

Config is read once at startup. Hot-reload is future work.

### 11.7 Missing capabilities in quirks table

**Finding**: The original quirks table missed several real differences between backends:
- `supportsBotDetection` — only Chromium returns `botDetected`. Now used as an agent signal (warning in result), not an escalation trigger.
- `supportsDialogAutoDismissal` — Chromium uses CDP to auto-dismiss JS dialogs. Stealth doesn't handle dialogs at all. Affects snapshot content.
- `supportsAbortSignal` — Chromium accepts `signal?: AbortSignal` in navigate. Stealth has no abort support.
- `getImages` depends on `evaluate` — stealth's `getImages()` calls `bridge.call("evaluate", ...)` internally.

**Impact**: Without these capabilities documented, the router can't make correct decisions about fallback behavior or error messages.

**Decision**: Added `supportsBotDetection`, `supportsDialogAutoDismissal`, and `supportsAbortSignal` to the quirks table (§7). Added the `getImages`→`evaluate` dependency as a note. Documented the router adaptation for each case.

### 11.8 `processHandle` removal

**Finding**: `BrowserSession` has an unused `processHandle?: unknown` field. Nothing ever sets it. The stealth backend manages its own `_bridges` map independently.

**Impact**: Dead code that adds confusion about who owns subprocess lifecycle.

**Decision**: Remove `processHandle` from `BrowserSession` (Phase 1b step 11). The `PythonPluginAdapter` manages its own subprocess references internally.

### 11.9 Python bridge savings estimate

**Finding**: The "~240 lines of boilerplate per plugin" and "~20-line bridge script" estimates were overstated. The current `stealth_bridge.py` handlers are mostly 3–8 lines each; the genuinely shared code is JSON-RPC transport + lifecycle (~40–50 lines).

**Impact**: Overstated savings set wrong expectations for plugin authors.

**Decision**: Corrected to realistic estimates in §6.2. A plugin author provides ~30–50 lines (not ~20). The shared library still provides significant value (transport, lifecycle, command routing) but the savings are more modest than originally claimed.

### 11.10 `lastNav` and session auto-recovery

**Finding**: The `lastNav` mechanism for session auto-recovery (`requireInteractiveSession()` in router.ts) is critical and lives entirely in the router. When a session doesn't exist but `lastNav` data is present, the router auto-creates a session on the **same plugin** the original session used (stored in `lastNav`). The `refBasedInteractionOrSnapshot()` helper detects stale `@e` refs after page navigation changes and returns a fresh snapshot instead of performing the action.

**Impact**: These are subtle cross-concern logic paths that can't be moved to plugins or the registry. They must survive the router refactor intact. Without auto-escalation, `refBasedInteractionOrSnapshot()` no longer needs to handle session transitions — only normal page-navigation staleness.

**Decision**: Noted as a risk in §11.3. The router refactor step must preserve `requireInteractiveSession()`, `refBasedInteractionOrSnapshot()`, and `lastNav` tracking as-is. The stale-ref-after-escalation case is eliminated by design (§4).

---

## Appendix: Current vs v2 Architecture

| Aspect | Current | v2 |
|---|---|---|
| **Backend type** | Union: `"chromium" \| "stealth"` | String: any registered plugin name |
| **Dispatch** | 13 if/else blocks hardcoded | Single `registry.get(name).method()` |
| **Session level** | Stored as `BackendLevel` union | Stored as `pluginName: string` |
| **Plugin config** | None (hardcoded imports) | `settings.json` with `browser.plugins` array |
| **Stealth levels** | Fixed: chromium → stealth | Array position = stealth level (0, 1, 2…); surfaced in tool descriptions and warnings |
| **Plugin type** | Hardcoded per backend | Auto-detected from `backends/<dir>/` contents |
| **Python bridge** | `StealthBridge` (hardcoded to `invisible_playwright`) | `PythonPluginAdapter` (auto-detected from `bridge.py`, config via `config` bag) |
| **Escalation** | Auto: chromium → stealth on bot detection | None — agent decides via `strategy` param or retry |
| **Session binding** | Can change mid-session on escalation | Set once at creation, never changes |
| **Test dispatch** | No tests (requires browsers) | `MockPlugin` fixture + unit tests |
| **Plugin correctness** | No common verification | Contract test harness reusable per plugin |
| **Default dependency** | Chromium + stealth (hardcoded) | Chromium only (stealth is user-installed) |
| **Community plugins** | Not possible (requires editing router) | Register via `settings.json` + implement interface |
| **Element cache** | Divergent: `AriaCachedNode` vs simplified `{role, name, level}` | Unified: shared `parseSnapshot()` + `AriaCachedNode` |
| **Router reduction** | N/A | ~25–30% (escalation logic + if/else dispatch eliminated; orchestration survives) |
| **processHandle** | Unused field in `BrowserSession` | Removed |

---

*End of document.*
