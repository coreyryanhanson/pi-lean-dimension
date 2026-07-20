# Changelog

## [Unreleased]

### Added

- **Documented user-guide override of builtins** — a same-named `.md` in
  `~/.pi/agent/pi-lean-portal/web-guides/` (e.g. `bot-detection.md`) shadows
  the builtin guide entirely: whole-guide replacement, not field merge. The
  README and `AGENTS.md` now spell out the override semantics, the
  `trigger.signal` requirement to keep a pattern guide firing after override,
  and that site guides and pattern guides live in disjoint namespaces (a site
  guide for `www.botdetection.com` does not collide with the `bot-detection`
  pattern). Tests pin all four override cases.

### Changed

- **Removed the portal URL guard** — `core/shared/url-safety.ts` and its
  tests are deleted; `browser-navigate` and `web-fetch` no longer reject
  localhost, private-IP, non-http(s) schemes, or secret-bearing URLs. The
  guard was an SSRF-style boundary that doesn't fit a coding agent with
  filesystem `bash`/`read`/`write` already in scope — it patched one hole in
  a sieve. The malformed-URL `new URL()` parse at both call sites stays
  (input validation, not a guard), so `webFetch({ url: "not a url" })` still
  returns `{ success: false, error: "Invalid URL" }`. The portal
  `AGENTS.md` constraint listing the guard is dropped.

- **Guide footer names the `web-guide` invocation** — `formatGuideFooter`
  now appends `(web-guide guide="<name>")` to each listed guide so the
  agent can call `web-guide` with the exact guide key instead of guessing
  from the short name.

- **Breaking (Python bridge API):** the abstract `BrowserBridge` class in
  `pi_browser_bridge/bridge.py` has been folded into its only subclass
  `PlaywrightBridge` in `playwright_base.py`. `bridge.py` is deleted and the
  module no longer exports `BrowserBridge`. User-installed stealth backends
  that subclassed `BrowserBridge` must now subclass `PlaywrightBridge`
  instead — the Camoufox template was already on `PlaywrightBridge`, so
  shipped examples are unaffected.

### Internal

- Refactor and documentation cleanup: deduplicated `setSearchStatus`, shared a
  `formatBytes` helper, simplified the bot-detection result shape, and removed
  unused exports across `core/shared`. No behavior change.
- **Dropped the lazy guide-content cache** — `getGuideContent()` now always
  reads user guides from disk (cheap, and removes a stale-cache footgun where
  a freshly `web-learn`ed guide wouldn't appear until invalidation).
  `invalidateGuideContent()` is removed; `web-learn` no longer calls it.
  `_setGuideContentForTest` now layers test overrides on top of the real
  builtin+user guides instead of replacing a cached map, and the guide tests
  mock `node:fs.existsSync` for the web-guides dir so on-disk user guides
  can't leak into the suite.

### Fixed

- **Status-bar glyph now syncs after `/tree` navigation** — the `browser`
  status-bar slot was stale after navigating the conversation tree:
  `browser-toggle`'s `session_tree` handler restored the toggle state and
  active-tool set from the branch, but nothing repainted the glyph, so the
  display could show `● idle` while the browser tools were actually
  disabled (or vice versa). `index.ts` now calls `updateFooterStatus` on
  `session_tree`, mirroring the existing `session_start` repaint. The fix
  is isolated to portal and ships independently of the in-flight host
  work.

## [0.2.4] - 2026-07-20

### Fixed

- **`/web off` no longer re-enables other extensions' disabled tools** —
  `applyBrowserState(false)` rebuilt the active set from
  `pi.getAllTools()` (every registered tool) and filtered out only portal's
  own tools, silently re-activating any tool a peer extension or toggle had
  removed from the active set. The bug was latent as long as portal was the
  only thing disabling tools; any co-installed extension managing its own
  tool visibility would have its state clobbered by a subsequent `/web off`.
  The disable path now subtracts from `pi.getActiveTools()` (the
  currently-active set), matching the existing `applyLearnState` pattern,
  so peer toggles compose correctly. The symmetric enable path was already
  safe.

## [0.2.3] - 2026-07-15

### Added

- **`web-search` guidelines document bang syntax, engine restriction, and site operators** —
  `promptGuidelines` now advertises SearXNG bangs (`!wp`, `!images`, `!map`, `:<lang>`),
  the `engines` param for upstream restriction, and `site:`/`inurl:`/`intitle:`/`filetype:`
  operators (engine-dependent). All three features already worked; only visibility was missing.

### Fixed

- **`web-fetch` handles parallel calls without clobbering temp files** —
  `trackFetchFile` no longer eagerly deletes prior spill files for the same
  taskId on each new spill. Parallel fetches (e.g. two large pages fetched
  with the same default taskId) now both keep their temp files, fixing a
  data-loss bug where the agent would read a returned `filePath` only to
  find it already deleted. Adds a regression test.

## [0.2.2] - 2026-07-15

### Added

- **`web-search` surfaces SearXNG instant answers** — calculator, unit
  convert, `random uuid`, hashes, DuckDuckGo definitions, translations, and
  weather answers now render above the result list (in boxed blocks) instead
  of being silently dropped. Answers show even when there are zero web
  results, so an answerer-driven query like `avg 1 2 3` returns the answer
  rather than "No results found". The `SearXNGResponse.answers` type was
  corrected from `string[]` to a discriminated union on `template`. The TUI
  status line gains a `💡 N answer(s)` badge, `details` carries
  `answers`/`answerCount`, and `promptGuidelines` notes answerer-friendly
  query forms.

### Fixed

- **Agent-facing strings** — corrected inaccuracies in runtime messaging the
  agent sees when interacting with the browser:
- **`browser.maxStorageStateSize` is now wired** — the setting was documented
  and referenced in a runtime warning but never read; it's now parsed in
  `plugin-config.ts` and threaded through both `_persistState` paths.

## [0.2.1] - 2026-07-14

### Fixed

- **Camoufox link** — corrected the upstream Camoufox URL in the root and
  portal READMEs and the contributed docs.

## [0.2.0] - 2026-07-14

### Stealth backends (user-managed)

- **User-installed stealth backends** — patched/fingerprint-managed browser
  binaries (e.g. Camoufox) can now be registered as plugins. They live under
  `~/.pi/agent/pi-lean-portal/user-backends/<name>-py/`, are never shipped in
  the npm tarball, and are never auto-downloaded — you write/audit the bridge,
  create the venv, fetch the binary, and register it in `settings.json`.
- **Camoufox reference template** — a tested `bridge.py` under
  `packages/pi-lean-portal/contributed/camoufox-py/`, plus
  `contributed/README.md` (install flow) and `contributed/CHOOSING.md` (when
  to reach for a stealth backend at all).
- **Quirks schema** — `PlaywrightBridge` subclasses declare engine quirks
  (`_fingerprint_managed_context`, `_skip_default_viewport`,
  `_scroll_via_wheel`, `_eval_prefix`) that the router and tools respect.
- **`probeUserBackend` helper** — discovers and validates user-managed Python
  backends for contract and parity testing.
- Multi-root plugin discovery, `browser.init` RPC, and `PYTHONPATH` injection
  for user backends (see `packages/pi-lean-portal/AGENTS.md`).

### MiniWoB++ evaluation harness

- **`bench/miniwob/`** — a `plugin.evaluate`-driven MiniWoB++ episode
  lifecycle with a Node `@e`-ref action layer, replacing the prior
  BrowserGym-based approach. Public API: `runMiniwobTask` and
  `registerMiniwobSuite` (lets user-owned parity files register custom
  backends without editing shipped code).
- **Per-backend suites** — chromium, firefox, chromium-py, firefox-py, plus
  adapter-smoke and a user-backends discovery suite (130 tasks × backend,
  auto-skips when prerequisites are absent).
- **Decision record** — `docs/decisions/miniwob-and-host-setup.md`
  documents the BrowserGym removal and host/MiniWoB setup rationale.

### Shared data & Python bridge

- **Shared JSON data tables** — bot-detection and accessibility tables moved
  to `core/shared/browser-data.json`, consumed by both Node
  (`browser-data.ts`) and Python (`browser_data.py`).
- **Python bridge refactor** — `playwright_base.py` rewrite with the stealth
  quirks schema; new `patch_playwright.py`; consolidated and expanded pytest
  suite (`test_py_bridges`, `test_playwright_base_quirks`,
  `test_browser_data`, `conftest`) — 243 pure-logic tests, needs only
  `pytest>=9.0`.

### Search

- **Pagination** — `web-search` now paginates results.

### Tools

- **Strategy visibility** — `browser-navigate`'s `strategy` parameter
  description is patched at registration with the actually configured plugin
  names (and any disabled ones), so the agent doesn't second-guess which
  strategies exist.

### CI & testing

- **GitHub Actions pipeline** (`.github/workflows/ci.yml`) — three jobs:
  `structural` (fast, no browser), `miniwob` (cross-engine browser tests), and
  an opt-in `contributed` job (Camoufox user-backends validation, manual
  trigger only).
- **New npm scripts** — `test:ci` (structural + contributed contract tests),
  `test:py-bridge` (Python bridge unit tests), `setup:miniwob`,
  `test:miniwob`.
- **Test infrastructure** — shared `persistence-suite`,
  `create-py-backend-harness`, `load-plugin-config-from-file`, and
  `probe-user-backend` helpers; an auto-discovery `run-contributed-suites`
  runner; expanded plugin-loading, registry, config, and session-manager
  tests.

## [0.1.0] - 2026-06-22

### Initial release — the web-tools suite

First public release of the pi-lean-dimension monorepo — three Pi extension
packages for web browsing and search.

- **`pi-lean-portal`** — Interactive browser, owns `/web` command (recommended).
- **`pi-lean-search`** — SearXNG search tool, wires into portal's `/web` toggle.
- **`pi-lean-dimension`** — Umbrella meta-package that bundles both.

### Features

- **13 tools**: `browser-navigate`, `browser-snapshot`, `browser-click`,
  `browser-type`, `browser-scroll`, `browser-back`, `browser-press`,
  `browser-console`, `browser-inspect`, `web-fetch`, `web-guide`, `web-learn`,
  `web-search`.
- **2 commands**: `/web on|off|learn|cookies|profile|status` and
  `/searxng-status`.
- **Playwright install UX:** `.npmrc` suppresses browser downloads during
  `npm install`. On first `browser-navigate` with no browsers installed, a
  clear notification prints `npx playwright install chromium firefox`.
- **Status bar:** Two independent glyphs (`browser`, `search`) show toggle
  state and SearXNG health.
- **Graceful degradation:** `web-search` registers even without SearXNG
  configured; on first unconfigured call it returns a setup message instead
  of failing silently or throwing.
- **Persistent profiles:** Session and named profiles for cookies/localStorage
  across conversations and subagents.
- **Navigation guides:** Four built-in pattern guides (bot-detection,
  cookie-consent, pagination, search) plus user-authored site guides via
  `web-learn`.
- **Lockstep versioning:** All three packages share v0.1.0. Switch to
  independent versioning planned after stabilization.
