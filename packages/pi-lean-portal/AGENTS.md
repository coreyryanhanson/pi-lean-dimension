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

The 12 registered tools map to 12 tool-facing plugin methods. The cookie/storage methods (`getCookies`, `addCookies`, `clearCookies`, `getStorageState`) are router-facing, not tool-mapped. Element cache access (`getElementCache`) is used internally by `browser-inspect`. The lifecycle methods (`init`, `cleanupAll`) are framework-facing. Total interface: 19 methods (18 required + 1 optional).

Capabilities (`PluginCapabilities`) advertise quirks. The router checks them at dispatch time.

## Browser launch hook

The portal's own backends launch their browser directly and drive
their own page — there is **no external-attach path**. The
`getAttachEndpoint()` interface method, the `AttachEndpoint` union,
`core/shared/cdp-endpoint.ts`, the `launchServer()` / `connect()`
hop, and the `_cdpEndpoint` / `_wsEndpoint` / `_browserServer` /
`_reconnectBrowser()` scaffolding were all removed (see
[`docs/decisions/miniwob-and-host-setup.md`](../../docs/decisions/miniwob-and-host-setup.md)).

One post-launch hook is retained for third-party subclasses:

- **`onBrowserLaunched()`** — a post-launch hook (default no-op) called
  once after the browser successfully launches, before any
  context/page is created. The portal's own backends no longer override
  it (external-attach discovery has been removed), but the hook is
  retained for third-party subclasses. Failures thrown from overrides
  are caught and logged by `_newBrowserContext`, so a setup glitch
  never blocks normal browsing.

There is no `connectOverCDP?` interface hook — a host-owns-browser
("Mode B") path was considered and dropped as YAGNI; it will be
re-added alongside a real consumer that needs it.

## Stealth backends (user-managed)

Stealth backends are **user-installed plugins** that drive
patched/fingerprint-managed browser binaries (e.g. Camoufox) for sites
that block the shipped Chromium/Firefox. They are never shipped in the
npm tarball and the extension never downloads or executes them
automatically — there is no plugin marketplace. For the install flow
and the choosing decision, see
[`contributed/README.md`](contributed/README.md) and
[`contributed/CHOOSING.md`](contributed/CHOOSING.md).

### Deployment: user-writable data tree, not the npm tarball

Stealth backends live under the user-writable data tree:

```
~/.pi/agent/pi-lean-portal/
├── web-guides/              (existing)
├── browser-state/           (existing)
└── user-backends/           ← stealth backends go here
    └── camoufox-py/
        ├── bridge.py        (user copies from contributed/)
        └── .venv/           (user-created: engine pip pkg + playwright)
```

This is **trusted user code** — the user wrote or audited the bridge,
created the venv, and fetched the binary. The extension spawns it as a
subprocess; it never auto-downloads stealth backends. `user-backends/`
is a **different tree from any in-repo test fixtures** (which live
gitignored under `bench/miniwob/fixtures/` for the evaluation
harness). The `~/.pi/agent/pi-lean-portal/user-backends/` tree is what
the pi agent's production `detectPluginType` reads at runtime.

Stealth backends are **never in the default fallback list**. When
`browser.plugins` is absent, only the four shipped backends
(`chromium`, `firefox`, `chromium-py`, `firefox-py`) are loaded. A
fresh install must not emit validation errors for plugins the user
never asked for. Tested in `__tests__/plugin-config-browser.test.ts`.

### Discovery: multi-root, absolute short-circuit

`detectPluginType(dir, roots)` (in `core/plugin-config.ts`) resolves
`dir` in order:

1. **Absolute path** — used directly (dev/power-user escape hatch).
2. **`DEFAULT_BACKEND_ROOTS[0]`** = package `backends/` (shipped
   backends).
3. **`DEFAULT_BACKEND_ROOTS[1]`** = `USER_BACKENDS_DIR` (user stealth).

First root with an unambiguous entry point (`index.ts` XOR `bridge.py`)
wins. Missing from all roots throws an error naming every root
searched. Tested in `__tests__/plugin-loading.test.ts`.

The `pythonPath` in `config` must be **absolute** — a relative
`pythonPath` is not resolved against `USER_BACKENDS_DIR` (that nicety
is intentionally out of scope). Point it at
`<user-backends>/<name>-py/.venv/bin/python`.

### Config channel: `browser.init` RPC

After the `ping` handshake, `python-adapter.ts` sends a single
`browser.init` RPC with `{ config: <user config dict> }`. The bridge
stores it as `self._plugin_config`; subclasses read
`self.plugin_config.get("launch", {})`. A bridge that does not
recognize `browser.init` rejects with a "bridge too old" message so
upgrades fail loudly. Re-sent after crash-recovery restarts. Tested in
`__tests__/python-adapter.test.ts` ("browser.init RPC").

### Importability: `PYTHONPATH` injection

`python-adapter.ts` `_buildPythonPath()` appends the package's
`backends/python-base/` to any existing `PYTHONPATH` in the spawn env,
so a user bridge in its own venv can
`from pi_browser_bridge.playwright_base import PlaywrightBridge`
without a `pip install` of `pi-browser-bridge` (which is not on PyPI).
Append (not prepend) so the editable install in `python-base/.venv`
keeps precedence for the shipped `chromium-py` / `firefox-py` bridges.
Tested in `__tests__/python-adapter.test.ts` ("PYTHONPATH injection").

### Quirks schema (`PlaywrightBridge` class attrs)

The contract for a stealth backend is a set of class attributes on
`PlaywrightBridge` in
`backends/python-base/pi_browser_bridge/playwright_base.py`. Set them
as class attributes on your subclass:

| Flag | Default | Effect when set |
|------|---------|-----------------|
| `_fingerprint_managed_context` | `False` | `create_browser_context()` skips hardcoded `viewport`/`user_agent`; lets the fingerprint package set them. |
| `_eval_prefix` | `""` | Prepended to every `page.evaluate` expression in `do_evaluate` (e.g. Camoufox's `"mw:"` routes writes to the main world). |
| `_scroll_via_wheel` | `False` | `do_scroll` uses `page.mouse.wheel` instead of `page.evaluate("window.scrollBy")` (avoids eval-write under isolated-world stealth). |
| `_skip_default_viewport` | `False` | Skips Playwright's `Browser.setDefaultViewport` CDP call (Camoufox binary rejects its `isMobile` prop). |
| `_skip_networkidle` | `False` | Nav-settle uses `load` instead of `networkidle` (patched binaries don't fire `networkidle` reliably). |

All flags default off → `chromium-py` / `firefox-py` behavior is
bit-identical to a pre-stealth install. A dropped v2 `_context_factory`
flag (dispatching to a `_camoufox_new_context` helper) was removed
when `camoufox.NewContext` turned out to be broken on the current
binary (`Protocol error (Browser.setDefaultViewport)` from the same
`isMobile` rejection `_skip_default_viewport` handles). Camoufox
injects the fingerprint at **browser launch** via `camoufox.NewBrowser`,
so standard `browser.new_context()` with
`_fingerprint_managed_context = True` is correct — do not re-attempt
`NewContext`.

### Camoufox: the shipped example template

Camoufox is the **shipped, tested example** — a reference `bridge.py`
and a MiniWoB++ parity-test template live at
`contributed/camoufox-py/` (source repo only; **not in the
npm tarball** because `docs/` is excluded from `package.json` `files`).
Pointer:
`packages/pi-lean-portal/contributed/camoufox-py/bridge.py`.
Auto-skip contract tests live at `__tests__/contributed/camoufox-py/camoufox-py.test.ts` and
`__tests__/contributed/camoufox-py/camoufox-py-persistence.test.ts` (run when a Camoufox
install is present under `user-backends/`). The generic MiniWoB++
runner at `bench/miniwob/suites/miniwob-user-backends.test.ts`
discovers any `<name>-py/` user backend at runtime.

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
- **Stealth backends are user-managed, not shipped** — they live under `~/.pi/agent/pi-lean-portal/user-backends/`, are never in the npm tarball, and the extension never auto-downloads them. The user-side install burden is real: a per-engine venv, a ~100 MB patched-binary fetch, and an explicit `settings.json` entry with an **absolute** `pythonPath`. See `contributed/README.md` for the install flow.
- **Fingerprint-managed context** — a stealth backend sets `_fingerprint_managed_context = True` so `create_browser_context()` skips the hardcoded `viewport`/`user_agent` and lets the fingerprint package set them. Camoufox injects the fingerprint at **browser launch** via `camoufox.NewBrowser`, so standard `browser.new_context()` is correct (a `_context_factory` / `NewContext` path was attempted and dropped — `camoufox.NewContext` is broken on the current binary).
- **Camoufox `mw:` prefix + `main_world_eval`** — Camoufox sets `_eval_prefix = "mw:"` so `do_evaluate` writes route to the main world (isolated-world stealth otherwise blocks them), and forwards `main_world_eval=True` to `NewBrowser`. Contract tests assert `do_evaluate("() => 1 + 1")` returns `2`.
- **`isMobile` / `_skip_default_viewport` binary quirk** — Camoufox's patched Firefox binary rejects the `isMobile` prop in Playwright's `Browser.setDefaultViewport` CDP call, so the template sets `_skip_default_viewport = True`. If a future binary version fixes the rejection, the flag degrades gracefully (default off) — re-validate on Camoufox releases.
- **`xvfb` for `headless='virtual'`** — on Linux, Camoufox's `headless='virtual'` mode needs the `xvfb` system package; true headless (`headless=True`, the template's default) works without it.
- **`BROWSER_DEBUG=1`** — enables structured `[browser]` log lines on stderr (navigate, snapshot, click). Checked in both ChromiumPlugin and the Python bridge.

## Debugging

```bash
BROWSER_DEBUG=1 npx vitest run __tests__/reddit-dialog.test.ts
```
