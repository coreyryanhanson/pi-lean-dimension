# AGENTS.md — pi-lean-dimension (Monorepo)

> Compact instruction file for an agent working on this repository.
>
> **This file owns monorepo-level truth only.** For portal internals (the
> `BrowserPlugin` interface, router dispatch, profile/cookie persistence
> mechanics, snapshot cache, nav-settle, bot-detection, `BROWSER_DEBUG`, the
> full constraints & debt list), see
> [`packages/pi-lean-portal/AGENTS.md`](packages/pi-lean-portal/AGENTS.md).
> The search and dimension packages have small stub `AGENTS.md` files that
> point back here.

## What This Is

An npm-workspaces monorepo containing three Pi extension packages:

- **`pi-lean-portal`** — Interactive web browsing (owns `/web` command). **12 tools + 1 command.**
- **`pi-lean-search`** — SearXNG search tool (`web-search`), wired into portal's `/web` toggle. **1 tool + 1 command** (`/searxng-status`).
- **`pi-lean-dimension`** — Umbrella meta-package that bundles portal + search (codeless manifest).

With search installed, the suite totals **13 tools + 2 commands**. Architecture: plugin-based dispatch via `PluginRegistry` + typed `BrowserPlugin` interface + stateless `web-fetch` tool. Portal entrypoint: `packages/pi-lean-portal/index.ts`.

## Developer Commands

```bash
npm test                                           # vitest run — all workspace tests (may hang if browser binaries missing)
npm run test:ci                                     # vitest run — structural tests only, excludes browser-dependent tests that may hang
npm run test:miniwob                                # MiniWoB++ live-browser test suite (auto-skips)
npm run setup:miniwob                               # one-time clone of MiniWoB++ content
npx vitest run packages/pi-lean-portal/__tests__/router-dispatch.test.ts  # single test file
npx vitest run packages/pi-lean-portal/__tests__/cookie-persistence.test.ts  # Chromium persistence
npx vitest run packages/pi-lean-portal/__tests__/firefox.test.ts  # Firefox contract tests
npm run test:watch                                 # vitest in watch mode
npm run publish:dry                                # npm publish --workspaces --dry-run (inspect tarballs)
npm run publish                                    # npm publish --workspaces --access public
```

There is no build step (`noEmit: true` in tsconfig). The extension is loaded directly by pi from the source TypeScript files. No linter or formatter is configured. Lockstep versioning via `scripts/sync-versions.js`; release pipeline in `scripts/release.mjs`.

## Directory Layout

```
pi-lean-dimension/                       (monorepo root)
├── package.json                         (name: pi-lean-portal-workspace, private: true, workspaces: ["packages/*"])
├── tsconfig.base.json
├── vitest.config.ts
├── scripts/
│   ├── sync-versions.js                 (lockstep version bump)
│   └── release.mjs                      (full release pipeline)
├── AGENTS.md                            (this file — monorepo-level truth)
├── PACKAGING-PLAN.md
├── IMPLEMENTATION-PLAN.md
├── README.md                            (monorepo overview with install matrix)
├── SPIKE-REPORT.md
├── CHANGELOG.md
├── LICENSE
└── packages/
    ├── pi-lean-portal/                  ← THE BROWSER + /web owner
    │   ├── package.json                 (name: pi-lean-portal, published)
    │   ├── index.ts                     Entry: imports & registers tool definitions + lifecycle
    │   ├── browser-toggle.ts            /web on|off|learn|status — three-state toggle + subcommands
    │   ├── browser-cookies.ts           /web cookies subcommand
    │   ├── browser-profile.ts           /web profile subcommand
    │   ├── browser-status.ts            /web status subcommand
    │   ├── backends/                    Plugin implementations
    │   │   ├── playwright-base/         Shared PlaywrightPluginBase (Node base class)
    │   │   ├── chromium/index.ts        Chromium Plugin (Node/Playwright)
    │   │   ├── firefox/index.ts         Firefox Plugin (Node/Playwright)
    │   │   ├── chromium-py/bridge.py    Chromium-Py Bridge (Python/Playwright)
    │   │   ├── firefox-py/bridge.py     Firefox-Py Bridge (Python/Playwright)
    │   │   ├── python-adapter.ts        JSON-RPC bridge for subprocess plugins
    │   │   └── python-base/             Shared Python bridge library
    │   ├── core/                        Framework: shared across all plugins
    │   │   ├── plugin-api.ts            BrowserPlugin interface + result types
    │   │   ├── plugin-registry.ts       Registration, validation, strategy resolution
    │   │   ├── plugin-config.ts         Pipeline config loading + types
    │   │   ├── router.ts                Dispatch, session lifecycle, truncation
    │   │   ├── guides.ts                Guide types, builtin guides, file loader
    │   │   ├── fetch-backend.ts         Stateless HTTP → Markdown
    │   │   └── shared/                  nav-settle, paths, task-id, accessibility-tree, etc.
    │   ├── verify-ship-manifest.ts      Ship-manifest test helper (production .ts coverage checker)
    │   ├── tools/                       Tool definitions — one file per tool (12 files) + index.ts + utils.ts
    │   ├── __tests__/                   Test files + helpers/
    │   ├── AGENTS.md                    (portal internals — additive to this file)
    │   └── README.md                    (portal-specific docs)
    ├── pi-lean-search/                  ← SearXNG search leaf
    │   ├── package.json                 (name: pi-lean-search, published)
    │   ├── index.ts                     Entry: tool registration, health probe, /searxng-status command
    │   ├── web-search-tool.ts           defineTool for web-search with execute + TUI rendering
    │   ├── search-config.ts             Settings reader for searxng.url
    │   ├── verify-ship-manifest.ts      Ship-manifest test helper
    │   ├── ship-manifest.test.ts        Manifest coverage test
    │   ├── __tests__/                   Test files + helpers/
    │   ├── AGENTS.md                    (stub — points here)
    │   └── README.md                    Package docs
    └── pi-lean-dimension/               ← Umbrella meta-package (codeless)
        ├── package.json                 (name: pi-lean-dimension, bundledDependencies)
        ├── verify-ship-manifest.ts      Ship-manifest test helper
        ├── ship-manifest.test.ts        Manifest coverage test
        ├── AGENTS.md                    (stub — points here)
        └── README.md                    Package docs
```

## Architecture (suite-level overview)

All interactive backends implement the `BrowserPlugin` interface (`packages/pi-lean-portal/core/plugin-api.ts`) — 19 methods (18 required + 1 optional). The 12 registered browser tools map to 12 tool-facing plugin methods; the cookie/storage methods are router-facing. Capabilities (`PluginCapabilities`) advertise quirks the router checks at dispatch time.

Plugin loading reads `browser.plugins` from `~/.pi/agent/settings.json` (global, merged with `.pi/settings.json` project-local). Each entry is `{name, dir, enabled, config}`; `dir` maps to `backends/<dir>/`, entry point auto-detected (`index.ts` = Node, `bridge.py` = Python). Default config: chromium + firefox enabled, chromium-py + firefox-py disabled.

**Active plugins (config-driven):**

- **`chromium`** — Node/Playwright (thin subclass of `PlaywrightPluginBase`), enabled by default. Reference Node backend.
- **`firefox`** — Node/Playwright (thin subclass of `PlaywrightPluginBase`), enabled by default. Same contract as chromium.
- **`chromium-py`** — Python/Playwright (thin subclass of `PlaywrightBridge`), disabled by default. Python parity reference. Shared logic in `python-base/`.
- **`firefox-py`** — Python/Playwright (thin subclass of `PlaywrightBridge`), disabled by default. Python parity reference. Shared logic in `python-base/`.

> For the `BrowserPlugin` method list, router dispatch responsibilities, profile/cookie persistence mechanics, snapshot cache, nav-settle, bot-detection tiers, `browser-inspect` internals, and the full constraints & debt list, see [`packages/pi-lean-portal/AGENTS.md`](packages/pi-lean-portal/AGENTS.md).

### Registered Tools (13 total with search)

**Portal (12):** web-fetch, browser-navigate, browser-snapshot, browser-click, browser-type, browser-scroll, browser-back, browser-press, browser-console, browser-inspect, web-guide, web-learn

**Search (1):** web-search

### Registered Commands

**Portal:** `/web on|off|learn|cookies|profile|status` — `/web on` (browsing only), `/web off` (all disabled), `/web learn` (browsing + guide-saving via web-learn), `/web cookies list|clear` (inspect/clear session cookies), `/web profile` (list/load profiles), `/web status` (backends + sessions + profiles), `/web` (show current state).

**Search:** `/searxng-status` — test the full SearXNG search pipeline and update the status bar glyph.

Toggle state is persisted via `pi.appendEntry("web-toggle-state", ...)` per-session branch, surviving `/reload`, `/resume`, `/fork`. Three-field schema: `{browserToolsEnabled, learnToolsEnabled, defaultProfile}`.

The toggle also manages a `SIBLING_TOOL_NAMES` set populated with `"web-search"`. `/web on|off` operates on the union of `BROWSER_TOOL_NAMES ∪ SIBLING_TOOL_NAMES`. Discovery uses **exact-name `Set.has()` membership** — no regex, no false positives on third-party `web-*` tools.

### Status Bar (glyph slots)

Portal manages two status bar slots:

**`browser`** — shows the browser tool toggle state:

- `● idle` (accent/blue) — browser tools enabled
- `● idle` (success/green) — learn mode enabled
- `○ web off` — browser tools disabled

**`search`** — shows the search tool toggle + SearXNG health (search-owned):

- `● searxng` (accent/blue) — healthy and reachable
- `● searxng` (warning/yellow) — server up but pipeline degraded
- `● searxng` (error/red) — unreachable
- `○ searxng` — search tools off (portal sets this on `/web off`)

The `search` slot is only shown when `pi-lean-search` is installed. Search probes SearXNG reachability on `session_start` and `/searxng-status` and sets the glyph color. Portal writes the `○` off state when `/web off` is called.

### Profile & Cookie Management (overview)

- **Storage state** is persisted to `~/.pi/agent/pi-lean-portal/browser-state/<profile-name>/storage-state.json` via `core/shared/storage-state.ts`.
- **Save-before-renavigate**: both Chromium and Python plugins call `_persistState()` before closing/reusing a context with a persistent profile, so cookies set during a session survive re-navigate, crash recovery, `/reload`, and `/resume`.
- **Atomic writes + concurrency safety**: `saveStorageState()` writes a temp file then renames atomically; concurrent writers merge at the cookie and localStorage level so two agents sharing a named profile don't clobber each other.
- **Session profiles** (`profile="session"`, the default) are scoped to one pi conversation under `_session-<piSessionId>`. **Named profiles** (`profile="shopping"`) are shared across conversations and agents. Conversation-scoped default set via `/web profile set <name>`, survives `/reload`/`/resume`.
- **Cookie operations** (`getCookies`, `addCookies`, `clearCookies`) delegate to the browser plugin's Playwright `context.cookies()` / `context.clearCookies()`.

> For the in-memory fallback, re-navigate semantics, and the Chromium vs Python context-reuse difference, see [`packages/pi-lean-portal/AGENTS.md`](packages/pi-lean-portal/AGENTS.md).

### Guides (`core/guides.ts`)

4 builtin pattern guides (`bot-detection`, `cookie-consent`, `pagination`, `search`). Site guides are user-authored — place a `.md` file with YAML frontmatter in `~/.pi/agent/pi-lean-portal/web-guides/` — and auto-register via their `domains` field. Caches invalidate on `web-learn` calls. Guides surface via an applicable-guide footer and badge; all matching guides are shown together with no priority suppression.

### Key Tools

| Tool | Use Case | State | Speed |
|------|----------|-------|-------|
| `web-fetch` | Static page → Markdown, no JS needed | Stateless | Fast |
| `browser-navigate` | Interactive page → accessibility tree with @e refs | Stateful session | Slower |
| `browser-inspect` | Element queries + text extraction with @e ref annotations | Stateful session | Fast (sync cache) |
| `web-guide` | Get navigation guidance for a site or pattern | Stateless | Instant |
| `web-learn` | Save or update navigation guidance for a site | Stateless | Instant |
| `web-search` (search) | Web search via SearXNG | Stateless | Medium |

`web-fetch` uses plain `fetch()` + `node-html-parser` + `turndown`. Returns ~4000 chars inline, spills to temp file when larger.

### Engine Parity Note

Playwright Firefox (Juggler) and Playwright Chromium (CDP) serialize ARIA trees in the **same YAML format**, so the shared parser in `core/shared/accessibility-tree.ts` works identically for both. The two engines may report **different role sets and props** for the same DOM. The contract test suite uses threshold assertions (`elementCount > 0`) rather than exact equality, so this should pass without false positives. If any fixture shows a meaningful divergence, document it here rather than papering over it.

**User-Agent drift (Python backends):** The Node Firefox backend dynamically probes the browser's UA at lazy init (probe-then-cache). The Python Firefox backend uses a hardcoded fallback UA string (`rv:135.0`). This string will drift as Firefox releases newer versions. If you use the Python Firefox backend for UA-sensitive sites, update the hardcoded UA string in `backends/firefox-py/bridge.py` to match the installed Firefox version.

## Testing

### Test files (30 files, 676 tests passing + live-browser tests)

**Portal structural tests (19 files, 650+ tests):** router-dispatch, browser-toggle, browser-toggle-profile, browser-navigate, plugin-registry, plugin-contract, plugin-config-browser, python-adapter, fetch-backend, accessibility-tree, url-safety, plugin-loading, snapshot-cache, browser-inspect, web-guides, router-session, storage-state, nav-settle, ship-manifest

**Portal MiniWoB tests (2 files):** miniwob-helper (16 structural tests, no browser), miniwob (125 MiniWoB++ tasks × 4 shipped backends) — see [MiniWoB Integration](#miniwob-integration) below.

**Search tests (2 files, 17+ tests):** web-search (config reader + tool structure), ship-manifest

**Dimension tests (1 file, 2 tests):** ship-manifest

| File | Requires browser? |
|------|--------------------|
| All portal structural tests (listed above) | No |
| Search tests (web-search, ship-manifest) | No |
| Dimension tests (ship-manifest) | No |
| reddit-dialog.test.ts | Chromium (errors if unavailable) |
| cookie-persistence.test.ts | Chromium (auto-skip) |
| chromium-py.test.ts | Chromium + Python venv (auto-skip) |
| chromium-py-persistence.test.ts | Chromium + Python venv (auto-skip) |
| firefox.test.ts | Playwright Firefox (auto-skip) |
| firefox-py.test.ts | Playwright Firefox + Python venv (auto-skip) |
| firefox-py-persistence.test.ts | Playwright Firefox + Python venv (auto-skip) |
| miniwob.test.ts | MiniWoB++ content + browser(s) per-backend (auto-skip) |

Live-browser tests auto-skip when the required browser or Python venv is absent. `reddit-dialog` errors if Chromium is missing (it's a structural requirement for the Node Chromium backend). `browser-toggle-profile` tests exercise the full profile lifecycle via mock API.

### Shared test utilities (`packages/pi-lean-portal/__tests__/helpers/`)

- `plugin-contract.ts` — `runContractTests(name, factory, opts?)` validates any BrowserPlugin
- `mock-plugin.ts` — MockPlugin for structural contract validation
- `reddit-fixture.ts` — HTML fixtures for Reddit dialog scenarios (4 variants)
- `test-server.ts` — `startTestServer()` returns a local HTTP server for integration tests
- `mock-python-bridge.py` — Python bridge stub used by python-adapter tests (supports `browser.getStorageState` and `browser.getCookies` for persistence testing)

### Contract test harness

`runContractTests()` validates structural contracts (all operations exist, result shapes) without a browser, and behavioral tests (`realBrowser: true`) with a live browser (Chromium or Firefox depending on the plugin passed).

### MiniWoB Integration

The suite at `packages/pi-lean-portal/__tests__/miniwob.test.ts` drives all 125
[MiniWoB++](https://miniwob.farama.org/) tasks through the four shipped
BrowserPlugin backends (chromium, firefox, chromium-py, firefox-py) to
verify the interactive plugin pipeline (navigate, snapshot, click, type,
press, scroll, goBack).

- **13 tasks run** with trivial solvers — 3 confident (assert reward > 0)
  and 10 best-effort (pipeline smoke tests).
- **77 element tasks** without a registered solver → `it.skip` with reason
  `needs goal-aware solver (Step 2 follow-up)`.
- **35 non-element tasks** (coord/drag/hover/select) → `it.skip` with
  the missing-tool reason.
- **Reusable machinery** in `helpers/miniwob-suite.ts`
  (`registerMiniwobSuite()`, solver registry, parsing toolkit) lets
  user-owned parity test files register custom backends without editing
  shipped code — see that file for the pattern.

**One-time setup:**

```bash
# Clone MiniWoB++ at the pinned commit (idempotent — no-op if exists)
npm run setup:miniwob

# Run the MiniWoB suite (auto-skips when content unreachable)
npm run test:miniwob
```

The setup script (`scripts/setup-miniwob.mjs`) defaults to
`/tmp/miniwob-plusplus/miniwob/html`. Override at test time:

```bash
export MINIWOB_HTML_ROOT=/path/to/miniwob/html  # path on disk
export MINIWOB_URL=http://…                      # already-running server
```

**Auto-skip gates:** The suite skips each backend when its required
browser is absent, and skips entirely when MiniWoB content is
unreachable (no `MINIWOB_HTML_ROOT`/default path AND no `MINIWOB_URL`).
This keeps `npm test` and `npm run test:ci` green in bare CI.

**What MiniWoB does NOT cover:** canvas/coordinate tasks (no tool),
drag-and-drop (no tool), hover/slider/select (no tool), and any
framework/structural concern (router dispatch, plugin registry, config
loading, snapshot cache, etc.). Those remain covered by the existing
structural tests.

See [`miniwob-integration-plan.md`](miniwob-integration-plan.md) for the
full plan, spike findings, per-backend parity status, and the
camoufox-py diagnostic.

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
- `browser-cookies.ts`, `browser-profile.ts`, `browser-status.ts` live at the portal package root and import from `core/` — they're command handlers, not plugins.
