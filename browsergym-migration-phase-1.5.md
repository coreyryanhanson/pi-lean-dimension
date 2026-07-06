# BrowserGym Migration — Phase 1.5 (Firefox + Python backend support)

> **Superseded** — see chat 2026-07-06 and `PLAN-browsergym-removal.md`. BrowserGym dropped as a runtime dependency due to playwright pin incompatibility.

> **Status:** Active implementation guide. Self-contained and definitive
> for Phase 1.5. Sits downstream of
> [`browsergym-migration-plan-v2.md`](browsergym-migration-plan-v2.md)
> (which completed Phase 1 — chromium Mode A via trivial solvers — and
> sketches Phase 1.5 as a condensed stub). This document replaces that
> stub with the full, decision-resolved plan.
> **Branch:** `refactor/seperate-host-module` (continues from Phase 1).

## Relationship to the v2 plan

Phase 1 (§1.0–1.9 of `browsergym-migration-plan-v2.md`) is **complete**.
It delivered:

- `pi-lean-host` package with `runMiniwobTask`, `benchPlugin`,
  `registerMiniwobSuite`, parser/solver helpers, public API in
  `src/index.ts`.
- Chromium Mode A: `--remote-debugging-port=0` + `ss -tlnp` /
  `CDP_PORT` discovery in
  `packages/pi-lean-portal/core/shared/cdp-endpoint.ts`, exposed via
  `ChromiumPlugin.getCdpEndpoint()`.
- Two optional `BrowserPlugin` interface methods: `getCdpEndpoint?()`
  (Mode A) and `connectOverCDP?(endpoint)` (Mode B).
- `BrowserGym` Python bridge (`adapter/browsergym-bridge.py`) with
  `miniwob.connect` / `listTasks` / `setup` / `validate` / `teardown`
  over JSON-RPC/stdio.
- 13 trivial solvers × chromium = 13 pass / 112 skip (matches the
  `13 + 77 + 35 = 125` task split).
- Two-job CI (`structural` + `miniwob`), dedicated `pi-lean-host/venv`
  cached on `requirements.txt` hash.

Phase 1.5 widens the bench matrix from **1 backend (chromium) to 4
shipped backends** (chromium, firefox, chromium-py, firefox-py) using
the **cross-process attach + two-venv** strategy settled below. Stealth
backends (`camoufox-py`, `invisible-py`) remain out of scope — they
register their own parity files via the public `registerMiniwobSuite`
API (see "Stealth backends" below).

## Goal

Run the existing 13 trivial-solver MiniWoB++ tasks against **firefox
(Node), chromium-py (Python), and firefox-py (Python)** backends
through the same `runMiniwobTask` / `benchPlugin` pipeline Phase 1
built for chromium — without changing the `@e`-ref accessibility
model, the trivial solvers, or the BrowserGym task/reward protocol.

**Acceptance target:** `npm run test:miniwob -w pi-lean-host` runs
13 trivial solvers × 4 backends = **52 pass** (or auto-skip per
backend availability). CI runs the expanded matrix green (or with
documented auto-skips) on a PR.

## Settled decisions (rules, not re-litigated)

| Rule | Choice |
|---|---|
| **Backends in scope** | All 4 shipped: `chromium` (done), `firefox`, `chromium-py`, `firefox-py`. Stealth backends out of scope. |
| **Attach strategy** | **Cross-process** for every backend. BrowserGym bridge (Python, in `pi-lean-host/venv`) attaches to the backend's browser via CDP (chromium family) or Playwright ws protocol (firefox family). No in-process Python-Playwright sharing. |
| **Venv layout** | **Two venvs.** `pi-lean-host/venv/` (browsergym-miniwob + its playwright pin) stays isolated. A new **portal-python venv** hosts `chromium-py`/`firefox-py` deps. The bridge never imports portal Python code; it attaches over the wire. |
| **Firefox attach mechanism** | `firefox.launchServer()` + Node-side `connect(wsEndpoint)` for the Node `firefox` plugin. `firefox-py` uses `browser_type.launch_server()` + `ws_endpoint` on the Python side. Both expose a new optional `getWsEndpoint?(): string \| null` iface method. The bridge connects via `playwright.firefox.connect(wsEndpoint)`. |
| **Chromium-py attach mechanism** | `chromium-py/bridge.py` launches with `--remote-debugging-port=0`. The TS `PythonPluginAdapter` reuses `resolveCdpEndpoint()` from `core/shared/cdp-endpoint.ts` and exposes `getCdpEndpoint()` on the adapter (the bridge subprocess is the one being scanned). No Python-side `ss` reimplementation. |
| **Interface additions** | One new optional method: `getWsEndpoint?(): string \| null` on `BrowserPlugin`. `getCdpEndpoint` and `getWsEndpoint` are mutually exclusive per backend (chromium-family → CDP, firefox-family → ws). `bench.ts` mode negotiation checks both. |
| **Bridge protocol** | Generalize `miniwob.connect({ cdpEndpoint })` to `miniwob.connect({ endpoint, kind: "cdp" \| "ws" })`. The bridge dispatches to `connect_over_cdp` (chromium) or `connect` (firefox) on the corresponding Playwright browser type. Backward-compatible: `cdpEndpoint` is accepted as a shorthand for `{ endpoint, kind: "cdp" }`. |
| **`@e`-ref invariant** | Unchanged. Only the backend plugin drives actions (Node plugin for `chromium`/`firefox`; Python bridge via `PythonPluginAdapter` for `chromium-py`/`firefox-py`). BrowserGym only runs `setup` / `validate`. |
| **Stealth backends** | Out of scope. `camoufox-py` / `invisible-py` register parity via the public `registerMiniwobSuite` API. The `invisible-py` Juggler ≤2-concurrent-context deadlock (see `pending-issues-invisible-py.md`) makes it incompatible with the bench loop's per-task context churn anyway — documented as a known constraint, not fixed here. |
| **`launchServer` lifecycle risk** | The v2 plan flags that `launchServer` changes the firefox lifecycle (server persists until explicitly closed). This is the single highest-risk change in Phase 1.5. Mitigation: feature-flagged behind a `BROWSER_FIREFOX_LAUNCH_SERVER` env var (default off) so existing firefox usage is unaffected until the host opts in. |
| **Python 3.13 incompatibility** | Carried forward from Phase 1: `greenlet==3.0.3` (browsergym's dep) crashes on 3.13. Both venvs accept `PI_LEAN_HOST_VENV_BASE_PYTHON` / `PI_LEAN_PORTAL_PY_VENV_BASE_PYTHON` to point at 3.10–3.12. |

## Architecture

### Cross-process attach (symmetric across all 4 backends)

Phase 1 confirmed that **two CDP clients on one Chromium** (Node
Playwright + Python Playwright) works with no `bid`/`@e`-ref leakage.
Phase 1.5 extends the same pattern to the other three backends. The
BrowserGym bridge is always a **separate Python process** in
`pi-lean-host/venv/`; it attaches to the backend's already-launched
browser over the wire.

```
┌──────────────────────────────┐      ┌──────────────────────────────┐
│  Backend plugin (drives DOM) │      │  BrowserGym bridge           │
│                              │      │  (pi-lean-host/venv)         │
│  chromium  (Node Playwright) │──CDP─│  playwright.chromium         │
│            --remote-debug    │      │   .connect_over_cdp(endpoint)│
│            ging-port=0       │      │                              │
│                              │      │                              │
│  firefox   (Node Playwright) │──ws──│  playwright.firefox          │
│            launchServer()    │      │   .connect(wsEndpoint)       │
│            + connect(ws)     │      │                              │
│                              │      │                              │
│  chromium-py (Py Playwright) │──CDP─│  playwright.chromium         │
│            --remote-debug    │      │   .connect_over_cdp(endpoint)│
│            ging-port=0       │      │                              │
│            (launched by      │      │                              │
│             bridge.py sub-   │      │                              │
│             process; TS      │      │                              │
│             adapter scans    │      │                              │
│             ss for the port) │      │                              │
│                              │      │                              │
│  firefox-py (Py Playwright)  │──ws──│  playwright.firefox          │
│            launch_server()   │      │   .connect(wsEndpoint)       │
│            + ws_endpoint     │      │                              │
└──────────────────────────────┘      └──────────────────────────────┘
            ▲                                       │
            │                                       │
            │   (backend drives click/type/         │
            │    scroll/...; bridge only runs       │
            │    setup + validate)                  │
            │                                       │
┌───────────┴───────────────────────────────────────┴──────────────┐
│  runMiniwobTask loop (browsergym-adapter.ts)                     │
│   snapshot → solver picks @e ref → plugin.click/type → validate  │
└──────────────────────────────────────────────────────────────────┘
```

**Invariant (generalized from Phase 1):** only the backend plugin
drives actions. The BrowserGym bridge only runs `setup` and `validate`.
This holds for Python backends too — the Python `bridge.py` (driven by
the TS `PythonPluginAdapter`) is "the backend plugin"; the BrowserGym
bridge is a *different* Python process that only attaches to read
rewards.

### Two-venv layout

```
packages/pi-lean-host/venv/         ← browsergym-miniwob==0.14.3 + playwright==1.44
                                      (Phase 1, unchanged)
                                      gitignored, cached on requirements.txt hash

packages/pi-lean-portal/venv-py/    ← NEW: portal-python venv
                                      playwright>=1.50 + python-base deps
                                      (drives chromium-py / firefox-py bridges)
                                      gitignored, cached on its own requirements hash
```

The two venvs never import each other's code. The BrowserGym bridge
attaches over CDP/ws — it doesn't care what Python launched the
browser.

### Episode lifecycle (unchanged from Phase 1, generalized)

```
1. Backend plugin: sessionStart → launchBrowser
   - chromium:     --remote-debugging-port=0 (done, Phase 1)
   - firefox:      launchServer() + connect(wsEndpoint) (Phase 1.5)
   - chromium-py:  bridge.py launches with --remote-debugging-port=0 (Phase 1.5)
   - firefox-py:   bridge.py uses launch_server() (Phase 1.5)
2. Test harness: spawn BrowserGym bridge subprocess under pi-lean-host/venv
3. Bridge: connect({ endpoint, kind }) — attach to the backend's browser
4. Bridge: MiniWoBTask(seed, base_url).setup(page) → { goal, info, episodeId }
5. Backend plugin: snapshot → @e-ref tree
6. Actor (trivial solver): picks @e ref, calls click/type/etc
7. Backend plugin: drives the page, auto-snapshots
8. Bridge: task.validate(page) → { reward, done, reason, info }
9. Repeat 5–8 until done OR episode_max_time
10. Test harness: assert reward > 0
```

## Implementation steps

### 2.1 Firefox (Node) — `launchServer` + wsEndpoint

**Files:**

- `packages/pi-lean-portal/backends/firefox/index.ts` — refactor
  `launchBrowser()` to `firefox.launchServer()` + `firefox.connect(wsEndpoint)`.
- `packages/pi-lean-portal/backends/playwright-base/playwright-plugin.ts` —
  generalize the lazy-init block to accept a `BrowserServer` lifecycle
  (the server persists until explicitly closed, unlike `launch()` which
  ties to the `Browser` lifetime).
- `packages/pi-lean-portal/core/plugin-api.ts` — add
  `getWsEndpoint?(): string | null` optional method.
- `packages/pi-lean-portal/__tests__/firefox.test.ts` — verify the
  refactor doesn't regress the existing firefox contract.

**Design:**

```ts
// backends/firefox/index.ts
export class FirefoxPlugin extends PlaywrightPluginBase {
 // ...
 private _browserServer: BrowserServer | null = null;
 private _wsEndpoint: string | null = null;

 protected async launchBrowser(): Promise<Browser> {
  // Feature-flagged: default off → unchanged firefox.launch() path.
  // Opt-in via BROWSER_FIREFOX_LAUNCH_SERVER=1 (host sets this).
  if (process.env.BROWSER_FIREFOX_LAUNCH_SERVER !== "1") {
   return firefox.launch({ headless: true });
  }
  this._browserServer = firefox.launchServer({ headless: true });
  this._wsEndpoint = this._browserServer.wsEndpoint();
  return firefox.connect(this._wsEndpoint);
 }

 /** Exposed for BrowserGym Mode A (ws variant). Null unless
  *  launchServer path is active. */
 getWsEndpoint(): string | null {
  return this._wsEndpoint;
 }

 protected async onBrowserLaunched(): Promise<void> {
  // No-op — wsEndpoint is captured synchronously in launchBrowser().
 }

 async cleanupAll(): Promise<void> {
  await super.cleanupAll();      // closes the connected Browser
  if (this._browserServer) {
   await this._browserServer.close().catch(() => {});
   this._browserServer = null;
   this._wsEndpoint = null;
  }
 }
}
```

**`PlaywrightPluginBase` changes:** the `disconnected` handler currently
sets `this._browser = null`. For the `launchServer` path, a disconnect
of the *connected Browser* does **not** close the server — the plugin
can `connect()` again. Wire a `_reconnectFirefox()` path gated on
`this._browserServer` being non-null. Default (non-launchServer)
backends are unaffected.

**Risk (called out by v2 plan):** `launchServer` changes the lifecycle.
The server persists across `Browser` disconnects until
`browserServer.close()`. `cleanupAll()` must close both. The
feature-flag default-off means the refactor is inert for normal portal
usage until the host opts in via the env var — existing firefox tests
run against the unchanged `launch()` path.

**Acceptance:** `firefox.test.ts` passes unchanged (default path); with
`BROWSER_FIREFOX_LAUNCH_SERVER=1`, `getWsEndpoint()` returns a
connectable ws:// URL and a second `playwright.firefox.connect()` from
the BrowserGym bridge succeeds.

### 2.2 chromium-py — CDP attach via TS-side port discovery

**Files:**

- `packages/pi-lean-portal/backends/chromium-py/bridge.py` — add
  `--remote-debugging-port=0` + `--remote-debugging-address=127.0.0.1`
  to `_launch_browser()` args.
- `packages/pi-lean-portal/backends/python-adapter.ts` — implement
  `getCdpEndpoint(): string | null` by calling
  `resolveCdpEndpoint({ processNames: ["chrome-headless", "chromium"] })`
  (reuses Phase 1's `core/shared/cdp-endpoint.ts`). Cache at first call.
  Reset to `null` when the bridge subprocess exits.
- `packages/pi-lean-portal/__tests__/python-adapter.test.ts` — add
  coverage for `getCdpEndpoint()` (mock the bridge subprocess + the
  `ss` scan; assert the adapter exposes the endpoint).

**Design notes:**

The `PythonPluginAdapter` already spawns `bridge.py` as a subprocess.
The Chromium that `bridge.py` launches is a child of that subprocess —
but `ss -tlnp` filters by process name (`chrome-headless` / `chromium`),
not by PID tree, so the scan finds it regardless of the parent. The
same `resolveCdpEndpoint` logic that powers the Node chromium plugin
works here unchanged.

`getCdpEndpoint()` on `PythonPluginAdapter` is synchronous-after-cache:
the first call (lazily, after the bridge reports browser-ready) runs
the `ss` scan once and caches. This mirrors the
`onBrowserLaunched()` → `_cdpEndpoint` pattern from Phase 1's
`PlaywrightPluginBase`, just driven from the TS adapter side instead of
a Node launch.

**Acceptance:** `python-adapter.test.ts` confirms `getCdpEndpoint()`
returns a `http://127.0.0.1:<port>` endpoint after the bridge launches;
a `playwright.chromium.connect_over_cdp()` from the BrowserGym bridge
succeeds against it.

### 2.3 firefox-py — `launch_server` + wsEndpoint

**Files:**

- `packages/pi-lean-portal/backends/firefox-py/bridge.py` — switch
  `_launch_browser()` from `self._pw.firefox.launch()` to
  `self._pw.firefox.launch_server()`, return the `BrowserServer`'s
  `ws_endpoint`, and expose a JSON-RPC method `get_ws_endpoint` so the
  TS adapter can read it.
- `packages/pi-lean-portal/backends/python-base/pi_browser_bridge/playwright_base.py`
  — add a `_browser_server` field + `do_get_ws_endpoint` handler + a
  `cleanupAll` path that closes the server. Gate on a
  `_use_launch_server: bool = False` subclass flag so `chromium-py` and
  the existing `firefox-py` (non-bench) path stay bit-identical.
- `packages/pi-lean-portal/backends/python-adapter.ts` — implement
  `getWsEndpoint(): string | null` that calls the bridge's
  `get_ws_endpoint` over JSON-RPC and caches.
- `packages/pi-lean-portal/__tests__/firefox-py.test.ts` — verify the
  refactor doesn't regress the existing firefox-py contract.

**Design notes:**

Python Playwright's `browser_type.launch_server()` returns a
`BrowserServer` with a `ws_endpoint` attribute. The backend's
`bridge.py` then does `self._pw.firefox.connect(ws_endpoint)` to get
its driving `Browser` — same pattern as the Node firefox plugin in §2.1.

The `_use_launch_server` flag keeps `chromium-py` (which uses plain
`launch()`) and the default `firefox-py` path unchanged. The host opts
in via a config flag passed to the bridge (e.g. `PI_BROWSER_USE_LAUNCH_SERVER=1`)
when running bench; normal portal usage is unaffected.

**Risk:** Same `launchServer` lifecycle concern as §2.1, on the Python
side. `playwright_base.py`'s cleanup path must close the
`BrowserServer` explicitly. The `_skip_networkidle` quirk from
`pending-issues-invisible-py.md` Part B is irrelevant here (vanilla
firefox-py, not the patched invisible binary) — no Juggler deadlock
risk.

**Acceptance:** `firefox-py.test.ts` passes unchanged (default path);
with the launch-server flag, `getWsEndpoint()` returns a connectable
ws:// URL and the BrowserGym bridge's `playwright.firefox.connect()`
succeeds.

### 2.4 Bridge generalization — `connect({ endpoint, kind })`

**Files:**

- `packages/pi-lean-host/adapter/browsergym-bridge.py` — generalize
  `miniwob.connect`. New signature:

  ```python
  miniwob.connect({ endpoint: str, kind: "cdp" | "ws" })
  ```

  Dispatch:
  - `kind == "cdp"` → `self._pw.chromium.connect_over_cdp(endpoint)`
  - `kind == "ws"`  → `self._pw.firefox.connect(endpoint)`
  Store the resulting `Browser` handle. **Backward compat:** accept
  the old `cdpEndpoint` key as shorthand for
  `{ endpoint: cdpEndpoint, kind: "cdp" }` so Phase 1's
  `browsergym-adapter.ts` keeps working unchanged until §2.5 wires the
  new shape through.
- `packages/pi-lean-host/adapter/browsergym-adapter.ts` — widen
  `RunMiniwobTaskOptions` with an `endpointKind: "cdp" | "ws"` field
  (default `"cdp"` for Phase 1 back-compat). The `_cdpEndpointOverride`
  field is renamed `_endpointOverride` (internal, underscore-prefixed —
  no external break). The adapter calls
  `miniwob.connect({ endpoint, kind })`.
- `packages/pi-lean-host/suites/adapter-smoke.test.ts` — unchanged
  (chromium / cdp path).

**Acceptance:** the existing `adapter-smoke.test.ts` (chromium / cdp)
still returns `rawReward > 0`. A new `adapter-smoke-firefox.test.ts`
exercises the `kind: "ws"` path against the Node `firefox` plugin with
`BROWSER_FIREFOX_LAUNCH_SERVER=1` and returns `rawReward > 0`.

### 2.5 `bench.ts` mode negotiation — recognize `getWsEndpoint`

**Files:**

- `packages/pi-lean-host/adapter/bench.ts` — `resolveMode()` grows a
  third check:

  ```ts
  function resolveMode(plugin: BrowserPlugin): BenchMode {
    if (typeof plugin.getCdpEndpoint === "function") return "plugin-owns-browser";
    if (typeof plugin.getWsEndpoint  === "function") return "plugin-owns-browser";
    if (typeof plugin.connectOverCDP === "function") return "host-owns-browser";
    throw new Error(/* ... */);
  }
  ```

  The Mode A path picks the endpoint kind based on which method the
  plugin implements: `getCdpEndpoint` → `kind: "cdp"`; `getWsEndpoint`
  → `kind: "ws"`. Pass `endpointKind` through to `runMiniwobTask`.
- `packages/pi-lean-host/adapter/browsergym-adapter.ts` — Mode A path
  reads `plugin.getCdpEndpoint?.()` *or* `plugin.getWsEndpoint?.()`
  depending on which exists, with the `typeof === "function"` guard
  (per the `exactOptionalPropertyTypes` rule from Phase 1).

**Acceptance:** `benchPlugin(new FirefoxPlugin(), { taskName: "click-test", solver, baseUrl })`
with `BROWSER_FIREFOX_LAUNCH_SERVER=1` returns `rawReward > 0` via the
ws path, no source changes required from the caller.

### 2.6 `registerMiniwobSuite` — 4-backend matrix

**Files:**

- `packages/pi-lean-host/solvers/register-suite.ts` — the existing
  `registerMiniwobSuite` already takes a `MiniwobBackend` with a
  `plugin` and `skipIf`. Phase 1.5 adds three more
  `registerMiniwobSuite` calls (one per backend) to the shipped
  `suites/miniwob-trivial.test.ts`, each with the right env-var /
  browser-available gate:

  ```ts
  registerMiniwobSuite({
    plugin: new FirefoxPlugin(),
    backendName: "firefox",
    skipIf: () => process.env.BROWSER_FIREFOX_LAUNCH_SERVER !== "1",
    getBaseUrl,
  });
  registerMiniwobSuite({
    plugin: new ChromiumPyPlugin(),   // via PythonPluginAdapter
    backendName: "chromium-py",
    skipIf: () => !venvAvailable("portal-python") || !browserInstalled("chromium"),
    getBaseUrl,
  });
  registerMiniwobSuite({
    plugin: new FirefoxPyPlugin(),
    backendName: "firefox-py",
    skipIf: () => !venvAvailable("portal-python") || !browserInstalled("firefox")
      || process.env.PI_BROWSER_USE_LAUNCH_SERVER !== "1",
    getBaseUrl,
  });
  ```

  Each `registerMiniwobSuite` call emits 125 `it` blocks (13 run + 112
  skip), so the file now produces `4 × 125 = 500` test entries.
- `packages/pi-lean-host/suites/miniwob-trivial.test.ts` — add the
  three new `describe` blocks.

**Auto-skip gates (silent, keeps `test:ci` green):**

- `firefox` (Node): skips unless `BROWSER_FIREFOX_LAUNCH_SERVER=1`.
- `chromium-py`: skips unless the portal-python venv exists AND
  Playwright Chromium is installed.
- `firefox-py`: skips unless the portal-python venv exists AND
  Playwright Firefox is installed AND
  `PI_BROWSER_USE_LAUNCH_SERVER=1`.

**Acceptance:** `npm run test:miniwob -w pi-lean-host` with all
prerequisites present runs `13 × 4 = 52` tasks; with no prerequisites
runs `0` (all skip). Matches the v2 plan's "52 pass (or auto-skip per
backend availability)".

### 2.7 Portal-python venv setup script

**Files:**

- `packages/pi-lean-portal/scripts/setup-venv-py.mjs` — **new.**
  Creates `packages/pi-lean-portal/venv-py/` from
  `packages/pi-lean-portal/backends/python-base/requirements.txt`
  (the existing portal-python pin) + `playwright install chromium
  firefox`. Accepts `PI_LEAN_PORTAL_PY_VENV_BASE_PYTHON` for 3.10–3.12
  (same 3.13 incompatibility note as Phase 1).
- `packages/pi-lean-portal/package.json` — add
  `"setup:venv-py": "node scripts/setup-venv-py.mjs"`.
- `packages/pi-lean-portal/.gitignore` — add `venv-py/`.
- Root `package.json` — add
  `"setup:venv-py": "npm run setup:venv-py -w pi-lean-portal"`.

**Acceptance:** `npm run setup:venv-py` is idempotent, creates a venv
that can spawn `chromium-py/bridge.py` and `firefox-py/bridge.py`, and
`playwright install` succeeds for both engines.

### 2.8 CI wiring — two venvs, expanded matrix

**File:** `.github/workflows/ci.yml`

The Phase 1 `miniwob` job installs only `pi-lean-host/venv` and runs
chromium-only. Phase 1.5 splits the `miniwob` job into a **matrix**
over `{ chromium, firefox, chromium-py, firefox-py }`, each cell
setting its env vars and installing its venv(s):

```yaml
miniwob:
  needs: structural
  strategy:
    fail-fast: false
    matrix:
      backend: [chromium, firefox, chromium-py, firefox-py]
  steps:
    - checkout
    - setup-node 22 + npm ci
    - install-playwright-browsers  # chromium + firefox
    - create-pi-lean-host-venv     # browsergym, cached on requirements.txt
    - if: matrix.backend == 'chromium-py' || matrix.backend == 'firefox-py'
      create-portal-python-venv    # cached on python-base/requirements.txt
    - env:
        chromium:     { }
        firefox:      { BROWSER_FIREFOX_LAUNCH_SERVER: "1" }
        chromium-py:  { PI_BROWSER_USE_LAUNCH_SERVER: "1" }   # no-op for chromium-py, harmless
        firefox-py:   { BROWSER_FIREFOX_LAUNCH_SERVER: "1", PI_BROWSER_USE_LAUNCH_SERVER: "1" }
      # actually set via a per-cell env map
    - run: npm run test:miniwob -w pi-lean-host -- --reporter=verbose
    - if: failure()
      uses: actions/upload-artifact  # traces + vitest output
```

**Notes:**

- `fail-fast: false` so one backend failing doesn't cancel the others.
- Each cell's auto-skip gate means a missing prerequisite skips
  silently — the matrix can safely include all 4 backends even on
  runners where, say, Firefox isn't installed; the cell will just skip.
- The portal-python venv is only created in the `chromium-py` /
  `firefox-py` cells (conditional step), keeping `chromium` / `firefox`
  cells fast.
- Path filter (from Phase 1's plan §1.8 nits): skip the whole `miniwob`
  job on PRs touching only `pi-lean-search` or docs (`*.md`). The
  auto-skip gates are the primary safety net; the path filter is a
  CI-cost optimization, not correctness.

**Acceptance:** CI runs the 4-cell matrix; each cell is green or
all-skip; venvs cached across runs; artifact upload fires on failure.

### 2.9 Docs + attribution

**Files:**

- `packages/pi-lean-host/README.md` — update the "Browser ownership
  modes" section: Mode A now covers both CDP (chromium family) and ws
  (firefox family); document `getWsEndpoint()` alongside
  `getCdpEndpoint()`; update the backend support table
  (chromium ✓ Phase 1, firefox ✓ Phase 1.5, chromium-py ✓ Phase 1.5,
  firefox-py ✓ Phase 1.5).
- `packages/pi-lean-host/AGENTS.md` — bump status to "Phase 1.5
  complete (4 shipped backends via cross-process attach)".
- `AGENTS.md` (monorepo root) — update the MiniWoB Integration section:
  13 trivial solvers × 4 backends = 52; note the two-venv CI layout;
  note the `BROWSER_FIREFOX_LAUNCH_SERVER` /
  `PI_BROWSER_USE_LAUNCH_SERVER` opt-in env vars.
- `browsergym-migration-plan-v2.md` — mark the "Phase 1.5 — Firefox +
  Python backend support (condensed)" section as superseded by this
  document.
- `packages/pi-lean-portal/AGENTS.md` — document the
  `launchServer` refactor + the feature-flag default-off, and the new
  `getWsEndpoint?()` iface method.
- `pending-issues-invisible-py.md` — add a note that the
  ≤2-concurrent-context Juggler deadlock is why stealth backends are
  excluded from the bench matrix (links here).

**Acceptance:** no stale "Phase 1.5 deferred" / "Phase 1.5 stretch"
language remains; the v2 plan's condensed Phase 1.5 section points here.

## Stealth backends (out of scope)

`camoufox-py` and `invisible-py` are **not** wired into the shipped
bench matrix. They register their own parity via the public
`registerMiniwobSuite` API — the same extension point any
third-party `BrowserPlugin` uses. The host package ships no
stealth-backend test files.

**Rationale:**

1. **Juggler ≤2-concurrent-context deadlock.** The patched
   invisible_playwright FF150 binary deadlocks on a third concurrent
   BrowserContext (see `pending-issues-invisible-py.md`'s "Deeper
   latent limitation"). The bench loop creates a fresh context per
   `runMiniwobTask` and the test runner may overlap tasks — incompatible.
2. **`removeDisplay()` execution-context bug.** The v2 plan's
   "camoufox-py execution-context bug (stealth Firefox destroys the
   context during `removeDisplay()`)" is the same class of patched-binary
   fragility. Resolving it is out of scope for Phase 1.5.
3. **User-owned parity is the designed extension point.** The
   `registerMiniwobSuite` public API + the user-owned parity test file
   template (Phase 1 §"User-plugin benchmarking") exist precisely for
   this. A stealth-backend owner runs:

   ```ts
   // invisible-py/__tests__/miniwob-parity.test.ts
   import { describe } from "vitest";
   import { registerMiniwobSuite } from "pi-lean-host";
   import { InvisiblePyBridge } from "../src/bridge.js";

   describe("invisible-py — MiniWoB parity (serial)", () => {
     // The owner is responsible for serial execution + the ≤2-context
     // constraint — e.g. a vitest `concurrent: false` project config.
     registerMiniwobSuite({
       plugin: /* InvisiblePyPlugin adapter */,
       backendName: "invisible-py",
       mode: "plugin-owns-browser",
       skipIf: () => !process.env.INVISIBLE_PY_AVAILABLE,
     });
   });
   ```

   Document the serial-execution requirement in the stealth backend's
   own README, not here.

The v2 plan's call to "resolve the camoufox-py execution-context bug"
is **deferred indefinitely** unless a stealth-backend owner picks it up
via the parity-file path and finds the bench loop's context churn
blocks them. Phase 1.5 documents the deferral; it doesn't fix it.

## Risks & open questions

| Risk | Mitigation |
|---|---|
| **Firefox `launchServer` lifecycle refactor** — the server persists until explicitly closed; a disconnect of the connected `Browser` doesn't close the server. Cleanup ordering bugs leak server processes. | Feature-flag default-off (`BROWSER_FIREFOX_LAUNCH_SERVER`). Existing firefox tests run the unchanged `launch()` path. The host opts in only for bench. `cleanupAll()` closes both `Browser` and `BrowserServer` in a finally chain. |
| **`getWsEndpoint` vs `getCdpEndpoint` naming** — two iface methods for "give me an endpoint to attach to" is slightly redundant; a single `getAttachEndpoint(): { endpoint: string; kind: "cdp" \| "ws" } \| null` would be cleaner. | Keep the two-method shape for Phase 1.5 (matches the v2 plan's "Expose `getWsEndpoint()` on the firefox plugin" wording, no churn to the Phase 1 `getCdpEndpoint` callers). Revisit as a refactor in a later phase if a third attach kind appears. |
| **`ss -tlnp` for chromium-py** — the scan finds Chromium by process name, but if the test runner has *both* the Node chromium plugin *and* chromium-py running simultaneously (e.g. parallel vitest workers), the scan could return the wrong port. | Run chromium-py in its own vitest worker / serial. The `registerMiniwobSuite` `skipIf` gate plus vitest's `concurrent: false` per-backend keeps the scans disjoint. Long-term: PID-tree filtering (find the chromium that's a child of the bridge.py subprocess). |
| **Playwright pin drift between venvs** — `pi-lean-host/venv` pins `playwright==1.44` (browsergym's dep); the new portal-python venv pins `playwright>=1.50`. The bridge attaches over CDP/ws — protocol-level compat, not API-level. A protocol break between 1.44 and 1.50+ would silently fail. | Two-venv isolation means the pins don't conflict *within* a venv. Cross-venv CDP/ws protocol compat is a Playwright upstream concern; the bridge's `ping` handshake surfaces a connect failure loudly. Re-pin browsergym when a new browsergym release supports a newer playwright. |
| **CI matrix cost** — 4 cells × (venv setup + browser install + 500 test entries) roughly quadruples the `miniwob` job time vs Phase 1. | Venv caching on requirements hash; the portal-python venv is only created in 2 of 4 cells; auto-skip gates mean cells with missing prereqs finish fast (all-skip). Path filter skips the whole job on doc-only PRs. |
| **`launchServer` + `connect()` reconnect semantics** — the v2 plan flags this as the highest-risk Phase 1.5 change. If the connected `Browser` disconnects (crash), the base class's `disconnected` handler currently nulls `_browser`. For launchServer, we want to `connect()` again, not relaunch. | The `PlaywrightPluginBase` `_reconnectFirefox()` path is gated on `_browserServer !== null`. Default (non-launchServer) backends never hit it. Add a firefox-specific reconnect test to `firefox.test.ts`. |

## File-level inventory

### New files (Phase 1.5)

- `packages/pi-lean-portal/scripts/setup-venv-py.mjs` — portal-python
  venv setup script.
- `packages/pi-lean-portal/venv-py/` (gitignored) — the venv itself.
- `packages/pi-lean-host/suites/adapter-smoke-firefox.test.ts` —
  ws-path smoke test (Node firefox + `BROWSER_FIREFOX_LAUNCH_SERVER=1`).

### Modified files

- `packages/pi-lean-portal/backends/firefox/index.ts` — `launchServer`
  - `connect(ws)` path behind `BROWSER_FIREFOX_LAUNCH_SERVER`;
  `getWsEndpoint()`; `cleanupAll` closes the server.
- `packages/pi-lean-portal/backends/playwright-base/playwright-plugin.ts`
  — `_reconnectFirefox()` path (gated on a `_browserServer` field the
  subclass sets); default behavior unchanged.
- `packages/pi-lean-portal/backends/chromium-py/bridge.py` —
  `--remote-debugging-port=0` + `--remote-debugging-address=127.0.0.1`
  in `_launch_browser()` args.
- `packages/pi-lean-portal/backends/firefox-py/bridge.py` —
  `launch_server()` path behind `_use_launch_server` flag;
  `get_ws_endpoint` JSON-RPC method.
- `packages/pi-lean-portal/backends/python-base/pi_browser_bridge/playwright_base.py`
  — `_browser_server` field; `_use_launch_server: bool = False`;
  `do_get_ws_endpoint` handler; cleanup closes the server.
- `packages/pi-lean-portal/backends/python-adapter.ts` —
  `getCdpEndpoint()` (chromium-py, via `resolveCdpEndpoint`) and
  `getWsEndpoint()` (firefox-py, via bridge JSON-RPC) implementations.
- `packages/pi-lean-portal/core/plugin-api.ts` — add
  `getWsEndpoint?(): string | null` optional method (documented
  `typeof === "function"` guard, same as `getCdpEndpoint`).
- `packages/pi-lean-portal/package.json` — `setup:venv-py` script.
- `packages/pi-lean-portal/.gitignore` — `venv-py/`.
- `packages/pi-lean-portal/__tests__/python-adapter.test.ts` —
  `getCdpEndpoint()` coverage.
- `packages/pi-lean-portal/__tests__/firefox-py.test.ts` —
  `launch_server` path coverage (default path unchanged).
- `packages/pi-lean-host/adapter/browsergym-bridge.py` — generalized
  `miniwob.connect({ endpoint, kind })`; backward-compat `cdpEndpoint`
  shorthand.
- `packages/pi-lean-host/adapter/browsergym-adapter.ts` —
  `endpointKind` option; `_endpointOverride` (renamed from
  `_cdpEndpointOverride`); Mode A reads `getCdpEndpoint` *or*
  `getWsEndpoint`.
- `packages/pi-lean-host/adapter/bench.ts` — `resolveMode` checks
  `getWsEndpoint`; Mode A picks `kind` based on which method exists.
- `packages/pi-lean-host/solvers/register-suite.ts` — no source
  change (the existing API already supports multiple backends); the
    change is in the test file that calls it.
- `packages/pi-lean-host/suites/miniwob-trivial.test.ts` — three new
  `describe` blocks (firefox, chromium-py, firefox-py).
- `packages/pi-lean-host/README.md` — backend support table + ws mode
  docs.
- `packages/pi-lean-host/AGENTS.md` — status bump.
- `AGENTS.md` (root) — MiniWoB integration section: 4 backends,
  two-venv CI, opt-in env vars.
- `browsergym-migration-plan-v2.md` — mark condensed Phase 1.5 section
  as superseded by this document.
- `packages/pi-lean-portal/AGENTS.md` — `launchServer` refactor +
  `getWsEndpoint` doc.
- `.github/workflows/ci.yml` — `miniwob` job → 4-cell matrix;
  portal-python venv step (conditional); `fail-fast: false`; env vars
  per cell; artifact upload on failure.
- `package.json` (root) — `setup:venv-py` redirect.

### Deleted files

(none)

### Kept unchanged

- `packages/pi-lean-portal/core/shared/cdp-endpoint.ts` — Phase 1's
  `resolveCdpEndpoint` is reused as-is by `python-adapter.ts`.
- `packages/pi-lean-host/adapter/browsergym-bridge.py`'s `setup` /
  `validate` / `teardown` / `listTasks` methods — Phase 1's
  task/reward protocol is backend-agnostic.
- `packages/pi-lean-host/solvers/trivial-solvers.ts` /
  `parser.ts` — the 13 solvers and `@e`-ref parser are
  backend-agnostic.
- All Phase 1 portal structural tests.

## Suggested batching

Mirroring Phase 1's 4-batch structure, Phase 1.5 lands cleanly as 4
review batches:

**Batch 1.5-A — Firefox (Node) `launchServer` refactor + `getWsEndpoint`
iface method.** Highest-risk change in isolation. Touches
`backends/firefox/index.ts`, `playwright-plugin.ts`, `plugin-api.ts`,
`firefox.test.ts`. Validates default-off behavior + opt-in ws path.
Acceptance: `firefox.test.ts` green; `benchPlugin(new FirefoxPlugin(),
…)` with `BROWSER_FIREFOX_LAUNCH_SERVER=1` returns `rawReward > 0`.

**Batch 1.5-B — chromium-py CDP attach + python-adapter `getCdpEndpoint`.**
Touch `chromium-py/bridge.py` (one-line args), `python-adapter.ts`,
`python-adapter.test.ts`. Reuses Phase 1's `resolveCdpEndpoint`.
Acceptance: `python-adapter.test.ts` green; bench against chromium-py
returns `rawReward > 0`.

**Batch 1.5-C — firefox-py `launch_server` + bridge generalization +
`bench.ts` ws negotiation.** Touch `firefox-py/bridge.py`,
`python-base/playwright_base.py`, `browsergym-bridge.py`
(`connect({ endpoint, kind })`), `browsergym-adapter.ts`
(`endpointKind`), `bench.ts` (`resolveMode` ws branch). Acceptance:
`adapter-smoke-firefox.test.ts` passes; `firefox-py.test.ts` green.

**Batch 1.5-D — Suite matrix, portal-python venv, CI, docs.** Touch
`miniwob-trivial.test.ts` (3 new describes), `setup-venv-py.mjs`,
`.github/workflows/ci.yml`, README/AGENTS updates. Acceptance: full
4-backend matrix green (or auto-skip) locally and in CI; venvs cached.

## Acceptance (full Phase 1.5)

- `npm run test:miniwob -w pi-lean-host` runs 13 trivial solvers × 4
  backends = **52 pass** (or auto-skip per backend availability).
- `npm run test:ci` unchanged (709+ structural tests, no regressions
  from the `plugin-api.ts` / `playwright-plugin.ts` / `python-base`
  edits — default-off feature flags keep shipped paths bit-identical).
- CI runs the 4-cell `miniwob` matrix green (or all-skip per cell);
  venvs cached; artifacts upload on failure.
- `benchPlugin` auto-detects the attach kind (CDP vs ws) from which
  optional method the plugin implements — no caller changes needed
  vs Phase 1's CDP-only API.
- No stale "Phase 1.5 deferred" / "Phase 1.5 stretch" language in any
  tracked doc; the v2 plan's condensed Phase 1.5 section points here.
