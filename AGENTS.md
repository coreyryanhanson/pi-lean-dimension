# AGENTS.md — pi-browser

> Compact instruction file for an agent working on this repo.

## What This Is

A pi extension that registers **11 tools + 2 commands** for web browsing. Architecture: plugin-based dispatch via `PluginRegistry` + typed `BrowserPlugin` interface + stateless `web-fetch` tool.

## Developer Commands

```bash
npm test              # vitest run — 422 tests across 13 files (all pass)
npx vitest run __tests__/router-dispatch.test.ts  # single test file
npm run test:watch    # vitest in watch mode
npx tsx scripts/dialog-gate.ts        # side-by-side backend comparison
npx tsx scripts/dialog-gate.ts --preset basic-close --repeat 20  # with preset
```

There is no build step (`noEmit: true` in tsconfig). The extension is loaded directly by pi from the source TypeScript files. No linter or formatter is configured.

## Directory Layout (compact)

```
pi-browser/
├── index.ts                  # Entry: registers 11 tools + 2 commands
├── browser-toggle.ts         # /web on|off|status — toggle tools in/out of active set
├── backends/                 # Plugin implementations
│   ├── chromium/index.ts     # Node/Playwright, reference ~1100 lines
│   ├── python-adapter.ts     # JSON-RPC bridge for subprocess plugins
│   └── chromium-py/bridge.py # Python bridge, disabled by default
├── core/                     # Framework: shared across all plugins
│   ├── plugin-api.ts         # BrowserPlugin interface, 13 result types
│   ├── plugin-registry.ts    # Registration, validation, strategy resolution
│   ├── plugin-config.ts      # Reads browser.plugins from settings.json
│   ├── router.ts             # Dispatch, session lifecycle, truncation
│   ├── fetch-backend.ts      # Stateless HTTP → Markdown (web-fetch only)
│   └── shared/               # session-manager, url-safety, bot-detection, cdp-supervisor, accessibility-tree
├── scripts/                  # dialog-gate.ts, experiment reports
└── __tests__/                # 13 test files + helpers/
```

## Architecture

### Plugin system

All interactive backends implement `BrowserPlugin` (`core/plugin-api.ts`). 13 required operations:

```
navigate, snapshot, click, type, scroll, goBack, press,
screenshot, getImages, getConsoleMessages, clearConsole,
evaluate, cleanup  (+ lifecycle: init, cleanupAll)
```

Capabilities (`PluginCapabilities`) advertise quirks. The router checks them at dispatch time (e.g. `supportsFullPageScreenshot` for fallback, `supportsAbortSignal` to skip signal wiring, `supportsConsoleCapture` for message-capture gating).

Plugin loading: reads `browser.plugins` from `~/.pi/agent/settings.json` (global, merged with `.pi/settings.json` project-local). Each entry is `{name, dir, enabled, config}`. `dir` maps to `backends/<dir>/`; entry point is auto-detected (`index.ts` = Node plugin, `bridge.py` = Python plugin). If no plugins configure, a default ChromiumPlugin is created.

**Active plugins (config-driven):**
- **`chromium`** — Node/Playwright (~1100 lines), always enabled by default, reference implementation
- **`chromium-py`** — Python/Playwright (~950 lines bridge.py), disabled by default

### Router (`core/router.ts`)

All tool calls dispatch through the router. Key responsibilities:
- **Strategy resolution**: `PluginRegistry.resolveStrategy("auto")` → first enabled plugin; `"<name>"` → named plugin
- **Session lifecycle**: per-taskId sessions created on first navigate, cleaned up on shutdown
- **Compact truncation**: `< 2800 chars` raw, cut at ~2500; `> 8000 chars` preserve top ~2000
- **Bot-detection downgrade**: when `botDetected && elementCount < 5`, navigate fails hard (blocks are unreadable)
- **Bot-detected snapshots are NOT compacted** — full content passes through for human judgment
- **All interaction results have fingerprint appended**: `\nfingerprint:XXXXX` for DOM-change detection
- **Auto-recovery**: crashed sessions are detected and re-navigated to the last URL
- **Stale @e ref handling**: if a session was just auto-created, interaction tools return a fresh snapshot instead of performing the action

### Key Tools

| Tool | Use Case | State | Speed |
|------|----------|-------|-------|
| `web-fetch` | Static page → Markdown, no JS needed | Stateless | Fast |
| `browser-navigate` | Interactive page → accessibility tree with @e refs | Stateful session | Slower |

`web-fetch` uses plain `fetch()` + `node-html-parser` + `turndown`. Returns ~4000 chars inline, spills to temp file when larger. `browser-navigate` uses Playwright Chromium, returns accessibility tree with @e1/@e2 refs.

### Registered tools (11 total)

web-fetch, browser-navigate, browser-snapshot, browser-click, browser-type, browser-scroll, browser-screenshot, browser-get-images, browser-back, browser-press, browser-console

### Registered commands (2 total)

`/browser-status` — show backend health and active sessions
`/web on|off|status` — toggle all browser tools out of the active tool set (saves ~1500-2000 tokens when off)

Toggle state is persisted via `pi.appendEntry("browser-toggle-state", ...)` per-session branch, surviving `/reload`, `/resume`, `/fork`.

## Testing

### Test files (13 files, 422 tests passing)

| File | Requires Chromium? |
|------|--------------------|
| router-dispatch.test.ts | No |
| browser-toggle.test.ts | No |
| plugin-registry.test.ts | No |
| plugin-contract.test.ts | No (structural) |
| python-adapter.test.ts | No |
| fetch-backend.test.ts | No |
| accessibility-tree.test.ts | No |
| url-safety.test.ts | No |
| plugin-loading.test.ts | No |
| dialog-compaction.test.ts (archived) | No |
| occlusion-live.test.ts | Yes (auto-skip) |
| reddit-dialog.test.ts | Yes (auto-skip) |
| chromium-py.test.ts | Yes (auto-skip) |

Integration tests (`occlusion-live`, `reddit-dialog`, `chromium-py`) skip automatically when Playwright Chromium is unavailable. The archived dialog-compaction test lives under `core/archived/`.

### Shared test utilities (`__tests__/helpers/`)

- `plugin-contract.ts` — `runContractTests(name, factory, opts?)` validates any BrowserPlugin
- `mock-plugin.ts` — MockPlugin for structural contract validation
- `reddit-fixture.ts` — HTML fixtures for Reddit dialog occlusion scenarios (4 variants)
- `test-server.ts` — `startTestServer()` returns a local HTTP server for integration tests
- External test server: `occlusion-test-server.cjs` for local debugging

### Contract test harness

`runContractTests()` from `plugin-contract.ts` validates structural contracts (all 13 operations exist, result shapes) without a browser, and behavioral tests (`realBrowser: true`) with a live Chromium against the local test server.

## Known Constraints & Debt

- **Console capture only on Chromium** — Python adapter's `BridgeBase` has capture but `chromium-py` bridge doesn't call it yet
- **AbortSignal not supported on Python bridge** — `supportsAbortSignal: false`, router skips signal wiring
- **Sessions are per taskId** — tasks are stable pi session IDs mapped to `browser-NNN` keys via `_sessionKeys`/`_sessionCounter` in index.ts. Created on first navigate, cleaned up on session_shutdown
- **Role-based locators only**: never XPath/CSS — always `getByRole()` via `buildLocator()` with positional `.nth()` for duplicates. The `INTERACTIVE_ROLES` set defines which roles get @e refs
- **All URLs go through `url-safety.ts`** — blocks localhost, private IPs (10.x, 172.16-31.x, 192.168.x, 169.254.169.254), dangerous schemes (file:, ftp:, data:, javascript:, vbscript:), and heuristically detects secrets in URLs
- **Screenshot**: JPEG 80% quality, viewport constrained to 1024px wide, returns data URI
- **Compact truncation everywhere**: snapshots ~2500 chars inline (with `\nfingerprint:XXXXX` suffix), fetch content ~4000 chars with temp file spill to `/tmp/pi-browser-fetch-*`
- **`browser_finetuning.md`** — occlusion/dialog/timing hardening strategy. Read before touching ChromiumPlugin click or snapshot logic
- **`plan_v2.md`** — full plugin-refactor architecture doc. Read before adding a new plugin type or changing the registry
- **`BROWSER_DEBUG=1`** — enables structured `[browser]` log lines on stderr (navigate, snapshot, click, occlusion events). Only checks in ChromiumPlugin

## Debugging

```bash
BROWSER_DEBUG=1 npx vitest run __tests__/occlusion-live.test.ts
```

Set `BROWSER_DEBUG=1` for structured logging from ChromiumPlugin.

## TypeScript Quirks

- `noEmit: true` — source-only, no build step
- `exactOptionalPropertyTypes: true` — `undefined` in optional params triggers type errors; use `Type.Optional()` wrapper (from `@earendil-works/pi-ai`) for tool parameters
- `noUncheckedIndexedAccess: true` — all indexed accesses require null checks
- `module: "nodenext"` — imports need `.js` extensions in source files

## `backends/` vs `core/` Boundaries

- `backends/` — plugin-specific implementations (Node or Python)
- `core/` — framework: plugin API, registry, config loader, router, shared utilities
- `core/shared/` — utilities used by both framework and plugins
- Plugins import from `../../core/plugin-api.js` and `../../core/shared/*.js`
- The router imports from `../../core/plugin-api.js` and `../../core/shared/*.js`