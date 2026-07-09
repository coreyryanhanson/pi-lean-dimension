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

An npm-workspaces monorepo containing three packages:

- **`pi-lean-portal`** — Interactive web browsing (owns `/web` command). **12 tools + 1 command.**
- **`pi-lean-search`** — SearXNG search tool (`web-search`), wired into portal's `/web` toggle. **1 tool + 1 command** (`/searxng-status`).
- **`pi-lean-dimension`** — Umbrella meta-package that bundles portal + search (codeless manifest).

The MiniWoB++ evaluation harness was dissolved out of the workspaces and lives at `bench/miniwob/` — it is research tooling, not a pi extension.

With search installed, the suite totals **13 tools + 2 commands** (portal + search only). Architecture: plugin-based dispatch via `PluginRegistry` + typed `BrowserPlugin` interface + stateless `web-fetch` tool. Portal entrypoint: `packages/pi-lean-portal/index.ts`.

## Developer Commands

```bash
npm test                                           # vitest run — all workspace tests (may hang if browser binaries missing)
npm run test:ci                                     # vitest run — structural tests only, excludes browser-dependent tests that may hang
npm run test:miniwob                                # MiniWoB++ cross-engine test suite (host: 130 tasks × 4 backends + smoke, auto-skips)
npm run setup:miniwob                               # one-time clone of MiniWoB++ content
# (no dedicated venv needed — the driver uses the plugin's Python path)
npx vitest run packages/pi-lean-portal/__tests__/router-dispatch.test.ts  # single test file
npx vitest run packages/pi-lean-portal/__tests__/cookie-persistence.test.ts  # Chromium persistence
npx vitest run packages/pi-lean-portal/__tests__/firefox.test.ts  # Firefox contract tests
npx vitest run bench/miniwob/suites/                # run all MiniWoB suites (chromium, firefox, chromium-py, firefox-py, adapter-smoke)
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
├── bench/                            ← MiniWoB++ evaluation harness
│   └── miniwob/                       130-task harness (adapter, solvers, suites, scripts)
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
- **User-installed stealth backends (not shipped)** — patched/fingerprint-managed browser binaries (e.g. Camoufox) installed by the user under `~/.pi/agent/pi-lean-portal/user-backends/<name>-py/`. Never in the npm tarball, never auto-downloaded (no plugin marketplace — trusted user code). Loaded only when explicitly listed in `browser.plugins` with an absolute `pythonPath`; never in the default fallback list. The shipped example template is Camoufox at `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/` (docs-only, source repo only). See `packages/pi-lean-portal/AGENTS.md` ("Stealth backends") and `packages/pi-lean-portal/docs/stealth-backends/README.md` for the install flow and quirks schema.

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

### Test split principle

**Subject under test** determines where a test lives, not *needs a browser*.

- **Portal structural tests** (`pi-lean-portal`): framework internals (router dispatch, registry, config loading, snapshot cache, nav-settle, storage state, accessibility parsing, url safety, plugin contract validation, browser toggle, fetch backend, python adapter). These are mocked unit tests — no real browser or MiniWoB content required.
- **MiniWoB behavioral tests** (`bench/miniwob/suites/`): behavioral evaluation against real browser engines (MiniWoB tasks, browser interaction pipeline verification). These require a live browser and MiniWoB++ content.
- **Per-backend contract tests** (in `pi-lean-portal`): verify each backend (chromium, firefox, chromium-py, firefox-py, etc.) against the `BrowserPlugin` interface contract. Require their respective browser engine.

### Test file summary

| Category | Location | Files (~) | Tests (~) | Requires browser? |
|----------|----------|-----------|-----------|-------------------|
| Portal structural | `pi-lean-portal/__tests__/` | 20 | 650+ | No |
| Portal contract/backend | `pi-lean-portal/__tests__/` | 9 | varies | Per-backend (auto-skip) |
| MiniWoB behavioral | `bench/miniwob/suites/` | 6 | 130 tasks × 4 + smoke* | Chromium + Firefox + Python + MiniWoB content |
| Search | `pi-lean-search/` | 2 | 17+ | No |
| Dimension | `pi-lean-dimension/` | 1 | 2 | No |

**Portal structural (20 files):** router-dispatch, browser-toggle, browser-toggle-profile, browser-navigate, plugin-registry, plugin-contract, plugin-config-browser, python-adapter, fetch-backend, accessibility-tree, url-safety, plugin-loading, snapshot-cache, browser-inspect, web-guides, router-session, storage-state, nav-settle, probe-user-backend, ship-manifest

**Portal per-backend contract tests (9 files):** reddit-dialog (errors if Chromium missing), cookie-persistence (auto-skip), chromium-py (auto-skip), chromium-py-persistence (auto-skip), firefox (auto-skip), firefox-py (auto-skip), firefox-py-persistence (auto-skip), camoufox-py (auto-skip, user-backends), camoufox-py-persistence (auto-skip, user-backends)

**MiniWoB behavioral tests (`bench/miniwob/suites/`, 6 files):**

- `miniwob-trivial.test.ts` — 130 MiniWoB++ tasks × chromium (13 run, 117 skip)
- `miniwob-firefox.test.ts` — 130 tasks × firefox (13 run, 117 skip)
- `miniwob-chromium-py.test.ts` — 130 tasks × chromium-py (13 run, 117 skip)
- `miniwob-firefox-py.test.ts` — 130 tasks × firefox-py (13 run, 117 skip)
- `adapter-smoke.test.ts` — end-to-end runMiniwobTask via real Chromium + `plugin.evaluate` episode lifecycle
- `miniwob-user-backends.test.ts` — discovers user-managed Python backends (no-op in bare CI; registers 130 tasks × discovered backends when installed)

**Shared test utilities** (`packages/pi-lean-portal/__tests__/helpers/`):

- `plugin-contract.ts` — `runContractTests(name, factory, opts?)` validates any BrowserPlugin
- `mock-plugin.ts` — MockPlugin for structural contract validation
- `reddit-fixture.ts` — HTML fixtures for Reddit dialog scenarios (4 variants)
- `test-server.ts` — `startTestServer()` returns a local HTTP server for integration tests
- `mock-python-bridge.py` — Python bridge stub used by python-adapter tests

### MiniWoB Integration

Behavioral MiniWoB++ evaluation lives under `bench/miniwob/` and uses a
hand-rolled MiniWoB++ driver (no BrowserGym dependency).

Shipped suite files under `bench/miniwob/suites/` drive
all 130 [MiniWoB++](https://miniwob.farama.org/) tasks through each
backend. The shared helper at `miniwob-suite-helper.ts` owns content
availability gates and the MiniWoB static server lifecycle; each
per-backend file supplies only the browser-availability probe and
plugin factory:

- **`miniwob-trivial.test.ts`** — Chromium (Node)
- **`miniwob-firefox.test.ts`** — Firefox (Node)
- **`miniwob-chromium-py.test.ts`** — Chromium-Py (Python bridge)
- **`miniwob-firefox-py.test.ts`** — Firefox-Py (Python bridge)

- **13 tasks run** with trivial solvers — 3 confident (assert reward > 0)
  and 10 best-effort (pipeline smoke tests).
- **82 element tasks** without a registered solver → `it.skip` with reason
  `needs goal-aware solver (Step 2 follow-up)`.
- **35 non-element tasks** (coord/drag/hover/select) → `it.skip` with
  the missing-tool reason.
- **Public API:** `registerMiniwobSuite` from `bench/miniwob/solvers/register-suite.ts` lets
  user-owned parity test files register custom backends without editing
  shipped code.

**One-time setup:**

```bash
# Clone MiniWoB++ at the pinned commit (idempotent — no-op if exists)
npm run setup:miniwob

# Run the MiniWoB suite (auto-skips when prereqs absent)
npm run test:miniwob
```

The setup script (`bench/miniwob/scripts/setup-miniwob.mjs`)
defaults to `/tmp/miniwob-plusplus/miniwob/html`. Override at test time:

```bash
export MINIWOB_HTML_ROOT=/path/to/miniwob/html  # path on disk
export MINIWOB_URL=http://…                      # already-running server
```

**Auto-skip gates:** Each per-backend suite file independently
auto-skips when its browser prerequisites are absent or MiniWoB++
content is unreachable. This keeps `npm test` and
`npm run test:ci` green in bare CI without path-filtering logic.

**What MiniWoB does NOT cover:** canvas/coordinate tasks (no tool),
drag-and-drop (no tool), hover/slider/select (no tool), and any
framework/structural concern (router dispatch, plugin registry, config
loading, snapshot cache, etc.). Those remain covered by the existing
portal structural tests.

See [`docs/decisions/miniwob-and-host-setup.md`](docs/decisions/miniwob-and-host-setup.md) for the
BrowserGym removal and host/MiniWoB setup decision record.

## CI Pipeline

The repository includes a GitHub Actions workflow at
`.github/workflows/ci.yml` that runs on every PR and push to `main`,
split into two parallel jobs:

**`structural` job (fast, no browser):**

1. **Checkout** the repository
2. **Setup Node.js 22** with npm caching
3. **Install dependencies** via `npm ci`
4. **Run structural tests** via `npm run test:ci`

**`miniwob` job (cross-engine browser tests, depends on structural):**

1. **Checkout** + **Setup Node.js 22** + `npm ci`
2. **Install Playwright Chromium** (drives Node chromium +
   chromium-py suites)
3. **Install Playwright Firefox** (drives Node firefox +
   firefox-py suites)
4. **Setup Python 3.12 + venv** with `playwright` pip package
   (drives chromium-py + firefox-py suites)
5. **Clone MiniWoB++ content** via `npm run setup:miniwob`
6. **Run all MiniWoB browser tests** via `npm run test:miniwob`
   (runs `bench/miniwob/suites/`, covering all 5 suite
   files)
7. **Upload test artifacts on failure** (vitest output, Playwright
   traces)

**Auto-skip gates:** Each per-backend suite file independently
auto-skips when its browser prerequisites are absent or MiniWoB++
content is unreachable. This keeps `npm test` and
`npm run test:ci` green in bare CI without path-filtering logic.

**Manual trigger:** The workflow also supports `workflow_dispatch`
for re-running from the Actions tab without pushing a new commit.

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
