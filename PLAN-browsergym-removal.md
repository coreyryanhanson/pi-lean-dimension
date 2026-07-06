# Plan — BrowserGym Removal Pass on `refactor/seperate-host-module`

> **Status:** Draft for review. Open questions resolved 2026-07-06 (see §6) — ready for execution.
> **Base branch:** `refactor/seperate-host-module` (HEAD `3499230`)
> **Reference point:** `cleanup/use-benchmarking-libraries` (HEAD `c0be5b0`) — the last commit before the BrowserGym integration work began. Used as the "no bloat" baseline.
> **Decision context:** See chat transcript 2026-07-06 and `DESIGN-in-process-browsergym.md` review (artifact `988219e0_reviewer_0_output.md`). The decision is **drop BrowserGym as a runtime dependency** because (a) the playwright `==1.44` pin is structurally incompatible with a browsing tool that must stay current, (b) the in-process design exists solely to engineer around BrowserGym's dep footprint, and (c) BrowserGym's real value (WebArena reward computation) requires a different architecture (standalone Mode B bridge) that this branch isn't building anyway.

## 0. Purpose and non-goals

**Purpose:** Strip BrowserGym as a runtime dependency from `pi-lean-host` while preserving the genuinely valuable non-BrowserGym work the branch introduced (the host package split, the `@e`-ref solver layer, the CDP/ws external-attach hooks, the stealth backend sketches, the CI pipeline).

**Non-goals:**

- Do **not** delete the design docs (`DESIGN-in-process-browsergym.md`, `browsergym-migration-plan-v2.md`, `browsergym-migration-phase-1.5.md`). They become historical artifacts recording *why this path was not taken*. Move to `docs/decisions/` if a decisions directory is established; otherwise leave in place with a one-line "superseded" header. The chat reasoning is the authoritative record; the docs are corroboration.
- Do **not** touch the WebArena future-option. Dropping BrowserGym for MiniWoB does not close the WebArena door — WebArena needs the standalone Mode B bridge in its own venv, which is a separate future decision. Do not pre-build it.
- Do **not** rework the `@e`-ref snapshot layer, the trivial solvers, the parser, or the suite registration. These are BrowserGym-agnostic and stay.
- Do **not** change the `BrowserPlugin` interface contract for normal browsing. The `getCdpEndpoint` / `getWsEndpoint` / `connectOverCDP` optionals stay (they're general external-attach hooks, not BrowserGym-specific), but their docstrings must be rewritten to drop the BrowserGym framing.

## 1. The bloat-and-betterness evaluation (do this first, before any deletion)

Before touching anything, audit every file changed between `cleanup/use-benchmarking-libraries` and the current HEAD. The criterion is: **is this change objectively better than the cleanup baseline, independent of BrowserGym?** If a change only earns its keep under the BrowserGym assumption, it's a deletion candidate. If it would be valuable even with BrowserGym gone, it stays.

### 1.1 How to run the audit

```bash
git diff --stat cleanup/use-benchmarking-libraries HEAD
git diff cleanup/use-benchmarking-libraries HEAD -- <path>   # per file
```

For each changed file, fill in the table in §1.2. The table's verdict column drives §2.

### 1.2 Per-file audit table

Verdicts: **KEEP** (objectively better, BrowserGym-agnostic), **REWORK** (valuable core, BrowserGym-specific surface to strip), **DELETE** (only earns its keep under BrowserGym), **ARCHIVE** (design docs — move, don't delete).

| Path | Δ LOC | Verdict | Reason |
|---|---|---|---|
| `.github/workflows/ci.yml` | +64 | REWORK | Structural/miniwob job split is good. Drop the `setup-venv` step and the browsergym-venv cache key. |
| `.gitignore` | +3 | KEEP | Trivial, correct. |
| `AGENTS.md` | +159 | REWORK | Monorepo-level doc updates are good but reference BrowserGym throughout. Rewrite to drop BrowserGym framing; keep the package-split and test-policy content. |
| `DESIGN-in-process-browsergym.md` | +774 | ARCHIVE | Design doc for the path not taken. Add a "Superseded — see chat 2026-07-06" header. Do not maintain as living spec. |
| `browsergym-migration-phase-1.5.md` | +718 | ARCHIVE | Same. |
| `browsergym-migration-plan-v2.md` | +618 | ARCHIVE | Same. |
| `browsergym-migration-plan.md` | ±122 | ARCHIVE | Original Option C plan. Same. |
| `package-lock.json`, `package.json` (root) | +26 | REWORK | Workspace wiring for `pi-lean-host`. Keep the workspace entry; drop any browsergym-only scripts. |
| `packages/pi-lean-host/.gitignore` | +9 | KEEP | Correct. |
| `packages/pi-lean-host/AGENTS.md` | +23 | REWORK | Stub points at monorepo AGENTS. Rewrite to drop BrowserGym framing; keep package-purpose description. |
| `packages/pi-lean-host/README.md` | +357 | REWORK | Host package docs. Substantial BrowserGym framing throughout (architecture diagrams, setup). Rewrite around the hand-rolled driver. |
| `packages/pi-lean-host/adapter/bench.ts` | +207 | KEEP | `benchPlugin` strategy selection. BrowserGym-agnostic — it dispatches to whatever the adapter exposes. |
| `packages/pi-lean-host/adapter/browsergym-adapter.ts` | +503 | REWORK (heavy) | ~half is BrowserGym RPC surface (`bridge.setup`, `bridge.validate`, task-table queries, venv resolution). ~half is CDP-attach plumbing and `runMiniwobTask` orchestration that's reusable. Split: keep the orchestration + CDP-attach, delete the BrowserGym RPC surface, rename to `miniwob-adapter.ts`. |
| `packages/pi-lean-host/adapter/browsergym-bridge.py` | +379 | DELETE | Entirely BrowserGym glue (task table, `task.setup`/`validate` dispatch, attach). Replace with `miniwob-driver.py` (~50 lines — see §3). |
| `packages/pi-lean-host/docs/cdp-endpoint-spike.md` | +73 | KEEP | CDP attach spike findings. BrowserGym-agnostic. |
| `packages/pi-lean-host/docs/miniwob-spike-findings.md` | +108 | KEEP | MiniWoB integration findings. BrowserGym-agnostic. |
| `packages/pi-lean-host/package.json` | +56 | REWORK | Drop the `setup:venv` script and any browsergym-specific deps. Keep the package metadata, scripts, vitest config. |
| `packages/pi-lean-host/requirements.txt` | +29 | DELETE | browsergym-miniwob + the playwright==1.44 pin. Gone. The hand-rolled driver has no Python deps beyond what the portal python-base already requires. |
| `packages/pi-lean-host/scripts/miniwob-server.ts` | +109 | KEEP | Static file server for MiniWoB++ content. BrowserGym-agnostic. |
| `packages/pi-lean-host/scripts/setup-miniwob.mjs` | moved | KEEP | MiniWoB++ content clone. BrowserGym-agnostic. |
| `packages/pi-lean-host/scripts/setup-venv.mjs` | +115 | DELETE | Creates the dedicated browsergym venv. No longer needed. |
| `packages/pi-lean-host/solvers/parser.ts` | +140 | KEEP | `@e`-ref parsing. BrowserGym-agnostic. |
| `packages/pi-lean-host/solvers/register-suite.ts` | +370 | REWORK (light) | Imports `runMiniwobTask` from the adapter. The import path changes when the adapter is renamed; the suite logic stays. |
| `packages/pi-lean-host/solvers/trivial-solvers.ts` | +189 | KEEP | Trivial solvers using `@e`-ref actions. BrowserGym-agnostic. |
| `packages/pi-lean-host/src/index.ts` | +45 | REWORK (light) | Public API exports. Update if the adapter export name changes. |
| `packages/pi-lean-host/suites/adapter-smoke.test.ts` | +178 | REWORK | End-to-end smoke via `runMiniwobTask`. Logic stays; update for the renamed adapter and the new driver. |
| `packages/pi-lean-host/suites/adapter-smoke-firefox.test.ts` | +181 | REWORK | Same. |
| `packages/pi-lean-host/suites/miniwob-helper.test.ts` | +110 | REWORK | Bridge-client spawn smoke. Becomes a driver-spawn smoke or deletes if the driver is in-process. Decide during execution. |
| `packages/pi-lean-host/suites/miniwob-trivial.test.ts` | +100 | KEEP (light rework) | The 125-task suite. Stays; update the import path. |
| `packages/pi-lean-host/tsconfig.json`, `vitest.config.ts` | +27 | KEEP | Package config. |
| `packages/pi-lean-portal/__tests__/cdp-endpoint.test.ts` | +260 | KEEP | CDP endpoint discovery tests. BrowserGym-agnostic. |
| `packages/pi-lean-portal/__tests__/firefox.test.ts` | +122 | REWORK (trim) | Firefox contract tests expanded for ws-endpoint. **ws-endpoint tests go (§1.3 decision: drop).** Revert toward cleanup baseline; keep only independently-justified additions. |
| `packages/pi-lean-portal/__tests__/helpers/miniwob-suite.ts` | −455 | KEEP (deletion) | Correctly moved to host. |
| `packages/pi-lean-portal/__tests__/helpers/miniwob.ts` | −1285 | KEEP (deletion) | Correctly moved to host. |
| `packages/pi-lean-portal/__tests__/miniwob-helper.test.ts` | −156 | KEEP (deletion) | Correctly moved to host. |
| `packages/pi-lean-portal/__tests__/miniwob.test.ts` | −300 | KEEP (deletion) | Correctly moved to host. |
| `packages/pi-lean-portal/backends/chromium/index.ts` | +60 | REWORK (light) | `getCdpEndpoint` impl. Keep the method; rewrite the docstring to drop BrowserGym framing. |
| `packages/pi-lean-portal/backends/firefox/index.ts` | +57 | REWORK (revert) | `getWsEndpoint` impl + launchServer wiring. **Revert toward cleanup baseline (§1.3 decision: drop).** Keep only independently-justified additions. |
| `packages/pi-lean-portal/backends/playwright-base/playwright-plugin.ts` | +244 | REWORK (revert) | The launchServer/ws-endpoint reconnect machinery. **Revert toward cleanup baseline (§1.3 decision: drop).** Keep only independently-justified changes. This is the largest single deletion in the pass. |
| `packages/pi-lean-portal/core/plugin-api.ts` | +60 | REWORK (light) | `getCdpEndpoint` / `getWsEndpoint` / `connectOverCDP` optionals. **Remove `getWsEndpoint?` (§1.3 decision: drop).** Keep `getCdpEndpoint?` and `connectOverCDP?`; rewrite their docstrings to drop BrowserGym framing (they're general external-attach hooks). |
| `packages/pi-lean-portal/core/shared/cdp-endpoint.ts` | +194 | KEEP | CDP endpoint discovery utility. BrowserGym-agnostic. |
| `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py` | +308 | KEEP | Phase-0 stealth scaffolding. The reviewer noted the sketch is incomplete (doesn't override `create_browser_context` to call camoufox's `NewContext`) — note this as a follow-up, don't fix here. |
| `packages/pi-lean-portal/docs/stealth-backends/invisible-py/bridge.py` | +310 | KEEP | Same. Same follow-up note. |
| `packages/pi-lean-portal/package.json` | +6 | REWORK (light) | Drop any browsergym-only scripts/deps. |

### 1.3 Resolved: drop the firefox `launchServer` path

**Decision (2026-07-06): drop it.** The firefox `launchServer`/`_wsEndpoint`/`_browserServer` reconnect machinery in `playwright-plugin.ts` (+244 lines) was built for BrowserGym's cross-process ws attach. Without BrowserGym it has no named consumer. The stealth backends (the actual near-term need) are Python and use the in-process path, not ws attach. YAGNI applies.

**Action:** revert `playwright-plugin.ts` toward the cleanup baseline, keeping only changes that are independently justified. Revert the `firefox/index.ts` ws-endpoint additions. Trim the `firefox.test.ts` ws-endpoint tests. On the interface, **remove `getWsEndpoint?`** entirely (no consumer, no implementation after the revert — leaving a dead optional is its own bloat). `getCdpEndpoint?` and `connectOverCDP?` stay: chromium CDP attach is still the path the host uses for Node chromium, and `connectOverCDP` is the Mode B hook a future WebArena bridge would need.

Re-evaluate ws-endpoint exposure when a real external-attach-to-firefox consumer appears (debugger, profiler, non-BrowserGym benchmark). At that point the work can be reintroduced with a named consumer justifying it.

### 1.4 Bloat checklist (apply to every KEEP/REWORK verdict)

For each file kept or reworked, verify against this checklist. If any answer is "yes," flag it:

1. **Does this file reference `browsergym`, `BrowserGym`, `bgym`, `ALL_MINIWOB`, `task.setup`, `task.validate`, `AbstractBrowserTask`, or `build_task_table`?** If yes and the file is being kept, those references must be removed or rewritten.
2. **Does this file add a Python import (`browsergym.*`) or a `playwright==1.44` pin?** If yes, the file is a deletion candidate.
3. **Does this file add complexity (new abstraction, new config flag, new lifecycle hook) whose only named consumer is BrowserGym?** If yes, flag for §1.3-style scrutiny.
4. **Does this file duplicate logic that already exists elsewhere in the branch?** If yes, consolidate.
5. **Is the file larger than the cleanup baseline equivalent without a concrete justification in this plan?** If yes, justify or trim.

Run `grep -rnE "browsergym|BrowserGym|bgym|ALL_MINIWOB|task\.setup|task\.validate|AbstractBrowserTask|build_task_table|playwright==1\.44" packages/ scripts/ .github/` after the deletion pass — every remaining hit must be either an ARCHIVE doc or a deliberate "historical reference" comment with a reason.

## 2. Deletion pass — execution order

Ordered so each step is independently verifiable. Commit after each step.

### Step 1 — Archive the design docs

Add a one-line `> **Superseded** — see chat 2026-07-06 and`PLAN-browsergym-removal.md`. BrowserGym dropped as a runtime dependency due to playwright pin incompatibility.` header to the top of:

- `DESIGN-in-process-browsergym.md`
- `browsergym-migration-plan-v2.md`
- `browsergym-migration-phase-1.5.md`
- `browsergym-migration-plan.md`

Do not move them yet (moving creates a noisy diff; the archive header is enough). Leave `stealth-browser-plan-v2.md` alone — it's still current.

**Verify:** `git diff` shows only header additions.

### Step 2 — Revert the firefox launchServer path

Per the §1.3 decision: **drop**. Concrete actions:

- Revert `packages/pi-lean-portal/backends/playwright-base/playwright-plugin.ts` toward the cleanup baseline. Keep only changes that are independently justified (e.g. unrelated bug fixes that landed in the same file). The `_wsEndpoint`, `_browserServer`, launchServer lifecycle, reconnect-on-crash, and close-handler machinery all go.
- Revert `packages/pi-lean-portal/backends/firefox/index.ts` ws-endpoint additions. If any cleanup-baseline-equivalent logic was modified in passing, restore it.
- Trim `packages/pi-lean-portal/__tests__/firefox.test.ts` ws-endpoint tests. Keep only tests that pass against the reverted backend.
- In `packages/pi-lean-portal/core/plugin-api.ts`: **remove `getWsEndpoint?`** from the interface. Keep `getCdpEndpoint?` and `connectOverCDP?`. Rewrite their docstrings to drop BrowserGym framing (handled fully in Step 7, but do the removal here so the type-check stays green).

**Verify:** `npm run test:ci` green. `grep -n "launchServer\|_wsEndpoint\|_browserServer\|getWsEndpoint" packages/pi-lean-portal/` returns nothing. `npx tsc --noEmit` on the portal package passes (no consumer references the removed optional).

### Step 3 — Delete the BrowserGym Python bridge and venv

```bash
git rm packages/pi-lean-host/adapter/browsergym-bridge.py
git rm packages/pi-lean-host/requirements.txt
git rm packages/pi-lean-host/scripts/setup-venv.mjs
```

Remove the `setup:venv` script from `packages/pi-lean-host/package.json`. Remove the venv-setup step from `.github/workflows/ci.yml` and the browsergym-venv cache key.

**Verify:** `ls packages/pi-lean-host/venv 2>/dev/null` — should be gone or gitignored-and-empty. `grep -rn "setup:venv\|setup-venv" packages/ .github/` returns nothing.

### Step 4 — Write the replacement MiniWoB driver

Create `packages/pi-lean-host/adapter/miniwob-driver.py` (~50-80 lines). It is a JSON-RPC server with the same transport shape as the deleted `browsergym-bridge.py` but with hand-rolled MiniWoB glue instead of `browsergym.miniwob`:

- `miniwob.connect(endpoint, kind)` — attach via CDP (`connect_over_cdp`) or ws (`firefox.connect(ws)`), find the active page.
- `miniwob.setup(subdomain, base_url, seed, episode_max_time)` — `page.goto(f"{base_url}{subdomain}.html")`, `page.evaluate` the `seedrandom + startEpisodeReal` block (copied from `BrowserGym/browsergym/miniwob/src/browsergym/miniwob/base.py:88-99`, attributed), `page.wait_for_function("() => WOB_TASK_READY")`. Skip `remove_human_display` (optional, doesn't affect reward).
- `miniwob.validate()` — `page.evaluate` reading `[WOB_REWARD_GLOBAL, WOB_RAW_REWARD_GLOBAL, WOB_REWARD_REASON, WOB_DONE_GLOBAL, WOB_EPISODE_ID, WOB_TASK_READY]` (from `base.py:155-166`). Return `(reward, done, msg, info)`.
- `miniwob.teardown()` — `pass` (MiniWoB has no teardown side-effects).
- `miniwob.ping()` — health check.

**Attribution:** Header comment crediting MiniWoB++ (Farama-Foundation, Apache-2.0) and noting the setup JS is paraphrased from BrowserGym's `base.py` (ServiceNow, Apache-2.0). The code is short enough to be obviously original; the attribution is for the episode-setup protocol.

**No Python dependencies beyond stdlib + playwright.** No numpy, no gymnasium, no browsergym.

**Venv strategy (decided 2026-07-06): no dedicated host venv.** The driver runs in whatever venv the plugin's `pythonPath` points at  the adapter takes `pythonPath` as a constructor arg, supplied by the test file from the `PythonPluginAdapter` config. The portal's existing `chromium-py`/`firefox-py` venv (which already has `playwright>=1.50`) is the typical target. No `resolveVenvPython()`, no `VENV_DIR`, no `setup-venv.mjs`. If `pythonPath` points at a venv without playwright, the driver fails with a clear import error — that's a config error, not a design flaw.

**Verify:** `python -c "import ast; ast.parse(open('packages/pi-lean-host/adapter/miniwob-driver.py').read())"` parses. `grep -n "import browsergym\|from browsergym" packages/pi-lean-host/adapter/miniwob-driver.py` returns nothing.

### Step 5 — Rework the TypeScript adapter

Rename `packages/pi-lean-host/adapter/browsergym-adapter.ts` → `miniwob-adapter.ts`. Strip the BrowserGym RPC surface; keep the CDP-attach plumbing, `runMiniwobTask` orchestration, and `MiniwobBackend` type. Update:

- `BRIDGE_SCRIPT` → `miniwob-driver.py`.
- venv resolution (`resolveVenvPython`) — **delete entirely.** The adapter takes `pythonPath` as a constructor arg from the test file (sourced from `PythonPluginAdapter` config). No `VENV_DIR`, no default venv lookup.
- `bridge.setup` / `bridge.validate` RPC names → `miniwob.setup` / `miniwob.validate` (matching the driver).
- task-table queries (`bridge.listTasks`) — **deleted.** The task list is now a generated file (see Step 5b). No Python round-trip for the task list.
- Docstrings and type comments — drop BrowserGym framing.

**Verify:** `grep -nE "browsergym|BrowserGym|bgym|ALL_MINIWOB" packages/pi-lean-host/adapter/miniwob-adapter.ts` returns nothing. `npx tsc --noEmit` on the host package passes.

### Step 5b — Generate the task list at setup time

**Task list source (decided 2026-07-06): generated file at setup time.** Extend `packages/pi-lean-host/scripts/setup-miniwob.mjs` to write `packages/pi-lean-host/generated/subdomains.ts` after cloning MiniWoB++ content. The generated file is a flat `export const MINIWOB_SUBDOMAINS = ["click-test", "click-button", ...] as const;` array, derived from `readdirSync(miniwobHtmlRoot)` filtered to `*.html` (strip extension).

**Commit policy:** **commit the generated file.** It's small (~125 string literals), reviewable, and lets `npm run test:ci` run without first invoking setup-miniwob. Regenerate deliberately when re-pinning miniwob-plusplus. The generator is idempotent; running it twice produces an identical file (modulo ordering — sort the output).

**`register-suite.ts` changes:**

- Delete the hand-maintained `unsolvedElement` array in `collectAllSubdomains()` (~77 entries).
- Replace `collectAllSubdomains()` with `MINIWOB_SUBDOMAINS` from the generated file.
- Keep `NON_ELEMENT_TASKS` and `SOLVERS` as static constants — they're task-semantic classifications, not file-list-derived.
- The classification logic (`taskRequires`, `SKIP_REASON_BY_REQ`) stays unchanged.

**Verify:** `node packages/pi-lean-host/scripts/setup-miniwob.mjs` produces `generated/subdomains.ts` with 125 entries (matches the pinned miniwob-plusplus commit). `npx tsc --noEmit` passes. `npm run test:ci` green without first running setup-miniwob (the committed generated file is used).

### Step 6 — Update imports and exports

- `packages/pi-lean-host/solvers/register-suite.ts` — `import { runMiniwobTask } from "../adapter/miniwob-adapter.js"`.
- `packages/pi-lean-host/src/index.ts` — update export paths.
- Any test file importing from `browsergym-adapter.js` — update.

**Verify:** `grep -rn "browsergym-adapter" packages/` returns nothing.

### Step 7 — Rewrite docstrings with BrowserGym framing removed

Files: `packages/pi-lean-portal/core/plugin-api.ts` (the `getCdpEndpoint`/`getWsEndpoint`/`connectOverCDP` optionals), `packages/pi-lean-portal/backends/chromium/index.ts`, `packages/pi-lean-portal/backends/firefox/index.ts` (if keeping ws), `packages/pi-lean-host/AGENTS.md`, `packages/pi-lean-host/README.md`, root `AGENTS.md`.

Rewrite around "external attach for benchmarking and tooling" — the hooks are general, not BrowserGym-specific. The README architecture diagram gets redrawn around the hand-rolled driver.

**Verify:** `grep -rnE "browsergym|BrowserGym" packages/pi-lean-portal/ packages/pi-lean-host/README.md packages/pi-lean-host/AGENTS.md AGENTS.md` returns only deliberate historical references in `docs/decisions/` or attribution comments.

### Step 8 — Smoke test the new path

```bash
npm run test:ci                                    # structural, must be green
npm run test:miniwob -w pi-lean-host               # requires chromium + MiniWoB content
npx vitest run packages/pi-lean-host/suites/adapter-smoke.test.ts
```

The 125-task suite should behave as before: 13 run (3 confident + 10 best-effort), 112 skip. The reward signal comes from `WOB_RAW_REWARD_GLOBAL` via the new driver, not `task.validate`.

**Verify:** adapter-smoke shows `rawReward > 0` for `click-test`. miniwob-trivial suite passes the same 13 it did before.

## 3. The replacement driver — reference sketch

This is the ~50-line core that replaces 379 lines of `browsergym-bridge.py` plus the entire BrowserGym dep tree. Not for execution in this plan step — written here so the deletion pass has a concrete target.

```python
# packages/pi-lean-host/adapter/miniwob-driver.py
"""
MiniWoB++ episode driver — JSON-RPC over stdio.

Hand-rolled glue replacing browsergym.miniwob. Reads the same
WOB_*_GLOBAL reward globals that BrowserGym's MiniWoBTask.validate
reads (browsergym/miniwob/base.py:155-178). No browsergym dep.

Attribution:
  MiniWoB++ © Farama-Foundation (Apache-2.0).
  Episode-setup JS paraphrased from BrowserGym's base.py
  (ServiceNow, Apache-2.0).
"""
from playwright.sync_api import sync_playwright

class MiniwobDriver:
    def __init__(self):
        self._pw = None
        self._browser = None
        self._page = None

    def connect(self, endpoint, kind):
        # kind == "cdp": connect_over_cdp; kind == "ws": firefox.connect
        ...

    def setup(self, subdomain, base_url, seed, episode_max_time_ms):
        url = f"{base_url}{subdomain}.html"
        self._page.goto(url)
        self._page.evaluate(
            f"Math.seedrandom({seed});"
            f"core.EPISODE_MAX_TIME={episode_max_time_ms};"
            f"core.startEpisodeReal();"
        )
        self._page.wait_for_function("() => WOB_TASK_READY")
        goal = self._page.evaluate("() => core.getUtterance()")
        return {"goal": goal}

    def validate(self):
        info = self._page.evaluate(
            "() => ({"
            "  reward: WOB_RAW_REWARD_GLOBAL > 0 ? 1 : 0,"
            "  raw_reward: WOB_RAW_REWARD_GLOBAL,"
            "  done: WOB_DONE_GLOBAL,"
            "  reason: WOB_REWARD_REASON,"
            "})"
        )
        return info

    def teardown(self):
        pass
```

Total real logic: ~30 lines. The rest is transport (JSON-RPC loop, ~30 lines, identical to the deleted bridge's transport).

## 4. Verification gates

Before declaring the pass complete:

1. **`npm run test:ci` is green.** Structural tests unaffected by the deletion.
2. **`grep -rnE "browsergym|BrowserGym|bgym|ALL_MINIWOB|task\.setup|task\.validate|AbstractBrowserTask|build_task_table|playwright==1\.44" packages/ scripts/ .github/ AGENTS.md`** returns only: (a) hits inside `docs/decisions/` archived docs, (b) deliberate attribution comments in `miniwob-driver.py`, (c) the `docs/cdp-endpoint-spike.md` / `miniwob-spike-findings.md` historical references. Anything else is a missed reference.
3. **`packages/pi-lean-host/requirements.txt` does not exist.** The host has no Python deps beyond what the portal python-base venv provides (playwright).
4. **`packages/pi-lean-host/scripts/setup-venv.mjs` does not exist.**
5. **`packages/pi-lean-host/adapter/browsergym-bridge.py` does not exist.** `miniwob-driver.py` does.
6. **`npm run test:miniwob`** (if chromium + MiniWoB content available) passes the same 13 tasks as before.
7. **LOC accounting** (run `git diff --stat cleanup/use-benchmarking-libraries HEAD` after the pass):
   - `pi-lean-host` should be **smaller** than the pre-pass state (the bridge + adapter + requirements + setup-venv deletions outweigh the driver addition + generated subdomains file).
   - `pi-lean-portal` should be **smaller than or roughly equal to** the cleanup baseline after the firefox launchServer revert (244-line reduction in `playwright-plugin.ts`, 57 in `firefox/index.ts`, ~122 in `firefox.test.ts`, minus the kept additions: `cdp-endpoint.ts` 194, stealth sketches 618, `plugin-api.ts` net ~40 after `getWsEndpoint?` removal, `chromium/index.ts` 60, `cdp-endpoint.test.ts` 260). If portal grew net-positive vs cleanup after the revert, re-audit — the kept additions should be roughly balanced by the launchServer revert.
   - The `pi-lean-host` package should have **no `venv/`, no `requirements.txt`, no `setup-venv.mjs`**. The `generated/subdomains.ts` file is the only new artifact.
   - If `pi-lean-portal` grew by more than ~400 LOC net vs cleanup after the pass, re-audit — that's the tightened bloat threshold (lowered from 600 because the launchServer revert removes ~400 LOC that was previously counted as "kept").

## 5. Anti-overengineering guardrails

These apply during execution, not just at audit time:

1. **The driver stays under 100 lines of real logic.** If it grows past that, something is being reinvented. BrowserGym's MiniWoB `validate` is 11 lines; ours should be comparable.
2. **No new abstraction in the adapter unless two concrete consumers exist.** The hand-rolled driver has one consumer (`runMiniwobTask`). Don't add a "task driver interface" or a "benchmark backend registry." Add abstractions when the second consumer appears.
3. **No new config flags.** The cleanup baseline had none for this. If a flag seems needed, it's probably papering over a design choice that should be made explicitly instead.
4. **No pre-building the WebArena path.** If a change is motivated by "this will be useful for WebArena later," reject it. WebArena is a separate future decision with a different architecture.
5. **The `pi-lean-host` package stays research tooling.** Don't wire it into the umbrella meta-package, don't add it to the default install, don't ship it as a pi extension. It's a dev-only harness.
6. **The portal-side additions earn their LOC.** `cdp-endpoint.ts` (194) is justified — it's the chromium external-attach path. The stealth sketches (618 combined) are justified — stealth bench is real. The firefox launchServer path (244) is **dropped per §1.3** — no named consumer, YAGNI. Every kept addition is concrete and consumer-backed; nothing stays on a hypothetical.

## 6. Resolved decisions (2026-07-06)

All three open questions are settled. Recording the outcomes here so the execution steps can reference them without ambiguity.

1. **§1.3 firefox launchServer path: DROP.** Revert `playwright-plugin.ts` toward the cleanup baseline; revert `firefox/index.ts` ws additions; trim `firefox.test.ts` ws tests; **remove `getWsEndpoint?` from `plugin-api.ts`** entirely. `getCdpEndpoint?` and `connectOverCDP?` stay. Re-evaluate ws-endpoint exposure when a named external-attach-to-firefox consumer appears. See Step 2.
2. **Driver venv strategy: NO DEDICATED HOST VENV.** `miniwob-driver.py` runs in whatever venv the plugin's `pythonPath` points at. The adapter takes `pythonPath` as a constructor arg (sourced from `PythonPluginAdapter` config by the test file). Delete `resolveVenvPython()`, `VENV_DIR`, `setup-venv.mjs`, `requirements.txt`. If `pythonPath` points at a venv without playwright, the driver fails with a clear import error — config error, not design flaw. See Step 4.
3. **Task list source: GENERATED FILE AT SETUP TIME.** `setup-miniwob.mjs` writes `packages/pi-lean-host/generated/subdomains.ts` (a committed `MINIWOB_SUBDOMAINS` const array) from `readdirSync(miniwobHtmlRoot)` filtered to `*.html`. `register-suite.ts` imports it and deletes its hand-maintained `unsolvedElement` array. `NON_ELEMENT_TASKS` and `SOLVERS` stay as static semantic classifications. See Step 5b.

## 7. Expected end state

After the pass:

- `pi-lean-host` is a MiniWoB evaluation harness with no BrowserGym dependency, no dedicated venv, no `requirements.txt`, no `setup-venv.mjs`, no playwright pin conflict. The hand-rolled driver is ~50-80 lines. The task list is a committed generated file, regenerated only when re-pinning miniwob-plusplus.
- `pi-lean-portal` keeps the genuinely valuable additions: CDP endpoint discovery (`cdp-endpoint.ts`), stealth backend sketches, `getCdpEndpoint?` and `connectOverCDP?` on `BrowserPlugin`. The firefox launchServer path is **reverted** — 244 lines of reconnect machinery removed, `getWsEndpoint?` removed from the interface.
- The four BrowserGym design docs are archived with "superseded" headers, not maintained.
- The WebArena future-option is preserved (a standalone Mode B bridge is the right architecture when it becomes real) but not pre-built.
- Total branch LOC vs cleanup is **net-positive but bounded** — the kept work (host package, solvers, CDP, stealth) outweighs the deletions, and there is no BrowserGym-shaped complexity anchor. The firefox launchServer revert is the single largest LOC reduction in the pass.

The branch name `cleanup/use-benchmarking-libraries` finally becomes accurate: MiniWoB++ is the benchmarking library, used directly, without a heavyweight intermediary.
