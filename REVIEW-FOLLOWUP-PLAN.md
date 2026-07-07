# Review Follow-up Plan — `refactor/seperate-host-module`

Multi-phase plan to close out the reviewer findings on the host-split branch.
Base of comparison: `cleanup/use-benchmarking-libraries`. Goal: a minimal,
cross-engine, user-extensible `pi-lean-host` package with no pivot-era drift.

**Out of scope** (handled on the parent stealth-browser branch, to be merged
there and wired up later): making the shipped `camoufox-py` / `invisible-py`
example bridges attach-capable. The extensibility *API* (`registerMiniwobSuite`)
is in scope; the example-bridge attach plumbing is not.

Each phase ends with a **Diff-shrink checkpoint** — an explicit place to re-read
the current diff and cut lines that drifted beyond what the phase needed. The
intent is to keep the branch footprint minimal per the user's original request
("the only lines of code introduced in this new branch compared with the
previous is necessary to our plan").

---

## Phase 0 — Doc / footprint cleanup (Blocker A, YAGNI doc refs)

**Goal:** Remove pivot-era scratch from the shipped tree; fix stale references.

- Delete from repo root (archive externally or under `docs/decisions/` only if
  the team wants in-repo history):
  - `CLEANUP-pass-2.md` (180) — **must not ship**: §1.1 contradicts the restored
    `firefox-py/bridge.py:51-68` + `playwright_base.py:159-176` launchServer
    machinery that commit `3feee3c` intentionally restored.
  - `DESIGN-in-process-browsergym.md` (776)
  - `browsergym-migration-phase-1.5.md` (720)
  - `browsergym-migration-plan-v2.md` (621)
- Trim `PLAN-browsergym-removal.md` (320) to a short decision record only
  (why BrowserGym was abandoned, what replaced it). Or move the whole file
  under `docs/decisions/` and leave a one-line pointer at root.
- `browsergym-migration-plan.md` (pre-existing, 1058, modified in this branch):
  the "Superseded" header edit is in-scope as decision history, but the file
  should not remain 1058 lines at root. Apply the same archival policy.
- Remove stale `benchPlugin` / `adapter/bench.ts` references from:
  - `AGENTS.md:96,100`
  - `packages/pi-lean-host/AGENTS.md` (directory-layout entry)
- Fix stale comment `packages/pi-lean-host/suites/miniwob-trivial.test.ts:6`
  ("Phase 1.5 will add: firefox, chromium-py, firefox-py") — firefox shipped;
  update to reflect actual state after Phase 2.
- Drop dead CI exclude `**/miniwob.test.ts` from root `package.json:11`
  `test:ci` (file was deleted from portal).
- Update `AGENTS.md` test-file-summary table to reflect 4 host suite files
  (after Phase 2) and the actual `test:miniwob`/`test:miniwob -w pi-lean-host`
  commands (after Phase 3).

**Estimated delta:** −~2600 lines (mostly deletions) + a few doc-line edits.

### Diff-shrink checkpoint 0

- `git diff --stat cleanup/use-benchmarking-libraries..HEAD` — confirm the five
  root docs are gone (or moved) and the only remaining top-level plan doc is a
  trimmed decision record.
- Verify no `benchPlugin`/`bench.ts` string survives anywhere
  (`grep -rn benchPlugin --include='*.md'`).
- Confirm `test:ci` exclude list no longer names a deleted file.

---

## Phase 1 — Extract shared MiniWoB suite helper (DRY, prep for Phase 2)

**Goal:** Collapse the two ~90%-identical suite files into one shared factory so
the per-engine file is ~10 lines and adding py backends is trivial.

- In `packages/pi-lean-host/solvers/` (or a new `suites/` helper), add
  `defineMiniwobSuite(backend, opts?)` / `createMiniwobSuiteFile(backend)`:
  - owns `HTML_ROOT`, `CONTENT_AVAILABLE` / `HAS_EXTERNAL_URL` gates,
    `ensureBaseUrl` / `sharedServer` / `afterAll` teardown, `BACKENDS` shape.
  - takes a `MiniwobBackend` (`{name, available, initPlugin}`) + availability
    flag.
- Rewrite `suites/miniwob-trivial.test.ts` and `suites/miniwob-firefox.test.ts`
  to call the helper.
- Keep `adapter-smoke.test.ts` separate (it's an end-to-end smoke, not a
  125-task suite) — but fix its inline parsers in Phase 4.

### Diff-shrink checkpoint 1

- The net line count of `suites/miniwob-trivial.test.ts` +
  `suites/miniwob-firefox.test.ts` + new helper should be **less** than the
  current sum of the two files. If it's not, the helper is over-engineered —
  cut it back.
- Inspect the helper for YAGNI: no config knobs, no mode flags beyond what
  chromium and firefox actually need. If a parameter is only used by one
  backend, inline it instead.

**Recommendation:** yes, evaluate here. This phase is *purely* a shrink
opportunity — if the helper doesn't produce a net reduction, revert it and
just copy-paste the py suites in Phase 2 (small duplication, no abstraction
debt). Prefer the helper only if it pays off across 4+ backends.

---

## Phase 2 — Add `chromium-py` and `firefox-py` suites (Blocker D)

**Goal:** Realize commitment #1 — integration tests across every shipped
browser.

- Add `suites/miniwob-chromium-py.test.ts` and
  `suites/miniwob-firefox-py.test.ts` via the Phase 1 helper.
- Backend factory: `PythonPluginAdapter` wrapping the respective
  `backends/<dir>/bridge.py` (already supported by `python-adapter.ts`).
- Availability probe: detect Python + the engine's browser binary; auto-skip
  (with reason) when absent — mirrors the firefox suite's gate.
- The harness plumbing already exists — verify, don't rebuild:
  - chromium-py: `python-adapter.ts:_discoverCdpEndpoint` +
    `chromium-py/bridge.py` `--remote-debugging-port=0`.
  - firefox-py: `python-adapter.ts:_discoverWsEndpoint` + `get_ws_endpoint`
    RPC + `firefox-py/bridge.py:51-63` `launch_server`.
- Add a `firefox-ws` attach-path test to `python-adapter.test.ts` (mock bridge
  returns `{wsEndpoint}` → `getAttachEndpoint()` returns `{kind:"firefox-ws"}`).
  This is the one coverage gap the reviewer flagged in (F).

### Diff-shrink checkpoint 2

- Each new py suite file should be ~10–20 lines (helper + backend factory +
  availability probe). If a file exceeds ~30 lines, it's carrying logic that
  belongs in the helper or the adapter — push it down.
- Before adding any new adapter code: re-read `python-adapter.ts` and confirm
  the py attach path is genuinely complete. If it is, **add zero adapter
  lines** — only the two suite files. If it isn't, scope the adapter change to
  the minimum and note it explicitly.
- Verify the driver error-framing mismatch (`miniwob-driver.py:80-86` writes
  `traceback` at top level; `miniwob-adapter.ts:BridgeClient._flush` reads
  `resp.error.data?.traceback`) — fix in the adapter only if it blocks
  debugging a failing py suite. One-line read-path change, no driver edit
  needed.

**Recommendation:** yes, evaluate here. The risk is "while adding py suites,
incidentally refactor the adapter." Resist that. The adapter is already
correct; the phase should be ~2 small files + 1 test addition.

---

## Phase 3 — CI cross-engine (Blocker D/CI)

**Goal:** CI actually runs firefox and python backends, not just chromium.

- Broaden `packages/pi-lean-host/package.json` `test:miniwob` from
  `vitest run suites/miniwob-trivial.test.ts` to `vitest run suites/` (runs
  all four suite files + smoke). Update root `package.json` `test:miniwob`
  alias and AGENTS.md commands accordingly.
- `.github/workflows/ci.yml` `miniwob` job:
  - Install firefox: `npx playwright install --with-deps firefox` (add a
    second `run` step; keep chromium step).
  - Add Python + venv setup: `actions/setup-python@v5` then
    `pip install playwright` + `python -m playwright install --with-deps
    chromium firefox` for the py backends.
  - Keep the auto-skip gates intact so bare/minimal runners stay green when
    a backend is absent.
- Consider splitting into `miniwob-chromium`, `miniwob-firefox`,
  `miniwob-python` jobs for parallelism + clearer failure isolation. Only do
  this if it doesn't bloat the workflow file materially — otherwise a single
  job with all installs is fine.

### Diff-shrink checkpoint 3

- `ci.yml` delta should be additive install/run steps only — no workflow
  rewrite. Compare the before/after `ci.yml` and cut any reformatting that
  isn't strictly required.
- `test:miniwob` command change is one string; ensure no duplicated command
  aliases across root + host `package.json`.

**Recommendation:** evaluate lightly here. CI files drift easily into
reformatting. Keep the diff to added steps.

---

## Phase 4 — DRY pass (suite helper done; remaining DRY items)

**Goal:** Close the remaining DRY findings.

- `adapter-smoke.test.ts:64-78`: delete inline `parseRefs` and
  `clickFirstButton`; import `parseRefs` from `solvers/parser.ts` and
  `clickFirstButton` from `solvers/trivial-solvers.ts`. The inline
  `clickFirstButton` uses the full-line substring match that `withRole` was
  tightened to avoid (parser.ts:55-71) — removing it also fixes a latent
  false-positive.
- Extract `CHROMIUM_PROCESS_NAMES` (or similar) shared constant for the
  `["chrome-headless","chromium"]` candidate list duplicated between
  `chromium/index.ts:73-89` and `python-adapter.ts:_discoverCdpEndpoint`.
  Put it in `core/shared/cdp-endpoint.ts` (already the owner of
  `resolveCdpEndpoint`) and import from both call sites.

### Diff-shrink checkpoint 4

- Net line count of the two call sites + new constant should drop. If the
  constant extraction doesn't reduce net lines (e.g. the candidate list is
  only 2 entries used twice), **skip it** — the duplication is trivial and
  the indirection costs a reader a hop. Apply judgment; the smoke-test parser
  fix is the higher-value item.

**Recommendation:** evaluate the CDP-constant extraction specifically — it's
borderline YAGNI. The smoke-test parser fix is unambiguous; do that regardless.

---

## Phase 5 — Firefox launchServer reconnect coverage + bugs (F)

**Goal:** Test and fix the firefox-ws reconnect path in portal.

- Add a structural test (mock BrowserServer / Browser) for
  `playwright-plugin.ts:108-404` launchServer path:
  - `_wsEndpoint` / `_browserServer` lifecycle.
  - `_reconnectBrowser` on `disconnected`.
  - `getAttachEndpoint()` returning `{kind:"firefox-ws", wsEndpoint}`.
- Fix two latent bugs at `playwright-plugin.ts:346-389`:
  1. **Unbounded nested `disconnected` handlers** — each reconnect installs a
     fresh nested handler on the new browser, which installs another on the
     next reconnect. Reattach once per browser, or detach before reattaching.
  2. **Missing `_pages` / `_elementCache` cleanup on launchServer reconnect** —
     the default branch at `:381-389` clears them and marks sessions crashed;
     the launchServer branch does not, so in-flight tasks hold dead Page
     references. Mirror the default-branch cleanup.

### Diff-shrink checkpoint 5

- The bug fixes should be **small** (a few lines each). The reconnect
  machinery itself is ~155 lines and was restored deliberately — do not
  rewrite it. If a fix starts turning into a refactor, stop and re-scope.
- The test is additive; cap it at a focused mock-based unit test, not a
  full live-firefox harness (that's `miniwob-firefox.test.ts`'s job).

**Recommendation:** evaluate here. Reconnect logic is exactly the kind of
"while I'm in here" zone where scope creeps. Keep fixes surgical.

---

## Phase 6 — `exports` map vs deep-import mismatch (G)

**Goal:** Either support the README's deep-import examples or change them.

- Decision point (pick one):
  - **(a) Widen `exports`** in `pi-lean-portal/package.json` to expose
    `./backends/*` and `./__tests__/helpers/*` (types + source). Pro: README
    examples work for npm consumers. Con: exposes internal surface area,
    invites coupling.
  - **(b) Rewrite examples** in `pi-lean-host/README.md` and the host's own
    suites to import only from `pi-lean-portal` (`.` entry) or via relative
    in-workspace paths that aren't advertised to consumers. Pro: keeps the
    public API narrow. Con: users can't easily construct a backend from an
    npm install without their own adapter.
- Decision: **(b)**. Verified against the future stealth-browser plan: a
  user running MiniWoB tests against their own camoufox-py / invisible-py
  plugin from outside the package source needs only:
  - **From `pi-lean-portal` `.` entry** (`core/plugin-api.ts` types):
    `BrowserPlugin` interface, `AttachEndpoint` union, `PluginCapabilities`
    — all already exported there.
  - **From `pi-lean-host`**: `registerMiniwobSuite`, `runMiniwobTask`,
    `MiniwobBackend`, solvers, parser — all already exported from
    `src/index.ts`.
  They write their own plugin in their own project and register it; they
  never deep-import a shipped backend (chromium is not theirs). Option (a)
  would expose internal shipped backends that stealth-browser users don't
  even want — it's the wrong direction for the stated plan.
- Action: update `pi-lean-host/README.md` examples to show users
  registering their **own** plugin via `registerMiniwobSuite` rather than
  importing a shipped backend. Keep the in-workspace suites using relative
  deep paths (they're not advertised to npm consumers).

### Diff-shrink checkpoint 6

- If (b): the README change is a few lines; no `exports` map widening means
  no new exported paths to maintain. Confirm no host suite or README example
  still imports a deep path that the `exports` map would block for consumers.
- Verify the `.` entry of `pi-lean-portal` still exports every type a
  stealth-browser author needs to implement `BrowserPlugin` +
  `getAttachEndpoint()` (`AttachEndpoint`, `PluginCapabilities`). If any
  type a user needs is missing from `core/plugin-api.ts`, add it there —
  that's the public surface, not a deep path.

---

## Phase 7 — Final diff-footprint audit

**Goal:** Confirm the branch introduces only lines necessary to the host-split

- cross-engine + user-extensible-test plan.

- `git diff --stat cleanup/use-benchmarking-libraries..HEAD` — review every
  file. For each, ask: "is this required by the host split, cross-engine
  support, or the public test API?" Flag anything that isn't.
- Specifically re-audit:
  - `packages/pi-lean-portal/backends/chromium/index.ts` (+62) — only the
    `onBrowserLaunched` → `resolveCdpEndpoint` wiring should be new.
  - `packages/pi-lean-portal/backends/firefox/index.ts` (+45) — only the
    launchServer/`_wsEndpoint`/`getAttachEndpoint` wiring.
  - `packages/pi-lean-portal/backends/playwright-base/playwright-plugin.ts`
    (+155) — the reconnect machinery; confirm no unrelated refactors bolted
    on.
  - `packages/pi-lean-portal/core/plugin-api.ts` (+39) — only
    `getAttachEndpoint?()` + `AttachEndpoint` union.
  - `packages/pi-lean-portal/core/shared/cdp-endpoint.ts` (+193) — confirm
    it's the minimal shared discovery module, not a general attach framework.
  - `packages/pi-lean-host/**` — confirm no `bench.ts`/`benchPlugin`
    remnants, no speculative multi-phase migration scaffolding.
- Run `npm run test:ci` + `npm run test:miniwob -w pi-lean-host` (with
  browsers present) and confirm green.
- Compare final insertion count to the starting ~7165; the target after
  Phase 0 doc deletions alone is ~−2600, and Phases 1/4 should trim further.

### Diff-shrink checkpoint 7 (final)

- This is the comprehensive re-read. If any file's delta can't be justified
  against the plan in one sentence, cut it or move it to a follow-up branch.

---

## Phase ordering & dependencies

```
0 (docs) ──┐
           ├─► 1 (suite helper) ─► 2 (py suites) ─► 3 (CI)
           │
4 (DRY) ───┘                    5 (reconnect) is independent
6 (exports) is independent      7 (final audit) runs last
```

- 0 can run first and standalone (pure deletions + doc edits).
- 1 must precede 2 (py suites use the helper).
- 2 must precede 3 (CI needs the suite files to exist).
- 4 can run anytime after 1 but should precede 7.
- 5 and 6 are independent of 1–4 and can run in parallel with them.
- 7 runs last against the fully-updated branch.

## Out of scope (explicit)

- Stealth-backend example bridges (`camoufox-py`, `invisible-py`) attach
  plumbing — handled on the parent stealth-browser branch; this branch will
  merge there and wire them up later. The `registerMiniwobSuite` API itself
  is in scope and already correct.
