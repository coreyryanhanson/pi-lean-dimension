# AGENTS.md — pi-browser

> Compact instruction file for an agent working on this repo.

## What This Is

A browser automation extension for `@earendil-works/pi-coding-agent`. Registers 11 tools + 2 commands (`/browser-status`, `/web`). Architecture: plugin-based dispatch via `PluginRegistry` + typed `BrowserPlugin` interface + stateless `web-fetch` tool.

## Directory Layout

```
pi-browser/
├── index.ts                    # Entry: registers tools, loads plugins from settings.json
├── browser-toggle.ts           # /web on|off|status — add/remove browser tools from active set
│
├── backends/
│   ├── chromium/index.ts       # ChromiumPlugin — Node/Playwright (~1100 lines, reference impl)
│   ├── python-adapter.ts       # PythonPluginAdapter — JSON-RPC over subprocess stdin/stdout
│   ├── chromium-py/bridge.py   # Python bridge (~950 lines); disabled by default
│   └── python-base/            # Shared Python package: pi_browser_bridge (pyproject.toml)
│       └── pi_browser_bridge/  # BrowserBridge base class
│
├── core/
│   ├── plugin-api.ts           # BrowserPlugin interface + 13 typed result types + capabilities
│   ├── plugin-registry.ts      # PluginRegistry — register, resolve, order
│   ├── plugin-config.ts        # Reads browser.plugins from settings.json, type detection
│   ├── router.ts               # Plugin dispatch (session lifecycle, snapshot truncation, URL safety)
│   ├── fetch-backend.ts        # Stateless HTTP → Markdown (used by web-fetch only)
│   └── shared/
│       ├── accessibility-tree.ts   # @e1/@e2 ref parsing + buildLocator(getByRole)
│       ├── bot-detection.ts        # Cloudflare/CAPTCHA heuristics
│       ├── session-manager.ts      # Per-task BrowserSession lifecycle
│       ├── url-safety.ts           # SSRF/secrets/scheme validation
│       └── cdp-supervisor.ts       # CDP dialog dismiss + console capture
│
├── scripts/
│   ├── dialog-gate.ts          # Side-by-side backend comparison runner (npx tsx scripts/dialog-gate.ts)
│   ├── baseline-*.md           # Baseline test results
│   ├── experiment-{1..5}-findings.md  # Occlusion/dialog hardening experiment reports
│   └── phase5-validation.md    # Phase 5 validation report
│
├── __tests__/
│   ├── helpers/                # Shared test utilities
│   │   ├── mock-plugin.ts      # MockPlugin for contract validation
│   │   ├── plugin-contract.ts  # runContractTests() — structural + behavioral contract tests
│   │   ├── reddit-fixture.ts   # HTML fixtures for Reddit dialog scenarios
│   │   └── test-server.ts      # Local HTTP test server (startTestServer)
│   │
│   ├── router-dispatch.test.ts     # 88 tests — strategy, sessions, navigation flow
│   ├── browser-toggle.test.ts      # 62 tests — toggle on/off, persist/restore, config
│   ├── plugin-registry.test.ts     # 47 tests — registration, validation, resolution
│   ├── python-adapter.test.ts      # 40 tests — JSON-RPC transport, heartbeat, errors
│   ├── fetch-backend.test.ts       # 24 tests — webFetch(), JS detection, bot detection
│   ├── accessibility-tree.test.ts  # 19 tests — @e ref parsing, buildLocator, duplicates
│   ├── url-safety.test.ts          # 14 tests — SSRF, schemes, secrets, malformed URLs
│   ├── plugin-loading.test.ts      # 12 tests — config loading, type detection, errors
│   ├── occlusion-live.test.ts      # 8 tests — real-browser occlusion (requires Chromium)
│   ├── reddit-dialog.test.ts       # 7 tests — dialog interactions vs test server
│   ├── plugin-contract.test.ts     # Contract tests via MockPlugin (shared 51-test harness)
│   └── chromium-py.test.ts         # Contract tests for Python bridge (shared harness, skipped if no venv)
│
├── browser_finetuning.md       # Occlusion/dialog/timing hardening strategy — READ before modifying click/snapshot
├── plan_v2.md                  # Full plugin-refactor architecture doc — READ before adding plugins or changing registry
├── phase2-plan.md, phase3-plan.md, phaseb.md, plan.md  # Historical planning docs
└── vitest.config.ts            # globals: true, include: __tests__/**/*.test.ts
```

## Plugin Architecture

All backends implement `BrowserPlugin` in `core/plugin-api.ts`. 13 required operations:

```
navigate, snapshot, click, type, scroll, goBack, press,
screenshot, getImages, getConsoleMessages, clearConsole,
evaluate, cleanup  (+ lifecycle: init, cleanupAll)
```

Capabilities advertise quirks (e.g. `supportsAbortSignal: false` on Python bridge). The router respects them.

Active plugins (configured in `~/.pi/agent/settings.json` under `browser.plugins`):
- **`chromium`** — Node/Playwright, always enabled, full-featured, registered as default
- **`chromium-py`** — Python/Playwright, disabled by default; validates Python adapter infrastructure

Each `plugins[]` entry has `{name, dir, enabled, config}`. `dir` maps to `backends/<dir>/`; entry point is auto-detected (`index.ts` = Node, `bridge.py` = Python). Fallback: if no plugins register, a default ChromiumPlugin is created.

## Router

`core/router.ts` dispatches via `PluginRegistry.resolveStrategy(strategy)`:
- `"auto"` → first enabled plugin in config order
- `"<name>"` → named plugin (e.g. `"chromium-py"`)

Cross-cutting concerns in the router, not plugins:
- Snapshot truncation (compactSnapshot — dialog-aware, DOM-change fingerprinting, ~2500 chars inline)
- URL safety (validateUrl — blocks localhost, private IPs, dangerous schemes)
- Session lifecycle (sessionManager.create/remove/update, auto-recovery from crashed sessions)
- Bot-detection downgrade heuristic (fail navigate when `botDetected && elementCount < 5`)

## Key Tools

| Tool | Use Case | State | Speed |
|------|----------|-------|-------|
| `web-fetch` | Static page → Markdown, no JS needed | Stateless | Fast |
| `browser-navigate` | Interactive page → accessibility tree with @e refs | Stateful session | Slower |

## Known Constraints & Debt

- **Console capture only on Chromium** — Python adapter's `BridgeBase` has console capture but `chromium-py` doesn't call it yet
- **AbortSignal not supported on Python bridge** — `supportsAbortSignal: false`
- **Sessions are per taskId** — created on first navigate, cleaned up on shutdown
- **Role-based locators only**: never XPath/CSS — always `getByRole()` via `buildLocator()` with positional `.nth()` for duplicates
- **All URLs go through `url-safety.ts`** — blocks localhost, private IPs, metadata endpoints, dangerous schemes
- **Screenshot quality**: JPEG 80% quality, max 1024px wide
- **Toggle state** (`/web`) persisted per-session branch via `pi.appendEntry("browser-toggle-state", ...)`, survives `/reload`, `/resume`, `/fork`
- **Compact truncation everywhere**: snapshots ~2500 chars inline, fetch content ~4000 chars with temp file spill
- **`browser_finetuning.md`** contains the occlusion/dialog/timing hardening strategy — read it before touching ChromiumPlugin click/snapshot logic
- **`plan_v2.md`** is the full architecture doc for the plugin refactor — read before adding a new plugin type or changing the registry

## Debugging

Set `BROWSER_DEBUG=1` to get structured `[browser]` log lines on stderr for navigate, snapshot, click, and occlusion events.

## Running Tests

```bash
npm test              # vitest run — all tests (~420 across 12 files)
npx vitest run __tests__/router-dispatch.test.ts  # single file
```

Integration tests (`occlusion-live.test.ts`, `reddit-dialog.test.ts`, `chromium-py.test.ts`) require Playwright Chromium installed. They skip automatically when Chromium is unavailable.

Contract tests (`runContractTests()` from `__tests__/helpers/plugin-contract.ts`) validate any BrowserPlugin. Structural tests run without a browser; behavioral tests (`realBrowser: true`) require the live Chromium.

## Development Scripts

```bash
npx tsx scripts/dialog-gate.ts        # Side-by-side Chromium vs Python backend comparison
npx tsx scripts/dialog-gate.ts --preset basic-close --repeat 20  # Preset with 20 repetitions
```

## `backends/` vs `core/` Boundaries

- `backends/` — plugin-specific implementations (Node or Python)
- `core/` — framework: plugin API, registry, config loader, router, shared utilities
- `core/shared/` — utilities used by both framework and plugins
- Plugins import from `../../core/plugin-api.js` and `../../core/shared/*.js`
- The router imports from `../../core/plugin-api.js` and `../../core/shared/*.js`

## Reading Order

1. `index.ts` — extension entry, tool definitions, plugin loading from settings.json
2. `core/plugin-api.ts` — BrowserPlugin interface, result types, capabilities
3. `core/plugin-registry.ts` — registration, strategy resolution, validation
4. `core/router.ts` — dispatch, session lifecycle, truncation (compactSnapshot)
5. `backends/chromium/index.ts` — reference implementation of BrowserPlugin
6. `backends/python-adapter.ts` — Python subprocess bridge pattern