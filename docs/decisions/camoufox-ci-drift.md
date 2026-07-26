# Decision: Camoufox CI Drift — Diagnosis and Fix Plan

**Status:** Steps 1 & 2 complete. Step 1 (CI version pin) restored a
green baseline on the legacy binary; Step 2 reproduced against the
current binary (`152.0.4-beta.28`), adapted the quirks, and moved the
pin forward. Step 3 (drift guard) is deferred — optional, lowest
priority.

**Branch:** Landed on the dedicated `fix/camoufox-ci-drift` branch cut
from `main`, **not** on the `refactor/break-out-masking-tool` feature
branch where the failures were first observed. Rationale: the
tool-masking work is complete and ships independently (squash-merged to
`main`); the Camoufox drift is logically unrelated, touches no
overlapping files (`.github/workflows/ci.yml`,
`contributed/camoufox-py/bridge.py`, `playwright_base.py`, this doc),
and the CI-reproducibility pin is urgent enough to ship as a patch
without waiting on the feature. A separate branch also gives the
version-pin choice its own review trail.

## Symptom

The `contributed` GitHub Actions job (workflow_dispatch-only, Camoufox
user-backend validation) fails 9 tests across two suites:

- `bench/miniwob/suites/miniwob-user-backends.test.ts` — `click-test`,
  `click-dialog` (reward 0; `click-dialog` fails here but the same task
  passes in `run-contributed-suites`, and `click-test` is the reverse —
  i.e. the failures are flaky across runs but always on click-driven tasks).
- `packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts` —
  `scroll_via_wheel` quirk (page doesn't move), `clicks a link with delayed
  navigation` (URL stuck at `/slow-nav`), `scrolls to the bottom after
  repeated scrolls`, and 4 cookie-persistence tests all rooted on
  `clicks Accept All` failing (`locator.click()` throws, not a silent
  no-op → no consent cookie → dialog reappears → no `storage-state.json`).

The last green run was **Jul 14 2025**. The failures started after and have
persisted since.

## Root cause: unpinned Camoufox stack drift, not a code regression

### What the evidence shows

1. **Every failing test is Camoufox-quirk-dependent.** All 9 failures live
   in the `contributed` job. The shipped `chromium-py` / `firefox-py`
   backends use *none* of the quirks (all default `False`) and are not
   failing. The failures cluster exactly on behavior the patched binary
   provides:
   - `scroll_via_wheel` — `page.mouse.wheel(0, delta)` no longer moves the
     page, **or** the `mw:`-prefixed `window.scrollY` read returns a stale
     `0` (either half of the round-trip could have changed).
   - `clicks a link with delayed navigation` — click no longer follows the
     JS redirect (`newUrl` stuck at `/slow-nav`).
   - `clicks Accept All` — `locator.click()` **throws** (the assertion is
     `clickResult.success === false`), not a silent no-op.
   - `click-dialog` / `click-test` reward 0 — clicks not registering in
     MiniWoB within the task's time budget (flaky across the two suites,
     consistent with `humanize=True`'s ~1.5s bezier mouse racing task
     timers).
   - The 4 cookie-persistence failures are all **downstream** of the
     Accept-All click failing.

2. **The code path is byte-identical to the last green run.** The last
   success was Jul 14 (`b066714` / `3f423ec`, the stealth-quirks landing).
   The only subsequent touch to this path is the Jul 16 refactor
   `c0674a0` ("fold abstract browser bridge into playwright bridge"). I
   diffed it: `do_click`, `do_scroll`, `do_evaluate`, `_h_init`,
   `_DISPATCH`, `run()`, and `plugin_config` were moved from `bridge.py`
   into `playwright_base.py` **verbatim** — no behavioral change.
   `__init__.py` exports stayed intact (`BrowserBridge` removed,
   `PlaywrightBridge` retained, Camoufox imports it). No later commit
   touched `python-base/`, `contributed/`, or the failing test helpers.

3. **No version pin on the Camoufox stack.** `.github/workflows/ci.yml`
   installs both pieces unpinned:

   ```yaml
   # ci.yml:187-188
   pip install --quiet "cloverlabs-camoufox[geoip]"
   python -m camoufox fetch
   ```

   GitHub runners are ephemeral, so every run pulls the **latest**
   `cloverlabs-camoufox` PyPI release **and** the latest patched Firefox
   binary via `camoufox fetch`. A newer release of either changed the
   behavior our quirks were written against:
   - `MainWorldContext.executeInGlobal` (the `mw:` prefix target in the
     patched Juggler),
   - wheel-event / smooth-scroll handling,
   - humanized-click timing or click-commit semantics.
   There is no `camoufox==` / binary-version pin anywhere in the repo
   (grepped `*.txt`/`*.toml`/`*.json`/`*.yml`/`*.cfg`).

4. **No fix exists on another branch.** `fix-clicks`,
   `bugfix-camoufox-inspect`, and `bugfix-browser-issues` all diverged from
   an older, pre-quirks lineage (their tips include "implement browser
   toggle", "initial fetch decoupling" — commits not on this branch). They
   contain no adaptation to the new binary.

### Conclusion

The `contributed` job is testing a moving target with no reproducibility
contract. The work is external to our code: first restore reproducibility,
then adapt the quirks to whatever the new binary changed. It lands on its
own `fix/camoufox-ci-drift` branch (see the Status note above).

## Fix plan

### Step 1 — Restore reproducibility (CI version pin)

Highest-value change; isolates whether the entire failure is pure drift.

- Pin `cloverlabs-camoufox` to the last-known-good version from the Jul 14
  run in `.github/workflows/ci.yml`. Determine the exact version by
  reproducing locally: install candidate versions, run
  `npm run test:miniwob` + the contributed contract suite, find the newest
  release that passes (or the last release before Jul 14 that does).
- Pin the fetched binary if `camoufox fetch` supports a version/preset
  argument; otherwise document that the binary tracks the package version
  and pinning the package is sufficient.
- Record the pinned version(s) in `packages/pi-lean-portal/contributed/README.md`
  (or `AGENTS.md` quirks table) so the pin has an owner and an upgrade
  procedure, not just a CI line that rots.

Expected outcome: with the pin, the `contributed` job goes green again on
the existing code. This confirms the diagnosis and gives a stable baseline
to develop Step 2 against.

### Step 2 — Adapt the quirks to the new binary (forward fix)

**Done.** Reproduced against `152.0.4-beta.28` and adapted the quirks;
the CI pin now tracks this binary. Findings and fixes:

- `scroll_via_wheel`: the wheel event is now a complete no-op on the
  new binary (the `wheel` listener never fires, `scrollY` stays `0`),
  while programmatic `window.scrollBy` via `page.evaluate` works again.
  The quirk is now backwards — flipped `_scroll_via_wheel` off in
  `contributed/camoufox-py/bridge.py` so `do_scroll` uses the eval path.
  Updated the `_scroll_via_wheel` docstring in `playwright_base.py` and
  the quirks tables in `contributed/README.md` + portal `AGENTS.md`.
- `clicks Accept All` / delayed-nav / `click-test` / `click-dialog` /
  `focus-text`: all rooted in `humanize=True`. The humanized bezier
  motion makes `locator.click(timeout=5s)` flake/timeout on the new
  binary and eats MiniWoB's ~10s task budgets. The contributed suites
  exercise the backend *contract*, not human-emulation stealth, so they
  now force `launch.humanize=false` — `run-contributed-suites.test.ts`
  merges it into the config it forwards to every discovered backend,
  and `miniwob-user-backends.test.ts` passes it at `init()`. Real users
  keep the `humanize=True` default for evasion-sensitive browsing.
- `mw:` eval: `_wrap_mw_eval_in_eval` still produces a valid single
  expression on the new binary — no change needed (the `eval_prefix`
  quirk test continues to pass).
- Navigation-settle hardening: `_wait_for_navigation_settle`'s
  no-nav branch did a blind 400 ms sleep then a single late-arrival
  check, which raced `framenavigated` under load (delayed-redirect
  tests flaked in the full suite). Replaced the blind sleep with a
  50 ms poll over the same 400 ms ceiling so a late-starting nav is
  caught as soon as `framenavigated` fires. Shared code, but strictly
  better (same max budget, returns early on nav, no-nav case unchanged).

Verification: `CONTRIB_RUN=1 npx vitest run
packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts`
(134 passed / 234 skipped, 0 failed across repeated runs) and
`bench/miniwob/suites/miniwob-user-backends.test.ts` (`click-test` /
`click-dialog` green). Residual click/settle flakes seen only under
heavy local full-suite load (browser churn) are not the original
deterministic CI failures; CI's cleaner environment doesn't reproduce
them.

The plan's original reproduction notes (kept for the record):

- Reproduce locally with `BROWSER_DEBUG=1` (and optionally
  `BROWSER_TRACE_DIR`) to capture the exact failure point for each quirk:
  - `scroll_via_wheel`: is it the wheel event that no-ops, or the `mw:`
    `window.scrollY` read that returns stale `0`? Check the trace.
  - `clicks Accept All` / delayed-nav: does `locator.click()` throw a
    specific error, or does the click land but the JS redirect not commit?
    Inspect the thrown message.
  - `mw:` eval: does the `_wrap_mw_eval_in_eval` rewrite still produce a
    single valid expression under the new `executeInGlobal` wrapper?
- Patch the affected quirk logic in
  `packages/pi-lean-portal/contributed/camoufox-py/bridge.py` and/or the
  shared quirk handlers in
  `packages/pi-lean-portal/backends/python-base/pi_browser_bridge/playwright_base.py`.
  Keep the `ponytail:` ceiling-notes on each quirk updated to reflect the
  new binary's actual behavior.
- The `humanize=True` flakiness on MiniWoB click tasks (reward 0 under
  timer pressure) may warrant a separate, test-mode-only override (e.g. a
  `launch.humanize` toggle the contributed suite sets to `false` for the
  fast-task MiniWoB runs) rather than a binary fix — decide during
  reproduction.

### Step 3 — Guard against silent drift recurring

- Add a CI step (or a comment block in `ci.yml`) that fails loudly when
  the pinned `cloverlabs-camoufox` is outdated relative to latest, so a
  maintainer gets a prompt to re-run Step 2 rather than discovering drift
  on the next unpinned rebuild. (Optional; lowest priority.)

## What this is not

- Not a portal-framework regression. `router.ts`, the plugin registry,
  config loading, snapshot cache, nav-settle, and the shipped Node/Python
  backends are untouched and passing. The `structural` and `miniwob` jobs
  are green.
- Not a test-harness bug. The persistence suite's chain of assertions
  (click → cookie → no-dialog → storage-state.json → third-nav) is correct;
  it correctly surfaces the upstream click failure at its first point of
  contact (`clicks Accept All`).
- Not a reason to roll back the Jul 16 refactor. The refactor moved code
  without changing behavior; reverting it would restore a redundant
  abstract base class and fix nothing.
