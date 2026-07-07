# BrowserGym Migration Plan — Option C (task/reward source, keep `@e` refs)

> **Superseded** — see chat 2026-07-06 and `browsergym-removal.md`. BrowserGym dropped as a runtime dependency due to playwright pin incompatibility.

> **Status:** Draft for review.
> **Supersedes:** The "Architecture decision: port the task model, not the
> framework" section of [`miniwob-integration-plan.md`](miniwob-integration-plan.md),
> which silently reversed the `automate-testing.md` decision to depend on
> BrowserGym and instead produced ~2476 lines of hand-maintained ported
> code (Option D). This plan returns to the original library-dependency
> direction while preserving our `@e`-ref accessibility model.
> **Branch context:** `cleanup/use-benchmarking-libraries` — the branch
> name advertises "use benchmarking libraries," which Option D did not do.
> This plan realigns the implementation with the branch's stated purpose.

## Goal

Replace the Option D port-everything implementation with Option C:
**depend on `browsergym[miniwob]` as a dev-only Python dependency for the
task table, episode setup, and reward protocol — while keeping our own
`@e`-ref accessibility snapshot and `BrowserPlugin` action layer
untouched.** BrowserGym never marks the DOM (no `bid` injection); we use
it purely as a task/reward source. Our plugin drives the page and takes
its own snapshots.

This deletes ~1285 lines of ported code in `helpers/miniwob.ts`, halves
the test-investment surface, and **unlocks the WebArena / WorkArena /
VisualWebArena upgrade path** (and the agent-benchmarking roadmap in
Phase 2/3) by changing one `pip install` extra instead of doing another
full manual port.

## Scope decisions (confirmed)

| Decision | Choice | Rationale |
|---|---|---|
| Plan scope | Migration + roadmap | Phase 1 = concrete Option C migration. Phase 2/3 = agent-benchmarking roadmap at a high level, deferred to its own plan once migration lands. |
| Python venv | Dedicated `browsergym` venv | Isolates `browsergym`'s `gymnasium` + `numpy` + its own `playwright` pin from the existing `chromium-py`/`firefox-py` venv. Avoids version-drift churn. One extra CI setup step. |
| Phase 1 backends | chromium-first within "Node now" | User chose Node backends (chromium + firefox) for Phase 1. Chromium via CDP attach is straightforward. Firefox has no CDP and needs a `launchServer` refactor — flagged as a Phase 1 risk; if invasive, firefox slides to Phase 1.5 alongside Python backends. |
| Host package location | New `pi-lean-host` package in the monorepo | Host is a *consumer* of `pi-lean-portal`, not a test of it. Separate deps, release cadence, CI profile. The name continues the Pylea pun (`pi-lean-dimension` umbrella, `pi-lean-portal` browser) — "the Host" is Lorne, the Pylean who evaluates performers at Caritas, which is what a benchmark harness does. See "Package layout" below. |
| Experimental variable (Phase 2/3) | Both tool-presence and tool-description variation | User wants both, factorially eventually. Phase 2 establishes baseline + tool-presence; Phase 3 adds description variation. |
| Integration-test scope | Only **behavioral evaluation** moves to `pi-lean-host`; portal framework integration tests stay in `pi-lean-portal` | The split criterion is *subject under test*, not *needs a browser binary*. See "Integration-test scope" below. |
| User-plugin support | First-class from Phase 1 — `pi-lean-host` exports a public API for benching any `BrowserPlugin` | A user writing a custom backend (WebKit, stealth browser, alternative automation framework) should be able to run it against our MiniWoB/WebArena suites. See "User-plugin benchmarking" below. |

## Integration-test scope

**Decision:** `pi-lean-host` houses **behavioral
evaluation** — tests where the portal (or any `BrowserPlugin`) is the
*subject under evaluation* by an external task suite (MiniWoB, WebArena,
the custom task package in Phase 4, agent benchmarking). Behavioral
tests are expressed as BrowserGym tasks and invoked from `pi-lean-host`;
**no hand-rolled HTML fixtures are added to portal or host test code.**
New behavioral concerns go into the custom BrowserGym task package
(Phase 4, separate repo). Concerns that genuinely can't be expressed
as tasks stay as portal unit tests (mocked, no browser).

The split criterion is **subject under test**, not *needs a browser
binary*:

| Test type | Subject under test | Browser role | Lives in |
|---|---|---|---|
| **Unit** (router-dispatch, plugin-registry, snapshot-cache parser, accessibility-tree parser, toggle logic, url-safety, nav-settle logic, storage-state logic, fetch-backend, python-adapter protocol, strict-mode locator behavior) | Portal's internal code paths | None (mocked) | `pi-lean-portal` |
| **Behavioral evaluation** (MiniWoB, WebArena, custom task package dialog/cookie/nav-settle tasks, agent benchmarking) | The portal as a black box, judged by an external task suite | Driven by portal, evaluated by BrowserGym | `pi-lean-host` |

**Note on the old "framework integration" category.** The current
portal tests that use a real browser as a fixture (reddit-dialog,
cookie-persistence, per-backend contract tests) fall into two buckets,
which the plan now partitions explicitly:

- **Behavioral concerns** (dialog stacking, async dialog appearance,
  cookie save-before-renavigate) → **Phase 4 replaces these with
  BrowserGym tasks** in the custom task package. The original portal
  tests are deleted once the equivalent tasks land and prove coverage.
- **Framework-internals concerns** (strict-mode duplicate-named
  locators, snapshot cache invalidation on re-navigate, nav-settle
  network-idle timing) → these have no user-visible "goal" an agent
  achieves and don't map to BrowserGym's task model. They stay as
  portal tests, re-expressed as mocked unit tests where possible
  (mocking Playwright at the locator level) so they don't need a real
  browser just to assert `getByRole(...).nth(2)` resolves without
  strict-mode violation.

**Policy (enforced from Phase 4 onward):**

1. **Prefer BrowserGym tasks over hand-rolled HTML.** Any new
   behavioral test goes into the custom task package as a task; it is
   not added as a new fixture in `pi-lean-portal/__tests__/` or
   `pi-lean-host/suites/`.
2. **Behavioral → task package + `pi-lean-host` invocation.**
   Framework-internals → `pi-lean-portal` unit test (mocked).
3. **No new browser-as-fixture tests in portal.** If a portal
   internals change needs browser coverage, the test is either
   re-expressed as a mocked unit test or, if it's genuinely behavioral,
   it goes into the custom task package and is invoked from host.

**Why portal framework-internals tests stay in portal** (after the
behavioral ones migrate to tasks in Phase 4):

1. **They test portal code, not the portal as a product.**
   `plugin-contract.ts`'s strict-mode test validates `buildLocator()`'s
   `nth(occurrenceIndex)` behavior; the snapshot-cache test validates
   invalidation on re-navigate. The subject is portal internals.
2. **They depend on portal-internal test helpers**
   (`helpers/plugin-contract.ts`, `helpers/mock-plugin.ts`,
   `helpers/mock-python-bridge.py`). These aren't part of portal's
   public package surface; cross-package coupling to them would be
   fragile.
3. **They're co-located with the code they test** for the same reason
   unit tests are — the strict-mode locator test belongs next to
   `buildLocator`, not in a consumer package.

**The Lorne metaphor reinforces this.** The Host doesn't evaluate
whether the portal's locator code works (that's the portal's own
unit-test business, internal to the dimension). The Host evaluates
whether the portal *succeeds at external tasks* — whether the
performer's act lands, not whether their vocal cords function.

**What this means concretely for `pi-lean-portal/__tests__/`:**

- **Phase 1:** delete the four MiniWoB files (`helpers/miniwob.ts`,
  `helpers/miniwob-suite.ts`, `miniwob.test.ts`, `miniwob-helper.test.ts`)
  - they move to `pi-lean-host`.
- **Phase 1:** delete the unfinished user-backend plugin tests
  (`camoufox-py.test.ts`, `camoufox-py-persistence.test.ts`,
  `invisible-py.test.ts`, `invisible-py-persistence.test.ts`). These were
  scratch tests for in-development user plugins; the Option C migration
  causes too much drift to justify keeping them around. They'll be
  rebuilt after completion as **user-owned parity test files** that
  consume the `pi-lean-host` public `benchPlugin` API (see "User-plugin
  benchmarking") — which is the structurally correct home for them
  anyway.
- **Deferred to a separate PR (out of scope for this migration):** the
  reviewer's "stacked dialogs dedup" cleanup at `plugin-contract.ts:1091`
  / `reddit-dialog.test.ts:107`. It's orthogonal to Option C and
  entangling it would muddy the file inventory. File it as its own
  follow-up.
- **Phase 4:** the behavioral portal tests (`reddit-dialog` behavioral
  parts, `cookie-persistence`) move to `pi-lean-host` as task
  invocations and the originals are deleted. The framework-internals
  portal tests stay, re-expressed as mocked unit tests where possible.

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
   parses `page.ariaSnapshot()` into `@e1, @e2, ...` refs. **Zero contact
   with BrowserGym's `bid` model.** BrowserGym's
   `observation.py`/`_pre_extract` (the `bid` stamping) is never called.
2. **The `BrowserPlugin` action layer** — `click(ref)`, `type(ref, text)`,
   `scroll`, `press`, `goBack`, `snapshot`. BrowserGym's
   `action/functions.py` (`click(bid)`, `fill(bid, val)`) is never
   called. Our plugin drives the page; BrowserGym only sets up the task
   and reads the reward.
3. **The solver/registry harness** — `helpers/miniwob-suite.ts` (solvers,
   `@e`-ref line parser, `registerMiniwobSuite`, backend gates). This is
   our test logic; BrowserGym doesn't provide solvers. Stays in
   `pi-lean-host` (see below).
4. **The `miniwob-plusplus` HTML checkout + HTTP server** —
   `scripts/setup-miniwob.mjs`. This was never BrowserGym's to outsource;
   the HTML is owned by the Farama `miniwob-plusplus` repo. We clone it
   at pin `7fd85d71` and serve it over HTTP. Unchanged in both options.

### Cross-process page sharing (the new piece)

BrowserGym's `MiniWoBTask.setup(page)` expects a
`playwright.sync_api.Page`. Our chromium plugin owns a Node Playwright
page. To let the Python adapter run setup/validate on the same page our
Node plugin drives, we attach the Python process to our Node-launched
browser:

- **Chromium (Phase 1):** Node plugin launches with
  `--remote-debugging-port=<port>`. Python adapter does
  `playwright.chromium.connect_over_cdp("http://localhost:<port>")`,
  enumerates contexts/pages, finds the active page, calls
  `task.setup(page)` / `task.validate(page)`. Our Node plugin continues
  to drive the same page via its own Playwright connection. **CDP
  multi-client attach is a standard Chromium feature.** This is new
  infrastructure for this repo (existing `chromium-py` launches its own
  browser) but well-trodden ground in the Playwright ecosystem.
- **Firefox (Phase 1 risk):** Firefox has no CDP. The cross-process
  attach mechanism is `browserType.launchServer()` + `connect(wsEndpoint)`
  (Playwright server protocol, works for all browser types). This
  requires the firefox plugin to switch from `firefox.launch()` to
  `firefox.launchServer()` + Node-side `connect()` — a real change to
  the existing firefox plugin's launch path. **If this refactor proves
  invasive, firefox slides to Phase 1.5.** The plan assumes
  chromium-first within Phase 1 and treats firefox as a Phase 1
  stretch goal.
- **Python backends (Phase 1.5):** `chromium-py`/`firefox-py` already
  run a Python Playwright. The BrowserGym adapter (also Python) could
  share the same Playwright instance or attach via the same mechanisms
  above. Deferred because the Node-first path is simpler and the
  camoufox-py execution-context bug found in the spike needs separate
  resolution.

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
10. Test harness: assert reward > 0 (trivial solvers) OR record metrics (agent benchmarking)
```

The key invariant: **only the Node plugin drives actions; the Python
adapter only runs `setup` and `validate`.** This keeps the `@e`-ref
model authoritative and avoids any `bid`/`@e` vocabulary collision.

## Package layout

### New package: `packages/pi-lean-host/`

```
packages/pi-lean-host/
├── package.json                  (name: pi-lean-host, NOT lockstep, NOT in umbrella meta-package; npm namespace reserved via an early placeholder publish — see §1.1)
├── README.md                     (host usage + "Benchmarking your own BrowserPlugin" guide, not shipped to end users)
├── AGENTS.md                     (stub — points at monorepo AGENTS.md)
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
├── venv/                         (gitignored — dedicated browsergym venv, created by setup script)
└── results/                      (gitignored — benchmark run outputs, Phase 2+)
```

**Depends on (workspace):** `pi-lean-portal` (for `BrowserPlugin` types + plugin constructors), `pi-lean-search` (if host varies search tool presence).

**Depends on (external, dev-only):** `browsergym[miniwob]` (Python, in the dedicated venv), Pi SDK (Node, for Phase 2 agent spawning), `vitest` (test runner).

**Not bundled in `pi-lean-dimension` umbrella meta-package** — that's for end-user-installed extensions. `pi-lean-host` is research tooling; it's published to npm **only to reserve the namespace** (see §1.1), not for end-user installation. The Pylea pun continues: the Host (Lorne) watches performers from outside the performance.

### What `pi-lean-portal` loses

Deleted from `packages/pi-lean-portal/__tests__/`:

- `helpers/miniwob.ts` (~1285 lines) — ported task table + setup JS + reward protocol + driver
- `helpers/miniwob-suite.ts` (~455 lines) — solvers, parser, registry
- `miniwob.test.ts` (~300 lines) — backend wiring
- `miniwob-helper.test.ts` (~156 lines) — structural guards on the ported table
- `miniwob-spike-findings.md` — moves to `pi-lean-host/docs/` (historical reference)

Deleted from `packages/pi-lean-portal/__tests__/` (unfinished user-backend plugin tests — rebuilt post-migration as user-owned parity files via the `pi-lean-host` public API):

- `camoufox-py.test.ts`, `camoufox-py-persistence.test.ts` (camoufox stealth Firefox)
- `invisible-py.test.ts`, `invisible-py-persistence.test.ts` (invisible-py user backend)

The underlying camoufox-py execution-context bug is still tracked in Phase 1.5; only the scratch test files are removed now.

**Kept** in `pi-lean-portal/__tests__/`:

- All structural tests (router-dispatch, plugin-registry, plugin-config, snapshot-cache, browser-inspect, web-guides, url-safety, nav-settle, storage-state, accessibility-tree, browser-toggle*, browser-status, plugin-loading, fetch-backend, python-adapter)
- Per-backend contract tests (chromium-py, firefox, firefox-py, cookie-persistence, reddit-dialog) — these test framework concerns (dialog stacking, async dialogs, nav-settle, strict-mode) that MiniWoB's trivial solvers don't exercise
- `helpers/plugin-contract.ts`, `helpers/reddit-fixture.ts`, `helpers/test-server.ts`, `helpers/mock-plugin.ts`, `helpers/mock-python-bridge.py`

### Repo-root cleanup

- `automate-testing.md` (171 lines, repo root) — **delete.** Research/chat notes accidentally committed; attribution already lives in `pi-lean-host/adapter/browsergym-bridge.py` header and `MINIWOB_SETUP_JS` is no longer ported so the in-file attribution reference disappears.
- `miniwob-integration-plan.md` — **keep as historical reference** but add a header note pointing at this plan as the active direction. Option D's port is being retired; the plan doc records why the original spike was run and what it found.
- `pending-issues-invisible-py.md`, `reports/` (untracked) — leave untracked; not part of this plan.

## Phase 1 — Option C migration

### 1.0 CDP endpoint spike (load-bearing — runs before §1.3/1.4)

The `browsergym-adapter.ts` (§1.3) signature and the chromium plugin
change (§1.4) both depend on **how we read the DevTools endpoint of a
`chromium.launch()`-ed browser from Node Playwright**. Resolve this
*before* writing the adapter or touching the plugin.

- Launch chromium with `--remote-debugging-port=0` (OS-assigned port).
- Confirm `http://localhost:<port>/json/version` is reachable and find
  the actual port. Candidate mechanisms to evaluate: scraping the
  DevTools listening URL from stderr, polling `/json/version` across the
  port range, or using a `chromium.connectOverCDP` round-trip.
- If Playwright Node doesn't surface the endpoint cleanly, fall back to
  a **fixed port per test run** (e.g. `9222`), resolved via env var so
  parallel CI matrix cells don't collide (`fail-fast: false` is
  proposed in §1.8, which makes parallelism more likely).
- Validate the two-CDP-client interleaving guard at the same time:
  after Python `setup(page)`, run `ariaSnapshot()` from Node and confirm
  the `@e`-ref tree is clean (no `bid` attrs in ARIA names). This is the
  §"Risks & open questions" two-CDP-clients mitigation and must pass
  before §1.3 is built on top of it.

**Acceptance:** A throwaway script launches chromium, prints a working
CDP endpoint, attaches a second Playwright client via
`connect_over_cdp`, and snapshots a page the first client drove — with
no `bid` leakage. The chosen mechanism is recorded in
`pi-lean-host/docs/cdp-endpoint-spike.md` so §1.3/1.4 implement against
a known answer.

### 1.1 Scaffold `pi-lean-host` package + reserve npm namespace

- `packages/pi-lean-host/package.json` — `name: pi-lean-host`, `version: 0.0.1` (independent, NOT lockstep, **not `private`**), `scripts: { test, "test:miniwob", "setup:miniwob", "setup:venv" }`. Workspace dep on `pi-lean-portal`.
- **Reserve the npm namespace early.** npm has no name-reservation
  without a publish, so the easiest way to claim `pi-lean-host` is to
  publish a minimal placeholder `0.0.1` (stub `README.md` + the
  `package.json` above) via `npm publish --access public` from the
  scaffold commit. This locks the name before Phase 1 is complete; real
  content ships under later versions. We won't run `sync-versions.js`
  against `pi-lean-host` until it's ready, so the placeholder publish is
  manual and one-off.
- Add to root `package.json` `workspaces` (already `packages/*` — picked up automatically).
- Root `vitest.config.ts` — include `packages/pi-lean-host/**` (or confirm workspaces glob already covers it).
- **Extend the root `test:ci` exclude globs in the same commit.** The
  current `test:ci` is `vitest run --exclude='**/miniwob.test.ts' ...
  --exclude='**/reddit*.test.ts'`. The new host suites
  (`miniwob-trivial.test.ts`, `miniwob-helper.test.ts`) do **not** match
  the exact-filename `**/miniwob.test.ts` glob, and `vitest.config.ts`
  includes `packages/*/**/*.test.ts` — so `npm test` and `npm run
  test:ci` at root would discover host suites with no `browsergym` venv
  installed. Add `--exclude='**/pi-lean-host/**'` to `test:ci` (and
  optionally broaden `**/miniwob.test.ts` to `**/miniwob*.test.ts` for
  clarity) so host tests only run via `npm run test:miniwob -w
  pi-lean-host`.
- `packages/pi-lean-host/AGENTS.md` stub pointing at monorepo `AGENTS.md`.
- `packages/pi-lean-host/README.md` — usage: `npm run setup:venv && npm run setup:miniwob && npm run test:miniwob`.

**Acceptance:** `npm test -w pi-lean-host` runs (no tests yet, exits clean); `npm run test:ci` at root does **not** discover host test files; `pi-lean-host@0.0.1` is visible on npm.

### 1.2 BrowserGym Python adapter (`adapter/browsergym-bridge.py`, ~150 lines)

A JSON-RPC-over-stdio server, modeled on the existing
`backends/python-base/pi_browser_bridge/` pattern. Methods:

- `miniwob.connect({ cdpEndpoint })` — `playwright.chromium.connect_over_cdp(...)`, store the browser handle.
- `miniwob.listTasks()` → returns the 125 task names from `ALL_MINIWOB_TASKS` (one-time call at harness init; lets the TS side build the test matrix without porting the table).
- `miniwob.setup({ taskName, seed, baseUrl })` — instantiate the task class by name, find the active page on the connected browser, call `task.setup(page)`, return `{ goal, info, episodeId }`.
- `miniwob.validate()` — call `task.validate(page)` on the stored task/page, return `{ reward, done, reason, info }`.
- `miniwob.teardown()` — `task.teardown()`, release handles.

Attribution header (Apache-2.0, ServiceNow BrowserGym, Farama MiniWoB++, commit pin `miniwob-plusplus@7fd85d71`).

**Dedicated venv:** `npm run setup:venv` creates `packages/pi-lean-host/venv/` with `pip install browsergym[miniwob] playwright` (pin versions in a `requirements.txt`). The adapter spawns under this venv's Python.

**Acceptance:** `python adapter/browsergym-bridge.py` starts, responds to `miniwob.listTasks` with 125 entries, handles `miniwob.connect` against a manually-launched chromium with `--remote-debugging-port`.

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

1. Read the CDP endpoint from the plugin's launched browser (requires a small `BrowserPlugin` extension — see 1.4).
2. Spawn the Python adapter subprocess, call `connect`, `setup`.
3. Loop: `plugin.snapshot()` → actor picks `@e` ref → `plugin.click/type/...` → `validate` → repeat until `done` or `maxSteps`.
4. Return reward + metrics.

**Acceptance:** `runMiniwobTask` against `click-button` with the trivial "click first button" solver returns `rawReward > 0`.

### 1.4 Expose CDP endpoint from the chromium plugin

The chromium plugin currently launches via `chromium.launch({ args: [...] })` with no debugging port. To let the Python adapter attach:

- Add `--remote-debugging-port=0` to the launch args (port 0 → OS-assigned free port). The exact read mechanism was resolved by the §1.0 spike — implement against the recorded answer (dynamic port via the spike-confirmed method, or a fixed env-var-resolved port if the spike fell back to that).
- Add an optional `getCdpEndpoint(): string | null` method to `BrowserPlugin` (chromium returns the endpoint; firefox returns null until Phase 1.5; Python backends return null in Phase 1).

**Risk:** This is the one place Phase 1 touches the shipped `pi-lean-portal` code. Keep the change minimal and gated so non-host usage is unaffected (the `--remote-debugging-port` arg is harmless for normal portal use; it just opens a debug port).

**Acceptance:** Chromium plugin launches with a readable CDP endpoint; existing portal tests still pass (`test:ci` unchanged).

### 1.5 Move solvers + suite harness

Move from `pi-lean-portal/__tests__/helpers/` to `pi-lean-host/solvers/`:

- `miniwob-suite.ts` → split into `parser.ts`, `trivial-solvers.ts`, `register-suite.ts`.
- Apply the reviewer's cleanup findings:
  - Tighten `withRole` to match only the role segment of the snapshot line (not inside quoted accessible names). The current `\b${roleKeyword}\b` regex already prevents the `button`/`spinbutton` collision; the real (lesser) bug is that the test runs against the whole line including the quoted accessible name, so a goal like `button "click the button"` matches `button` inside the quoted name too. Anchor the regex to the segment before the first `"`.
  - Remove the speculative `knownIssue` field (no shipped backend uses it; can re-add when a backend needs it).
  - Document that `registerMiniwobSuite` is the extension point for user-owned parity test files.

**Acceptance:** `registerMiniwobSuite` registers the 13 trivial-solver tasks against a mock plugin and the suite structure matches the current shape.

### 1.6 Move + slim the test files

- `miniwob.test.ts` → `pi-lean-host/suites/miniwob-trivial.test.ts`. Backend gates: chromium (confident), firefox (Phase 1 stretch — skip if no `launchServer` support), chromium-py/firefox-py (skip, Phase 1.5).
- `miniwob-helper.test.ts` → `pi-lean-host/suites/miniwob-helper.test.ts`, slimmed from 156 → ~40 lines. No ported task table to lock; tests become "adapter spawns, `listTasks` returns 125, `setup` returns a goal, `validate` returns reward against a mock."

**Acceptance:** `npm run test:miniwob -w pi-lean-host` runs 13 trivial-solver tests × chromium = 13 pass (or skip if browser absent), 77 element tasks skipped with `needs goal-aware solver`, 35 non-element tasks skipped with missing-tool reasons. (`13 + 77 + 35 = 125`, matching the AGENTS.md task split: 3 confident + 10 best-effort run, 77 element tasks lack a solver, 35 non-element tasks lack the tool.)

### 1.7 Move + keep the setup script

- `scripts/setup-miniwob.mjs` → `packages/pi-lean-host/scripts/setup-miniwob.mjs`.
- Apply the reviewer's hardening:
  - In the `.git` exists branch, also verify `miniwob/html/` is present; re-clone/repair if absent.
  - Verify the checked-out commit matches `PINNED_COMMIT`; warn on drift.
- Add `npm run setup:venv -w pi-lean-host` (creates the dedicated venv from `requirements.txt`).
- Root `package.json` scripts: `setup:miniwob` → `npm run setup:miniwob -w pi-lean-host`; `test:miniwob` → `npm run test:miniwob -w pi-lean-host`.

**Acceptance:** `npm run setup:miniwob` is idempotent across re-runs, verifies `html/` presence + pinned commit, and the venv setup is one command.

### 1.8 CI wiring

Update `.github/workflows/ci.yml`:

- **New step in the `test` job (after Playwright browser install):** `python -m venv packages/pi-lean-host/venv && packages/pi-lean-host/venv/bin/pip install -r packages/pi-lean-host/requirements.txt`. Cache the venv on `requirements.txt` hash.
- **Run host tests:** `npm run test:miniwob -w pi-lean-host` after `test:ci`.
- **Apply reviewer's CI nits:** add `fail-fast: false` to the test matrix; add a test-report/trace upload-on-failure step; add a path filter so MiniWoB doesn't run on PRs that touch only `pi-lean-search` or docs.
- **Python-backend skip:** chromium-py/firefox-py auto-skip in Phase 1 (no venv-with-browsergym-and-portal-py-backends setup yet). Phase 1.5 wires that.

**Acceptance:** CI runs `test:ci` (structural, portal) then `test:miniwob` (host, chromium-only) green on a PR; venv cached across runs.

### 1.9 Docs + attribution

- `pi-lean-host/README.md` — setup, usage, architecture (one paragraph: "BrowserGym is the task/reward source; our plugin drives; CDP attach shares the page; `@e` refs untouched").
- `pi-lean-host/adapter/browsergym-bridge.py` header — Apache-2.0 attribution to BrowserGym (ServiceNow) + MiniWoB++ (Farama), commit pin `miniwob-plusplus@7fd85d71`, `browsergym` PyPI version pin.
- Monorepo `AGENTS.md` — update the testing section: portal structural tests stay in `pi-lean-portal`; MiniWoB behavioral tests move to `pi-lean-host`; note the dedicated venv + `setup:venv` step.
- `miniwob-integration-plan.md` — add header note: "Option D (port-everything) was implemented and then retired in favor of Option C (BrowserGym as task/reward source). See `browsergym-migration-plan.md`. This doc is kept for spike-findings reference."
- `automate-testing.md` — **delete** (per repo-root cleanup).

**Acceptance:** No stale references to `automate-testing.md` or the old `helpers/miniwob.ts` paths remain in tracked files.

## Phase 1.5 — Firefox + Python backend support

Deferred from Phase 1 because the cross-process attach mechanism differs per backend:

- **Firefox (Node):** switch `backends/firefox/index.ts` from `firefox.launch()` to `firefox.launchServer()` + Node-side `connect(wsEndpoint)`. Expose `getWsEndpoint()` on the firefox plugin. Python adapter does `playwright.firefox.connect(wsEndpoint)`. **Risk:** `launchServer` changes the lifecycle (server persists until explicitly closed); validate against existing firefox tests.
- **chromium-py / firefox-py:** the BrowserGym adapter (Python) shares the same Python Playwright the backend uses, OR attaches via the same CDP/wsEndpoint mechanisms above. Resolve the camoufox-py execution-context bug (stealth Firefox destroys the context during `removeDisplay()`) via a non-`mw:`-prefixed eval path or split injection.
- **CI:** add venv setup that includes both `browsergym[miniwob]` and the `chromium-py`/`firefox-py` backend deps; wire the Python-backend MiniWoB tests into the matrix.

**Acceptance:** `test:miniwob` runs 13 trivial solvers × 4 backends = 52 pass (or auto-skip per backend availability).

## Phase 2 — Agent-benchmarking roadmap (high-level)

> Detailed design deferred to a separate plan once Phase 1 lands. This
> section captures the direction so Phase 1 decisions don't foreclose it.

### Vision

Run **Pi as the agent** against MiniWoB (and later WebArena) tasks, with
the full `@e`-ref toolset, and measure end-to-end success. Then vary
**which tools are present** and **how tool descriptions are worded** to
study how each factor influences agent browsing effectiveness. The
trivial solvers (Phase 1) test the *plugin pipeline*; the agent benchmarking
(Phase 2+) tests *agent decision-making given the plugin as tools*.

### Why it fits this setup

- Pi has an SDK and CLI; the host harness can spawn Pi with a specific
  config, feed it the task goal, let it call the browser tools, and
  detect completion via `WOB_DONE_GLOBAL`.
- The **tool-presence variable** maps cleanly onto the existing `/web`
  toggle + `SIBLING_TOOL_NAMES` machinery — we already enable/disable
  browser tools per session. Varying presence is a config flip.
- The **tool-description variable** is harder (no config-driven
  description override exists yet) — Phase 3 work.
- The `runMiniwobTask` adapter from Phase 1 is reusable unchanged: the
  `actor` field just switches from `"trivial"` to `{ type: "pi",
  config }`.

### Phase 2.1 — Baseline success rate

- Implement `actor: { type: "pi", config }` in `browsergym-adapter.ts`:
  spawn Pi with the full default browser toolset, feed `goal` as the
  user message, let Pi act until `WOB_DONE_GLOBAL` or `episode_max_time`.
- Run the ~50 element-reachable tasks × chromium × N seeds.
- Record per-task: reward, success (reward > 0), steps, tokens, wall time.
- **Output:** a baseline success-rate table. No variation yet.

### Phase 2.2 — Tool-presence variation

- Sweep: for each subset of the 13 browser tools (e.g. remove
  `browser-inspect`, remove `web-fetch`, remove `browser-scroll`, etc.),
  re-run the baseline.
- Reuse the `/web` toggle + `SIBLING_TOOL_NAMES` machinery to disable
  tools per Pi session.
- **Output:** success-rate delta per tool removal. Identifies which
  tools are load-bearing for agent effectiveness.

### Phase 2.3 — Tool-description variation

- Build a config-driven description-override mechanism (new — doesn't
  exist yet). Likely a `toolDescriptionOverrides` field in the Pi
  config that swaps a tool's `description` string at registration time.
- Sweep: for each tool, run with {terse, verbose, example-laden}
  description variants.
- **Output:** success-rate delta per description style per tool.

### Phase 2.4 — Run management + storage

- `pi-lean-host/results/` — structured JSON per run (task, backend,
  seed, tool config, description config, metrics).
- Aggregation script: success-rate tables, delta plots.
- Cost control: LLM token budget per run; cap concurrent Pi sessions.
- **Not in CI** — benchmark runs are manual or scheduled, not per-PR.

### Open questions for the Phase 2 plan

- LLM model pinning (which Pi model? allow sweeps?)
- Episode budget (`episode_max_time` for agent runs — longer than
  trivial-solver runs)
- How to handle Pi sessions that get stuck (loop detection, force-stop)
- Whether to use BrowserGym's `cheat()` for upper-bound comparison
- Statistical rigor (how many seeds per cell for significance)

## Phase 3 — Other BrowserGym benchmarks

The point of Option C: this is now a `pip install browsergym[webarena]`

- one new adapter method away.

- `browsergym[webarena]` — self-hosted Docker containers (shopping,
  forum, CMS, whiteboard). Requires Docker-in-CI. Highest-fidelity
  realistic-app testing.
- `browsergym[workarena]` — ServiceNow tasks (enterprise SaaS).
- `browsergym[visualwebarena]`, `assistantbench`, `weblinx`, `openapps`,
  `timewarp` — each adds a benchmark family.

Each requires: a `pip install` extra, a setup script (clone content /
start Docker), an adapter method that knows the task family's
`setup`/`validate` shape (they all subclass `AbstractBrowserTask`, so
the shape is uniform). The `runMiniwobTask` wrapper generalizes to
`runBgymTask(benchmark, taskName, ...)`.

## Phase 4 — Custom BrowserGym task package (separate repo)

**Goal:** replace `pi-lean-portal`'s remaining behavioral integration
tests (reddit-dialog, cookie-persistence, any other browser-as-fixture
tests that cover user-visible behaviors) with BrowserGym tasks living
in a **standalone Python repo**, imported by `pi-lean-host` as a
`pip install` extra — exactly like `browsergym[miniwob]`. Once the
equivalent tasks land and prove coverage, the original portal tests
are deleted.

This is the natural endpoint of Option C: if BrowserGym is the
task/reward source, then *any* behavioral test should be expressible
as a BrowserGym task, and the tests that aren't expressible are by
definition unit tests of internal code paths (see "Integration-test
scope" partition rule).

### Why a standalone repo (not a monorepo sibling)

1. **It's a Python package, not a Node workspace package.** The
   `pi-lean-dimension` monorepo is npm-workspaces — `package.json`,
   lockstep versioning, `npm publish`. A Python BrowserGym task package
   doesn't belong in an npm workspace; it'd be a foreign object with
   its own `pyproject.toml` and PyPI release. Separate repo = honest
   structure.
2. **Decoupled release cadence, fully.** `pi-lean-portal` locksteps
   with `pi-lean-search` and `pi-lean-dimension`. A custom-task package
   dragged into that cadence would either bump on every portal release
   (wrong — tasks change when tasks change) or break the lockstep
   invariant. Separate repo = no such tension.
3. **Reusable beyond pi-lean.** A `browsergym-webagent-quirks` (or
   similarly general name) package is useful to anyone building a
   browser agent, not just us. If it's good enough to test our plugin,
   it's probably good enough to test other plugins. Standalone repo is
   the correct "this is a community benchmark" signal.
4. **Mirrors the BrowserGym ecosystem structure.** `miniwob-plusplus`,
   `workarena`, etc. are each their own repo. A custom task package is
   a peer to those, not a child of `pi-lean-dimension`.
5. **Keeps `pi-lean-host` lean.** Host's job is "run tasks against
   plugins and record outcomes." Host shouldn't *contain* task
   definitions any more than it should contain plugin definitions.
   Tasks come from `browsergym[miniwob]`, `browsergym[webarena]`, and
   `browsergym[<our-quirks>]`. Host imports and runs. Clean separation:
   host is the harness, task packages are the content.

### What the task package contains

A Python package, sibling in shape to `browsergym/miniwob/`:

```
browsergym-webagent-quirks/                (separate repo)
├── pyproject.toml                          (name: browsergym-webagent-quirks, deps: browsergym-core)
├── README.md                               (task catalog, attribution)
├── src/browsergym_webagent_quirks/
│   ├── __init__.py                         (registers tasks via browsergym.core.registration.register_task)
│   ├── all.py                              (task class list — like miniwob/all.py)
│   ├── base.py                             (shared base, if any)
│   ├── dialogs/
│   │   ├── stacked_dialog_task.py          (replaces reddit-dialog stacking test)
│   │   ├── async_dialog_task.py            (replaces reddit-dialog async test)
│   │   └── html/                            (the HTML fixtures, served by the task's setup())
│   ├── persistence/
│   │   ├── cookie_persistence_task.py      (replaces cookie-persistence.test.ts behavioral parts)
│   │   └── html/
│   └── nav/
│       ├── slow_nav_settle_task.py         (if expressible as a task — see gotcha below)
│       └── html/
└── tests/                                  (the package's own internal tests)
```

Each task class subclasses `AbstractBrowserTask` and implements
`setup(page) → (goal, info)` and `validate(page, chat_messages) →
(reward, done, msg, info)`. The HTML fixtures (`reddit-fixture.ts`
variants, cookie-banner HTML) move *into the task package* as task
setup logic — the test code in `pi-lean-host` becomes "register this
task family, run it against the plugin, assert reward," same shape as
the MiniWoB tests, zero hand-rolled HTML in the test files.

### Integration with `pi-lean-host`

In `pi-lean-host/requirements.txt`:

```
browsergym[miniwob] == 0.x.y
browsergym-webagent-quirks == 0.a.b   # from PyPI, OR:
# browsergym-webagent-quirks @ git+https://github.com/yourorg/browsergym-webagent-quirks.git@v0.1.0
```

In `pi-lean-host/adapter/browsergym-bridge.py`, `listTasks` already
iterates `ALL_MINIWOB_TASKS`. To support multiple benchmark families,
it iterates the union of registered task lists:
`browsergym.miniwob.ALL_MINIWOB_TASKS +
browsergym_webagent_quirks.ALL_TASKS + ...`. The adapter doesn't care
which repo a task came from; it just runs `setup`/`validate`. This is
the `runBgymTask(benchmark, taskName, ...)` generalization from Phase
3, and the custom task package makes it the natural shape.

In `pi-lean-host/suites/`, a new test file invokes the quirks suite:

```ts
// pi-lean-host/suites/portal-quirks.test.ts
import { registerBgymSuite } from "pi-lean-host";
import { chromiumPlugin } from "pi-lean-portal/backends/chromium/index.ts";

describe("pi-lean-portal — portal-quirks behavioral coverage", () => {
  registerBgymSuite({
    plugin: chromiumPlugin,
    backendName: "chromium",
    benchmark: "browsergym-webagent-quirks",
    taskFilter: (t) => t.tags.includes("portal-relevant"),
  });
});
```

### What migrates and what stays

**Migrates to the task package (behavioral):**

- reddit-dialog stacking → `stacked_dialog_task.py`
- reddit-dialog async appearance → `async_dialog_task.py`
- reddit-dialog ×10 consistency → parameterized as 10 seeds of the
  same task
- cookie-persistence behavioral assertions (cookie survives
  re-navigate, save-before-renavigate works) →
  `cookie_persistence_task.py`

**Stays in `pi-lean-portal` as mocked unit tests (framework
internals):**

- strict-mode duplicate-named locators (`buildLocator`'s
  `nth(occurrenceIndex)` behavior) — no user-visible goal, mocks
  Playwright's `getByRole` at the locator level
- snapshot-cache invalidation on re-navigate — framework internals,
  mocked page
- nav-settle network-idle timing — *if* expressible as a task ("click
  a slow-loading link, then click a button on the new page, reward if
  both succeed"), it migrates; *if* it's purely a timing assertion,
  it stays as a mocked unit test

**Deleted from `pi-lean-portal/__tests__/` once the equivalent tasks
land and prove coverage:**

- `reddit-dialog.test.ts` (behavioral parts)
- `cookie-persistence.test.ts` (behavioral parts)
- `helpers/reddit-fixture.ts` (HTML moves into the task package)
- The relevant `plugin-contract.ts` behavioral sections

**Kept in `pi-lean-portal/__tests__/`:**

- All unit tests (router-dispatch, plugin-registry, snapshot-cache,
  accessibility-tree, browser-toggle, url-safety, nav-settle logic,
  storage-state logic, fetch-backend, python-adapter)
- The per-backend `runContractTests()` *structural* contract validation
  (does the plugin implement all methods, do result shapes match) —
  this is interface-shape validation, not behavioral, and has no
  BrowserGym-task equivalent
- `helpers/plugin-contract.ts`, `helpers/mock-plugin.ts`,
  `helpers/mock-python-bridge.py`, `helpers/test-server.ts` (the
  last only if still used by a kept test; otherwise deletable)

### Naming

The package name should reflect that it's reusable beyond pi-lean:

- **`browsergym-webagent-quirks`** (recommended) — general name for
  tasks testing browser-agent framework behaviors (dialog stacking,
  async dialogs, cookie persistence, nav-settle). Reusable by any
  browser-agent project.
- **`browsergym-portal-quirks`** — couples it to pi-lean portal. Fine
  if the tasks are genuinely portal-specific (test our specific guide
  format, our specific toggle behaviors); limiting otherwise.
- **`browsergym-dialogs` / `browsergym-persistence`** — split by
  concern if it grows. Multiple small packages, each tightly scoped.
  More overhead, more reuse. Defer splitting until a clear seam
  emerges.

Start with one general package (`browsergym-webagent-quirks`) and
split only if a clear seam emerges.

### Co-development workflow

During active co-development of a new task alongside a new portal
behavior, install the task package in editable mode so changes are
picked up without re-installing:

```
# in pi-lean-host/venv/
pip install -e /path/to/local/browsergym-webagent-quirks
```

The `requirements.txt` pin only matters for CI and releases. For CI,
pin to a git tag or PyPI version. For local dev, editable install is
the loop.

If you want both repos cloned together for development without making
one a child of the other, a git submodule or a workspace-style
checkout script works — but editable install alone is usually enough.

### Acceptance (Phase 4)

- The custom task package is `pip install`-able and registers its
  tasks with `browsergym.core.registration.register_task`.
- `pi-lean-host/adapter/browsergym-bridge.py` `listTasks` returns the
  union of MiniWoB + custom tasks.
- `pi-lean-host/suites/portal-quirks.test.ts` runs the custom tasks
  against chromium and asserts reward > 0.
- `pi-lean-portal/__tests__/reddit-dialog.test.ts` behavioral parts
  are deleted; the equivalent task in the custom package proves
  coverage.
- `pi-lean-portal/__tests__/cookie-persistence.test.ts` behavioral
  parts are deleted; the equivalent task proves coverage.
- The strict-mode and snapshot-cache tests remain in portal as mocked
  unit tests.
- `pi-lean-host/suites/` contains zero hand-rolled HTML.

### Open questions for Phase 4

- Which nav-settle concerns are expressible as tasks vs. which stay as
  mocked unit tests? Decide per-concern during Phase 4 implementation.
- Does the custom task package need its own `cheat()` implementations
  (deterministic solvers) for upper-bound comparison, or do we reuse
  the `pi-lean-host` trivial solvers?
- Should the package publish to PyPI (public, semver-stable) or stay
  git-tagged (internal, looser versioning)? Leaning git-tagged until
  it's mature enough for external users.
- Naming: `browsergym-webagent-quirks` (general) vs.
  `browsergym-portal-quirks` (portal-specific). Decide based on
  whether the first batch of tasks is genuinely portal-specific or
  general browser-agent concerns.

## User-plugin benchmarking

**Goal:** a user who writes a custom `BrowserPlugin` (a WebKit backend,
a stealth browser, an alternative automation framework, a research
prototype) should be able to run it against our MiniWoB / WebArena /
agent-benchmark suites to validate it — without modifying `pi-lean-host`
source. This is a first-class use case from Phase 1, not a future
afterthought, because Option C's value proposition is precisely that
the host is plugin-agnostic: it speaks the `BrowserPlugin` interface

- BrowserGym task protocol, nothing backend-specific.

### Public API surface

`pi-lean-host` exports a documented library API, not just test files:

```ts
// packages/pi-lean-host/src/index.ts (new — currently the plan has
// adapter/solvers/suites as flat folders; add a src/ entry point)
export { runMiniwobTask } from "./adapter/browsergym-adapter.ts";
export { registerMiniwobSuite } from "./solvers/register-suite.ts";
export { trivialSolvers, withRole, parseSnapshotLine } from "./solvers/";
export { benchPlugin } from "./bench.ts";  // high-level entry (see below)
export type { BenchResult, BenchOpts } from "./bench.ts";
```

The internal test suites (`suites/miniwob-trivial.test.ts`, etc.) are
thin consumers of this API — they call `benchPlugin(chromiumPlugin,
...)` the same way an external user would. This keeps the test code and
the external API honest about being the same surface.

### Two browser-ownership modes

The cross-process page-sharing design (see "Architecture →
Cross-process page sharing") has two modes, and `pi-lean-host` supports
both so user plugins aren't forced into one launch model:

**Mode A — plugin-owns-browser (default for our backends).** The plugin
launches its own browser and exposes `getCdpEndpoint(): string | null`.
`pi-lean-host` passes that endpoint to the BrowserGym adapter, which
attaches via `connect_over_cdp`. Used by: `chromium` (Phase 1),
`firefox` (Phase 1.5 via `launchServer` + wsEndpoint), `chromium-py` /
`firefox-py` (Phase 1.5). **Tests the plugin's real launch path**
(args, profile dir, persistent context).

**Mode B — host-owns-browser (for user plugins that can't or won't
launch their own).** `pi-lean-host` launches a reference chromium with
`--remote-debugging-port`, BrowserGym attaches via CDP, and the **user
plugin connects to the same endpoint** via `connectOverCDP(endpoint)`.
The plugin implements an optional `connectOverCDP(endpoint: string):
Promise<void>` method instead of (or in addition to) `launchBrowser()`.
Used by: user plugins that are thin wrappers over an existing browser
session, or that want to be benched without re-implementing browser
launch. **Doesn't test the plugin's launch path** — only its
snapshot/click/type/etc. methods.

The `benchPlugin(plugin, taskName, opts)` entry point takes a `mode:
"plugin-owns-browser" | "host-owns-browser"` option and wires the
appropriate page-sharing path. A user plugin can be benched in Mode B
with zero changes to `pi-lean-portal`'s `BrowserPlugin` interface —
they just implement the optional `connectOverCDP` method on their own
class.

### What a user-owned parity test file looks like

A user writes their own test file in their own package that depends on
`pi-lean-host`:

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

`registerMiniwobSuite` is the documented extension point. It registers
the 125-task matrix (13 trivial-solver confident + 10 best-effort + 77
skip-needs-goal-aware-solver + 35 skip-missing-tool) against the
provided plugin, with auto-skip gating delegated to the user's
`skipIf`.

### `BrowserPlugin` interface additions (cumulative)

Phase 1 + user-plugin support add two optional methods to
`BrowserPlugin` (`core/plugin-api.ts`). Both default to `null`/no-op so
existing plugins and existing tests are unaffected:

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

Both are optional. A user plugin can implement either, both, or
neither (in which case `pi-lean-host` skips it with a clear "plugin
supports neither getCdpEndpoint nor connectOverCDP — cannot bench"
reason).

**Caller guard note (`exactOptionalPropertyTypes: true`):** because the
repo enforces `exactOptionalPropertyTypes`, an optional method may be
`undefined` at runtime, not just absent-on-the-type. Host-side callers
must guard with `typeof plugin.getCdpEndpoint === "function"` (and
likewise for `connectOverCDP`) — **not** a truthiness check like
`if (plugin.getCdpEndpoint)`, which is safe under `strictNullChecks`
but is the wrong pattern to teach in the public API docs. The
`benchPlugin` mode negotiation uses the `typeof === "function"` guard
and the README's "Benchmarking your own BrowserPlugin" section shows
the same idiom.

### Documentation

`pi-lean-host/README.md` includes a "Benchmarking your own BrowserPlugin"
section: the two modes, the optional interface methods, a copy-paste
parity-test-file template, and how to interpret the 125-task matrix
output (what the skip reasons mean, what counts as a pass).

### Acceptance (Phase 1)

- `pi-lean-host` exports `benchPlugin`, `runMiniwobTask`,
  `registerMiniwobSuite`, and the parser/solver helpers from a
  documented `src/index.ts`.
- A mock plugin implementing only `connectOverCDP` (Mode B) can be
  benched against `click-button` and returns a reward.
- The shipped `miniwob-trivial.test.ts` uses `benchPlugin` (not a
  private code path) — proving the public API is the same API the
  shipped tests use.

## Risks & open questions

| Risk | Mitigation |
|---|---|
| **CDP endpoint read from Node Playwright** — confirm the exact API for reading the CDP endpoint of a `chromium.launch()`-ed browser. | **Step 1.0 spike (promoted ahead of §1.3/1.4):** launch chromium with `--remote-debugging-port=0`, verify `http://localhost:<port>/json/version` is reachable, find the port. If Playwright Node doesn't surface it cleanly, fall back to a fixed env-var-resolved port per test run (parallel CI cells need distinct slots). The two-CDP-client `ariaSnapshot()` cleanliness check runs in the same spike. |
| **Firefox `launchServer` refactor** — switching the firefox plugin to `launchServer` + `connect` may break existing firefox tests. | Phase 1 chromium-first; firefox is a Phase 1 stretch goal, slips to Phase 1.5 if the refactor is invasive. Gate behind a feature flag if needed. |
| **Two CDP clients on one Chromium** — Node Playwright + Python Playwright both attached. Standard feature, but validate no interleaving issues with `ariaSnapshot()` while Python holds a reference. | Phase 1.2 acceptance test: run `setup` from Python, `snapshot` from Node, confirm `@e`-ref tree is clean (no `bid` attrs in ARIA names). |
| **`browsergym[miniwob]` Python dep weight in CI** — gymnasium, numpy, playwright pin. | Dedicated venv cached on `requirements.txt` hash; only installed in the bench CI step, not for `test:ci`. |
| **`browsergym` upstream churn** — task table or setup JS changes upstream. | Pin `browsergym` version in `requirements.txt`. Re-pin deliberately; the adapter's `listTasks` method makes drift visible (test count changes). |
| **MiniWoB content drift** — `miniwob-plusplus` repo moves past `7fd85d71`. | Keep the pin; re-pin deliberately with a re-spike. |
| **Phase 2 cost** — agent-benchmarking LLM runs are expensive. | Phase 2 plan defers until Phase 1 lands; budget caps per run; manual/scheduled, not CI. |
| **Phase 4 cross-repo co-development coupling** — a portal behavior change + the task that exercises it live in two repos; landing both requires two PRs across repos with a dependency between them. | Editable install (`pip install -e /path/to/local/browsergym-webagent-quirks`) for local dev picks up changes without re-installing. The `requirements.txt` pin only matters for CI and releases. Accept "two PRs for one logical change" as the cost of decoupled release cadence; paid mostly during initial Phase 4 development, rarely after. |
| **Phase 4 task-vs-unit-test misclassification** — drawing the line between "behavioral → task package" and "framework-internals → mocked unit test" is judgment work; a concern misclassified as a task when it's really internals (or vice versa) creates either an awkward task or a test that should have migrated. | Per-concern decision during Phase 4 implementation, documented in the task package README. Rule of thumb: if it has a user-visible goal an agent achieves, it's a task; if it's asserting a code path's internal behavior, it's a unit test. |

## File-level inventory

### New files

- `packages/pi-lean-host/package.json`
- `packages/pi-lean-host/README.md` (includes "Benchmarking your own BrowserPlugin" guide)
- `packages/pi-lean-host/AGENTS.md`
- `packages/pi-lean-host/requirements.txt` (pinned: `browsergym[miniwob]`, `playwright`)
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
- `packages/pi-lean-host/docs/miniwob-spike-findings.md` (moved)

### Modified files

- `packages/pi-lean-portal/backends/chromium/index.ts` — add `--remote-debugging-port`, expose CDP endpoint
- `packages/pi-lean-portal/backends/firefox/index.ts` — (Phase 1.5) `launchServer` + `getWsEndpoint`
- `packages/pi-lean-portal/core/plugin-api.ts` — add two optional methods to `BrowserPlugin`: `getCdpEndpoint?(): string | null` (Mode A) and `connectOverCDP?(endpoint: string): Promise<void>` (Mode B). Both default to absent so existing plugins are unaffected.
- `packages/pi-lean-portal/__tests__/helpers/plugin-contract.ts` — no change (kept tests)
- `package.json` (root) — update `setup:miniwob` / `test:miniwob` scripts to target the host workspace
- `.github/workflows/ci.yml` — venv setup step, host test step, `fail-fast: false`, path filter, report upload
- `AGENTS.md` — testing section: portal structural vs host behavioral split
- `miniwob-integration-plan.md` — header note pointing here

### Deleted files

- `packages/pi-lean-portal/__tests__/helpers/miniwob.ts`
- `packages/pi-lean-portal/__tests__/helpers/miniwob-suite.ts`
- `packages/pi-lean-portal/__tests__/miniwob.test.ts`
- `packages/pi-lean-portal/__tests__/miniwob-helper.test.ts`
- `packages/pi-lean-portal/__tests__/camoufox-py.test.ts`, `camoufox-py-persistence.test.ts` (unfinished user-backend plugin tests — rebuilt post-migration as user-owned parity files via the `pi-lean-host` public API)
- `packages/pi-lean-portal/__tests__/invisible-py.test.ts`, `invisible-py-persistence.test.ts` (same rationale)
- `automate-testing.md` (repo-root research notes)

### Kept unchanged

- `packages/pi-lean-portal/__tests__/helpers/plugin-contract.ts`, `reddit-fixture.ts`, `test-server.ts`, `mock-plugin.ts`, `mock-python-bridge.py`
- All portal structural tests + per-backend contract tests (framework integration tests stay in portal — see "Integration-test scope")
- `scripts/sync-versions.js`, `scripts/release.mjs` (host is NOT lockstep; its npm namespace is reserved via the manual placeholder publish in §1.1, and we won't run `sync-versions.js` against it until it's ready)

## Decision log

1. **Option C over Option D** — Option D ported ~2476 lines to avoid a
   `browsergym` dep, contradicting the branch's "use benchmarking
   libraries" purpose and the `automate-testing.md` decision. Option C
   keeps `@e` refs untouched, takes the dep, deletes the port, unlocks
   the WebArena upgrade path.
2. **Dedicated `browsergym` venv** — isolates `gymnasium`/`numpy`/playwright-pin
   churn from the existing `chromium-py`/`firefox-py` venv.
3. **New `pi-lean-host` package** — host is a consumer of
   `pi-lean-portal`, not a test of it. Separate deps, release cadence,
   CI profile. Acyclic dep: `pi-lean-host` → `pi-lean-portal`. Name
   continues the Pylea pun (Lorne = the Host, evaluates performers).
4. **Chromium-first Phase 1** — CDP attach is straightforward for
   chromium; firefox needs a `launchServer` refactor (Phase 1.5 risk).
5. **Phase 2 covers both tool-presence and tool-description variation** —
   tool-presence first (reuses existing `/web` toggle), description
   variation second (needs a new override mechanism).
6. **`automate-testing.md` deleted** — research notes accidentally at
   repo root; attribution lives in the adapter header.
7. **Only behavioral evaluation moves to `pi-lean-host`** — portal
   framework-internals tests stay in `pi-lean-portal` (re-expressed as
   mocked unit tests where possible). Split criterion is *subject under
   test*, not *needs a browser*. The policy from Phase 4 onward: no new
   hand-rolled HTML fixtures in portal or host; new behavioral concerns
   go into the custom BrowserGym task package.
8. **User-plugin benchmarking is first-class from Phase 1** —
   `pi-lean-host` exports a public `benchPlugin` API and supports two
   browser-ownership modes (plugin-owns-browser via `getCdpEndpoint`,
   host-owns-browser via `connectOverCDP`) so any `BrowserPlugin` can
   be benched without modifying `pi-lean-host` source. Both interface
   additions are optional and default to absent.
9. **Custom BrowserGym task package as a standalone repo (Phase 4)** —
   portal's behavioral integration tests (reddit-dialog,
   cookie-persistence) are replaced by BrowserGym tasks living in a
   separate Python repo (`browsergym-webagent-quirks` or similar),
   imported by `pi-lean-host` as a `pip install` extra. Standalone repo
   (not a monorepo sibling) because it's a Python package, decouples
   release cadence from portal lockstep, is reusable beyond pi-lean,
   and mirrors the BrowserGym ecosystem structure (`miniwob-plusplus`,
   `workarena` are each their own repo). HTML fixtures move into the
   task package; `pi-lean-host/suites/` contains zero hand-rolled HTML.
   Framework-internals tests that can't be expressed as tasks stay as
   mocked portal unit tests.
10. **Versioning: stay on 0.x.x** — the Option C migration + big plugin
    update ships as a 0.x.x release, not 1.0.0. Rationale: planned
    future tools (`coord`, `drag`, `hover`, `select`) may be added as
    new required `BrowserPlugin` methods, which would be a breaking
    change requiring a 2.0 under 1.x. Holding 1.0 until the toolset
    stabilizes avoids shipping 1.0 followed quickly by 2.0. The
    `@e`-ref model and `BrowserPlugin` interface are proven but the
    surface is still growing; 1.0 marks "we commit to this API being
    stable," and we're not there yet. `pi-lean-host` is excluded from
    lockstep and stays on its own independent 0.x versioning regardless.
11. **`pi-lean-host` is not `private` — namespace reserved via an early
    placeholder publish** — npm offers no name reservation without a
    publish, so the easiest way to claim `pi-lean-host` is to ship a
    minimal `0.0.1` (stub README + scaffold `package.json`) from the
    §1.1 commit via `npm publish --access public`. The package is
    research tooling, not intended for end-user installation, but
    publishing it reserves the name before Phase 1 completes. Real
    content ships under later versions. `sync-versions.js` is not run
    against `pi-lean-host` until it's ready, so the placeholder publish
    is manual and one-off.
