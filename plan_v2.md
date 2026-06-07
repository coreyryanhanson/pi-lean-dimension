# pi-browser — Plugin Architecture v2 (Simplified)

> Date: 2026-06-07
> Status: **Proposed** — supersedes Phases 1b–4 of `plan.md` for the plugin system.
> Motivation: The `invisible_playwright` outage taught us that dependency on a single stealth backend is a risk.
> Goal: Make the pi-browser extension backend-agnostic — users configure their preferred browser plugins
> (Node or Python, Chromium or Firefox, official or stealth) as an ordered escalation chain with per-plugin config.

---

## 1. Problem Statement

### What broke

The router hardcodes two backends (`chromium` and `stealth`) with `if/else` dispatch across all 13 operations. When `invisible_playwright` went offline, there was no way to swap in an alternative (e.g., Camoufox) without modifying source code.

### What we want

1. **Named, user-configurable plugins** — Users specify backends as an ordered array in `settings.json`; array position = escalation order
2. **Support both Node and Python backends** — Auto-detected from plugin directory contents, not a config field
3. **Generic escalation chain** — Try plugins in array order; fail → next; stop on first success
4. **Backend-agnostic shared core** — URL safety, bot detection, accessibility tree, session management stay shared
5. **Testable escalation logic** — Unit-test the chain without real browsers or Python interpreters

### What stays the same

- **`web-fetch`** remains a separate stateless tool outside the escalation chain (Phase 1a done)
- **`browser-toggle.ts`** infrastructure persists
- **Shared utilities** stay in the TypeScript core
- **The 13 operation surface** — all plugins must implement navigate, snapshot, click, type, scroll, screenshot, goBack, press, getImages, getConsoleMessages, clearConsole, evaluate, cleanup

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
│  ├── plugin-registry.ts  Typed registry, array-ordered escalation  │
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

Every interactive backend implements this interface with the 13 operations. Key points:

- **Identity**: `name` (unique string, e.g., "chromium", "camoufox") — stable identifier used in strategy param, session tracking, and error messages
- **Lifecycle**: optional `init(config)`, required `cleanup(taskId)` and `cleanupAll()`
- **Navigation & state**: `navigate()`, `snapshot()`
- **Interaction**: `click()`, `type()`, `scroll()`, `goBack()`, `press()`
- **Media**: `screenshot()`, `getImages()`
- **Console & eval**: `getConsoleMessages()`, `clearConsole()`, `evaluate()`
- **Capabilities**: read-only `PluginCapabilities` object advertising what the backend supports

### Unified result types

Each operation returns a typed result (e.g., `NavigateResult`, `InteractionResult`, `ScreenshotResult`). All share a common pattern:

- `success: boolean` — always present
- `error?: string` — present on failure
- Operation-specific fields (e.g., `snapshot`, `elementCount`, `dataUri`)

**Error contract**: Operations return `{success: false, error}` for expected failures (bot detection, element not found). They **may throw** for infrastructure failures (process crash, OOM). The router catches throws and normalizes them.

### PluginRegistry

A typed registry that holds all registered plugins. Supports:

- `register(name, plugin)` — with validation that all 13 operations exist
- `get(name)` → `BrowserPlugin | undefined`
- `getEscalationChain(config)` → plugins in user-configured array order, filtered to enabled
- `available()` → list of registered plugin names

---

## 4. Escalation Semantics

**Rule: Fail → next**

1. User-configured plugins are gathered from the `plugins` array, filtered to `enabled !== false`
2. On `browser-navigate` with `strategy="auto"`:
   - Try each plugin in array order (position 0 = highest priority)
   - If `navigate()` returns `success: true` AND `botDetected: false` → session established, done
   - If `success: false` OR `botDetected: true` → log reason, try next plugin
   - If the last plugin also fails → return error from the last plugin tried
3. On `strategy="<name>"` (explicit): use only that plugin. If it fails, no fallback
4. Session stores `pluginName: string` (not a union type) — any registered plugin name is valid

> **Why an array, not priority numbers?** Numeric priorities introduce an ambiguous tie-breaking problem
> (what happens when two plugins share the same number?) and add cognitive overhead — to understand the
> escalation order, you must scan all priorities and sort them in your head. The array *is* the escalation
> order. Position 0 is tried first, position 1 next, and so on. Zero ambiguity, zero tie-breaking logic.

---

## 5. User-Configurable Plugin Chain

### Config schema (settings.json)

The `plugins` array defines the escalation chain. **Array position = escalation order.**

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

**Python side**: A shared base library (`pi_browser_bridge`) eliminates ~240 lines of boilerplate per plugin. It provides:
- JSON-RPC transport (stdin/stdout, error wrapping, timeouts)
- Browser session lifecycle (init, context/page creation, cleanup)
- Role-based locator helpers (wait_for patterns, click, fill)
- Generic command handlers for all 13 operations
- Shutdown lifecycle (SIGTERM, resource release)

**What a plugin author provides**: A ~20-line bridge script that imports `pi_browser_bridge`, overrides `create_browser_session()` with the stealth-specific init, and that's it. Example: Camoufox and Invisible Playwright bridges differ only in the import line and init kwargs.

**Bridge protocol**: Line-delimited JSON-RPC over stdin/stdout (same as current stealth bridge). Each command maps to a `BrowserPlugin` method name with matching params/result shapes.

---

## 7. Quirks System

Capabilities that differ between backends are advertised via `PluginCapabilities`. The router respects these transparently.

| Capability | Chromium | Camoufox | Invisible PW |
|---|---|---|---|
| `supportsFullPageScreenshot` | ✅ | ? | ❌ |
| `supportsConsoleCapture` | ✅ (CDP) | ❌ | ❌ |
| `supportsJavaScriptEvaluate` | ✅ | ❌ (read-only) | ✅ |
| `engine` | "chromium" | "firefox" | "firefox" |

**Promotion rule**: If 2+ plugins share a quirk pattern, it gets promoted to a core capability field.

**Router adaptation**: Before calling an operation, the router checks capabilities. Example: if `fullPage` screenshot is requested but the plugin doesn't support it, fall back to viewport screenshot instead of crashing.

---

## 8. Test Strategy

### 8.1 Escalation chain tests (MockPlugin)

A `MockPlugin` fixture implements `BrowserPlugin` with configurable behavior:
- Simulate navigate failure or bot detection
- Track call counts per operation
- Callbacks for asserting call order

Key test scenarios:
- Plugins tried in priority order; first success wins
- Short-circuit: later plugins not tried after success
- Bot detection triggers escalation to next plugin
- All-fail returns aggregated error
- Explicit strategy uses only that plugin (no fallback)
- Disabled plugins skipped in escalation

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
| 3 | Build shared Python bridge library (`pi_browser_bridge` package) | `backends/python-base/` |
| 4 | Build `PythonPluginAdapter` (TypeScript side) | `backends/python-adapter.ts` |
| 5 | Port `playwright-backend.ts` → `ChromiumPlugin` class | `backends/chromium/` |
| 6 | Port `stealth-bridge.py` → use shared bridge base | `backends/stealth/` |
| 7 | Port `stealth-backend.ts` → use `PythonPluginAdapter` | `backends/stealth/` |
| 8 | Simplify router → registry-based dispatch | `core/router.ts` |
| 9 | Widen `BackendLevel` to `string` (plugin name) | `core/shared/session-manager.ts` |
| 10 | Build `MockPlugin` fixture + escalation chain tests | `__tests__/` |
| 11 | Build plugin contract test harness | `__tests__/` |
| 12 | Read plugin config from `settings.json` | New config module |

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

### Phase 4 — Community readiness

- Deprecated re-exports in `utils/` (with `console.warn`)
- Directory restructuring (optional — only if a 3rd plugin arrives)
- Contribution guide at `backends/community/README.md`
- Extract test harness to npm package (optional, deferred until demand)

---

## 10. Open Questions & Future Work

### Cross-session plugin persistence

**Decision**: No migration. Sessions stay bound to their original plugin. If that plugin is no longer registered, the router returns a clear error listing available plugins. The LLM adapts from conversation context.

### Plugin discovery & defaults

**Decision**: Explicit registration only (no auto-discovery). Default fallback: if no `browser.plugins` config exists, single Chromium plugin — same as today.

### Python dependency management

**Decision**: User responsibility. Only Chromium ships as a default dependency (Playwright npm + `npx playwright install chromium`). All stealth backends require user-installed Python environments and browser binaries. Document prerequisites with clear setup guides. Auto-install is future work.

This boundary is intentional: pi-browser owns the plugin *framework*. Plugin authors own their *installation*. The extension does not manage Python virtualenvs or download stealth browser binaries.

### Error recovery semantics

If a bridge process crashes mid-operation: detect exit, attempt restart, return `{success: false, error: "Bridge crashed; retry the operation"}`.

### Plugin capabilities negotiation

**Decision**: Return error if current plugin can't satisfy the operation (e.g., JS evaluate on read-only backend). Let the agent decide whether to retry with a different plugin. Auto-escalation by capability is future work.

---

## Appendix: Current vs v2 Architecture

| Aspect | Current | v2 |
|---|---|---|
| **Backend type** | Union: `"chromium" \| "stealth"` | String: any registered plugin name |
| **Dispatch** | 13 if/else blocks hardcoded | Single `registry.get(name).method()` |
| **Session level** | Stored as `BackendLevel` union | Stored as `pluginName: string` |
| **Plugin config** | None (hardcoded imports) | `settings.json` with `browser.plugins` array |
| **Chain order** | Fixed: chromium → stealth | Array position in config |
| **Plugin type** | Hardcoded per backend | Auto-detected from `backends/<dir>/` contents |
| **Python bridge** | `StealthBridge` (hardcoded to `invisible_playwright`) | `PythonPluginAdapter` (auto-detected from `bridge.py`, config via `config` bag) |
| **Test escalation** | No tests (requires browsers) | `MockPlugin` fixture + unit tests |
| **Plugin correctness** | No common verification | Contract test harness reusable per plugin |
| **Default dependency** | Chromium + stealth (hardcoded) | Chromium only (stealth is user-installed) |
| **Community plugins** | Not possible (requires editing router) | Register via `settings.json` + implement interface |

---

*End of document.*
