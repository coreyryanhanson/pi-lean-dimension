# AGENTS.md — pi-lean-portal (package)

> Portal package of the [pi-lean-dimension](../../AGENTS.md) monorepo.
>
> **This file is additive only.** It covers portal internals not obvious from
> the monorepo overview. For the suite overview, install matrix, full
> directory layout, dev commands (`npm test`, `npm run test:ci`, release
> scripts), registered tools/commands summary, status bar slots, profile &
> cookie management overview, guides, key tools table, engine parity note,
> testing strategy, TypeScript quirks, and the `backends/` vs `core/`
> boundary convention, see [`../../AGENTS.md`](../../AGENTS.md).
>
> Entry point: `index.ts` — imports & registers tool definitions + lifecycle,
> calls `initBrowserToggle(pi)`.

## `BrowserPlugin` interface (`core/plugin-api.ts`)

19 methods (18 required + 1 optional):

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

The 12 registered tools map to 12 tool-facing plugin methods. The cookie/storage methods (`getCookies`, `addCookies`, `clearCookies`, `getStorageState`) are router-facing, not tool-mapped. Element cache access (`getElementCache`) is used internally by `browser-inspect`. The lifecycle methods (`init`, `cleanupAll`) are framework-facing. Total interface: 19 methods.

Capabilities (`PluginCapabilities`) advertise quirks. The router checks them at dispatch time.

## External attach (benchmarking)

The `BrowserPlugin` interface exposes one optional method for external
attach, used by `pi-lean-host`'s MiniWoB++ harness (Mode A —
plugin-owns-browser):

```ts
getAttachEndpoint?(): AttachEndpoint | null;
// AttachEndpoint = { kind: "cdp"; endpoint: string } | { kind: "firefox-ws"; endpoint: string }
```

Returns the attach descriptor once the browser has launched and the
endpoint has been discovered, or `null` if the plugin doesn't expose
one. Host-side callers must guard with
`typeof plugin.getAttachEndpoint === "function"` (not a truthiness
check) under `exactOptionalPropertyTypes`.

Two kinds are supported:

- **`"cdp"`** — Chrome DevTools Protocol. Chromium family (Node + Python)
  launches with `--remote-debugging-port=0` and discovers the port via
  `ss -tlnp` / `CDP_PORT` env. The external client attaches with
  `chromium.connect_over_cdp(endpoint)`.
- **`"firefox-ws"`** — Juggler over WebSocket. Firefox family (Node +
  Python) uses `firefox.launchServer()` + `firefox.connect(wsEndpoint)`.
  The external client attaches with `firefox.connect(wsEndpoint)`.

`PlaywrightPluginBase` provides the discovery scaffolding:

- **`onBrowserLaunched()`** — a post-launch hook (default no-op) called
  once after the shared browser successfully launches, before any
  context/page is created. The chromium plugin overrides it to scan for
  the `--remote-debugging-port=0` endpoint and cache it in
  `protected _cdpEndpoint`. Future firefox plugins override it similarly
  to populate `_wsEndpoint`.
- **`_cdpEndpoint`** / **`_wsEndpoint`** — cached endpoint strings for
  each attach kind, reset to `null` on browser disconnect so a re-launch
  re-discovers.
- **`_browserServer`** — `BrowserServer` handle for the launchServer path
  (firefox family). When non-null, the `disconnected` handler calls
  `_reconnectBrowser()` instead of clearing state, so a Browser disconnect
  reconnects to the still-up server without relaunching.
- **`_reconnectBrowser()`** — override (firefox plugin) that calls
  `firefox.connect(wsEndpoint)` to recover from a Browser disconnect
  while the BrowserServer stays up.
- **Error swallowing**: failures from `onBrowserLaunched()` are caught
  and logged by `_newBrowserContext`, so a port-scan glitch never blocks
  normal browsing.
- **`resolveCdpEndpoint()`** (`core/shared/cdp-endpoint.ts`) — shared
  discovery utility (reads `CDP_PORT` env, falls back to scanning). Used
  by the chromium plugin's `onBrowserLaunched()` override.

There is no `connectOverCDP?` interface hook — a host-owns-browser
("Mode B") path was considered and dropped as YAGNI; it will be
re-added alongside a real consumer that needs it.

## Router (`core/router.ts`)

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

## Profile & Cookie persistence mechanics

(See `../../AGENTS.md` for the user-facing overview; this section is the implementation detail.)

- **Storage state** is persisted to `~/.pi/agent/pi-lean-portal/browser-state/<profile-name>/storage-state.json` via `core/shared/storage-state.ts`.
- **Save-before-renavigate**: both Chromium and Python plugins call `_persistState()` before closing/reusing a context with a persistent profile. This ensures cookies set during a session (e.g. consent dialogs, login) survive `browser-navigate` re-calls, crash recovery, `/reload`, and `/resume`.
- **Atomic writes + concurrency safety** (`storage-state.ts`): `saveStorageState()` writes to a temp file then renames atomically, preventing half-write races. Concurrent writers merge at the cookie level (`name+domain+path` key) and localStorage level (`origin+name` key), so two agents sharing a named profile don't clobber each other's data.
- **Session profiles** (`profile="session"`) are scoped to one pi conversation, stored under `_session-<piSessionId>`. Default profile is now `"session"` (changed from `"none"`), so conversations persist state automatically.
- **Named profiles** (`profile="shopping"`, `profile="work"`) are shared across conversations and agents.
- **Conversation-scoped default profile** set via `/web profile set <name>`, survives `/reload`/`/resume`.
- **Cookie operations** (`getCookies`, `addCookies`, `clearCookies`) delegate to the browser plugin's Playwright `context.cookies()` / `context.clearCookies()`.

## Known Constraints & Debt

- **Console capture in Python backends** — Both `chromium-py` and `firefox-py` inherit console capture (500-entry ring buffer) and dialog auto-dismissal from `PlaywrightBridge._setup_page_session()` in `python-base`. The base `BrowserBridge` does not install handlers; future Python plugins must override `_setup_page_session`.
- **AbortSignal not supported on Python bridge** — the router passes `signal` through unconditionally (no capability check). The Python adapter accepts and silently ignores the signal. `supportsAbortSignal` is advertised but unenforced.
- **Sessions are per taskId** — mapped to `browser-NNN` keys via `_sessionKeys`/`_sessionCounter` in `core/shared/task-id.ts`. Created on first navigate, cleaned up on `session_shutdown`.
- **Python shared-context machinery removed (B1)** — the `browser.newPage`/`browser.closePage` RPC routes, `_profile_contexts` ref-counting, and `ensure_profile_session`/`remove_profile_session` methods were removed from both the base `BrowserBridge` and `ChromiumPyBridge`. Named profiles now use disk persistence (load-on-navigate via `storageState`) matching the TS Chromium plugin. Both backends use `ensure_session(task_id, config)` for all sessions.
- **Python bridge reuses BrowserContexts across navigations** — `ensure_session()` returns the existing session on re-navigate (unlike the TS Chromium plugin which creates a fresh context per navigate). This means in-process cookies survive re-navigation without explicit save, but also means `storageState` from the router is ignored on re-navigate (the context already exists). The Python adapter's `_persistState()` saves current cookies to disk before the navigate RPC for cross-process persistence.
- **`_persistState()` helper in both backends** — extracted from `cleanup()`, this method checks `session?.persistState`, snapshots the BrowserContext's storage state, persists it to disk, and returns the raw state for optional in-memory reuse (Chromium uses the return as fallback for the new context; Python returns it for API consistency). Called both from `cleanup()` and — on re-navigate — from `getOrCreateContext()` (Chromium) or `navigate()` (Python) before the old context is closed/reused.
- **Role-based locators only**: never XPath/CSS — always `getByRole()` via `buildLocator()` with positional `.nth()` for duplicates. The `INTERACTIVE_ROLES` set defines which roles get @e refs.
- **All URLs go through `url-safety.ts`** — blocks localhost, private IPs (10.x, 172.16-31.x, 192.168.x, 169.254.169.254), dangerous schemes (file:, ftp:, data:, javascript:, vbscript:), and heuristically detects secrets in URLs.
- **Screenshot**: JPEG 80% quality, viewport constrained to 1280px wide, returns data URI.
- **Accessibility tree parser is single-pass, no-cap**: both TypeScript (`core/shared/accessibility-tree.ts`) and Python (`backends/python-base/pi_browser_bridge/accessibility.py`) use an identical single-pass algorithm — every interactive element gets an @e ref, no dialog prioritization, no element cap. Full ARIA trees beyond truncation are cached to disk via `snapshot-cache.ts`.
- **Bot detection has three tiers**: checked against page title (challenge phrases), body text (challenge phrases + CDN patterns), and raw HTML (CAPTCHA widget embed codes). Both the TypeScript (`core/shared/bot-detection.ts`) and Python (`python-base/pi_browser_bridge/bot_detection.py`) backends share the same HTML-level signal set.
- **Compact truncation everywhere**: snapshots truncated at ~2500 chars (with `\nfingerprint:XXXXX`), fetch content at ~4000 chars with temp file spill to `/tmp/pi-lean-portal/fetch-*.md`.
- **Snapshot Disk Cache** (`core/shared/snapshot-cache.ts`): when truncated, full tree written to `/tmp/pi-lean-portal/snapshot-*.txt`. Last 2 files per task. Cached regardless of bot-detection status — the full inline content still passes through on bot pages for human judgment, with the cache file available as a recovery file for the agent. I/O failures degrade gracefully to inline-only.
- **`browser-inspect`** (`core/shared/dom-extractor.ts`): runs inline JS via `page.evaluate()`. Requires `getElementCache()` on the plugin. Text output truncated at ~2500 chars by default; pass `maxChars=0` for full. Keyword filtering via `query` parameter (case-insensitive substring on text, href, src).
- **`parentRef` on `AriaCachedNode`**: enables `subtree=...` queries in `browser-inspect`. Set by depth-based parent stack in `parseSnapshot()`'s single pass. Dialogs become parent of interior elements.
- **`dialogDetected` is resolved from element cache**: computed from the parsed `ElementCache` via `Array.some()` matching `role="dialog"` or `role="alertdialog"`. Not affected by snapshot truncation (unlike the old string-scan approach).
- **Guide staleness**: no builtin site guides shipped — entirely user-authored via `~/.pi/agent/pi-lean-portal/web-guides/*.md`. Guides carry `updated` date and `currentDate` timestamp in output.
- **Learn mode toggle**: `/web learn` enables `web-learn` tool; `/web on` removes it. Agent never calls `web-learn` unprompted. Default is off on fresh sessions.
- **Navigation settle** (`core/shared/nav-settle.ts`): after click or press, detects page navigation via a `framenavigated` listener and waits for `load + networkidle` (capped, errors swallowed) before reading URL/title/snapshot. Replaces the old fixed `waitForTimeout(300)` pattern that caused URL/DOM mismatches. Framework-agnostic via a lightweight `NavigationSettlePage` interface for testability.
- **`BROWSER_DEBUG=1`** — enables structured `[browser]` log lines on stderr (navigate, snapshot, click). Checked in both ChromiumPlugin and the Python bridge.

## Debugging

```bash
BROWSER_DEBUG=1 npx vitest run __tests__/reddit-dialog.test.ts
```
