# BrowserGym Migration Plan v2 — Option C implementation guide

> **Superseded** — see chat 2026-07-06 and `PLAN-browsergym-removal.md`. BrowserGym dropped as a runtime dependency due to playwright pin incompatibility.

> **Status:** Active implementation guide. supersedes
> [`browsergym-migration-plan.md`](browsergym-migration-plan.md) for
> implementation guidance; the original is retained as decision history.
> **Completed:** §1.0 CDP endpoint spike, §1.1 `pi-lean-host` scaffold +
> npm namespace reservation (`pi-lean-host@0.0.1` published).
> **Spike findings:** [`packages/pi-lean-host/docs/cdp-endpoint-spike.md`](packages/pi-lean-host/docs/cdp-endpoint-spike.md).
> **Branch:** `cleanup/use-benchmarking-libraries`.

## Goal

Depend on `browsergym[miniwob]` as a dev-only Python dependency for the
task table, episode setup, and reward protocol — while keeping our own
`@e`-ref accessibility snapshot and `BrowserPlugin` action layer
untouched. BrowserGym never marks the DOM (no `bid` injection); we use
it purely as a task/reward source. Our plugin drives the page and takes
its own snapshots.

This deletes ~1285 lines of ported code in `helpers/miniwob.ts` and
unlocks the WebArena / WorkArena / VisualWebArena upgrade path by
changing one `pip install` extra instead of doing another full manual
port.

## Settled decisions (rules, not re-litigated)

| Rule | Choice |
|---|---|
| Python venv | Dedicated `browsergym` venv at `packages/pi-lean-host/venv/` (gitignored). Isolates `gymnasium` + `numpy` + `browsergym`'s own `playwright` pin from the existing `chromium-py`/`firefox-py` venv. |
| Phase 1 backends | Chromium-first (Node). Firefox needs a `launchServer` refactor → Phase 1.5. Python backends → Phase 1.5. |
| Host package | `pi-lean-host` in the monorepo. Consumer of `pi-lean-portal`, not a test of it. Acyclic dep: `pi-lean-host` → `pi-lean-portal`. **Not** in the `pi-lean-dimension` umbrella meta-package. **Not** lockstep — independent versioning. |
| Test split criterion | *Subject under test*, not *needs a browser*. Behavioral evaluation (MiniWoB, WebArena, custom tasks, agent benchmarking) → `pi-lean-host`. Framework-internals (router, registry, snapshot cache, strict-mode locators, nav-settle logic) → `pi-lean-portal` as mocked unit tests. |
| Behavioral test policy | From Phase 4 onward: no new hand-rolled HTML fixtures in portal or host. New behavioral concerns go into the custom BrowserGym task package (Phase 4, separate repo). |
| User-plugin benchmarking | First-class from Phase 1. `pi-lean-host` exports a public `benchPlugin` API; any `BrowserPlugin` can be benched without modifying host source. |
| Versioning | Stay on `0.x.x` for the migration release. `pi-lean-host` is excluded from lockstep and stays on independent `0.x` versioning. |
| CDP endpoint mechanism | `--remote-debugging-port=0` + `ss -tlnp` process-name filtering (Linux), with a `CDP_PORT` env var fallback for non-Linux. **Playwright Node 1.61 does not expose `browser.process()`** — see spike findings. |

## Architecture

### What BrowserGym owns (we import, not port)

From `browsergym[miniwob]` (Python, Apache-2.0, ServiceNow):

1. **The 125 task classes** — `browsergym.miniwob.ALL_MINIWOB_TASKS`, each
   with a `subdomain` attribute. We iterate this list; we do not
   transcribe it. → deletes the ~520-line ported task table.
2. **`MiniWoBTask.setup(page)`** — does `page.goto(url)`, injects the
   `remove_human_display` JS block, calls `seedrandom` +
   `startEpisodeReal`, waits for `WOB_TASK_READY`. → deletes the ~80-line
   `MINIWOB_SETUP_JS` constant.
3. **`MiniWoBTask.validate(page)`** — reads `WOB_REWARD_GLOBAL`,
   `WOB_RAW_REWARD_GLOBAL`, `WOB_REWARD_REASON`, `WOB_DONE_GLOBAL`,
   `WOB_EPISODE_ID`, `WOB_TASK_READY`; returns `(reward, done, msg,
   info)`. → deletes the reward-reading + driver glue.

### What we keep (ours, unchanged)

1. **The `@e`-ref accessibility snapshot** — `core/shared/accessibility-tree.ts`
   parses `page.ariaSnapshot()` into `@e1, @e2, ...` refs. Zero contact
   with BrowserGym's `bid` model. BrowserGym's `observation.py` /
   `_pre_extract` (the `bid` stamping) is never called.
2. **The `BrowserPlugin` action layer** — `click(ref)`, `type(ref, text)`,
   `scroll`, `press`, `goBack`, `snapshot`. BrowserGym's
   `action/functions.py` (`click(bid)`, `fill(bid, val)`) is never
   called. Our plugin drives the page; BrowserGym only sets up the task
   and reads the reward.
3. **The solver/registry harness** — `helpers/miniwob-suite.ts` (solvers,
   `@e`-ref line parser, `registerMiniwobSuite`, backend gates). Our
   test logic; BrowserGym doesn't provide solvers. Moves to
   `pi-lean-host/solvers/` (§1.5).
4. **The `miniwob-plusplus` HTML checkout + HTTP server** —
   `scripts/setup-miniwob.mjs`. Owned by the Farama `miniwob-plusplus`
   repo. We clone it at pin `7fd85d71` and serve it over HTTP. Moves to
   `pi-lean-host/scripts/` (§1.7).

### Cross-process page sharing (spike-confirmed)

BrowserGym's `MiniWoBTask.setup(page)` expects a
`playwright.sync_api.Page`. Our chromium plugin owns a Node Playwright
page. The Python adapter attaches to our Node-launched browser via CDP.

**Chromium (Phase 1):** Node plugin launches with
`--remote-debugging-port=0` (OS-assigned free port). Port discovery via
`ss -tlnp` filtered by process name (`chrome-headless` / `chromium`),
extracting the port from `127.0.0.1:<port>`. Fallback: `CDP_PORT` env
var for non-Linux. Python adapter does
`playwright.chromium.connect_over_cdp("http://127.0.0.1:<port>")`,
enumerates `browser.contexts` → `context.pages`, finds the active page,
calls `task.setup(page)` / `task.validate(page)`. Our Node plugin
continues to drive the same page via its own Playwright connection.

**Spike-confirmed facts** (see
[`packages/pi-lean-host/docs/cdp-endpoint-spike.md`](packages/pi-lean-host/docs/cdp-endpoint-spike.md)):

- `--remote-debugging-port=0` works; the OS assigns a free port.
- `ss -tlnp` with process-name filtering finds it reliably on Linux.
- Playwright Node 1.61 does **not** expose `browser.process()` — port
  discovery must go through an external mechanism (`ss`, `lsof`,
  `/proc`) or a fixed env-var-resolved port.
- Two CDP clients on one Chromium is a standard feature — no
  interleaving issues, no `bid`/`@e`-ref leakage in `ariaSnapshot()`
  after Python `setup(page)` runs.
- Python `connect_over_cdp` finds the active page by iterating
  `browser.contexts` → `context.pages`.

**Firefox (Phase 1.5):** No CDP. Cross-process attach is
`browserType.launchServer()` + `connect(wsEndpoint)` (Playwright server
protocol). Requires the firefox plugin to switch from `firefox.launch()`
to `firefox.launchServer()` + Node-side `connect()` — flagged as a
Phase 1.5 risk.

**Python backends (Phase 1.5):** `chromium-py`/`firefox-py` already run
a Python Playwright. The BrowserGym adapter (also Python) could share
the same Playwright instance or attach via the same mechanisms above.
The camoufox-py execution-context bug needs separate resolution.

### Episode lifecycle

```
1. Node plugin: sessionStart → launchBrowser (chromium, CDP port exposed)
2. Test harness: spawn Python adapter subprocess, pass CDP endpoint
3. Python adapter: connect_over_cdp, find active page
4. Python adapter: MiniWoBTask(seed, base_url).setup(page) → {goal, info}
5. Node plugin: snapshot → @e-ref tree
6. Actor (trivial solver OR Pi agent): picks @e ref, calls click/type/etc
7. Node plugin: drives the page, auto-snapshots
8. Python adapter: task.validate(page) → {reward, done, reason, info}
9. Repeat 5–8 until done OR episode_max_time
10. Test harness: assert reward > 0 (trivial solvers) OR record metrics (agent)
```

**Invariant:** only the Node plugin drives actions; the Python adapter
only runs `setup` and `validate`. This keeps the `@e`-ref model
authoritative and avoids any `bid`/`@e` vocabulary collision.

## Package layout

### Already scaffolded (§1.1, complete)

```
packages/pi-lean-host/
├── package.json          (name: pi-lean-host, version: 0.0.1, public, NOT lockstep)
├── README.md             (placeholder — "future pi-lean-portal browser benchmarking suite")
├── AGENTS.md             (stub → monorepo AGENTS.md)
├── requirements.txt      (placeholder for browsergym[miniwob] + playwright pins)
└── docs/
    └── cdp-endpoint-spike.md   (§1.0 spike findings)
```

Root `package.json` `test:ci` already excludes `**/pi-lean-host/**`.
Root `package.json` `workspaces` glob `packages/*` picks host up
automatically.

### To build in Phase 1 (§1.2–1.9)

```
packages/pi-lean-host/
├── src/
│   └── index.ts                  (public API entry point — exports benchPlugin, runMiniwobTask, registerMiniwobSuite, parser/solver helpers)
├── adapter/
│   ├── browsergym-bridge.py      (~150 lines) JSON-RPC server: setup/validate via browsergym.miniwob
│   ├── browsergym-adapter.ts     (~120 lines) TS wrapper: spawns bridge, exposes runMiniwobTask() (Mode A + Mode B)
│   └── bench.ts                  (~80 lines) high-level benchPlugin() entry: mode negotiation, task list, result aggregation
├── solvers/
│   ├── trivial-solvers.ts        (moved from portal helpers/miniwob-suite.ts — the 13 hardcoded solvers)
│   ├── parser.ts                 (moved — @e-ref line parser, withRole, etc.)
│   └── register-suite.ts         (moved — registerMiniwobSuite, backend gates; documented extension point for user plugins)
├── suites/
│   ├── miniwob-trivial.test.ts   (pipeline smoke — 13 tasks × backends, asserts reward > 0; uses public benchPlugin API)
│   └── miniwob-helper.test.ts    (~40 lines — adapter smoke: spawns, setup returns goal, validate returns reward)
├── scripts/
│   └── setup-miniwob.mjs         (moved from repo root — clones miniwob-plusplus at pin)
├── venv/                         (gitignored — dedicated browsergym venv, created by setup:venv)
└── results/                      (gitignored — benchmark run outputs, Phase 2+)
```

**Depends on (workspace):** `pi-lean-portal` (for `BrowserPlugin` types

- plugin constructors), `pi-lean-search` (if host varies search tool
presence in Phase 2).

**Depends on (external, dev-only):** `browsergym[miniwob]` (Python, in
the dedicated venv), Pi SDK (Node, for Phase 2 agent spawning),
`vitest` (test runner).

### What `pi-lean-portal` loses

Deleted from `packages/pi-lean-portal/__tests__/`:

- `helpers/miniwob.ts` (~1285 lines) — ported task table + setup JS + reward protocol + driver
- `helpers/miniwob-suite.ts` (~455 lines) — solvers, parser, registry
- `miniwob.test.ts` (~300 lines) — backend wiring
- `miniwob-helper.test.ts` (~156 lines) — structural guards on the ported table
- `miniwob-spike-findings.md` — moves to `pi-lean-host/docs/` (historical reference)
- `camoufox-py.test.ts`, `camoufox-py-persistence.test.ts` (unfinished user-backend plugin tests — rebuilt post-migration as user-owned parity files via the `pi-lean-host` public API)
- `invisible-py.test.ts`, `invisible-py-persistence.test.ts` (same rationale)

**Kept** in `pi-lean-portal/__tests__/`:

- All structural tests (router-dispatch, plugin-registry, plugin-config, snapshot-cache, browser-inspect, web-guides, url-safety, nav-settle, storage-state, accessibility-tree, browser-toggle*, browser-status, plugin-loading, fetch-backend, python-adapter)
- Per-backend contract tests (chromium-py, firefox, firefox-py, cookie-persistence, reddit-dialog) — these test framework concerns (dialog stacking, async dialogs, nav-settle, strict-mode) that MiniWoB's trivial solvers don't exercise
- `helpers/plugin-contract.ts`, `helpers/reddit-fixture.ts`, `helpers/test-server.ts`, `helpers/mock-plugin.ts`, `helpers/mock-python-bridge.py`

### Repo-root cleanup

- `automate-testing.md` (171 lines) — **delete.** Research/chat notes accidentally committed; attribution lives in the adapter header.
- `miniwob-integration-plan.md` — **keep as historical reference.** Add a header note: "Option D (port-everything) was implemented and then retired in favor of Option C. See `browsergym-migration-plan-v2.md`. Kept for spike-findings reference."
- `pending-issues-invisible-py.md`, `reports/` (untracked) — leave untracked.
- `spike/cdp-endpoint-spike.mjs`, `spike/cdp-bridge.py` — **delete.** Throwaway spike scripts; findings are recorded in `packages/pi-lean-host/docs/cdp-endpoint-spike.md`.

## Phase 1 — Option C migration (§1.2–1.9)

> §1.0 (CDP spike) and §1.1 (scaffold + namespace) are complete. The
> steps below are the remaining actionable implementation work.

### 1.2 BrowserGym Python adapter (`adapter/browsergym-bridge.py`, ~150 lines)

A JSON-RPC-over-stdio server, modeled on the existing
`backends/python-base/pi_browser_bridge/` pattern. Methods:

- `miniwob.connect({ cdpEndpoint })` — `playwright.chromium.connect_over_cdp(...)`, store the browser handle.
- `miniwob.listTasks()` → returns the 125 task names from `ALL_MINIWOB_TASKS` (one-time call at harness init; lets the TS side build the test matrix without porting the table).
- `miniwob.setup({ taskName, seed, baseUrl })` — instantiate the task class by name, find the active page on the connected browser (iterate `browser.contexts` → `context.pages`), call `task.setup(page)`, return `{ goal, info, episodeId }`.
- `miniwob.validate()` — call `task.validate(page)` on the stored task/page, return `{ reward, done, reason, info }`.
- `miniwob.teardown()` — `task.teardown()`, release handles.

Attribution header (Apache-2.0, ServiceNow BrowserGym, Farama MiniWoB++, commit pin `miniwob-plusplus@7fd85d71`).

**Dedicated venv:** `npm run setup:venv -w pi-lean-host` creates
`packages/pi-lean-host/venv/` with `pip install -r requirements.txt`
(pinned `browsergym[miniwob]` + `playwright`). The adapter spawns under
this venv's Python.

**Acceptance:** `python adapter/browsergym-bridge.py` starts, responds
to `miniwob.listTasks` with 125 entries, handles `miniwob.connect`
against a manually-launched chromium with `--remote-debugging-port`.

### 1.3 TS wrapper + CDP attach (`adapter/browsergym-adapter.ts`, ~120 lines)

Modeled on `backends/python-adapter.ts` (JSON-RPC client). Exposes:

```ts
export async function runMiniwobTask(opts: {
  plugin: BrowserPlugin;
  taskName: string;
  seed: number;
  baseUrl: string;          // MINIWOB_URL
  actor: "trivial" | { type: "pi"; config: PiAgentConfig };  // Phase 1: "trivial" only
  solver?: trivialSolver;   // for actor: "trivial"
  maxSteps?: number;
  episodeMaxTimeMs?: number;
}): Promise<{ reward: number; rawReward: number; done: boolean; reason: string; steps: number; goal: string }>;
```

Responsibilities:

1. Read the CDP endpoint from the plugin's launched browser (via the `getCdpEndpoint()` method added in §1.4).
2. Spawn the Python adapter subprocess under the dedicated venv, call `connect`, `setup`.
3. Loop: `plugin.snapshot()` → actor picks `@e` ref → `plugin.click/type/...` → `validate` → repeat until `done` or `maxSteps`.
4. Return reward + metrics.

**Acceptance:** `runMiniwobTask` against `click-button` with the trivial
"click first button" solver returns `rawReward > 0`.

### 1.4 Expose CDP endpoint from the chromium plugin

The chromium plugin currently launches via `chromium.launch({ args: [...] })`
with no debugging port. To let the Python adapter attach:

- Add `--remote-debugging-port=0` to the launch args (port 0 → OS-assigned free port). **Port discovery mechanism is spike-confirmed:** `ss -tlnp` filtered by process name (`chrome-headless` / `chromium`), extracting the port from `127.0.0.1:<port>`. Cache the result at lazy-init so the scan runs once. Fallback for non-Linux: read a `CDP_PORT` env var (fixed port per test run; parallel CI matrix cells need distinct slots).
- Add an optional `getCdpEndpoint(): string | null` method to `BrowserPlugin` (`core/plugin-api.ts`). Chromium returns the endpoint; firefox returns `null` until Phase 1.5; Python backends return `null` in Phase 1. Both optional-method additions (`getCdpEndpoint` + `connectOverCDP` for user plugins) are documented in "User-plugin benchmarking" below.

**Risk:** This is the one place Phase 1 touches the shipped
`pi-lean-portal` code. Keep the change minimal and gated so non-host
usage is unaffected (the `--remote-debugging-port` arg is harmless for
normal portal use; it just opens a debug port).

**Acceptance:** Chromium plugin launches with a readable CDP endpoint;
existing portal tests still pass (`test:ci` unchanged).

### 1.5 Move solvers + suite harness

Move from `pi-lean-portal/__tests__/helpers/` to `pi-lean-host/solvers/`:

- `miniwob-suite.ts` → split into `parser.ts`, `trivial-solvers.ts`, `register-suite.ts`.
- Apply the reviewer's cleanup findings:
  - **Tighten `withRole`** to match only the role segment of the snapshot line (not inside quoted accessible names). Anchor the regex to the segment before the first `"` so a goal like `button "click the button"` doesn't match `button` inside the quoted name.
  - **Remove the speculative `knownIssue` field** (no shipped backend uses it; re-add when a backend needs it).
  - **Document `registerMiniwobSuite`** as the extension point for user-owned parity test files (see "User-plugin benchmarking").

**Acceptance:** `registerMiniwobSuite` registers the 13 trivial-solver
tasks against a mock plugin and the suite structure matches the current
shape.

### 1.6 Move + slim the test files

- `miniwob.test.ts` → `pi-lean-host/suites/miniwob-trivial.test.ts`. Backend gates: chromium (confident), firefox (Phase 1 stretch — skip if no `launchServer` support), chromium-py/firefox-py (skip, Phase 1.5).
- `miniwob-helper.test.ts` → `pi-lean-host/suites/miniwob-helper.test.ts`, slimmed from 156 → ~40 lines. No ported task table to lock; tests become "adapter spawns, `listTasks` returns 125, `setup` returns a goal, `validate` returns reward against a mock."

**Acceptance:** `npm run test:miniwob -w pi-lean-host` runs 13
trivial-solver tests × chromium = 13 pass (or skip if browser absent),
77 element tasks skipped with `needs goal-aware solver`, 35 non-element
tasks skipped with missing-tool reasons. (`13 + 77 + 35 = 125`,
matching the AGENTS.md task split: 3 confident + 10 best-effort run, 77
element tasks lack a solver, 35 non-element tasks lack the tool.)

### 1.7 Move + keep the setup script

- `scripts/setup-miniwob.mjs` → `packages/pi-lean-host/scripts/setup-miniwob.mjs`.
- Apply the reviewer's hardening:
  - In the `.git` exists branch, also verify `miniwob/html/` is present; re-clone/repair if absent.
  - Verify the checked-out commit matches `PINNED_COMMIT`; warn on drift.
- Add `npm run setup:venv -w pi-lean-host` (creates the dedicated venv from `requirements.txt`).
- Root `package.json` scripts: `setup:miniwob` → `npm run setup:miniwob -w pi-lean-host`; `test:miniwob` → `npm run test:miniwob -w pi-lean-host`.

**Acceptance:** `npm run setup:miniwob` is idempotent across re-runs,
verifies `html/` presence + pinned commit, and the venv setup is one
command.

### 1.8 CI wiring

Update `.github/workflows/ci.yml`:

- **New step in the `test` job (after Playwright browser install):** create the dedicated venv and `pip install -r packages/pi-lean-host/requirements.txt`. Cache the venv on `requirements.txt` hash.
- **Run host tests:** `npm run test:miniwob -w pi-lean-host` after `test:ci`.
- **Apply reviewer's CI nits:** add `fail-fast: false` to the test matrix; add a test-report/trace upload-on-failure step; add a path filter so MiniWoB doesn't run on PRs that touch only `pi-lean-search` or docs.
- **Python-backend skip:** chromium-py/firefox-py auto-skip in Phase 1 (no venv-with-browsergym-and-portal-py-backends setup yet). Phase 1.5 wires that.

**Acceptance:** CI runs `test:ci` (structural, portal) then
`test:miniwob` (host, chromium-only) green on a PR; venv cached across
runs.

### 1.9 Docs + attribution

- `pi-lean-host/README.md` — replace placeholder with setup, usage, architecture (one paragraph: "BrowserGym is the task/reward source; our plugin drives; CDP attach shares the page; `@e` refs untouched"), and the "Benchmarking your own BrowserPlugin" guide (see "User-plugin benchmarking").
- `pi-lean-host/adapter/browsergym-bridge.py` header — Apache-2.0 attribution to BrowserGym (ServiceNow) + MiniWoB++ (Farama), commit pin `miniwob-plusplus@7fd85d71`, `browsergym` PyPI version pin.
- Monorepo `AGENTS.md` — update the testing section: portal structural tests stay in `pi-lean-portal`; MiniWoB behavioral tests move to `pi-lean-host`; note the dedicated venv + `setup:venv` step.
- `miniwob-integration-plan.md` — add header note pointing here as the active direction.
- `automate-testing.md` — **delete** (per repo-root cleanup).
- `spike/cdp-endpoint-spike.mjs`, `spike/cdp-bridge.py` — **delete** (throwaway; findings recorded in `pi-lean-host/docs/`).

**Acceptance:** No stale references to `automate-testing.md`, the old
`helpers/miniwob.ts` paths, or the `spike/` scripts remain in tracked
files.

## User-plugin benchmarking (Phase 1, first-class)

A user who writes a custom `BrowserPlugin` (WebKit, stealth browser,
alternative automation framework, research prototype) can run it
against our MiniWoB / WebArena / agent-benchmark suites without
modifying `pi-lean-host` source.

### Public API surface

`pi-lean-host` exports a documented library API from `src/index.ts`:

```ts
export { runMiniwobTask } from "./adapter/browsergym-adapter.ts";
export { registerMiniwobSuite } from "./solvers/register-suite.ts";
export { trivialSolvers, withRole, parseSnapshotLine } from "./solvers/";
export { benchPlugin } from "./adapter/bench.ts";
export type { BenchResult, BenchOpts } from "./adapter/bench.ts";
```

The internal test suites (`suites/miniwob-trivial.test.ts`, etc.) are
thin consumers of this API — they call `benchPlugin(chromiumPlugin, ...)`
the same way an external user would.

### Two browser-ownership modes

**Mode A — plugin-owns-browser (default for our backends).** The plugin
launches its own browser and exposes `getCdpEndpoint(): string | null`.
`pi-lean-host` passes that endpoint to the BrowserGym adapter, which
attaches via `connect_over_cdp`. Used by: `chromium` (Phase 1), `firefox`
(Phase 1.5 via `launchServer` + wsEndpoint), `chromium-py` / `firefox-py`
(Phase 1.5). Tests the plugin's real launch path.

**Mode B — host-owns-browser (for user plugins that can't or won't
launch their own).** `pi-lean-host` launches a reference chromium with
`--remote-debugging-port`, BrowserGym attaches via CDP, and the **user
plugin connects to the same endpoint** via `connectOverCDP(endpoint)`.
The plugin implements an optional `connectOverCDP(endpoint: string):
Promise<void>` method instead of (or in addition to) `launchBrowser()`.
Doesn't test the plugin's launch path — only its
snapshot/click/type/etc. methods.

`benchPlugin(plugin, taskName, opts)` takes a `mode:
"plugin-owns-browser" | "host-owns-browser"` option and wires the
appropriate page-sharing path.

### `BrowserPlugin` interface additions

Phase 1 adds two optional methods to `BrowserPlugin`
(`core/plugin-api.ts`). Both default to absent so existing plugins and
tests are unaffected:

```ts
export interface BrowserPlugin {
  // ... existing 18 required + 1 optional methods ...

  /** CDP/ws endpoint for BrowserGym to attach (Mode A). null if the
   *  plugin doesn't expose one (host will use Mode B or skip). */
  getCdpEndpoint?(): string | null;

  /** Connect to an externally-launched browser (Mode B). Plugins that
   *  implement this can be benched without launching their own browser. */
  connectOverCDP?(endpoint: string): Promise<void>;
}
```

**Caller guard note (`exactOptionalPropertyTypes: true`):** host-side
callers must guard with `typeof plugin.getCdpEndpoint === "function"`
(and likewise for `connectOverCDP`) — **not** a truthiness check like
`if (plugin.getCdpEndpoint)`. The `benchPlugin` mode negotiation uses
the `typeof === "function"` guard and the README's "Benchmarking your
own BrowserPlugin" section shows the same idiom.

### User-owned parity test file template

```ts
// my-browser-plugin/__tests__/miniwob-parity.test.ts
import { describe } from "vitest";
import { registerMiniwobSuite } from "pi-lean-host";
import { MyWebKitPlugin } from "../src/index.ts";

describe("MyWebKitPlugin — MiniWoB parity", () => {
  registerMiniwobSuite({
    plugin: new MyWebKitPlugin(),
    backendName: "my-webkit",
    mode: "host-owns-browser",  // MyWebKitPlugin implements connectOverCDP
    skipIf: () => !process.env.MY_WEBKIT_AVAILABLE,
  });
});
```

`pi-lean-host/README.md` includes this template plus how to interpret
the 125-task matrix output (what the skip reasons mean, what counts as
a pass).

### Acceptance (Phase 1 user-plugin)

- `pi-lean-host` exports `benchPlugin`, `runMiniwobTask`,
  `registerMiniwobSuite`, and the parser/solver helpers from a
  documented `src/index.ts`.
- A mock plugin implementing only `connectOverCDP` (Mode B) can be
  benched against `click-button` and returns a reward.
- The shipped `miniwob-trivial.test.ts` uses `benchPlugin` (not a
  private code path) — proving the public API is the same API the
  shipped tests use.

## Phase 1.5 — Firefox + Python backend support (condensed)

Deferred from Phase 1 because the cross-process attach mechanism
differs per backend:

- **Firefox (Node):** switch `backends/firefox/index.ts` from `firefox.launch()` to `firefox.launchServer()` + Node-side `connect(wsEndpoint)`. Expose `getWsEndpoint()` on the firefox plugin. Python adapter does `playwright.firefox.connect(wsEndpoint)`. Risk: `launchServer` changes the lifecycle (server persists until explicitly closed); validate against existing firefox tests.
- **chromium-py / firefox-py:** the BrowserGym adapter (Python) shares the same Python Playwright the backend uses, OR attaches via the same CDP/wsEndpoint mechanisms above. Resolve the camoufox-py execution-context bug (stealth Firefox destroys the context during `removeDisplay()`) via a non-`mw:`-prefixed eval path or split injection.
- **CI:** add venv setup that includes both `browsergym[miniwob]` and the `chromium-py`/`firefox-py` backend deps; wire the Python-backend MiniWoB tests into the matrix.

**Acceptance:** `test:miniwob` runs 13 trivial solvers × 4 backends =
52 pass (or auto-skip per backend availability).

## Phase 2 — Agent-benchmarking roadmap (condensed)

> Detailed design deferred to a separate plan once Phase 1 lands.

Run **Pi as the agent** against MiniWoB (and later WebArena) tasks with
the full `@e`-ref toolset, and measure end-to-end success. Then vary
**which tools are present** and **how tool descriptions are worded** to
study how each factor influences agent browsing effectiveness. The
trivial solvers (Phase 1) test the *plugin pipeline*; agent
benchmarking (Phase 2+) tests *agent decision-making given the plugin
as tools*.

- **Phase 2.1 — Baseline success rate.** Implement `actor: { type: "pi", config }` in `browsergym-adapter.ts`: spawn Pi with the full default browser toolset, feed `goal` as the user message, let Pi act until `WOB_DONE_GLOBAL` or `episode_max_time`. Run ~50 element-reachable tasks × chromium × N seeds. Output: baseline success-rate table.
- **Phase 2.2 — Tool-presence variation.** Sweep subsets of the 13 browser tools (remove `browser-inspect`, `web-fetch`, `browser-scroll`, etc.). Reuse the `/web` toggle + `SIBLING_TOOL_NAMES` machinery to disable tools per Pi session. Output: success-rate delta per tool removal.
- **Phase 2.3 — Tool-description variation.** Build a config-driven description-override mechanism (new — `toolDescriptionOverrides` field in Pi config that swaps a tool's `description` at registration time). Sweep {terse, verbose, example-laden} variants per tool. Output: success-rate delta per description style per tool.
- **Phase 2.4 — Run management + storage.** `pi-lean-host/results/` structured JSON per run; aggregation script for success-rate tables + delta plots; LLM token budget per run; cap concurrent Pi sessions. Not in CI — manual or scheduled.

**Why it fits this setup:** Pi has an SDK and CLI; the host harness
spawns Pi with a specific config, feeds it the task goal, lets it call
the browser tools, and detects completion via `WOB_DONE_GLOBAL`. The
tool-presence variable maps onto the existing `/web` toggle. The
`runMiniwobTask` adapter from Phase 1 is reusable unchanged: the
`actor` field switches from `"trivial"` to `{ type: "pi", config }`.

**Open questions for the Phase 2 plan:** LLM model pinning; episode
budget for agent runs; stuck-session detection (loop detection,
force-stop); whether to use BrowserGym's `cheat()` for upper-bound
comparison; statistical rigor (seeds per cell for significance).

## Phase 3 — Other BrowserGym benchmarks (condensed)

The point of Option C: this is now a `pip install browsergym[webarena]` +
one new adapter method away.

- `browsergym[webarena]` — self-hosted Docker containers (shopping, forum, CMS, whiteboard). Requires Docker-in-CI. Highest-fidelity realistic-app testing.
- `browsergym[workarena]` — ServiceNow tasks (enterprise SaaS).
- `browsergym[visualwebarena]`, `assistantbench`, `weblinx`, `openapps`, `timewarp` — each adds a benchmark family.

Each requires: a `pip install` extra, a setup script (clone content /
start Docker), an adapter method that knows the task family's
`setup`/`validate` shape (they all subclass `AbstractBrowserTask`, so
the shape is uniform). The `runMiniwobTask` wrapper generalizes to
`runBgymTask(benchmark, taskName, ...)`.

## Phase 4 — Custom BrowserGym task package (condensed)

> Detailed design deferred to a separate plan.

Replace `pi-lean-portal`'s remaining behavioral integration tests
(reddit-dialog, cookie-persistence) with BrowserGym tasks living in a
**standalone Python repo** (`browsergym-webagent-quirks` or similar),
imported by `pi-lean-host` as a `pip install` extra — exactly like
`browsergym[miniwob]`. Once the equivalent tasks land and prove
coverage, the original portal tests are deleted.

**Why a standalone repo (not a monorepo sibling):** it's a Python
package, not a Node workspace package; decoupled release cadence from
portal lockstep; reusable beyond pi-lean (useful to anyone building a
browser agent); mirrors the BrowserGym ecosystem structure
(`miniwob-plusplus`, `workarena` are each their own repo); keeps
`pi-lean-host` lean (host is the harness, task packages are the
content).

**What migrates:** reddit-dialog stacking → `stacked_dialog_task.py`;
reddit-dialog async appearance → `async_dialog_task.py`; reddit-dialog
×10 consistency → parameterized as 10 seeds; cookie-persistence
behavioral assertions → `cookie_persistence_task.py`. HTML fixtures
move into the task package; `pi-lean-host/suites/` contains zero
hand-rolled HTML.

**What stays in `pi-lean-portal` as mocked unit tests:** strict-mode
duplicate-named locators; snapshot-cache invalidation on re-navigate;
nav-settle network-idle timing (unless expressible as a task).

**Co-development workflow:** editable install
(`pip install -e /path/to/local/browsergym-webagent-quirks`) picks up
changes without re-installing. The `requirements.txt` pin only matters
for CI and releases.

**Open questions for the Phase 4 plan:** which nav-settle concerns are
expressible as tasks vs. mocked unit tests (decide per-concern); does
the task package need its own `cheat()` implementations; PyPI publish
vs. git-tagged; naming (`browsergym-webagent-quirks` general vs.
`browsergym-portal-quirks` portal-specific).

## Risks & open questions

| Risk | Mitigation |
|---|---|
| **Firefox `launchServer` refactor** — switching the firefox plugin to `launchServer` + `connect` may break existing firefox tests. | Phase 1 chromium-first; firefox is a Phase 1 stretch goal, slips to Phase 1.5 if the refactor is invasive. Gate behind a feature flag if needed. |
| **`browsergym[miniwob]` Python dep weight in CI** — gymnasium, numpy, playwright pin. | Dedicated venv cached on `requirements.txt` hash; only installed in the bench CI step, not for `test:ci`. |
| **`browsergym` upstream churn** — task table or setup JS changes upstream. | Pin `browsergym` version in `requirements.txt`. Re-pin deliberately; the adapter's `listTasks` method makes drift visible (test count changes). |
| **MiniWoB content drift** — `miniwob-plusplus` repo moves past `7fd85d71`. | Keep the pin; re-pin deliberately with a re-spike. |
| **Phase 2 cost** — agent-benchmarking LLM runs are expensive. | Phase 2 plan defers until Phase 1 lands; budget caps per run; manual/scheduled, not CI. |
| **Phase 4 cross-repo co-development coupling** — a portal behavior change + the task that exercises it live in two repos. | Editable install for local dev. Accept "two PRs for one logical change" as the cost of decoupled release cadence; paid mostly during initial Phase 4 development. |
| **Phase 4 task-vs-unit-test misclassification** — drawing the line between "behavioral → task package" and "framework-internals → mocked unit test" is judgment work. | Per-concern decision during Phase 4 implementation, documented in the task package README. Rule of thumb: if it has a user-visible goal an agent achieves, it's a task; if it's asserting a code path's internal behavior, it's a unit test. |

> **Resolved risks** (from the original plan, now closed by the §1.0
> spike): CDP endpoint read from Node Playwright — `ss -tlnp` +
> `CDP_PORT` fallback confirmed. Two CDP clients on one Chromium — no
> `bid`/`@e`-ref leakage confirmed. See
> [`packages/pi-lean-host/docs/cdp-endpoint-spike.md`](packages/pi-lean-host/docs/cdp-endpoint-spike.md).

## File-level inventory

### Already created (§1.0 + §1.1, complete)

- `packages/pi-lean-host/package.json` (name: pi-lean-host, version: 0.0.1, public, NOT lockstep)
- `packages/pi-lean-host/README.md` (placeholder — replaced in §1.9)
- `packages/pi-lean-host/AGENTS.md` (stub → monorepo AGENTS.md)
- `packages/pi-lean-host/requirements.txt` (placeholder — pinned in §1.2)
- `packages/pi-lean-host/docs/cdp-endpoint-spike.md` (§1.0 spike findings)
- `package.json` (root) — `test:ci` extended with `--exclude='**/pi-lean-host/**'`
- `.npmrc` (root) — npm auth token for `pi-lean-host` publishes

### New files (Phase 1 §1.2–1.9)

- `packages/pi-lean-host/src/index.ts` (public API entry point)
- `packages/pi-lean-host/adapter/browsergym-bridge.py`
- `packages/pi-lean-host/adapter/browsergym-adapter.ts` (Mode A + Mode B)
- `packages/pi-lean-host/adapter/bench.ts` (high-level `benchPlugin()` entry)
- `packages/pi-lean-host/solvers/parser.ts`
- `packages/pi-lean-host/solvers/trivial-solvers.ts`
- `packages/pi-lean-host/solvers/register-suite.ts` (documented extension point for user plugins)
- `packages/pi-lean-host/suites/miniwob-trivial.test.ts`
- `packages/pi-lean-host/suites/miniwob-helper.test.ts`
- `packages/pi-lean-host/scripts/setup-miniwob.mjs` (moved)
- `packages/pi-lean-host/docs/miniwob-spike-findings.md` (moved from portal)

### Modified files

- `packages/pi-lean-portal/backends/chromium/index.ts` — add `--remote-debugging-port=0`, expose CDP endpoint via `getCdpEndpoint()` (port discovery via `ss -tlnp` + `CDP_PORT` fallback per spike findings)
- `packages/pi-lean-portal/backends/firefox/index.ts` — (Phase 1.5) `launchServer` + `getWsEndpoint`
- `packages/pi-lean-portal/core/plugin-api.ts` — add two optional methods to `BrowserPlugin`: `getCdpEndpoint?(): string | null` (Mode A) and `connectOverCDP?(endpoint: string): Promise<void>` (Mode B). Both default to absent.
- `package.json` (root) — update `setup:miniwob` / `test:miniwob` scripts to target the host workspace
- `.github/workflows/ci.yml` — venv setup step, host test step, `fail-fast: false`, path filter, report upload
- `AGENTS.md` — testing section: portal structural vs host behavioral split
- `miniwob-integration-plan.md` — header note pointing here
- `packages/pi-lean-host/README.md` — replace placeholder with full docs (§1.9)
- `packages/pi-lean-host/requirements.txt` — pin `browsergym[miniwob]` + `playwright` versions (§1.2)

### Deleted files

- `packages/pi-lean-portal/__tests__/helpers/miniwob.ts`
- `packages/pi-lean-portal/__tests__/helpers/miniwob-suite.ts`
- `packages/pi-lean-portal/__tests__/miniwob.test.ts`
- `packages/pi-lean-portal/__tests__/miniwob-helper.test.ts`
- `packages/pi-lean-portal/__tests__/camoufox-py.test.ts`, `camoufox-py-persistence.test.ts` (unfinished user-backend plugin tests — rebuilt post-migration as user-owned parity files via the `pi-lean-host` public API)
- `packages/pi-lean-portal/__tests__/invisible-py.test.ts`, `invisible-py-persistence.test.ts` (same rationale)
- `automate-testing.md` (repo-root research notes)
- `spike/cdp-endpoint-spike.mjs`, `spike/cdp-bridge.py` (throwaway spike scripts — findings recorded in `pi-lean-host/docs/`)

### Kept unchanged

- `packages/pi-lean-portal/__tests__/helpers/plugin-contract.ts`, `reddit-fixture.ts`, `test-server.ts`, `mock-plugin.ts`, `mock-python-bridge.py`
- All portal structural tests + per-backend contract tests (framework integration tests stay in portal)
- `scripts/sync-versions.js`, `scripts/release.mjs` (host is NOT lockstep)
