# Stealth Python Backends — Implementation Plan (dev-facing)

> **Status:** READY FOR IMPLEMENTATION
> **Source of truth:** `stealth-browser-plan-v3.md` (architectural plan). This
> document breaks that plan into shippable sprints with explicit acceptance
> criteria for the engineering team.
> **Branch:** `feat/stealth-browser-quirks`
> **Date:** 2026-07-08
> **Owner:** portal + host maintainers
>
> **Read this first:** the "invisible-playwright policy" section of v3. It is
> a hard constraint that affects almost every sprint. Summary: **no reference
> to `invisible-playwright` or `invisible-py` may land in any git-tracked file
> under `packages/`.** The untracked local dev artifact
> `packages/pi-lean-portal/docs/stealth-backends/invisible-py/bridge.py` stays
> untracked; `git grep -ni "invisible" -- packages/` must remain empty for all
> tracked files.

## Conventions for this doc

- **Sprint** = a shippable unit that can be merged independently and leaves
  `npm run test:ci` green. Sprints are ordered by dependency; do not reorder.
- **AC** = acceptance criterion. Every AC is verifiable by a command or a
  review step. "Done" means every AC is met — no partial credit.
- **Files touched** lists the concrete paths a sprint modifies or creates.
  Treat it as a contract: if you find yourself editing files outside this
  list, stop and confirm with the plan owner.
- **Out of scope** is explicit. Do not gold-plate.
- All `docs/stealth-backends/...` paths are relative to
  `packages/pi-lean-portal/` (the templates live inside the portal package,
  not at the repo root). The `packages/pi-lean-portal/` prefix is shown in
  full wherever a `cp`/import path matters.

---

## Dependency graph

```
Sprint 0 (Gap 0 scrub) ─────────────┐
                                     │
Sprint 1 (probeUserBackend + tests) ─┼─→ Sprint 3 (Camoufox contract tests)
                                     │            │
                                     ├─→ Sprint 2 (generic user-backends runner + Camoufox parity template)
                                     │
                                     └─→ Sprint 4 (docs: AGENTS.md + README + CHOOSING.md)
                                                      │
Sprint 0 ────────────────────────────────────────────→ Sprint 5 (CI opt-in workflow + grep guard)
```

- Sprint 0 unblocks Sprint 5's grep guard and is otherwise independent.
- Sprints 1 → 2 → 3 are sequential (each reuses `probeUserBackend`).
- Sprint 4 (docs) must come **after** the code sprints so docs describe what
  shipped, not what was planned.
- Sprint 5 wires everything together and depends on all prior sprints.

Sprints may be parallelized across devs **only** where the graph permits
(e.g. Sprint 0 and Sprint 1 can run concurrently since they touch disjoint
files). One writer per file — coordinate via this doc's "Files touched"
lists.

---

## Sprint 0 — Scrub existing invisible references (BLOCKING)

**Goal:** make the shipped tree endorsement-free so the
`git grep` policy guard in Sprint 5 is enforceable. This is small, fast,
and unblocks Sprint 5.

**Gap:** Gap 0 in v3.

**Files touched (exhaustive — these are the four currently-violating tracked files):**

1. `packages/pi-lean-portal/backends/python-base/pi_browser_bridge/playwright_base.py`
   — lines 107, 141, 147, 297, 301. Rewrite comments generically. Replace
   `invisible_playwright` with abstract phrasing such as "another stealth
   engine that patches `new_context`" / "some patched Firefox binaries". Do
   not introduce a new named engine.
2. `packages/pi-lean-portal/core/shared/paths.ts:35` — the JSDoc example
   lists `invisible-py/`. Remove that example, keeping `camoufox-py/` as the
   sole worked example, **or** substitute a synthetic `stealth-py`
   placeholder. Pick one and be consistent.
3. `packages/pi-lean-portal/__tests__/plugin-config-browser.test.ts`
   — line 175 (the `it(...)` label naming `camoufox-py / invisible-py`) and
   line 180 (`expect(names).not.toContain("invisible-py")`). Rename the skip
   label to a synthetic placeholder (e.g. `stealth-py`) and update the
   assertion so the test still asserts a non-fallback stealth name is
   excluded from the default fallback list. The test's intent must remain
   intact.
4. `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py:270`
   — the comment credits `invisible-py` by name. Rephrase to describe the
   pattern in the abstract: "some patched Firefox binaries have a
   binary-level back-navigation bug that requires a `document.referrer`
   workaround; Camoufox does not, with `enable_cache=True`".

**Do NOT touch** the untracked `packages/pi-lean-portal/docs/stealth-backends/invisible-py/bridge.py`.
It is a dev artifact. It must remain untracked. Do not `git add` it.

**Acceptance criteria:**

- [ ] **AC 0.1** All four listed files rewritten per the per-file instructions
  above. No behavior changes — comments and a single test label/assertion
  only. Existing tests must still pass.
- [ ] **AC 0.2** `git grep -ni "invisible" -- packages/` returns **zero
  matches** (tracked files only; the untracked dev artifact is correctly
  ignored by `git grep`). Run this and paste the empty output in the PR.
- [ ] **AC 0.3** `npm run test:ci` is green.
- [ ] **AC 0.4** `git status` shows the `invisible-py/` dev artifact as
  untracked (`??`), not staged.

**Definition of done:** AC 0.1 – AC 0.4 all pass and the PR includes the
empty `git grep` output as evidence.

---

## Sprint 1 — `probeUserBackend` helper + unit tests

**Goal:** ship the public probe that lets a user-managed stealth backend be
exercised through the 130-task MiniWoB++ harness without forking the repo.
This is the foundation for Sprints 2, 3, and 5.

**Gap:** Gap 1a in v3.

**Files touched:**

- `packages/pi-lean-host/src/index.ts` — re-export `probeUserBackend`.
- **One of** (decide and record the choice in the PR):
  - `packages/pi-lean-host/suites/miniwob-suite-helper.ts` — add
    `probeUserBackend` next to `probePythonBackend`, **and** update the
    module doc comment that currently says "User-owned parity test files do
    **not** use this helper" (that wording is stale — the helper already
    houses the public `probePythonBackend`); **or**
  - new `packages/pi-lean-host/src/probe-user-backend.ts` — new module
    re-exported from `src/index.ts`, leaving the suite-helper doc untouched.

> **Note (pre-existing, out of scope to fix):** `src/index.ts` already
> re-exports `probePythonBackend` from `../suites/miniwob-suite-helper.js`,
> but `suites/` is **not** in `pi-lean-host` `files` — so the *currently
> published* tarball's `probePythonBackend` re-export already points at an
> unshipped module. Option A above would inherit this defect; option B
> (new `src/probe-user-backend.ts`) avoids it. Do **not** fix the
> pre-existing `probePythonBackend` re-export in this branch — just don't
> make it worse, and don't imply option A is safe.

- `packages/pi-lean-host/__tests__/probe-user-backend.test.ts` — new unit
  test (structural; no real browser needed).
- `packages/pi-lean-host/package.json` `files` — confirm the chosen module is
  included in the npm tarball (it must be, since it's a public API).

**Public API (contract — do not deviate):**

```ts
export function probeUserBackend(name: string): {
  available: boolean;
  bridgePath: string;
  venvPython: string;
  reason?: string;
}
```

**Resolution rules (mirror `detectPluginType` so the test file and the
runtime loader agree):**

- `bridgePath` = `path.join(USER_BACKENDS_DIR, name, "bridge.py")`. Accept
  an optional second arg `opts?: { bridgePath?: string }` to let a caller
  pass an absolute path (the dev/power-user escape hatch — mirrors the
  absolute short-circuit in `detectPluginType`).
- `venvPython` = `path.join(USER_BACKENDS_DIR, name, ".venv/bin/python3")`,
  unless the user sets `PI_USER_BACKEND_<UPPERNAME>_PYTHON`, in which case
  use that env value (lets a user point at a non-`user-backends` venv
  without editing the test).
- `available` = `true` iff: bridge file exists AND venv python runs
  (`--version` exit 0). `reason` explains the first missing piece so a skip
  message is useful.
- Do **not** bake in Camoufox-specific probing (binary fetch check). The
  probe is engine-agnostic. The camoufox template's parity file can add its
  own binary probe on top if needed — but keep the shipped probe generic.

**Implementation notes:**

- **Vendor a local `userBackendsDir()` helper — do not import
  `USER_BACKENDS_DIR` from `pi-lean-portal` at runtime.** Rationale:
  `pi-lean-host` declares `pi-lean-portal` as an **optional** peer
  dependency (by design — host is usable standalone), and
  `pi-lean-portal`'s `package.json` `exports` exposes only `.` with no
  subpath for `./core/shared/paths.js`. A runtime value-import would break
  for any consumer installing `pi-lean-host` as a standalone tarball
  without monorepo source colocation (the relative path cannot climb from
  `node_modules/pi-lean-host/src/` into a sibling package's internals).
  The portal-side precedent for cross-package imports is either
  `import type` (erased at runtime, no resolution needed — see
  `adapter/miniwob-adapter.ts`) or imports in `suites/` (not in
  `pi-lean-host` `files` → not shipped). Neither is a runtime value-import
  from shipped `src/`.
- The vendored helper: a tiny function in `src/` (or inlined in
  `probe-user-backend.ts`) that returns `process.env.PI_USER_BACKENDS_DIR`
  if set, else `path.join(homedir(), ".pi", "agent", "pi-lean-portal",
  "user-backends")`. This duplicates one stable path string (documented as
  stable in `pi-lean-portal/core/shared/paths.ts`), which is the lesser
  evil versus making `pi-lean-portal` a required peer just to read a
  directory path. The env override is also genuinely useful for
  non-standard installs — something the portal constant does not offer.
  Sprint 2's generic runner must use this same helper for consistency.
- The probe must be synchronous-ish in shape but may spawn python for the
  venv check — return a plain object, no promises. (If a sync spawn is
  awkward, return a Promise; just be consistent and update the 1b template
  in Sprint 2 to await it.)

**Acceptance criteria:**

- [ ] **AC 1.1** `probeUserBackend` is exported from `pi-lean-host` (the
  public entry `src/index.ts` re-exports it) and is present in the npm
  tarball (`npm run publish:dry` shows it in the file list).
- [ ] **AC 1.2** Unit test `probe-user-backend.test.ts` covers, at minimum:
  - backend present + venv runs → `{ available: true, ... }` with correct
    `bridgePath` / `venvPython`.
  - bridge missing → `{ available: false, reason: <mentions missing bridge> }`.
  - venv missing/non-runnable → `{ available: false, reason: <mentions venv> }`.
  - `PI_USER_BACKEND_<UPPERNAME>_PYTHON` env override is respected.
  - optional `opts.bridgePath` absolute override is respected.
  - The test uses a temp directory as `USER_BACKENDS_DIR` (via env override
    or dependency injection — do not write to the real
    `~/.pi/agent/pi-lean-portal/`).
- [ ] **AC 1.3** The placement decision (suite-helper vs new module) is
  recorded in the PR description, and any stale doc comment is updated to
  match.
- [ ] **AC 1.4** `npx vitest run packages/pi-lean-host/__tests__/probe-user-backend.test.ts` is green. (Note: `npm run test:ci` excludes `pi-lean-host/**` by design — see `vitest.globalSetup.ts` — so it would not exercise this test and must not be used as the gate for host-side structural tests.)
- [ ] **AC 1.5** No reference to `invisible` in any touched file
  (`git grep -ni "invisible" -- packages/pi-lean-host/` is empty).

**Definition of done:** AC 1.1 – AC 1.5 all pass.

---

## Sprint 2 — Generic user-backends runner + Camoufox parity-test template

**Goal:** let maintainers run `npm run test:miniwob` against whatever stealth
engines they have installed locally (auto-skip when none), and ship a
copy-pasteable parity-test template for Camoufox so users can run the full
130-task suite against their own user-backends install.

**Gap:** Gap 1b + Gap 1c in v3. Depends on Sprint 1 (`probeUserBackend`).

**Files touched:**

- `packages/pi-lean-host/suites/miniwob-user-backends.test.ts` — **new**,
  repo/dev artifact. Note: `suites/` is **not** in
  `packages/pi-lean-host/package.json` `files`, so this is not in the npm
  tarball. It runs under `npm run test:miniwob` because that script is
  `vitest run suites/`.
- `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/miniwob-parity.test.ts`
  — **new**, docs-only template (not in `package.json` `files`, not run by
  `npm run test:miniwob`).

**Generic runner spec (`miniwob-user-backends.test.ts`):**

- On load, read the user-backends root via the vendored `userBackendsDir()`
  helper from Sprint 1 (which honors `PI_USER_BACKENDS_DIR` else computes
  the default `~/.pi/agent/pi-lean-portal/user-backends/`). Do **not**
  import from `pi-lean-portal` at runtime — see Sprint 1's implementation
  notes.
- If the root is absent or contains no `<name>-py/` directory with a
  `bridge.py`, **auto-skip the entire file** with a clear reason (this is
  the normal CI state — the file must be a no-op there).
- For each discovered `<name>-py/` with a `bridge.py`, register a MiniWoB
  suite via `probeUserBackend(name)` + `registerMiniwobSuite(...)`. Use the
  `PythonPluginAdapter` constructor shape verified in v3:
  `new PythonPluginAdapter(name, { bridgeScript: probe.bridgePath,
  pythonPath: probe.venvPython, capabilities: { ..., engine: <inferred or
  per-backend> } })`.
- The `capabilities` override: derive `engine` per backend if possible
  (Camoufox → `"firefox"`); if unknown, omit `engine` and let the adapter
  default. Set the `supports*` flags to the same values as the existing
  `*-py` suite references — the `supports*` set is engine-independent
  (AbortSignal false, rest true), so reference `miniwob-firefox-py.test.ts`
  for Firefox-based backends and `miniwob-chromium-py.test.ts` for
  Chromium-based ones; only `engine` differs.
- The `baseUrl` async getter: `async () => process.env.MINIWOB_URL ??
  "http://localhost:8080"`.
- No stealth engine is **named** in the shipped runner source. It discovers
  at runtime.

**Camoufox parity-test template spec (`camoufox-py/miniwob-parity.test.ts`):**

- Docs-only. A user drops it into their own test tree (or a scratch vitest
  project) and runs it. Not run by `npm run test:miniwob`.
- Uses `probeUserBackend("camoufox-py")` + `registerMiniwobSuite`.
- Constructs `PythonPluginAdapter` with the verified shape (see Sprint 1
  notes and the template body in v3 Gap 1b).
- `capabilities.engine = "firefox"` (Camoufox is Firefox-based) so the
  contract suite's identity test reads the engine correctly.
- Include a header comment explaining: this is a user-owned template, where
  to put it, that it requires a Camoufox install + MiniWoB++ content, and
  how to run it (`MINIWOB_URL=... vitest run <this-file>`).

**Acceptance criteria:**

- [ ] **AC 2.1** `miniwob-user-backends.test.ts` auto-skips cleanly when
  `user-backends/` is absent/empty. Verified by running
  `npm run test:miniwob` (the only script that runs `suites/` —
  `npm run test:ci` excludes `pi-lean-host/**` and would not exercise this
  file) — must be green with the file reported as skipped, not failed.
- [ ] **AC 2.2** With a fake `user-backends/<name>-py/` (temp dir + stub
  `bridge.py` + a working python venv) pointed at by
  `PI_USER_BACKENDS_DIR`, the runner discovers it and registers a suite
  (it may then skip at the task level due to missing MiniWoB content —
  that's fine; the discovery + registration must work). Capture this in a
  short dev-run note in the PR.
- [ ] **AC 2.3** The Camoufox parity-test template compiles against the
  shipped adapter API. Verification: on a dev machine with Camoufox
  installed, running the template against MiniWoB content executes the 13
  trivial-solver tasks with `reward > 0` on the 3 confident tasks. If no
  dev machine has Camoufox, fall back to a TypeScript compile check
  (`tsc --noEmit` on a copy placed in a scratch project) and note the
  manual-verification TODO in the PR.
- [ ] **AC 2.4** Neither new file references `invisible` (tracked-file grep
  must stay empty).
- [ ] **AC 2.5** `npm run test:ci` is green.

**Definition of done:** AC 2.1 – AC 2.5 all pass.

---

## Sprint 3 — Camoufox contract tests

**Goal:** ship two auto-skip contract test files that exercise the multi-root
discovery + `PYTHONPATH` injection + `browser.init` + quirks schema
end-to-end against a real user-backends Camoufox install, mirroring the
existing `chromium-py` / `chromium-py-persistence` pair.

**Gap:** Gap 5 in v3. Depends on Sprint 1 (`probeUserBackend` for the
availability probe).

**Files touched:**

- `packages/pi-lean-portal/__tests__/camoufox-py.test.ts` — **new**.
- `packages/pi-lean-portal/__tests__/camoufox-py-persistence.test.ts` —
  **new**, mirrors `chromium-py-persistence.test.ts`.

**Critical shape constraints (verified in v3 — do not get these wrong):**

- `ContractTestOptions` is `{ realBrowser?, navigateTimeout?,
  navigationSettle? }` **only — there is no `engine` field**. Passing
  `engine: "firefox"` to `runContractTests` is an excess-property type error
  under `exactOptionalPropertyTypes`. The engine is advertised on the
  plugin's `capabilities`, which the contract suite's identity test reads
  (`plugin-contract.ts:281`).
- The factory constructs a `PythonPluginAdapter` with a `capabilities`
  override setting `engine: "firefox"` (same shape as the Gap 1b template).
- `runContractTests("camoufox-py", factory, { realBrowser: true,
  navigateTimeout, navigationSettle })` — matching `firefox-py.test.ts:102`
  for the options shape.
- The factory points the adapter at
  `~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/`.
- **Auto-skip** when `probeUserBackend("camoufox-py").available` is false.
  Use the same skip pattern as the existing `*-py.test.ts` files.

**Camoufox-specific assertions to add (in `camoufox-py.test.ts`, beyond the
shared contract suite):**

- `do_scroll` works (exercises the `_scroll_via_wheel` quirks flag).
- `do_evaluate("() => 1 + 1")` returns `2` (exercises the `mw:` prefix /
  `_eval_prefix` quirk).

**Persistence test (`camoufox-py-persistence.test.ts`):**

- Mirror `chromium-py-persistence.test.ts` exactly in structure.
- Auto-skip on missing deps (same gate as the contract test).
- Verifies storage-state save/reload across a re-navigate via the
  user-backends Camoufox install.

**Acceptance criteria:**

- [ ] **AC 3.1** Both files are auto-skip (no errors) when Camoufox is not
  installed — `npm run test:ci` is green with both reported as skipped.
- [ ] **AC 3.2** On a dev machine with Camoufox installed in
  `user-backends/camoufox-py/`, both files run and pass against a real
  Camoufox browser. Capture the run output in the PR.
- [ ] **AC 3.3** The contract test options object passes
  `exactOptionalPropertyTypes` (no `engine` field on the options). The
  `engine` is set on `capabilities`, not on options.
- [ ] **AC 3.4** The two Camoufox-specific assertions (wheel scroll, `mw:`
  eval) are present and pass on a real Camoufox install.
- [ ] **AC 3.5** Neither file references `invisible` (grep guard stays
  empty).
- [ ] **AC 3.6** `.test.ts` files are correctly excluded from the npm
  tarball by the ship-manifest walk (`npm run publish:dry` does not list
  them).

**Definition of done:** AC 3.1 – AC 3.6 all pass. If no dev machine has
Camoufox, AC 3.2 and AC 3.4 may be deferred to Sprint 5's CI run — but the
files must ship and auto-skip cleanly (AC 3.1) regardless.

---

## Sprint 4 — Docs: AGENTS.md + stealth-backends README + CHOOSING.md

**Goal:** document the user-managed stealth model so a developer or user can
discover, install, and reason about stealth backends without reading v3.

**Gap:** Gap 2 + Gap 3 + Gap 4 in v3. Must come **after** Sprints 1–3 so the
docs describe what shipped.

**Files touched:**

- `AGENTS.md` (monorepo root) — update the "Active plugins" table and the
  Test files table.
- `packages/pi-lean-portal/AGENTS.md` — new section covering the
  user-backends model, multi-root resolution, `browser.init`, quirks schema,
  `PYTHONPATH` injection, Camoufox-as-template pointer, and Known
  Constraints.
- `packages/pi-lean-portal/docs/stealth-backends/README.md` — **new**, the
  install flow.
- `packages/pi-lean-portal/docs/stealth-backends/CHOOSING.md` — **new**, the
  decision doc (v3 calls this "STEALTH.md"; place it here under
  `stealth-backends/` to keep it co-located with the templates).

**AGENTS.md content requirements (both root and portal):**

- The **user-backends model**: `~/.pi/agent/pi-lean-portal/user-backends/`,
  not in the npm tarball, trusted user code (not a plugin marketplace — the
  user wrote or audited it; no auto-download).
- **Multi-root `dir` resolution** (package root → `USER_BACKENDS_DIR` →
  absolute), with the absolute-`pythonPath` rule.
- **`browser.init` RPC** + `plugin_config` as the config channel.
- **The quirks schema table** — copy verbatim from v3's "Model" section.
- **`PYTHONPATH` injection** making `pi_browser_bridge` importable from any
  user venv.
- **Camoufox as the shipped example template** (docs-only, source repo only
  — not in the npm tarball because `docs/` is excluded from
  `packages/pi-lean-portal/package.json` `files`), with a one-line pointer
  to `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py`.
- A **Known Constraints** entry for: fingerprint-managed context, Camoufox
  `mw:` prefix + `main_world_eval`, the `isMobile` /
  `_skip_default_viewport` binary quirk, `xvfb` for `headless='virtual'`,
  and the user-side install burden (venv + binary fetch + `settings.json`
  entry).
- Root `AGENTS.md` "Active plugins" table: add a **user-installed (not
  shipped)** row for stealth backends, and update the Test files table with
  the new auto-skip suites/tests from Sprints 1–3.

**README.md content requirements (install flow, Camoufox as worked example):**

1. Pick a location: `~/.pi/agent/pi-lean-portal/user-backends/<name>-py/`.
2. Copy the template from the source repo at
   `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py`
   (or write your own subclass using the quirks schema documented in
   `playwright_base.py`). **State explicitly that this requires the git
   repo, not just `npm install pi-lean-portal`.**
3. Create a venv at `user-backends/<name>-py/.venv/` and install the
   engine's pip package + `playwright`.
4. Fetch the patched binary (engine-specific, e.g.
   `python -m camoufox fetch`).
5. System deps: `xvfb` on Linux if using `headless='virtual'`.
6. Register in `settings.json` with an **absolute** `pythonPath` and a
   `launch` object. Show the Camoufox example JSON (copy from v3's Model
   section).
7. Verify: `/web status` lists the plugin; `browser-navigate` to a test
   page works; on a missing binary, the bridge's `_install_hint` surfaces.
8. Security note: `user-backends/` is trusted user code. The extension
   never downloads or executes stealth backends automatically. Audit
   anything you copy.
9. Benchmarking (optional): pointer to
   `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/miniwob-parity.test.ts`
   and the `registerMiniwobSuite` public API.

**CHOOSING.md content requirements:**

- When to use a stealth backend at all (bot-detection sites; most sites do
  not need it; shipped backends are faster and have better ARIA-tree
  parity).
- When to use Camoufox specifically (the shipped, tested template;
  Firefox-based; fingerprint injected at browser launch; `mw:`-prefix
  main-world eval; wheel-based scroll).
- Implementing your own stealth backend: the quirks schema is the contract.
  Cover the two lifecycle patterns **in the abstract, no engine named**:
  1. Engine accepts an external Playwright instance (e.g.
     `NewBrowser(playwright, …)`) — do not override `_ensure_playwright`;
     override `_launch_browser` only. (Camoufox is the example.)
  2. Engine owns its own Playwright instance — override
     `_ensure_playwright` / `_maybe_stop_playwright` to delegate to the
     engine's context manager; do not call super.
- Trade-offs: ~100 MB binary fetch, per-engine venv, slower humanized
  input, `xvfb` on Linux for some headless modes, back-nav may be limited
  on patched binaries (Camoufox needs `enable_cache`; engines with bfcache
  disabled may need a `document.referrer` workaround — described
  generically).

**Acceptance criteria:**

- [ ] **AC 4.1** All four files updated/created per the content requirements
  above.
- [ ] **AC 4.2** No mention of `invisible-playwright` / `invisible-py` in
  any of the four files. The grep guard
  `git grep -ni "invisible" -- packages/ AGENTS.md` stays empty.
- [ ] **AC 4.3** The quirks schema table in portal `AGENTS.md` matches v3's
  "Model" section verbatim (same 5 flags, same defaults, same effects).
- [ ] **AC 4.4** The README install flow is followable end-to-end by a dev
  who has never seen v3 — every command and config snippet is present and
  correct. Reviewer spot-checks by manually walking the 9 steps.
- [ ] **AC 4.5** The root `AGENTS.md` "Active plugins" and Test files tables
  are updated to reflect Sprints 1–3's new files.
- [ ] **AC 4.6** Docs-only change; `npm run test:ci` remains green.

**Definition of done:** AC 4.1 – AC 4.6 all pass.

---

## Sprint 5 — CI opt-in workflow + grep guard

**Goal:** give maintainers a one-click way to validate the stealth path in
CI, and enforce the invisible-playwright policy going forward with a
`git grep` guard.

**Gap:** Gap 6 in v3. Depends on Sprints 0 (grep guard), 1 (probe), 2
(runner), 3 (contract tests).

**Files touched:**

- `.github/workflows/ci.yml` — add a new opt-in job.

**Job spec:**

- Trigger: `workflow_dispatch` only (and/or path-filtered on
  `packages/pi-lean-portal/docs/stealth-backends/**`). Do **not** run on
  every PR — keeps regular CI fast.
- Steps:
  1. Checkout + setup Node 22 + `npm ci`.
  2. Setup Python 3.12 + create a venv at
     `~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/.venv/`.
  3. `pip install cloverlabs-camoufox[geoip]` + `python -m camoufox fetch`.
  4. Copy
     `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py`
     into the user-backends tree (so the runner from Sprint 2 discovers it).
  5. Setup MiniWoB++ content (`npm run setup:miniwob`) + start the static
     server (the existing `miniwob` job already does this — mirror its
     steps).
  6. Run the camoufox contract tests (Sprint 3) + the
     `miniwob-user-backends.test.ts` suite (Sprint 2, which will discover
     the copied camoufox-py).
  7. **Run the invisible-reference grep guard:**
     `git grep -ni "invisible" -- packages/ AGENTS.md` must exit non-zero
     on any match. Express as a step that fails on non-empty output.
     Tracked-files only — the untracked `invisible-py/` dev artifact is
     correctly ignored by `git grep`. The scope includes root `AGENTS.md`
     because Sprint 4 edits it. **This step depends on Sprint 0 being
     complete.**
  8. Upload traces + vitest output on failure.

**Acceptance criteria:**

- [ ] **AC 5.1** The new job is `workflow_dispatch`-triggered (and/or
  path-filtered) and does **not** run on every PR. The existing
  `structural` and `miniwob` jobs are unchanged.
- [ ] **AC 5.2** A manual run of the job (from the Actions tab) on a clean
  checkout: installs Camoufox, copies the template, runs the contract tests
  - user-backends runner, and exits green. Capture the run URL in the PR.
- [ ] **AC 5.3** The grep guard step runs
  `git grep -ni "invisible" -- packages/ AGENTS.md` and fails the job if
  it returns any match. Verified by temporarily inserting a tracked
  `invisible` reference in a throwaway commit on a branch and confirming
  the job fails (then reverting). Record this verification in the PR.
- [ ] **AC 5.4** The job uploads traces + vitest output on failure
  (`actions/upload-artifact`).
- [ ] **AC 5.5** `npm run test:ci` and `npm run test:miniwob` (auto-skip
  state) remain green on a bare CI machine — the new job does not regress
  the default pipeline.

**Definition of done:** AC 5.1 – AC 5.5 all pass. AC 5.2 requires an actual
green workflow run linked from the PR; AC 5.3 requires the negative-test
verification note. This sprint's green workflow run (AC 5.2) is also the
**branch-level merge gate** (see X.6) — the branch does not merge until it
is linked. Sprints 2–3 may merge with `tsc --noEmit` + auto-skip evidence
when no dev machine has Camoufox, but every behavioral claim (AC 2.3,
3.2, 3.4) ultimately rests on this one green run.

---

## Cross-cutting acceptance criteria (apply to every sprint PR)

- [ ] **X.1** `npm run test:ci` is green on the PR branch.
- [ ] **X.2** `git grep -ni "invisible" -- packages/ AGENTS.md` is empty
  (tracked files). Paste the empty output in the PR description for every
  sprint. (Scope includes root `AGENTS.md` because Sprint 4 edits it.)
- [ ] **X.3** No new file or edit introduces a named reference to
  `invisible-playwright` / `invisible-py` (the policy is permanent, not just
  Sprint 0).
- [ ] **X.4** No file outside the sprint's "Files touched" list is modified
  without a recorded justification in the PR.
- [ ] **X.5** The PR description links back to the relevant Gap(s) in v3 and
  lists which ACs are satisfied, with command output / run URLs as evidence.
- [ ] **X.6** The branch (`feat/stealth-browser-quirks`) is not considered
  "done" / mergeable until at least one green Sprint 5 workflow run is
  linked (AC 5.2). Sprints 2–3 may merge with `tsc --noEmit` + auto-skip
  evidence when no dev machine has Camoufox, but every behavioral claim
  (AC 2.3, 3.2, 3.4) ultimately rests on that one green run — so the
  branch-level gate is the green Sprint 5 workflow, not the per-sprint ACs.

---

## Out of scope (explicit — do not do in this branch)

- Resolving a relative `pythonPath` against `USER_BACKENDS_DIR` in the
  adapter (v3 lists this as an "optional nicety, deferred — not required
  for v3").
- Shipping `invisible-py` contract tests or any invisible-py artifact in
  git (policy — permanent).
- A `pip install`-able `pi-browser-bridge` on PyPI (v3 explicitly keeps
  `PYTHONPATH` injection instead).
- Re-attempting Camoufox `NewContext` (v3 documents it is broken on the
  current binary; `_skip_default_viewport` + standard `browser.new_context()`
  with `_fingerprint_managed_context = True` is correct).
- Bundling the `docs/stealth-backends/` templates in the npm tarball
  (`docs/` is excluded from `package.json` `files` by design; the templates
  require the source repo).
- A plugin marketplace / auto-download for stealth backends (the
  user-backends model is trusted user code only).

---

## Suggested timeline

Assuming one dev, ~1 sprint/day, no blockers:

| Day | Sprint | Notes |
|-----|--------|-------|
| 1   | Sprint 0 | Small, unblocks Sprint 5's grep guard. |
| 2   | Sprint 1 | Foundation; Sprints 2/3/5 depend on it. |
| 3   | Sprint 2 | Reuses `probeUserBackend`. |
| 4   | Sprint 3 | Reuses `probeUserBackend`. May need a Camoufox-equipped machine for AC 3.2/3.4; if none, defer to Sprint 5 CI. |
| 5   | Sprint 4 | Docs; quick once code is settled. |
| 6   | Sprint 5 | CI; needs a green workflow run (AC 5.2) — allow extra time for CI iteration. |

With two devs: Sprint 0 and Sprint 1 can run in parallel on day 1
(disjoint files), then Sprint 2 + Sprint 3 can run in parallel on day 2–3
(disjoint files, both depend only on Sprint 1). Sprint 4 and Sprint 5 stay
last.

---

## Open questions to resolve before/during implementation

1. **`probeUserBackend` placement** (Sprint 1): suite-helper vs new module.
   Pick one, record in PR. Recommendation: new `src/probe-user-backend.ts`
   module — keeps the suite-helper focused on suite lifecycle and avoids
   touching its stale-but-separate doc comment semantics. Confirm with plan
   owner if unsure.
2. **`probeUserBackend` sync vs async return** (Sprint 1): the v3 signature
   shows a plain object, but the venv check may need a spawn. Decide
   upfront and keep the 1b template consistent.
3. **Capabilities `engine` derivation in the generic runner** (Sprint 2):
   how does the runner infer `engine` for an unknown backend? Options: (a)
   omit `engine` and let the adapter default; (b) read a convention file
   (e.g. `engine.txt`) in the user backend dir; (c) require the user's
   parity file to override. Recommendation: (a) for the generic runner,
   (c) for the shipped Camoufox template. Confirm.
4. **Manual-verification fallback for AC 3.2/3.4 and AC 2.3** (Sprints 2/3):
   if no dev machine has Camoufox, fall back to a TypeScript compile check
   - a TODO, and let Sprint 5's CI be the real verification. State this
   explicitly in the PR so it's not a silent gap.

Resolve these in the first PR that touches the relevant sprint, or raise
them with the plan owner before starting.
