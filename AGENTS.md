# AGENTS.md — pi-lean-dimension (Monorepo)

> Compact instruction file for an agent working on this repository.
>
> **This file owns monorepo-level truth only.** For portal internals (the
> `BrowserPlugin` interface, router dispatch, status bar `browser` slot,
> profile/cookie persistence mechanics, guides, key-tools table, engine
> parity, snapshot cache, nav-settle, bot-detection, `BROWSER_DEBUG`, the
> `backends/` vs `core/` boundary, per-file test lists, and the full
> constraints & debt list), see
> [`packages/pi-lean-portal/AGENTS.md`](packages/pi-lean-portal/AGENTS.md).
> For the search-owned `search` status bar slot, see
> [`packages/pi-lean-search/AGENTS.md`](packages/pi-lean-search/AGENTS.md).
> The dimension package has a small stub `AGENTS.md` that points back here.

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
npm run test:ci                                     # Structural + contributed-backend contract tests (excludes chromium/firefox/bench). Runs contributed/* contract tests when backends are installed — expect 2-3 min on a dev machine with backends; use 300s+ timeout if wrapping.
npm run test:py-bridge                              # Python bridge unit tests (pytest, 248 pure-logic tests under packages/pi-lean-portal/backends/python-base/tests/ — needs only `pytest>=9.0`, no browser). Uses the package-local .venv if present, else system `python3`.
npm run test:miniwob                                # MiniWoB++ cross-engine test suite (host: 130 tasks × 4 backends + smoke, auto-skips)
npm run setup:miniwob                               # one-time clone of MiniWoB++ content
# (no dedicated venv needed — the driver uses the plugin's Python path)
npx vitest run packages/pi-lean-portal/__tests__/router-dispatch.test.ts  # single test file (fast, ~1s)
npx vitest run packages/pi-lean-portal/__tests__/cookie-persistence.test.ts  # Chromium persistence
npx vitest run packages/pi-lean-portal/__tests__/firefox.test.ts  # Firefox contract tests
npx vitest run bench/miniwob/suites/                # run all MiniWoB suites (chromium, firefox, chromium-py, firefox-py, adapter-smoke, user-backends, inspect-csp-smoke, inspect-eval-smoke)
npm run test:watch                                 # vitest in watch mode
npm run publish:dry                                # dry-run publish (portal+search --dry-run + dimension --dry-run) — inspect tarballs
npm run publish                                    # full publish (portal+search npm publish + dimension publish)
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
│   ├── release.mjs                      (full release pipeline)
│   ├── publish-dimension.mjs            (umbrella meta-package publish)
│   └── run-py-bridge-tests.mjs          (Python bridge unit test runner)
├── AGENTS.md                            (this file — monorepo-level truth)
├── README.md                            (monorepo overview with install matrix)
├── CHANGELOG.md
├── LICENSE
├── bench/                            ← MiniWoB++ evaluation harness
│   ├── README.md                      (bench architecture and public API)
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
        ├── AGENTS.md                    (stub — points here)
        └── README.md                    Package docs
```

## Architecture (suite-level overview)

Portal dispatches through a `PluginRegistry` + typed `BrowserPlugin` interface (`packages/pi-lean-portal/core/plugin-api.ts`); `web-fetch` is stateless. All backends implement the same 19-method interface, so the 12 browser tools are backend-agnostic. Backend config lives under `browser.plugins` in `~/.pi/agent/settings.json` (merged with `.pi/settings.json`).

**Shipped backends (config-driven):** `chromium` (Node, enabled), `firefox` (Node, enabled), `chromium-py` (Python, disabled), `firefox-py` (Python, disabled). User-installed stealth backends (e.g. Camoufox) are never shipped, never auto-downloaded, and loaded only when explicitly listed with an absolute `pythonPath` — see `packages/pi-lean-portal/AGENTS.md` ("Stealth backends") and `packages/pi-lean-portal/contributed/README.md`.

> For the `BrowserPlugin` method list, router dispatch, the status bar `browser` slot, profile/cookie persistence, guides, key-tools table, engine parity, snapshot cache, nav-settle, bot-detection tiers, `browser-inspect` internals, the `backends/` vs `core/` boundary, and the full constraints & debt list, see [`packages/pi-lean-portal/AGENTS.md`](packages/pi-lean-portal/AGENTS.md). The search-owned `search` status bar slot is documented in [`packages/pi-lean-search/AGENTS.md`](packages/pi-lean-search/AGENTS.md).

### Registered Tools (13 total with search)

**Portal (12):** web-fetch, browser-navigate, browser-snapshot, browser-click, browser-type, browser-scroll, browser-back, browser-press, browser-console, browser-inspect, web-guide, web-learn

**Search (1):** web-search

### Registered Commands

**Portal:** `/web on|off|learn|cookies|profile|status` — `/web on` (browsing only), `/web off` (all disabled), `/web learn` (browsing + guide-saving via web-learn), `/web cookies list|clear` (inspect/clear session cookies), `/web profile` (list/load profiles), `/web status` (backends + sessions + profiles), `/web` (show current state).

**Search:** `/searxng-status` — test the full SearXNG search pipeline and update the status bar glyph.

Toggle state is persisted via `pi.appendEntry("web-toggle-state", ...)` per-session branch, surviving `/reload`, `/resume`, `/fork`. Three-field schema: `{browserToolsEnabled, learnToolsEnabled, defaultProfile}`.

**Defaults for new sessions** are resolved by the `pi-tool-masking` library, not portal/search code: `initBrowserToggle` passes the packaged `ToolsetSpec` (with its own `defaultEnabled`) straight to `defineToolset`, and the library's restore reads the `toolsetDefaults` block from merged Pi settings (`~/.pi/agent/settings.json` + `.pi/settings.json`) before falling back to the packaged default. Keys: `toolset-state:pi-lean-dimension.web`, `toolset-state:pi-lean-dimension.web-learn`, `toolset-state:pi-lean-dimension.search` (search key only honored when `pi-lean-search` is installed). The legacy `browserToggle.defaultEnabled` key was **removed in 0.4.0** and is no longer read — the migration warning that bridged it is gone too.

The toggle also manages a `SIBLING_TOOL_NAMES` set populated with `"web-search"`. `/web on|off` operates on the union of `BROWSER_TOOL_NAMES ∪ SIBLING_TOOL_NAMES`. Discovery uses **exact-name `Set.has()` membership** — no regex, no false positives on third-party `web-*` tools.

## Testing

### Test split principle

**Subject under test** determines where a test lives, not *needs a browser*.

- **Portal structural tests** (`pi-lean-portal`): framework internals (router dispatch, registry, config loading, snapshot cache, nav-settle, storage state, accessibility parsing, url safety, plugin contract validation, browser toggle, fetch backend, python adapter). These are mocked unit tests — no real browser or MiniWoB content required.
- **Python bridge unit tests** (`pi-lean-portal/backends/python-base/tests/`): pure-logic pytest tests for the shared `pi_browser_bridge` library (accessibility, bot-detection, JSON-RPC transport, chromium-py/firefox-py routing, `PlaywrightBridge` stealth-quirk flags). Use fakes/mocks; the `playwright` import is lazily guarded, so they need only `pytest>=9.0` — no Playwright wheel, no browser binaries. Run via `npm run test:py-bridge`; wired into the `structural` CI job.
- **MiniWoB behavioral tests** (`bench/miniwob/suites/`): behavioral evaluation against real browser engines (MiniWoB tasks, browser interaction pipeline verification). These require a live browser and MiniWoB++ content.
- **Per-backend contract tests** (in `pi-lean-portal`): verify each backend (chromium, firefox, chromium-py, firefox-py, etc.) against the `BrowserPlugin` interface contract. Require their respective browser engine.

### Test file summary

| Category | Location | Files (~) | Tests (~) | Requires browser? |
|----------|----------|-----------|-----------|-------------------|
| Portal structural | `pi-lean-portal/__tests__/` | 22 | 700 | No |
| Python bridge unit | `pi-lean-portal/backends/python-base/tests/` | 6 | 248 | No (pytest only) |
| Portal contract/backend | `pi-lean-portal/__tests__/` | 8 | varies | Per-backend (auto-skip) |
| MiniWoB behavioral | `bench/miniwob/suites/` | 8 | 130 tasks × 4 + user-backends + smoke* | Chromium + Firefox + Python + MiniWoB content |
| Search | `pi-lean-search/` | 2 | 29 | No |

Per-file detail for the portal-owned test lists (structural, python bridge, per-backend contract, shared test utilities) lives in [`packages/pi-lean-portal/AGENTS.md`](packages/pi-lean-portal/AGENTS.md) ("Testing (portal detail)"). MiniWoB suite detail is in the MiniWoB Integration section below.

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

Plus the supporting suites: **`miniwob-user-backends.test.ts`** (discovers user-managed Python backends — no-op in bare CI; registers 130 tasks × discovered backends when installed), **`adapter-smoke.test.ts`** (end-to-end `runMiniwobTask` via real Chromium + `plugin.evaluate` episode lifecycle), **`inspect-csp-smoke.test.ts`** (`browser-inspect` CSP/eval-boundary smoke), and **`inspect-eval-smoke.test.ts`** (`browser-inspect` eval-path smoke).

- **13 tasks run** with trivial solvers — 3 confident (assert reward > 0)
  and 10 best-effort (pipeline smoke tests).
- **82 element tasks** without a registered solver → `it.skip` with reason
  `needs goal-aware solver`.
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
split into three jobs, two gated by inputs on
`workflow_dispatch` (both default to **off** so a bare manual
run only hits structural; push/PR always runs both
`structural` + `miniwob`):

**`structural` job (fast, no browser):**

1. **Checkout** the repository
2. **Setup Node.js 22** with npm caching
3. **Install dependencies** via `npm ci`
4. **Run structural tests** via `npm run test:ci`
5. **Setup Python 3.12** + install `pytest>=9.0`
6. **Run Python bridge unit tests** via `npm run test:py-bridge` (248 pure-logic pytest tests under `packages/pi-lean-portal/backends/python-base/tests/` — no Playwright wheel or browser binaries required)

**`miniwob` job (cross-engine browser tests, depends on structural):**

- On push/PR: always runs.
- On `workflow_dispatch`: runs only when the **miniwob** input
  is toggled on.

1. **Checkout** + **Setup Node.js 22** + `npm ci`
2. **Install Playwright Chromium** (drives Node chromium +
   chromium-py suites)
3. **Install Playwright Firefox** (drives Node firefox +
   firefox-py suites)
4. **Setup Python 3.12 + venv** with `playwright` pip package
   (drives chromium-py + firefox-py suites)
5. **Clone MiniWoB++ content** via `npm run setup:miniwob`
6. **Run all MiniWoB browser tests** via `npm run test:miniwob`
   (runs `bench/miniwob/suites/`, covering all 8 suite
   files)
7. **Upload test artifacts on failure** (vitest output, Playwright
   traces)

**Auto-skip gates:** Each per-backend suite file independently
auto-skips when its browser prerequisites are absent or MiniWoB++
content is unreachable. This keeps `npm test` and
`npm run test:ci` green in bare CI without path-filtering logic.

**`contributed` job (opt-in, Camoufox user-backends validation):**

`workflow_dispatch`-only — does NOT run on every PR. Trigger manually
from the Actions tab and toggle the **contributed** input on.
Depends on `structural` passing.

1. **Checkout** + **Setup Node.js 22** + `npm ci`
2. **Install Firefox system deps** via `npx playwright install-deps firefox`
3. **Setup Python 3.12 + user-backends venv** using the pinned
   versions in `packages/pi-lean-portal/contributed/camoufox-py/pin.json`
   (the CI workflow reads package + binary from that sidecar via `jq`;
   PyPI package pinned since Jul 14 2026, binary pinned to the current
   release after the quirks were adapted to ``152.0.4-beta.28`` — see
   `packages/pi-lean-portal/contributed/README.md`
   "Pinned CI stack" for the upgrade procedure)
4. **Copy Camoufox bridge template** and pin manifest from
   `packages/pi-lean-portal/contributed/camoufox-py/`
   (`bridge.py` + `pin.json`) into the user-backends tree
5. **Clone MiniWoB++ content** via `npm run setup:miniwob`
6. **Start MiniWoB static server** on port 8080
7. **Run Camoufox contract tests** + the
   `miniwob-user-backends.test.ts` suite (which discovers the
   installed Camoufox backend)
8. **Upload test artifacts on failure** (vitest output, Playwright traces)

**Manual trigger:** The workflow also supports `workflow_dispatch`
for re-running jobs from the Actions tab without pushing a new commit.
The **miniwob** and **contributed** inputs both default to **off**;
turn them on to run the respective jobs. When both are off, only
the `structural` job runs (fast, no browser required).

## TypeScript Quirks

- `noEmit: true` — source-only, no build step
- `exactOptionalPropertyTypes: true` — `undefined` in optional params triggers type errors; use `Type.Optional()` wrapper from `@earendil-works/pi-ai` for tool parameters
- `noUncheckedIndexedAccess: true` — all indexed accesses require null checks
- `module: "nodenext"` — imports need `.js` extensions in source files
- `isolatedModules: true` — each file treated as a separate module; cross-file type analysis limited
- `noUncheckedSideEffectImports: true` — side-effect imports must be used or suppressed
- `moduleDetection: "force"` — every file is a module (no global augmentations)
