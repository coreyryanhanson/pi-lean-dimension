# AGENTS.md — pi-browser

> Compact instruction file for an agent working on this repo.

## What This Is

A pi extension that registers **12 tools + 1 command** for web browsing. Architecture: plugin-based dispatch via `PluginRegistry` + typed `BrowserPlugin` interface + stateless `web-fetch` tool. See `index.ts` for entrypoint.

## Developer Commands

```bash
npm test              # vitest run — 659 tests across 19 files (all pass)
npx vitest run __tests__/router-dispatch.test.ts  # single test file
npm run test:watch    # vitest in watch mode
```

There is no build step (`noEmit: true` in tsconfig). The extension is loaded directly by pi from the source TypeScript files. No linter or formatter is configured.

## Directory Layout

```
pi-browser/
├── index.ts                  # Entry: imports & registers tool definitions + lifecycle
├── browser-toggle.ts         # /web on|off|learn|status — three-state toggle + subcommands
├── browser-cookies.ts        # /web cookies subcommand (extracted from toggle)
├── browser-profile.ts        # /web profile subcommand (extracted from toggle)
├── browser-status.ts         # /web status subcommand (extracted from toggle)
├── backends/                 # Plugin implementations
│   ├── chromium/index.ts     # Node/Playwright, reference ~1300 lines
│   ├── chromium-py/bridge.py # Python/Playwright bridge, disabled by default (~1420 lines)
│   ├── python-adapter.ts     # JSON-RPC bridge for subprocess plugins (~1100 lines)
│   └── python-base/          # Shared Python bridge library (accessibility.py, bridge.py, transport.py)
├── core/                     # Framework: shared across all plugins
│   ├── plugin-api.ts         # BrowserPlugin interface + result types (Cookie, StorageState, etc.)
│   ├── plugin-registry.ts    # Registration, validation, strategy resolution
│   ├── plugin-config.ts      # Pipeline config loading, validation, detection + types (PluginConfig, PluginType, PluginDetection)
│   ├── router.ts             # Dispatch, session lifecycle, truncation, cookie/profile dispatch
│   ├── guides.ts             # Guide types, builtin guides, file loader, presence resolution
│   ├── fetch-backend.ts      # Stateless HTTP → Markdown (web-fetch only)
│   └── shared/               # paths, task-id, accessibility-tree, bot-detection, dom-extractor,
│                              # session-manager, settings-reader, snapshot-cache, storage-state, url-safety
├── guides/                   # User-authored guide files (gitignored)
├── tools/                    # Tool definitions — one file per tool (12 files) + index.ts + utils.ts
└── __tests__/                # 19 test files + helpers/
```

## Architecture

### Plugin system

All interactive backends implement `BrowserPlugin` (`core/plugin-api.ts`). The interface has 19 methods (18 required + 1 optional):

```
init?(config)       — optional, called once at startup
cleanupAll()        — shutdown all
navigate            — main navigation
snapshot            — accessibility tree
click, type, scroll, goBack, press
screenshot          — JPEG data URI
getConsoleMessages, clearConsole
evaluate            — JS eval in page
getElementCache     — for browser-inspect
cleanup(taskId)     — teardown one session
getCookies, addCookies, clearCookies  — cookie operations
getStorageState     — profile storage for session restore
```

The 12 registered tools map to 12 tool-facing plugin methods. The cookie/storage methods (getCookies, addCookies, clearCookies, getStorageState) are router-facing, not tool-mapped. Element cache access (getElementCache) is used internally by browser-inspect. The lifecycle methods (init, cleanupAll) are framework-facing. Total interface: 19 methods.

Capabilities (`PluginCapabilities`) advertise quirks. The router checks them at dispatch time.

Plugin loading: reads `browser.plugins` from `~/.pi/agent/settings.json` (global, merged with `.pi/settings.json` project-local). Each entry is `{name, dir, enabled, config}`. `dir` maps to `backends/<dir>/`; entry point is auto-detected (`index.ts` = Node plugin, `bridge.py` = Python plugin). Falls back to a default `ChromiumPlugin` instance if no plugins configure.

**Active plugins (config-driven):**

- **`chromium`** — Node/Playwright (~1300 lines), always enabled by default, reference implementation
- **`chromium-py`** — Python/Playwright (~1420 lines bridge.py), disabled by default

### Router (`core/router.ts`)

All tool calls dispatch through the router. Key responsibilities:

- **Strategy resolution**: `PluginRegistry.resolveStrategy("auto")` → first enabled plugin; `"<name>"` → named plugin
- **Session lifecycle**: per-taskId sessions created on first navigate, cleaned up on shutdown. Sessions survive `/reload`, `/resume`, `/fork` via `lastNav` recovery.
- **Compact truncation**: `< 2800 chars` raw → cut at ~2500; `> 8000 chars` → preserve top ~2000
- **Bot-detection**: when `botDetected && elementCount < 5`, navigate fails hard. Full (untruncated) content passes through for human judgment.
- **All interaction results have fingerprint appended**: `\nfingerprint:XXXXX` for DOM-change detection
- **Auto-recovery**: crashed sessions are detected and re-navigated to the last URL
- **Stale @e ref handling**: if a session was just auto-created, interaction tools return a fresh snapshot instead of performing the action
- **Cookie dispatch**: `getCookies`, `addCookies`, `clearCookies` — delegates to plugin's cookie operations
- **Profile-aware session creation**: when `lastNav.profileName` is set, loads storage state from disk before creating session

### Registered Tools (12 total)

web-fetch, browser-navigate, browser-snapshot, browser-click, browser-type, browser-scroll, browser-back, browser-press, browser-console, browser-inspect, web-guide, web-learn

### Registered Commands

`/web on|off|learn|cookies|profile|status` — `/web on` (browsing only), `/web off` (all disabled),
`/web learn` (browsing + guide-saving via web-learn), `/web cookies list|clear` (inspect/clear session cookies),
`/web profile` (list/load profiles), `/web status` (backends + sessions + profiles),
`/web` (show current state).

Toggle state is persisted via `pi.appendEntry("browser-toggle-state", ...)` per-session branch, surviving `/reload`, `/resume`, `/fork`. Three-field schema: `{browserToolsEnabled, learnToolsEnabled, defaultProfile}`. Legacy `{enabled}` branches are auto-migrated.

### Profile & Cookie Management

- **Storage state** is persisted to `~/.pi/agent/browser-state/<profile-name>.json` via `core/shared/storage-state.ts`
- **Session profiles** (`profile="session"`) are scoped to one pi conversation, stored under `_session-<piSessionId>`
- **Named profiles** (`profile="shopping"`, `profile="work"`) are shared across conversations and agents
- **Conversation-scoped default profile** set via `/web profile set <name>`, survives `/reload`/`/resume`
- **Cookie operations** (`getCookies`, `addCookies`, `clearCookies`) delegate to the browser plugin's Playwright `context.cookies()` / `context.clearCookies()`

### Guides (`core/guides.ts`)

4 builtin pattern guides (`bot-detection`, `cookie-consent`, `pagination`, `search`) + 1 test-only site fixture (`_internal-test.example`). Domain map is built dynamically from `guides/*.md` files — any guide with YAML frontmatter `domains` field auto-registers. Caches invalidate on `web-learn` calls.

Guide presence is three-tier: auto-inject (bot-detection), auto-hint (cookie-consent), on-demand (all others).

### Key Tools

| Tool | Use Case | State | Speed |
|------|----------|-------|-------|
| `web-fetch` | Static page → Markdown, no JS needed | Stateless | Fast |
| `browser-navigate` | Interactive page → accessibility tree with @e refs | Stateful session | Slower |
| `browser-inspect` | Element queries + text extraction with @e ref annotations | Stateful session | Fast (sync cache) |
| `web-guide` | Get navigation guidance for a site or pattern | Stateless | Instant |
| `web-learn` | Save or update navigation guidance for a site | Stateless | Instant |

`web-fetch` uses plain `fetch()` + `node-html-parser` + `turndown`. Returns ~4000 chars inline, spills to temp file when larger.

## Testing

### Test files (19 files, 659 tests passing)

| File | Requires Chromium? |
|------|--------------------|
| All structural/unit tests (router-dispatch, browser-toggle, browser-toggle-profile, plugin-registry, plugin-contract, plugin-config-browser, python-adapter, fetch-backend, accessibility-tree, url-safety, plugin-loading, snapshot-cache, browser-inspect, web-guides, router-session, storage-state) | No |
| occlusion-live.test.ts | Yes (auto-skip) |
| reddit-dialog.test.ts | Yes (auto-skip) |
| chromium-py.test.ts | Yes (auto-skip) |

Integration tests (`occlusion-live`, `reddit-dialog`, `chromium-py`) skip automatically when Playwright Chromium is unavailable. `browser-toggle-profile` tests exercise the full profile lifecycle via mock API.

### Shared test utilities (`__tests__/helpers/`)

- `plugin-contract.ts` — `runContractTests(name, factory, opts?)` validates any BrowserPlugin
- `mock-plugin.ts` — MockPlugin for structural contract validation
- `reddit-fixture.ts` — HTML fixtures for Reddit dialog occlusion scenarios (4 variants)
- `test-server.ts` — `startTestServer()` returns a local HTTP server for integration tests
- `mock-python-bridge.py` — Python bridge stub used by python-adapter tests
- External test server: `occlusion-test-server.cjs` for local debugging

### Contract test harness

`runContractTests()` validates structural contracts (all operations exist, result shapes) without a browser, and behavioral tests (`realBrowser: true`) with a live Chromium.

## Known Constraints & Debt

- **Console capture only on Chromium** — Python adapter's `BridgeBase` has capture but `chromium-py` bridge doesn't call it yet
- **AbortSignal not supported on Python bridge** — `supportsAbortSignal: false`, router skips signal wiring
- **Sessions are per taskId** — mapped to `browser-NNN` keys via `_sessionKeys`/`_sessionCounter` in `core/shared/task-id.ts`. Created on first navigate, cleaned up on `session_shutdown`
- **Role-based locators only**: never XPath/CSS — always `getByRole()` via `buildLocator()` with positional `.nth()` for duplicates. The `INTERACTIVE_ROLES` set defines which roles get @e refs
- **All URLs go through `url-safety.ts`** — blocks localhost, private IPs (10.x, 172.16-31.x, 192.168.x, 169.254.169.254), dangerous schemes (file:, ftp:, data:, javascript:, vbscript:), and heuristically detects secrets in URLs
- **Screenshot**: JPEG 80% quality, viewport constrained to 1024px wide, returns data URI
- **Accessibility tree parser is single-pass, no-cap**: both TypeScript (`core/shared/accessibility-tree.ts`) and Python (`backends/python-base/pi_browser_bridge/accessibility.py`) use an identical single-pass algorithm — every interactive element gets an @e ref, no dialog prioritization, no element cap. Full ARIA trees beyond truncation are cached to disk via `snapshot-cache.ts`.
- **Bot detection has three tiers**: checked against page title (challenge phrases), body text (challenge phrases + CDN patterns), and raw HTML (CAPTCHA widget embed codes). Both the TypeScript (`core/shared/bot-detection.ts`) and Python (`chromium-py/bridge.py`) backends share the same HTML-level signal set.
- **Compact truncation everywhere**: snapshots truncated at ~2500 chars (with `\nfingerprint:XXXXX`), fetch content at ~4000 chars with temp file spill to `/tmp/pi-browser/fetch-*.md`
- **Snapshot Disk Cache** (`core/shared/snapshot-cache.ts`): when truncated, full tree written to `/tmp/pi-browser/snapshot-*.txt`. Last 2 files per task. Bot-detected snapshots are never cached. I/O failures degrade gracefully to inline-only.
- **`browser-inspect`** (`core/shared/dom-extractor.ts`): runs inline JS via `page.evaluate()`. Requires `getElementCache()` on the plugin. Text output truncated at ~2500 chars by default; pass `maxChars=0` for full. Keyword filtering via `query` parameter (case-insensitive substring on text, href, src).
- **`parentRef` on `AriaCachedNode`**: enables `subtree=...` queries in `browser-inspect`. Set by depth-based parent stack in `parseSnapshot()`'s single pass. Dialogs become parent of interior elements.
- **`dialogDetected` is resolved from element cache**: computed from the parsed `ElementCache` via `Array.some()` matching `role="dialog"` or `role="alertdialog"`. Not affected by snapshot truncation (unlike the old string-scan approach).
- **Guide staleness**: no builtin site guides shipped — entirely user-authored via `guides/*.md`. Guides carry `updated` date paired with `currentDate` in output.
- **Learn mode toggle**: `/web learn` enables `web-learn` tool; `/web on` removes it. Agent never calls `web-learn` unprompted. Default is off on fresh sessions.
- **`BROWSER_DEBUG=1`** — enables structured `[browser]` log lines on stderr (navigate, snapshot, click, occlusion events). Checked in both ChromiumPlugin and the Python bridge.

## Debugging

```bash
BROWSER_DEBUG=1 npx vitest run __tests__/occlusion-live.test.ts
```

## TypeScript Quirks

- `noEmit: true` — source-only, no build step
- `exactOptionalPropertyTypes: true` — `undefined` in optional params triggers type errors; use `Type.Optional()` wrapper from `@earendil-works/pi-ai` for tool parameters
- `noUncheckedIndexedAccess: true` — all indexed accesses require null checks
- `module: "nodenext"` — imports need `.js` extensions in source files
- `isolatedModules: true` — each file treated as a separate module; cross-file type analysis limited
- `noUncheckedSideEffectImports: true` — side-effect imports must be used or suppressed
- `moduleDetection: "force"` — every file is a module (no global augmentations)

## `backends/` vs `core/` Boundaries

- `backends/` — plugin-specific implementations (Node or Python)
- `core/` — framework: plugin API, registry, config loader, router, shared utilities
- `core/shared/` — utilities used by both framework and plugins
- Plugins import from `../../core/plugin-api.js` and `../../core/shared/*.js`
- The router imports from `../../core/plugin-api.js` and `../../core/shared/*.js`
- `browser-cookies.ts`, `browser-profile.ts`, `browser-status.ts` live at root level and import from `core/` — they're command handlers, not plugins.
