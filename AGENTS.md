# AGENTS.md — pi-browser

> Compact instruction file for an agent working on this repo.

## What This Is

A browser automation extension for `@earendil-works/pi-coding-agent`. Registers 11 tools + 2 commands (`/browser-status`, `/web`). Architecture: plugin-based dispatch via `PluginRegistry` + typed `BrowserPlugin` interface + stateless `web-fetch` tool.

## Current Architecture (Post-V2 Refactor)

```
pi-browser/
├── index.ts                    # Entry: registers tools, loads plugins from config, startup/shutdown
├── browser-toggle.ts           # /web on|off|status — toggle all browser tools, persist state
│
├── backends/
│   ├── chromium/index.ts       # ChromiumPlugin — Node/Playwright backend (~750 lines)
│   ├── python-adapter.ts       # PythonPluginAdapter — JSON-RPC over subprocess stdin/stdout
│   ├── chromium-py/            # Python bridge (bridge.py, ~950 lines)
│   │   └── bridge.py           #   Validates Python adapter; disabled by default
│   └── python-base/            # Shared Python package: pi_browser_bridge (pyproject.toml)
│       └── pi_browser_bridge/  #   BrowserBridge base class
│
├── core/
│   ├── plugin-api.ts           # BrowserPlugin interface + 13 typed result types + capabilities
│   ├── plugin-registry.ts      # PluginRegistry — register, resolve, order (stealth levels)
│   ├── plugin-config.ts        # Reads browser.plugins from settings.json, type detection
│   ├── router.ts               # Plugin dispatch (replaces old if/else router)
│   ├── fetch-backend.ts        # Stateless HTTP → Markdown (used by web-fetch only)
│   └── shared/                 # Moved from old utils/
│       ├── accessibility-tree.ts   # @e1/@e2 ref parsing + buildLocator(getByRole)
│       ├── bot-detection.ts        # Cloudflare/CAPTCHA heuristics
│       ├── session-manager.ts      # Per-task BrowserSession lifecycle
│       ├── url-safety.ts           # SSRF/secrets/scheme validation
│       └── cdp-supervisor.ts       # CDP dialog dismiss + console capture
│
└── __tests__/                  # ~314 tests across 9+ test files (see below)
```

## Plugin Architecture (BrowserPlugin Interface)

All interactive backends implement `BrowserPlugin` (in `core/plugin-api.ts`) with 13 operations + capabilities:

```
navigate, snapshot, click, type, scroll, goBack, press,
screenshot, getImages, getConsoleMessages, clearConsole,
evaluate, cleanup  (+ lifecycle: init, cleanupAll)
```

Capabilities advertise quirks (e.g. `supportsAbortSignal: false` on Python bridge). The router respects them.

Plugins are configured in `~/.pi/agent/settings.json` under `browser.plugins`. Each entry has `{name, dir, enabled, config}`. The `dir` maps to `backends/<dir>/`, where the entry point is either `index.ts` (Node) or `bridge.py` (Python) — auto-detected.

Two active plugins at time of writing:
- **`chromium`** (Node/Playwright, always enabled) — full-featured, registered as default
- **`chromium-py`** (Python/Playwright, disabled by default) — validates Python adapter infrastructure

## Router

`core/router.ts` dispatches via `PluginRegistry.resolveStrategy(strategy)`:
- `"auto"` → first enabled plugin in config order
- `"<name>"` → named plugin (e.g. `"chromium-py"`)

Cross-cutting concerns in the router, not plugins:
- Snapshot truncation (compactSnapshot — dialog-aware, DOM-change fingerprinting)
- URL safety (validateUrl)
- Session lifecycle (sessionManager.create/remove/update)
- Bot-detection downgrade heuristic (fail navigate when `botDetected && elementCount < 5`)

## Key Tools: web-fetch vs Interactive Browsing

| Tool | Use Case | State | Speed |
|------|----------|-------|-------|
| `web-fetch` | Static page → Markdown, no JS needed | Stateless | Fast |
| `browser-navigate` | Interactive page → accessibility tree with @e refs | Stateful session | Slower |

## Known Constraints & Debt

- **Console capture only on Chromium** — Python adapter's `BridgeBase` has console capture but the `chromium-py` bridge doesn't call it yet
- **AbortSignal not supported on Python bridge** — `supportsAbortSignal: false`
- **Sessions are per taskId** — created on first navigate, cleaned up on shutdown
- **Compact truncation everywhere**: snapshots ~2500 chars inline, fetch content ~4000 chars with temp file spill
- **Role-based locators only**: never XPath/CSS — always `getByRole()` via `buildLocator()`
- **All URLs go through `url-safety.ts`** — blocks localhost, private IPs, dangerous schemes
- **Screenshot quality**: JPEG 80% quality, max 1024px wide
- **Toggle state** (`/web`) persisted per-session branch, survives `/reload`, `/resume`, `/fork`
- **`browser_finetuning.md`** contains the occlusion/dialog/timing hardening strategy — read it before touching the ChromiumPlugin click/snapshot logic
- **`plan_v2.md`** is the full architecture doc for the plugin refactor — read before adding a new plugin type or changing the registry

## Tests

```
__tests__/
├── router-dispatch.test.ts     # 88 tests — strategy resolution, session lifecycle, navigation flow
├── browser-toggle.test.ts      # 62 tests — toggle on/off, persist/restore, config defaults
├── plugin-registry.test.ts     # 47 tests — registration, validation, resolution, ordering
├── python-adapter.test.ts      # 40 tests — JSON-RPC transport, heartbeat, error handling, sessions
├── fetch-backend.test.ts       # 24 tests — webFetch(), JS detection, bot detection, content capping
├── accessibility-tree.test.ts  # 19 tests — @e ref parsing, buildLocator, duplicate resolution
├── url-safety.test.ts          # 14 tests — SSRF, schemes, secrets, malformed URLs
├── plugin-loading.test.ts      # 12 tests — config loading, type detection, error handling
├── occlusion-live.test.ts      # 8 tests — real-browser occlusion detection (requires Chromium)
├── chromium-py.test.ts         # Contract tests for Python bridge (skipped if no venv)
└── plugin-contract.test.ts     # Contract test harness validation against MockPlugin
```

### Running Tests

```bash
npm test              # vitest run — all tests
npx vitest run __tests__/router-dispatch.test.ts  # single file
```

Integration tests (`occlusion-live.test.ts`, `chromium-py.test.ts`) require Playwright Chromium installed. They skip automatically in CI.

## What Changed (V1 → V2)

- **V2 refactor done**: BrowserPlugin interface extracted, PluginRegistry implemented, router rewritten, fetch decoupled. The old `backend/` and `utils/` are gone.
- **Python bridge infrastructure added**: `PythonPluginAdapter` (JSON-RPC over stdin/stdout), `python-base/pi_browser_bridge/` shared library, `chromium-py` bridge
- **Contract test harness**: `runContractTests()` validates any BrowserPlugin — structural (always) and behavioral (real browser opt-in)
- **Config-driven plugin loading**: from `browser.plugins` in settings.json; fallback to single chromium
- **Capability system**: plugins advertise what they support, router adapts

## Reading Order

1. `index.ts` — extension entry, plugin registration, tool definitions
2. `core/plugin-api.ts` — BrowserPlugin interface, result types, capabilities
3. `core/plugin-registry.ts` — registration, strategy resolution, ordering
4. `core/router.ts` — dispatch, session lifecycle, truncation (compactSnapshot)
5. `backends/chromium/index.ts` — reference implementation of BrowserPlugin
6. `backends/python-adapter.ts` — Python subprocess bridge pattern

## `backends/` vs `core/` Boundaries

- `backends/` — plugin-specific implementations (Node or Python)
- `core/` — framework: plugin API, registry, config loader, router, shared utilities
- `core/shared/` — utilities used by both framework and plugins (accessibility, bot detection, URL safety, sessions, CDP)
- Plugins import from `../../core/plugin-api.js` and `../../core/shared/*.js`
- The router imports from `../../core/plugin-api.js` and `../../core/shared/*.js`