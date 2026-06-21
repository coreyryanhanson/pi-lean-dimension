# AGENTS.md — pi-browser

> Compact instruction file for an agent working on this repo.

## What This Is

A pi extension that registers **12 tools + 1 command** for web browsing. Architecture: plugin-based dispatch via `PluginRegistry` + typed `BrowserPlugin` interface + stateless `web-fetch` tool. See `index.ts` for entrypoint.

## Developer Commands

```bash
npm test              # vitest run — 695 tests across 22+ test files (all pass)
npx vitest run __tests__/router-dispatch.test.ts  # single test file
npx vitest run __tests__/cookie-persistence.test.ts  # Chromium persistence tests (auto-skips if no Chromium)
npx vitest run __tests__/firefox.test.ts  # Firefox contract tests (auto-skips if no Playwright Firefox)
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
│   ├── playwright-base/      # Shared PlaywrightPluginBase (Node base class)
│   ├── chromium/index.ts     # Chromium Plugin (Node/Playwright) — thin subclass of PlaywrightPluginBase
│   ├── firefox/index.ts      # Firefox Plugin (Node/Playwright) — thin subclass (NEW)
│   ├── chromium-py/bridge.py # Chromium-Py Bridge (Python/Playwright) — thin subclass of PlaywrightBridge
│   ├── firefox-py/bridge.py  # Firefox-Py Bridge (Python/Playwright) — thin subclass (NEW)
│   ├── python-adapter.ts     # JSON-RPC bridge for subprocess plugins
│   └── python-base/          # Shared Python bridge library (bridge.py, playwright_base.py, accessibility.py, bot_detection.py, transport.py)
├── core/                     # Framework: shared across all plugins
│   ├── plugin-api.ts         # BrowserPlugin interface + result types (Cookie, StorageState, etc.)
│   ├── plugin-registry.ts    # Registration, validation, strategy resolution
│   ├── plugin-config.ts      # Pipeline config loading, validation, detection + types (PluginConfig, PluginType, PluginDetection)
│   ├── router.ts             # Dispatch, session lifecycle, truncation, cookie/profile dispatch
│   ├── guides.ts             # Guide types, builtin guides, file loader, applicable-guide resolution
│   ├── fetch-backend.ts      # Stateless HTTP → Markdown (web-fetch only)
│   └── shared/               # nav-settle, paths, task-id, accessibility-tree, bot-detection, dom-extractor,
│                              # session-manager, settings-reader, snapshot-cache, storage-state, url-safety
├── guides/                   # User-authored guide files (gitignored)
├── tools/                    # Tool definitions — one file per tool (12 files) + index.ts + utils.ts
└── __tests__/                # 21 test files + helpers/
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

Plugin loading: reads `browser.plugins` from `~/.pi/agent/settings.json` (global, merged with `.pi/settings.json` project-local). Each entry is `{name, dir, enabled, config}`. `dir` maps to `backends/<dir>/`; entry point is auto-detected (`index.ts` = Node plugin, `bridge.py` = Python plugin). Falls back to a default config: chromium + firefox enabled, chromium-py + firefox-py disabled.

**Active plugins (config-driven):**

- **`chromium`** — Node/Playwright (thin subclass of `PlaywrightPluginBase`), always enabled by default, reference implementation
- **`firefox`** — Node/Playwright (thin subclass of `PlaywrightPluginBase`), enabled out-of-the-box, same contract as chromium (NEW)
- **`chromium-py`** — Python/Playwright parity reference (thin subclass of `PlaywrightBridge`), disabled by default. Validates ``python-base`` against the TS reference; use as the baseline when building a new Python stealth backend.
- **`firefox-py`** — Python/Playwright parity reference (thin subclass of `PlaywrightBridge`), disabled by default. Mirror of chromium-py for Firefox-based stealth work (NEW)

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
- **Profile-aware session creation and persistence**:
  - On `navigate()`, the router calls `loadStorageState(profileName)` when a named or session profile is active and passes the result as `options.storageState` to the plugin.
  - On re-navigate (same taskId with persistent profile), both Chromium and Python plugins call `_persistState()` to save the current session's cookies/localStorage to disk **before** closing (Chromium) or reusing (Python) the old context.
  - **In-memory fallback** (Chromium): `_persistState()` returns the raw state it just saved; `getOrCreateContext()` uses it as `options?.storageState ?? savedState`, so cookies survive the very next re-navigate even when no disk copy existed before.
  - The router also loads storage state in `requireInteractiveSession()` when restoring from `lastNav.profileName`.

### Registered Tools (12 total)

web-fetch, browser-navigate, browser-snapshot, browser-click, browser-type, browser-scroll, browser-back, browser-press, browser-console, browser-inspect, web-guide, web-learn

### Registered Commands

`/web on|off|learn|cookies|profile|status` — `/web on` (browsing only), `/web off` (all disabled),
`/web learn` (browsing + guide-saving via web-learn), `/web cookies list|clear` (inspect/clear session cookies),
`/web profile` (list/load profiles), `/web status` (backends + sessions + profiles),
`/web` (show current state).

Toggle state is persisted via `pi.appendEntry("browser-toggle-state", ...)` per-session branch, surviving `/reload`, `/resume`, `/fork`. Three-field schema: `{browserToolsEnabled, learnToolsEnabled, defaultProfile}`.

### Profile & Cookie Management

- **Storage state** is persisted to `~/.pi/agent/browser-state/<profile-name>/storage-state.json` via `core/shared/storage-state.ts`.
- **Save-before-renavigate**: both Chromium and Python plugins call `_persistState()` before closing/reusing a context with a persistent profile. This ensures cookies set during a session (e.g. consent dialogs, login) survive `browser-navigate` re-calls, crash recovery, `/reload`, and `/resume`.
- **Atomic writes + concurrency safety** (`storage-state.ts`): `saveStorageState()` writes to a temp file then renames atomically, preventing half-write races. Concurrent writers merge at the cookie level (`name+domain+path` key) and localStorage level (`origin+name` key), so two agents sharing a named profile don't clobber each other's data.
- **Session profiles** (`profile="session"`) are scoped to one pi conversation, stored under `_session-<piSessionId>`. Default profile is now `"session"` (changed from `"none"`), so conversations persist state automatically.
- **Named profiles** (`profile="shopping"`, `profile="work"`) are shared across conversations and agents.
- **Conversation-scoped default profile** set via `/web profile set <name>`, survives `/reload`/`/resume`.
- **Cookie operations** (`getCookies`, `addCookies`, `clearCookies`) delegate to the browser plugin's Playwright `context.cookies()` / `context.clearCookies()`.

### Guides (`core/guides.ts`)

4 builtin pattern guides (`bot-detection`, `cookie-consent`, `pagination`, `search`). Site guides are user-authored — place a `.md` file with YAML frontmatter in `guides/` — and auto-register via their `domains` field. Caches invalidate on `web-learn` calls.

Guides are surfaced via an applicable-guide footer and badge: pattern guides (bot-detection, cookie-consent) fire on signal, site guides fire on domain match. All matching guides are shown together with no priority suppression.

### Key Tools

| Tool | Use Case | State | Speed |
|------|----------|-------|-------|
| `web-fetch` | Static page → Markdown, no JS needed | Stateless | Fast |
| `browser-navigate` | Interactive page → accessibility tree with @e refs | Stateful session | Slower |
| `browser-inspect` | Element queries + text extraction with @e ref annotations | Stateful session | Fast (sync cache) |
| `web-guide` | Get navigation guidance for a site or pattern | Stateless | Instant |
| `web-learn` | Save or update navigation guidance for a site | Stateless | Instant |

`web-fetch` uses plain `fetch()` + `node-html-parser` + `turndown`. Returns ~4000 chars inline, spills to temp file when larger.

### Engine Parity Note

Playwright Firefox (Juggler) and Playwright Chromium (CDP) serialize ARIA trees in the **same YAML format**, so the shared parser in `core/shared/accessibility-tree.ts` works identically for both. However, the two engines may report **different role sets and props** for the same DOM. The contract test suite uses threshold assertions (`elementCount > 0`) rather than exact equality, so this should pass without false positives. If any fixture shows a meaningful divergence, document it here rather than papering over it.

## Testing

### Test files (22+ files, 695+ tests passing)

| File | Requires browser? |
|------|--------------------|
| All structural/unit tests (router-dispatch, browser-toggle, browser-toggle-profile, plugin-registry, plugin-contract, plugin-config-browser, python-adapter, fetch-backend, accessibility-tree, url-safety, plugin-loading, snapshot-cache, browser-inspect, web-guides, router-session, storage-state, nav-settle) | No |
| reddit-dialog.test.ts | Chromium (errors if unavailable) |
| cookie-persistence.test.ts | Chromium (auto-skip) |
| chromium-py.test.ts | Chromium + Python venv (auto-skip) |
| chromium-py-persistence.test.ts | Chromium + Python venv (auto-skip) |
| firefox.test.ts (NEW) | Playwright Firefox (auto-skip) |
| firefox-py.test.ts (NEW) | Playwright Firefox + Python venv (auto-skip) |
| firefox-py-persistence.test.ts (NEW) | Playwright Firefox + Python venv (auto-skip) |

Live-browser tests auto-skip when the required browser or Python venv is absent. `reddit-dialog` errors if Chromium is missing (it's a structural requirement for the Node Chromium backend). `browser-toggle-profile` tests exercise the full profile lifecycle via mock API.

### Shared test utilities (`__tests__/helpers/`)

- `plugin-contract.ts` — `runContractTests(name, factory, opts?)` validates any BrowserPlugin
- `mock-plugin.ts` — MockPlugin for structural contract validation
- `reddit-fixture.ts` — HTML fixtures for Reddit dialog scenarios (4 variants)
- `test-server.ts` — `startTestServer()` returns a local HTTP server for integration tests
- `mock-python-bridge.py` — Python bridge stub used by python-adapter tests (supports `browser.getStorageState` and `browser.getCookies` for persistence testing)

### Contract test harness

`runContractTests()` validates structural contracts (all operations exist, result shapes) without a browser, and behavioral tests (`realBrowser: true`) with a live browser (Chromium or Firefox depending on the plugin passed).

## Known Constraints & Debt

- **Console capture in `chromium-py`** — `chromium-py/bridge.py` installs a console handler with a 500-entry ring buffer. The base `BrowserBridge` does not install handlers; future Python plugins must override `_setup_page_session`.
- **AbortSignal not supported on Python bridge** — the router passes `signal` through unconditionally (no capability check). The Python adapter accepts and silently ignores the signal. `supportsAbortSignal` is advertised but unenforced.
- **Sessions are per taskId** — mapped to `browser-NNN` keys via `_sessionKeys`/`_sessionCounter` in `core/shared/task-id.ts`. Created on first navigate, cleaned up on `session_shutdown`
- **Python shared-context machinery removed (B1)** — the `browser.newPage`/`browser.closePage` RPC routes, `_profile_contexts` ref-counting, and `ensure_profile_session`/`remove_profile_session` methods were removed from both the base `BrowserBridge` and `ChromiumPyBridge`. Named profiles now use disk persistence (load-on-navigate via `storageState`) matching the TS Chromium plugin. Both backends use `ensure_session(task_id, config)` for all sessions.
- **Python bridge reuses BrowserContexts across navigations** — `ensure_session()` returns the existing session on re-navigate (unlike the TS Chromium plugin which creates a fresh context per navigate). This means in-process cookies survive re-navigation without explicit save, but also means `storageState` from the router is ignored on re-navigate (the context already exists). The Python adapter's `_persistState()` saves current cookies to disk before the navigate RPC for cross-process persistence.
- **`_persistState()` helper in both backends** — extracted from `cleanup()`, this method checks `session?.persistState`, snapshots the BrowserContext's storage state, persists it to disk, and returns the raw state for optional in-memory reuse (Chromium uses the return as fallback for the new context; Python returns it for API consistency). Called both from `cleanup()` and — on re-navigate — from `getOrCreateContext()` (Chromium) or `navigate()` (Python) before the old context is closed/reused.
- **Role-based locators only**: never XPath/CSS — always `getByRole()` via `buildLocator()` with positional `.nth()` for duplicates. The `INTERACTIVE_ROLES` set defines which roles get @e refs
- **All URLs go through `url-safety.ts`** — blocks localhost, private IPs (10.x, 172.16-31.x, 192.168.x, 169.254.169.254), dangerous schemes (file:, ftp:, data:, javascript:, vbscript:), and heuristically detects secrets in URLs
- **Screenshot**: JPEG 80% quality, viewport constrained to 1280px wide, returns data URI
- **Accessibility tree parser is single-pass, no-cap**: both TypeScript (`core/shared/accessibility-tree.ts`) and Python (`backends/python-base/pi_browser_bridge/accessibility.py`) use an identical single-pass algorithm — every interactive element gets an @e ref, no dialog prioritization, no element cap. Full ARIA trees beyond truncation are cached to disk via `snapshot-cache.ts`.
- **Bot detection has three tiers**: checked against page title (challenge phrases), body text (challenge phrases + CDN patterns), and raw HTML (CAPTCHA widget embed codes). Both the TypeScript (`core/shared/bot-detection.ts`) and Python (`chromium-py/bridge.py`) backends share the same HTML-level signal set.
- **Compact truncation everywhere**: snapshots truncated at ~2500 chars (with `\nfingerprint:XXXXX`), fetch content at ~4000 chars with temp file spill to `/tmp/pi-browser/fetch-*.md`
- **Snapshot Disk Cache** (`core/shared/snapshot-cache.ts`): when truncated, full tree written to `/tmp/pi-browser/snapshot-*.txt`. Last 2 files per task. Cached regardless of bot-detection status — the full inline content still passes through on bot pages for human judgment, with the cache file available as a recovery file for the agent. I/O failures degrade gracefully to inline-only.
- **`browser-inspect`** (`core/shared/dom-extractor.ts`): runs inline JS via `page.evaluate()`. Requires `getElementCache()` on the plugin. Text output truncated at ~2500 chars by default; pass `maxChars=0` for full. Keyword filtering via `query` parameter (case-insensitive substring on text, href, src).
- **`parentRef` on `AriaCachedNode`**: enables `subtree=...` queries in `browser-inspect`. Set by depth-based parent stack in `parseSnapshot()`'s single pass. Dialogs become parent of interior elements.
- **`dialogDetected` is resolved from element cache**: computed from the parsed `ElementCache` via `Array.some()` matching `role="dialog"` or `role="alertdialog"`. Not affected by snapshot truncation (unlike the old string-scan approach).
- **Guide staleness**: no builtin site guides shipped — entirely user-authored via `guides/*.md`. Guides carry `updated` date and `currentDate` timestamp in output.
- **Learn mode toggle**: `/web learn` enables `web-learn` tool; `/web on` removes it. Agent never calls `web-learn` unprompted. Default is off on fresh sessions.
- **Navigation settle** (`core/shared/nav-settle.ts`): after click or press, detects page navigation via a `framenavigated` listener and waits for `load + networkidle` (capped, errors swallowed) before reading URL/title/snapshot. Replaces the old fixed `waitForTimeout(300)` pattern that caused URL/DOM mismatches. Framework-agnostic via a lightweight `NavigationSettlePage` interface for testability.
- **`BROWSER_DEBUG=1`** — enables structured `[browser]` log lines on stderr (navigate, snapshot, click). Checked in both ChromiumPlugin and the Python bridge.

## Debugging

```bash
BROWSER_DEBUG=1 npx vitest run __tests__/reddit-dialog.test.ts
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
