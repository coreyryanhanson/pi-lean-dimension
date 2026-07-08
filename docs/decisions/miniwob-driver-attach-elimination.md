# MiniWoB Driver: Eliminate the Cross-Process Browser Attach

**Status:** Proposal with decisions resolved (drafted 2026-07-07;
reviewer feedback incorporated 2026-07-07 — awaiting implementation)
**Context:** Phase 7 MiniWoB failures — `refactor/seperate-host-module` branch

## TL;DR

The MiniWoB driver (`miniwob-driver.py`) runs a **second** Playwright
browser connection that attaches to the plugin's already-launched
browser (chromium: CDP, firefox: ws). This cross-process attach is
solving a problem that doesn't exist. The driver's entire job is
~10 lines of JavaScript execution on a page the plugin already owns
and can run via `plugin.evaluate()`. Eliminating the driver's browser
connection fixes every firefox / python-backend / concurrency failure
documented in `PHASE7-REMAINING-ISSUES.md` and makes the cross-process
attach framework built this branch orphaned (deletable).

This document proposes that change and records what it does and does
not sacrifice.

---

## The problem

### What the driver actually does

`miniwob-driver.py` exposes three RPC methods over stdio JSON-RPC:

- `connect(endpoint, kind)` — attach a **second** Playwright client to
  the plugin's browser (CDP for chromium, `firefox.connect(ws)` for
  firefox).
- `setup(subdomain, base_url, seed, episode_max_time_ms)` — navigate to
  the task URL, run `Math.seedrandom(...); core.EPISODE_MAX_TIME = ...;
  core.startEpisodeReal()`, wait for `WOB_TASK_READY`, read
  `core.getUtterance()`.
- `validate()` — read `{ reward, raw_reward, done, reason }` from the
  `WOB_*` page globals.

That is the driver's complete behavior. It performs no
Python-specific computation. It does not need a Playwright client for
any purpose other than executing those JS strings on the page.

### Why that's an architectural mistake

`BrowserPlugin` already exposes both primitives the driver needs:

- `plugin.navigate(url, taskId, timeoutMs)` — owns the page, launches
  the browser (or reuses an existing context).
- `plugin.evaluate(taskId, expression)` — runs arbitrary JS on its own
  page, returning the result.

So `setup` and `validate` could be a handful of `plugin.evaluate`
calls in `miniwob-adapter.ts`. No subprocess. No Python. No
Playwright-on-the-driver-side. No CDP port scan. No `launchServer`.
No `getAttachEndpoint`. No ws endpoint. No Node/Python Playwright
version matching. No cross-process attach of any kind.

The driver was built as a *second* page-owner and then stitched to the
first via attach plumbing. This came from copying BrowserGym's shape:
BrowserGym is Python and its task owns the page, so the original
design reasoned "the episode lifecycle is Python, so we need a Python
process with a Playwright connection." But in our architecture **the
plugin owns the page**, not the task. A second page-owner is not just
unnecessary — on firefox it is impossible to make share the page.

### Why it breaks on firefox

Playwright Firefox (Juggler) gives each `firefox.connect(ws)` client
its own **isolated** set of BrowserContexts. Confirmed empirically:

- A Node client connects to a `launchServer`, creates a context + page,
  and sets `window.__SHARED = 'hello-from-node'`.
- A second Node `connect(ws)` to the same server reports
  `b2.contexts.length === 0`.
- A Python `pw.firefox.connect(ws)` reports `len(b.contexts) === 0`,
  and a page it creates reads `window.__SHARED` as `undef`.

There is no Playwright Firefox equivalent of chromium CDP's
page-sharing across clients. CDP (`connect_over_cdp`) shares the
browser's existing contexts; ws-attach does not.

The concrete failure this produces: the driver's `setup()` runs the
episode-start JS on **its own isolated page**, while the Node plugin
clicks on **its own page** where the MiniWoB `sync-task-cover` "START"
overlay is still intercepting pointer events. The two pages never
meet. All three confident firefox tasks fail with `rawReward=0` and
clicks time out against the cover.

### Why it breaks on the Python backends

- **`firefox-py`** calls `self._pw.firefox.launch_server(...)`. Python
  Playwright has **no `launch_server`** method (verified: only `launch`,
  `connect`, `connect_over_cdp`, `launch_persistent_context`). Every
  navigate throws `'BrowserType' object has no attribute
  'launch_server'` on the first task. **Re-verified 2026-07-07**
  against the pinned venv at
  `packages/pi-lean-portal/backends/python-base/.venv`:
  `dir(pw.firefox)` yields exactly `connect`, `connect_over_cdp`,
  `executable_path`, `launch`, `launch_persistent_context`, `name`,
  `on`, `once`, `remove_listener` — no `launch_server`. The failure
  narrative holds as written.
- **`chromium-py`** never discovers a CDP endpoint. The Python adapter
  only calls `resolveCdpEndpoint` when `CDP_PORT` is set to a numeric
  value (a deliberate cost-savings gate), so in any environment that
  doesn't set `CDP_PORT` — including the default venv setup —
  `getAttachEndpoint()` returns `null` for every task and the suite
  fails at "browser may not have launched with an attach port."

### Why the chromium Node path has a concurrency race

`npm run test:miniwob` runs 5 suite files in parallel. Each spawns its
own chromium. The `ss -tlnp` port scan in `resolveCdpEndpoint` can
pick up a *different* instance's port, miss the timing, or scan before
the port is bound. Isolation passes 13/13; the parallel run fails
52/53 with "getAttachEndpoint() returned null" and "Target page,
context or browser has been closed."

### The Node/Python Playwright version coupling

Even when the attach *would* work, the driver's Python Playwright and
the plugin's Node Playwright must be the same version. The branch
shipped with Node 1.61 vs Python 1.60, and firefox ws attach rejected
the connection with `428 Precondition Required` ("Playwright version
mismatch: server v1.61 / client v1.60"). This is a permanent
maintenance hazard: any drift between the two installs silently breaks
firefox-py and (per the spike notes) chromium-py.

---

## Proposed solution

**Run the MiniWoB episode lifecycle through `plugin.evaluate()` on the
plugin's own page. Remove the driver's browser connection entirely.**

### Concrete changes

1. **`miniwob-adapter.ts`** — replace the `BridgeClient` subprocess +
   `connect`/`setup`/`validate` RPC sequence with direct
   `plugin.evaluate(taskId, ...)` calls:
   - `setup` JS: `Math.seedrandom({seed});
     core.EPISODE_MAX_TIME = {ms}; core.startEpisodeReal();` then
     **poll `plugin.evaluate(taskId, 'typeof WOB_TASK_READY !==
     "undefined" && WOB_TASK_READY')`** with the existing
     `donePollIntervalMs` / `donePollTimeoutMs` budget until true,
     mirroring `miniwob-driver.py:64`'s
     `wait_for_function("WOB_TASK_READY")` — only then read
     `core.getUtterance()`. Reading `getUtterance()` before
     `WOB_TASK_READY` is set returns stale/empty utterances.
     Mirror BrowserGym's `removeDisplay` block (delete
     `sync-task-cover`, `reward-display`, `click-canvas` and
     monkeypatch `startEpisodeReal`/`endEpisode`/`getUtterance` to
     bring them back transiently) so the cover never intercepts the
     solver's clicks. (Navigation note: the driver today re-`goto`s
     with `wait_until="load"` after `plugin.navigate`; the rewrite
     collapses to a single `plugin.navigate` using the portal's
     nav-settle, which is stricter than a raw `load` event — confirm
     `core.startEpisodeReal()` is safe to run after nav-settle.)
   - `validate` JS: `() => ({ reward: WOB_RAW_REWARD_GLOBAL > 0 ? 1
     : 0, raw_reward: WOB_RAW_REWARD_GLOBAL, done: WOB_DONE_GLOBAL,
     reason: WOB_REWARD_REASON })`, polled with the existing
     `donePollIntervalMs` / `donePollTimeoutMs` budget.
   - **Error propagation:** replace the `bridge.call` try/catch with
     checks on `EvaluateResult.success` / `EvaluateResult.error` for
     both `setup` and `validate`. A failed `evaluate` must surface as
     `result.setupFailed = true` with the engine error in
     `result.error` — the same shape the driver's RPC exceptions
     produce today.
   - Drop `getAttachEndpoint()`, the `attachFn` branch, and the
     `BridgeClient` class. Per decision 2, also remove the
     `RunMiniwobTaskOptions.pythonPath` option and the
     `MiniwobBackend.driverPythonPath` field (breaking — see decision
     2). The `PythonPluginAdapter` constructor's `pythonPath` config
     (used by the chromium-py / firefox-py suite files to spawn the
     backend bridge) is a **separate** field and stays.
2. **`miniwob-driver.py`** — delete, or reduce to a pure JS-string
   templating module with no `playwright` import and no browser. If
   kept as a string-template helper it has no reason to be Python.
3. **`firefox-py/bridge.py`** — drop the dead `launch_server` path;
   use plain `self._pw.firefox.launch(headless=True)`. The python
   adapter's `_discoverWsEndpoint` / `_wsEndpoint` plumbing is no
   longer needed.
4. **`chromium-py/bridge.py`** — unchanged (it already uses plain
   `launch`); only the adapter-side CDP discovery goes away.
5. **Suite helper** — drop `DRIVER_PYTHON_PATH` and its auto-detection;
   the harness no longer needs the venv python to spawn a driver.
   The venv is still needed to *run* the python bridge backends, but
   not to drive MiniWoB.

### What becomes orphaned

The cross-process attach framework built this branch exists **only**
to support Mode A MiniWoB. Nothing else in the portal consumes
`getAttachEndpoint()`. With the driver no longer attaching, the
following are orphaned:

- `core/shared/cdp-endpoint.ts` (~193 lines)
- `chromium/index.ts` `onBrowserLaunched` → `resolveCdpEndpoint`
  wiring (~62 lines)
- `firefox/index.ts` `launchServer` / `_wsEndpoint` /
  `getAttachEndpoint` / `_reconnectBrowser` (~45 lines)
- `playwright-base/playwright-plugin.ts` reconnect machinery (~147
  lines)
- `python-adapter.ts` `_cdpEndpoint` / `_wsEndpoint` / discovery /
  `getAttachEndpoint` plumbing (~128 lines)
- `plugin-api.ts` `getAttachEndpoint?()` + `AttachEndpoint` union
  (~39 lines)

**Decision: delete the orphaned framework.** It is ~614 lines built
solely for Mode A MiniWoB. Nothing in the portal consumes
`getAttachEndpoint()` — not `web-fetch`, not `browser-navigate`, not
profiles, not cookies, not the `/web` toggle. Retaining it means
carrying unconsumed, lightly-tested code (the `ss` scan has a known
concurrency race; the firefox `launchServer` path is unreachable on
Python) as a speculative capability with no consumer. If a future
external-attach consumer appears, reintroducing it against a real
consumer is cleaner than maintaining it against none. The branch's net
diff shrinks meaningfully, which also helps the Phase 0 footprint goal.

**Reversal note:** if an unshipped consumer of `getAttachEndpoint()`
is identified later (e.g. a planned screenshot tool, CDP inspector, or
third-party rider on the portal's browser), revisit this decision
before the branch merges.

### What the harness continues to prove

The adapter's stated invariant — "the plugin drives actions; the
driver only runs setup/validate and never touches the DOM" — is
**strengthened**. Setup and validate become `plugin.evaluate` calls,
so the plugin is the sole owner of the page and all JS execution. The
trivial solvers still call `plugin.click` / `plugin.type` /
`plugin.snapshot` exactly as before. The harness continues to
validate the portal's real `@e`-ref action layer on a live MiniWoB
page across chromium, firefox, chromium-py, and firefox-py.

---

## What this sacrifices

### Nothing about portal backend features

`BrowserPlugin`, every backend implementation, normal portal
browsing, named/session profiles, cookie + storage-state persistence,
the accessibility-tree snapshot, bot detection, dialog handling,
`web-fetch`, `/web` toggle semantics — all unchanged. The change is
confined to the MiniWoB harness in `pi-lean-host` plus the deletion of
attach plumbing that has no portal consumer.

### Nothing about cross-engine parity coverage

The four backends (chromium Node, firefox Node, chromium-py,
firefox-py) all expose `navigate` + `evaluate`, so all four remain
drivable by the rewritten harness. Firefox-py becomes runnable for
the first time (the `launch_server` blocker is removed). Chromium-py
becomes runnable without a `CDP_PORT` env var. The 125-task suite and
the 13-task trivial-solver subset are unchanged.

### One architectural capability is retired

The "plugin-owns-browser, external client attaches" model (Mode A)
goes away with the attach framework. If `getAttachEndpoint()` is
deleted, an external CDP/ws client can no longer ask the portal for
its browser's attach descriptor. **There is no current consumer of
this capability** — it was built solely for MiniWoB — but it is the
one thing this proposal removes that isn't strictly MiniWoB-internal.
If a future use case wants it (e.g. an out-of-process observer,
screenshot tool, or third-party CDP client riding on the portal's
browser), it would have to be reintroduced. Keeping the framework
as-is (the "retain" option above) preserves this at the cost of
~614 lines of unconsumed, lightly-tested code.

### The harness no longer exercises cross-process attach

Today's harness implicitly tests that a separately-spawned Playwright
client can attach to a running portal browser. That is no longer
tested. This is desirable — the attach is fragile (version coupling,
`ss` races, firefox isolation) and was never a portal feature — but
it should be recorded as a deliberate scope reduction. If cross-engine
attach ever becomes a real portal feature, it will need its own test
suite.

### The driver subprocess disappears

If the driver is fully deleted, the `runMiniwobTask` internals move
fully into TypeScript and the `pythonPath` / `driverPythonPath`
options are **removed** (per decision 2, a breaking change to the
exported types). User-owned parity tests that passed `pythonPath` get
a compile error pointing at the change rather than a silently-ignored
option. The "bring your own driver" extension point narrows to
"bring your own plugin." This matches the documented public API
(`registerMiniwobSuite(backend, getBaseUrl)`) which never exposed the
driver as a customization point.

---

## Decisions (resolved)

1. **Delete the attach framework — source AND structural tests.**
   ~614 lines of orphaned source with no portal consumer, plus the
   structural tests that exercise only that framework. The deletion
   scope must include both or `npm run test:ci` regresses:
   - **Source (~614 lines):** `core/shared/cdp-endpoint.ts`, the
     chromium `onBrowserLaunched` → `resolveCdpEndpoint` wiring, the
     firefox `launchServer` / `_wsEndpoint` / `getAttachEndpoint` /
     `_reconnectBrowser` block, the `playwright-base` reconnect
     machinery, the `python-adapter` `_cdpEndpoint` / `_wsEndpoint` /
     discovery / `getAttachEndpoint` plumbing, and the `plugin-api`
     `getAttachEndpoint?()` + `AttachEndpoint` union.
   - **Structural tests (~950 lines):** `__tests__/cdp-endpoint.test.ts`
     (260 lines, entirely tests `resolveCdpEndpoint`/`scanSsForEndpoint`)
     and `__tests__/playwright-reconnect.test.ts` (349 lines, entirely
     tests the firefox `launchServer`/`_reconnectBrowser` path) are
     deleted outright; the `describeCdpEndpoint` and `describeWsEndpoint`
     blocks in `__tests__/python-adapter.test.ts` (~360 lines, assert
     `adapter.getAttachEndpoint()`) are removed. `plugin-contract.test.ts`
     does **not** touch `getAttachEndpoint` (verified by grep) and is
     unaffected. Note `npm run test:ci` excludes `**/pi-lean-host/**`
     but **not** these portal test files, so they are load-bearing for
     the CI gate.
   Revisit only if an unshipped consumer of `getAttachEndpoint()` is
   identified. **Expected invariant: `npm run test:ci` stays green**
   alongside `npm run test:miniwob` going green.
2. **Delete the driver entirely; inline the JS into `miniwob-adapter.ts`.**
   Once the driver has no browser it is ~10 lines of JS string
   templating — keeping it as a Python module adds a subprocess spawn,
   a JSON-RPC transport, a venv dependency, and a Node/Python version
   coupling, all to template three JS strings clearer inlined next to
   their `plugin.evaluate` callers. If the JS strings are preferred in
   one place, a TypeScript helper module (`miniwob-episode.ts`
   exporting `SETUP_JS`, `VALIDATE_JS`, `REMOVE_DISPLAY_JS` constants)
   achieves that without a subprocess. This removes the last Python
   dependency from the MiniWoB harness.
   **Also remove `RunMiniwobTaskOptions.pythonPath` and
   `MiniwobBackend.driverPythonPath`** (breaking change to exported
   types). Both exist only to spawn the driver subprocess and have no
   purpose once the driver is gone; retaining them as ignored leaves a
   dead public field that silently does nothing. `pi-lean-host` is
   independently versioned research tooling (not lockstep, not in the
   umbrella meta-package), so the blast radius of the breaking change
   is small and a compile error is a clearer signal to any user-owned
   parity test than a silently-ignored option. The
   `PythonPluginAdapter` constructor's `pythonPath` config (a separate
   field used by the chromium-py / firefox-py suite files to spawn the
   backend bridge) is unaffected and stays.
3. **Port BrowserGym's `removeDisplay` verbatim with attribution;**
   simplify to a paraphrase later only if confirmed safe.
   Apache-2.0 (ServiceNow) — the attribution must be a proper
   Apache-2.0 notice, not just a name: reproduce BrowserGym's
   copyright line (if present in the sourced file), state the source
   ("obtained from BrowserGym, ServiceNow, Apache-2.0; copied
   verbatim"), and note that no changes were made to the copied
   block. Start verbatim because (a) it's the same amount of code in
   the adapter either way (a JS string constant), (b) it removes the
   "did my paraphrase cover the edge case?" question — notably
   whether `core.getUtterance()` depends on the display divs being in
   the DOM (BrowserGym's `bringBackDisplay`-during-`getUtterance`
   monkeypatch suggests it does), and (c) the swap direction verbatim
   → paraphrase is just as cheap as paraphrase → verbatim if a future
   simplification is wanted, so the default should be the one with no
   unknowns. The paraphrase remains available as a later
   simplification once the bring-back-during-utterance logic is
   confirmed unused.
4. **Remove the chromium-py `CDP_PORT`-only gate and the
   `resolveCdpEndpoint` call.** The gate was a cost-savings hack that
   silently fails MiniWoB in any environment without `CDP_PORT`. With
   the driver gone, nothing in the portal reads `_cdpEndpoint` — the
   python adapter's `getAttachEndpoint()` becomes dead code along with
   the rest of the attach framework (per decision 1). Removing the
   gate and call drops the last `ss` invocation from the python
   adapter and eliminates the silent-failure mode. Verified: the only
callers of `getAttachEndpoint()` are in `miniwob-adapter.ts`.
5. **Keep the venv + `playwright` install in CI; update the comment.**
   The venv is still required — `chromium-py` and `firefox-py` are
   Python and need `playwright` to run their bridges. What changes is
   *why*: today the install is implicitly justified as "for the
   MiniWoB driver"; after the change it's "for the python bridge
   backends." The install step itself stays identical; only the
   comment changes. Secondary: run the 5 suite files in parallel
   (default) — the concurrency race is gone with the CDP scan removed.
   Only serialize with `--no-fileParallelism` if a flake appears.

## Expected outcome

All five shipped suite files pass their 13 runnable tasks; the 112
skips remain for the same reasons (no goal-aware solver / no
coordinate tool). The branch's `npm run test:miniwob -w pi-lean-host`
goes green without serializing the suites, without version-pinning the
Python Playwright to Node's, and without a CDP port scan. `npm run
test:ci` stays green because the structural tests for the deleted
attach framework are removed in the same change (decision 1). The
cross-engine parity goal of the refactor is met for all four
backends.
