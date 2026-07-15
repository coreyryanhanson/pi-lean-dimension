# Changelog

## [Unreleased]

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
