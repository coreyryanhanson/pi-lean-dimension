# Cleanup Pass 2 — DRY/YAGNI review before merge to `cleanup/use-benchmarking-libraries`

> **Status:** Draft for review — no code changes made yet. This document is the stable reference for the cleanup pass.
> **Date:** 2026-07-06
> **Base branch:** `refactor/seperate-host-module` (HEAD `c864674`)
> **Reference point:** `cleanup/use-benchmarking-libraries` (the "no bloat" baseline used by `PLAN-browsergym-removal.md`)
> **Predecessor plan:** [`PLAN-browsergym-removal.md`](PLAN-browsergym-removal.md)

## 0. Context

`PLAN-browsergym-removal.md` was executed, but the execution was **asymmetric**: the Node-side `launchServer`/ws-endpoint revert mandated by §1.3 / Step 2 was carried out, while the equivalent **Python parity side was not**. A separate dead surface area (`benchPlugin` + Mode B + `connectOverCDP?`) also survived the pass. This document captures the remaining cleanup work, ordered by severity, with concrete file:line references and a verification gate per item.

The two governing principles, carried over from the predecessor plan:

- **YAGNI:** code whose only named consumer is hypothetical (WebArena later, a future ws-attach debugger) is a deletion candidate. Re-add when the consumer appears.
- **DRY:** don't keep two parallel implementations of the same BrowserGym-era capability (Node path reverted, Python path kept).

## 1. Findings

### 1.1 — Python-side `launchServer`/ws-endpoint machinery was never reverted  *(highest severity)*

The plan §1.3 + Step 2 explicitly said: drop the firefox `launchServer`/`_wsEndpoint`/`_browserServer` path, with verification gate `grep -n "launchServer\|_wsEndpoint\|_browserServer\|getWsEndpoint" packages/pi-lean-portal/` returning nothing. The **Node** side was reverted (`playwright-plugin.ts`, `firefox/index.ts`, `plugin-api.ts`). The **Python** side was not. It is all still present:

- `packages/pi-lean-portal/backends/firefox-py/bridge.py:54-68` — `PI_BROWSER_USE_LAUNCH_SERVER` env var, `firefox.launch_server()`, `_browser_server`, `firefox.connect(ws_endpoint)`.
- `packages/pi-lean-portal/backends/python-base/pi_browser_bridge/playwright_base.py:159-176, 231-249, 308-312` — `_use_launch_server` class attr, `_browser_server` state, `do_get_ws_endpoint()`, close handler.
- `packages/pi-lean-portal/backends/python-base/pi_browser_bridge/bridge.py:392-402, 441-446` — base `do_get_ws_endpoint` + the `get_ws_endpoint` RPC dispatch.
- `packages/pi-lean-portal/backends/python-adapter.ts:196-200, 339, 401, 553, 791-792, 1268-1297` — `_wsEndpoint` field, `_discoverWsEndpoint()`, the public `getWsEndpoint()` method, and the per-navigate call site.

Two compounding problems:

1. **Runtime cost, not just dead code.** `python-adapter.ts:791-792` calls `this._discoverWsEndpoint().catch(() => {})` on **every navigate** when `_wsEndpoint` is null. Each navigate on a Python plugin pays a `get_ws_endpoint` JSON-RPC round-trip that always returns `{"wsEndpoint": None}` in normal use (no plugin sets `_use_launch_server=True`).
2. **Orphaned by the interface.** `getWsEndpoint?` was removed from `plugin-api.ts`, so `python-adapter.getWsEndpoint()` (line 1296) implements a method that no longer exists on the contract and has zero consumers (`grep getWsEndpoint` across `pi-lean-host/` and `pi-lean-portal/__tests__/` returns nothing). It is also untested.

**Action:** mirror the Node revert on the Python side.

- `firefox-py/bridge.py`: delete the `PI_BROWSER_USE_LAUNCH_SERVER` branch in `_launch_browser`, restore plain `firefox.launch(headless=True)`.
- `python-base/pi_browser_bridge/playwright_base.py`: remove `_use_launch_server`, `_browser_server`, `do_get_ws_endpoint`, and the `_browser_server.close()` block in the close handler.
- `python-base/pi_browser_bridge/bridge.py`: remove `do_get_ws_endpoint` and the `get_ws_endpoint` RPC dispatch case.
- `python-adapter.ts`: remove `_wsEndpoint` field, `_discoverWsEndpoint()`, `getWsEndpoint()`, and the per-navigate call at line 791-792.

**Verify:** `grep -rnE "launchServer|_wsEndpoint|_browserServer|getWsEndpoint|get_ws_endpoint|_use_launch_server|launch_server|PI_BROWSER_USE_LAUNCH_SERVER" packages/pi-lean-portal/` returns nothing. `npm run test:ci` green. `npx tsc --noEmit` on the portal package passes.

---

### 1.2 — `benchPlugin` + Mode B + `connectOverCDP?` is dead surface area  *(high severity)*

`packages/pi-lean-host/adapter/bench.ts` (199 lines) has no consumer:

- No test calls `benchPlugin`. `suites/adapter-smoke.test.ts` and `suites/miniwob-trivial.test.ts` (via `registerMiniwobSuite`) both call `runMiniwobTask` directly.
- Mode B (`host-owns-browser`) depends on `plugin.connectOverCDP`, and **no shipped plugin implements `connectOverCDP`** — `grep -rn connectOverCDP packages/pi-lean-portal/backends/` returns nothing.
- `launchReferenceBrowser`, `resolveMode`, `BenchMode`, `BenchOpts`, `BenchResult` exist only to support `benchPlugin`.

The plan §1.3 kept `connectOverCDP?` on the interface with the justification *"the Mode B hook a future WebArena bridge would need."* But that justification is exactly what plan §5 guardrail #4 forbids: *"No pre-building the WebArena path. If a change is motivated by 'this will be useful for WebArena later,' reject it."* The plan is internally inconsistent here, and the implementation sided with the over-build.

**Decision: delete `connectOverCDP?` too.** Per plan §5 guardrail #4 ("No pre-building the WebArena path"), keeping a hook with no implementation and no consumer is the exact pattern the guardrail forbids. Re-add when a real WebArena/Mode B consumer appears — at which point the hook earns its keep alongside its consumer.

**Action:**

- Delete `packages/pi-lean-host/adapter/bench.ts`.
- Drop `benchPlugin`, `BenchMode`, `BenchOpts`, `BenchResult` from `packages/pi-lean-host/src/index.ts`.
- Remove `connectOverCDP?` from `packages/pi-lean-portal/core/plugin-api.ts` (no implementation, no consumer).
- Drop the `Mode B` references from `packages/pi-lean-host/README.md` (handled as part of §1.4).

**Verify:** `grep -rn "benchPlugin\|BenchMode\|BenchOpts\|BenchResult\|host-owns-browser\|launchReferenceBrowser\|connectOverCDP" packages/` returns nothing (other than this doc). `npm run test:ci` green. `npx tsc --noEmit` on both packages passes (no consumer references the removed interface method).

---

### 1.3 — Shipping bug: `generated/subdomains.ts` not in the published tarball  *(high severity — actual bug)*

`packages/pi-lean-host/solvers/register-suite.ts:45` imports `../generated/subdomains.js`. `registerMiniwobSuite` is exported from `src/index.ts` as the headline public API. But `packages/pi-lean-host/package.json` `files` array is `["README.md","AGENTS.md","LICENSE","src/","adapter/","solvers/","scripts/"]` — **no `generated/`**. The file is committed to git (so workspace/monorepo use works), but `npm publish` produces a tarball that breaks at runtime for anyone who imports `registerMiniwobSuite`.

**Action:** add `"generated/"` to the `files` array in `packages/pi-lean-host/package.json`.

**Verify:** `npm publish --dry-run -w pi-lean-host` lists `generated/subdomains.ts` in the tarball contents.

---

### 1.4 — README documents a different API than the one that ships  *(medium severity)*

`packages/pi-lean-host/README.md` is significantly out of sync with the code. It reads like an earlier design that was replaced.

| README claim | Actual code |
|---|---|
| `benchPlugin(plugin, { backendName, tasks, seed, baseUrl, mode, skipIf })` returns `Record<string, MiniwobResult>` (`:163-180`) | `benchPlugin(plugin, { taskName, mode?, solver, seed?, baseUrl, maxSteps?, episodeMaxTimeMs?, cdpPort? })` returns a single `BenchResult` (`adapter/bench.ts:80`). No batch API, no `backendName`, no `tasks[]`, no `skipIf`. |
| `TrivialSolver = (snapshot: string, goal: string) => TrivialAction \| null` (`:308`) | `TrivialSolver = (ctx: SolverCtx) => Promise<void>`, `SolverCtx = { plugin, taskId, goal, snapshot, snapshotNow() }` (`miniwob-adapter.ts:34`). No `TrivialAction` return type; solvers call `plugin.click/type` directly. |
| `MiniwobResult` / `MiniwobTaskOpts` types | Actual types are `MiniwobTaskResult` (also has `timedOut`, `setupFailed`, `error?`) and `RunMiniwobTaskOptions`. |
| `registerMiniwobSuite({ plugin, backendName, mode, skipIf })` (`:210-218`) | `registerMiniwobSuite(backend: MiniwobBackend, getBaseUrl: () => Promise<string>)`, `MiniwobBackend = { name, available, initPlugin }` (`solvers/register-suite.ts`). |
| `trivialSolvers` export | Actual export is `SOLVERS` (a `Map`). |
| Architecture diagram labels driver `(Python, venv)` (`:50`); run comment says "browser/venv/content absent" (`:114`) | Plan §6 decision #2 removed the dedicated venv. Stale. |
| Prerequisite "Python 3.10–3.12 (greenlet 3.0.3 does not build on 3.13)" | BrowserGym-pin-era; modern playwright supports 3.13. Stale. |

**Action:** rewrite the README against the actual signatures. Do this **after** §1.2 so it documents the final API (`runMiniwobTask` + `registerMiniwobSuite`), not a phantom one. Drop the venv references and the Python-version pinning language.

**Verify:** every code snippet in the README compiles against the actual exported types. Manual review against `src/index.ts`.

---

### 1.5 — Minor dead bits in `miniwob-driver.py`  *(low severity)*

- **`kind: "ws"` branch (line 36) is unreachable.** `miniwob-adapter.ts:375` only ever calls `connect` with `kind: "cdp"`. With the Python launchServer path gone (§1.1), there is no ws endpoint to connect to anyway. Drop the branch.
- **`shutdown` RPC doesn't exist.** `miniwob-adapter.ts` `stop()` calls `bridge.call("shutdown", {})`, but the driver has no `shutdown` method — `getattr` returns `None` and produces `{"error": "Unknown method: shutdown"}` every time, swallowed by `.catch(() => {})`. Either add a `shutdown` that breaks the main loop, or drop the call (the `_kill()` SIGTERM already ends the process).
- **`episode_id` and `task_ready` in the `validate()` response (lines 70, 72)** are never read by the adapter (it reads only `reward`, `raw_reward`, `done`, `reason`). YAGNI — drop or keep deliberately, but flag as intentional.
- **`teardown()` is a documented no-op** returning `{"ok": True}`, called with `.catch(() => {})` and result ignored. Pure round-trip overhead. Fine to keep as a deliberate symmetry placeholder; flag it as intentional or drop it.

**Decision: drop all four.** Pure YAGNI — each is either unreachable, ignored by the adapter, or a documented no-op whose result is discarded. The SIGTERM in `_kill()` already handles process teardown.

**Action:**

- Drop the `kind: "ws"` branch in `connect()`.
- Drop the `bridge.call("shutdown", {})` call in `miniwob-adapter.ts` `stop()`.
- Drop `episode_id` and `task_ready` from the `validate()` response object.
- Drop the `teardown()` method from the driver and the `bridge.call("teardown", {})` call in `runMiniwobTask`.

**Verify:** `python -c "import ast; ast.parse(open('packages/pi-lean-host/adapter/miniwob-driver.py').read())"` parses. `grep -n "teardown\|shutdown\|kind: \"ws\"\|episode_id\|task_ready" packages/pi-lean-host/` returns nothing. `npm run test:miniwob` (if chromium + content available) passes the same 13 tasks.

---

### 1.6 — `package.json` keywords say `pi-extension` but the package isn't one  *(low severity)*

`packages/pi-lean-host/package.json` `keywords: ["pi-package", "pi-extension", "benchmark", "miniwob"]`, but both root `AGENTS.md` and the package's own README say "research tooling — not a pi extension, not in the umbrella meta-package." The `pi-extension` keyword is misleading for registry discovery.

**Action:** drop `pi-extension` from keywords. Keep `pi-package` for monorepo affinity, or drop both since the package is independently versioned.

---

### 1.7 — Dual bail mechanism in `runMiniwobTask`  *(low severity)*

`miniwob-adapter.ts:425-445` polls `validate()` in a `while (steps < maxSteps)` loop that *also* checks `Date.now() - pollStart > donePollTimeoutMs`. Two independent bail conditions for one "poll until done" loop, with `timedOut` only set on the time bail — a `maxSteps` bail returns with `timedOut=false` and `steps=maxSteps`, which is misleading (it did time out, by a different counter).

With defaults (`maxSteps=20`, `donePollIntervalMs=200ms` → ~4s minimum vs `donePollTimeoutMs=10_000ms` wall clock), the time limit almost always wins first, making `maxSteps` decorative.

**Action:** collapse to one mechanism. Wall-clock `donePollTimeoutMs` is the natural one; derive `steps` as a reported count, not a bail condition. Either drop `maxSteps` from `RunMiniwobTaskOptions`, or keep it as a hard upper bound and set `timedOut=true` on both bails with a `bailReason` field distinguishing them.

**Verify:** `npm run test:ci` green. adapter-smoke still asserts `rawReward > 0` for `click-test`.

---

### 1.8 — Documentation gaps in `AGENTS.md` files  *(low severity — not bloat, related)*

Neither root `AGENTS.md` nor `packages/pi-lean-portal/AGENTS.md` mentions the `getCdpEndpoint?`/`connectOverCDP?` interface additions or the `onBrowserLaunched()` lifecycle hook on `PlaywrightPluginBase`. Plan §7 listed the portal AGENTS as a rewrite target.

**Action:** add a short paragraph to `packages/pi-lean-portal/AGENTS.md` covering the `getCdpEndpoint?` optional, the `onBrowserLaunched()` post-launch hook, and the CDP-endpoint discovery utility (`core/shared/cdp-endpoint.ts`). §1.2 removes `connectOverCDP?`, so do not document it.

---

## 2. Suggested execution order

Ordered so each step is independently verifiable and the README (§1.4) lands last so it documents the final API.

1. **§1.1** — Python launchServer/ws revert. Biggest LOC saving; kills the per-navigate RPC cost.
2. **§1.2** — delete `bench.ts` + `connectOverCDP?`. Second biggest saving; resolves the plan's internal §1.3-vs-§5 contradiction.
3. **§1.3** — add `generated/` to `files`. One-line shipping-bug fix.
4. **§1.5** — drop dead driver branches (`ws`, `shutdown`).
5. **§1.7** — collapse the dual bail mechanism.
6. **§1.6** — drop `pi-extension` keyword.
7. **§1.4** — rewrite README against the final API (after §1.2 settles what the API actually is).
8. **§1.8** — AGENTS.md paragraph for `getCdpEndpoint?` / `onBrowserLaunched()`.

> **Decisions locked:** §1.2 deletes `connectOverCDP?` (no future-surface carve-out). §1.5 drops all four dead bits (no symmetry carve-out for `teardown`).

## 3. Verification gates (run after the pass)

1. `npm run test:ci` is green.
2. `grep -rnE "launchServer|_wsEndpoint|_browserServer|getWsEndpoint|get_ws_endpoint|_use_launch_server|launch_server|PI_BROWSER_USE_LAUNCH_SERVER" packages/pi-lean-portal/` returns nothing.
3. `grep -rn "benchPlugin|BenchMode|BenchOpts|BenchResult|host-owns-browser|launchReferenceBrowser" packages/` returns nothing (other than this doc).
4. `npm publish --dry-run -w pi-lean-host` lists `generated/subdomains.ts` in the tarball.
5. `grep -rnE "browsergym|BrowserGym|bgym|ALL_MINIWOB|task\.setup|task\.validate|AbstractBrowserTask|build_task_table|playwright==1\.44" packages/ scripts/ .github/ AGENTS.md` still returns only the deliberate historical/attribution hits (carried over from predecessor plan §4).
6. `npm run test:miniwob` (if chromium + MiniWoB content available) passes the same 13 tasks as before.
7. LOC accounting: `git diff --stat cleanup/use-benchmarking-libraries HEAD` should show `pi-lean-portal` **smaller** than its current state by ~250-300 LOC (Python parity revert) and `pi-lean-host` **smaller** by ~200 LOC (`bench.ts` + dead driver branches).

## 4. Expected end state

After the pass:

- `pi-lean-portal` Python parity path is bit-identical to the Node parity path — both reverted, no `launchServer`/ws-endpoint surface anywhere.
- `pi-lean-host` ships a single public API surface (`runMiniwobTask` + `registerMiniwobSuite` + the parser/solver helpers), no `benchPlugin`/Mode B dead layer.
- The published `pi-lean-host` tarball actually works for `registerMiniwobSuite` consumers.
- The README documents the API that exists.
- The `connectOverCDP?` optional is deleted (YAGNI — re-add when a real Mode B consumer appears), not left as half-implemented dead code.
- The branch is ready to merge to `cleanup/use-benchmarking-libraries` with the bloat actually bounded.
