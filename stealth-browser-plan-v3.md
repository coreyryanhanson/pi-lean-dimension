# Stealth Python Backends — Plan v3 (gap-focused)

> Status: **ACTIVE** — supersedes `stealth-browser-plan-v2.md` (2026-06-30).
> v2 was a packaging-aware replan written before any code existed; most
> of it has since been implemented. This document is **self-contained**:
> it re-states only the model a developer needs, records what shipped,
> and focuses on the **remaining gaps** — the largest of which
> (MiniWoB++ integration for user-managed stealth backends) was not in
> v2 at all.
>
> Date: 2026-07-08 (revised after architectural review)
> Author: GLM 5.2
> Branch: `feat/stealth-browser-quirks`
>
> **Path convention:** all `docs/stealth-backends/...` paths in this
> document refer to **`packages/pi-lean-portal/docs/stealth-backends/...`**
> (the templates live inside the portal package, not at the repo root).
> The `packages/pi-lean-portal/` prefix is omitted for brevity in
> running prose but is shown in full where a `cp`/import path matters.

## TL;DR

- **Phase 0 (shared bridge infra) — DONE.** `browser.init` RPC, the
  quirks schema on `PlaywrightBridge`, and `python-adapter.ts` config
  forwarding are all in the published package and covered by tests.
- **Phase 0b (packaging/discovery) — DONE.** Multi-root
  `detectPluginType(dir, roots)`, `USER_BACKENDS_DIR`, absolute-path
  short-circuit, and `PYTHONPATH` injection are all shipped and tested.
- **Camoufox backend — DONE as a user-installed template.**
  `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py`
  is a complete, working, copy-pasteable subclass (committed `81cecb5`).
  It is **docs, not source** — users drop it into
  `~/.pi/agent/pi-lean-portal/user-backends/` or use it as a reference
  for implementing other stealth browsers with quirks. Note: `docs/` is
  **not** in `packages/pi-lean-portal/package.json` `files`, so the
  template is only available from the **source repo**, not the npm
  tarball (see Gap 3).
- **invisible-playwright — confirmed working, but NOT shipped.** The
  bridge exists only as an untracked local file
  (`packages/pi-lean-portal/docs/stealth-backends/invisible-py/bridge.py`,
  **not in git**). It validated the lifecycle-ownership-override
  pattern and the quirks schema against a second stealth engine, but
  `invisible-playwright` is a low-adoption plugin and implicitly
  endorsing it in shipped code/docs is a security/reputational risk we
  do not want to take. **All references to it must be scrubbed from the
  shipped codebase** — see the "invisible-playwright policy" section,
  including **Gap 0** (the scrub itself, which is currently outstanding:
  four tracked files still name it).
- **Remaining gaps (the work this plan owns):**
  1. **MiniWoB++ integration for stealth backends** — the shipped
     MiniWoB suite covers only the four in-package backends. Stealth
     backends must be exercisable through the same 130-task harness,
     **and** this must work when the backend lives in the user config
     tree, not the source repo. (New — not in v2.)
  2. **AGENTS.md updates** — neither root nor portal `AGENTS.md`
     mention `user-backends/`, `browser.init`, the quirks schema, or
     the user-managed stealth model.
  3. **`packages/pi-lean-portal/docs/stealth-backends/README.md`** —
     install steps, venv setup, binary fetch, `settings.json` shape,
     absolute-`pythonPath` rule. Only `bridge.py` templates exist
     today; no README.
  4. **`STEALTH.md`** — when to pick which backend (shipped vs stealth,
     Camoufox vs a custom engine).
  5. **Camoufox contract tests** —
     `__tests__/camoufox-py.test.ts` +
     `__tests__/camoufox-py-persistence.test.ts`, auto-skip on missing
     deps, driving a real user-backends install on the dev machine.
     (No invisible-py tests ship — see policy.)
  6. **CI opt-in workflow** for the camoufox live-browser tests.

---

## Model (the parts that survived v2 unchanged)

### Deployment: user-managed, not source-managed

Stealth backends are **user-installed plugins**, never shipped in the
npm tarball. They live under the user-writable data tree:

```
~/.pi/agent/pi-lean-portal/
├── web-guides/              (existing)
├── browser-state/           (existing)
└── user-backends/           (NEW, shipped by Phase 0b)
    └── camoufox-py/
        ├── bridge.py        (user copies from packages/pi-lean-portal/docs/stealth-backends/)
        └── .venv/           (user-created: camoufox[geoip] + playwright)
```

`settings.json` references them by bare `dir` (resolved against
`USER_BACKENDS_DIR`) or absolute path, with an **absolute** `pythonPath`
pointing at the user venv's interpreter:

```jsonc
{
  "browser": {
    "plugins": [{
      "name": "camoufox-py",
      "dir": "camoufox-py",
      "enabled": true,
      "config": {
        "pythonPath": "/home/me/.pi/agent/pi-lean-portal/user-backends/camoufox-py/.venv/bin/python",
        "launch": { "headless": true, "os": "windows", "humanize": true }
      }
    }]
  }
}
```

The four shipped backends (`chromium`, `firefox`, `chromium-py`,
`firefox-py`) remain the default fallback when `browser.plugins` is
absent. Stealth backends are **never** in the fallback list — a fresh
install must not emit validation errors for plugins the user never
asked for.

### Discovery: multi-root, absolute short-circuit

`detectPluginType(dir, roots)` resolves `dir` in order:

1. **Absolute path** — used directly (dev/power-user escape hatch).
2. **`DEFAULT_BACKEND_ROOTS[0]`** = package `backends/` (shipped backends).
3. **`DEFAULT_BACKEND_ROOTS[1]`** = `USER_BACKENDS_DIR` (user stealth).

First root with an unambiguous entry point (`index.ts` XOR `bridge.py`)
wins. Missing from all roots throws an error naming every root searched.
Implemented in `core/plugin-config.ts`; tested in
`__tests__/plugin-loading.test.ts`.

### Importability: `PYTHONPATH` injection

`python-adapter.ts` `_buildPythonPath()` appends the package's
`backends/python-base/` to any existing `PYTHONPATH` in the spawn env,
so a user bridge in its own venv can
`from pi_browser_bridge.playwright_base import PlaywrightBridge`
without a `pip install` of `pi-browser-bridge` (which is not on PyPI).
Append (not prepend) so the editable install in `python-base/.venv`
keeps precedence for the shipped `chromium-py` / `firefox-py` bridges.
Tested in `__tests__/python-adapter.test.ts` ("PYTHONPATH injection").

### Config channel: `browser.init` RPC

After the `ping` handshake, `python-adapter.ts` sends a single
`browser.init` RPC with `{ config: <user config dict> }`. The bridge
stores it as `self._plugin_config`; subclasses read
`self.plugin_config.get("launch", {})`. A bridge that does not
recognize `browser.init` rejects with a "bridge too old" message so
upgrades fail loudly. Re-sent after crash-recovery restarts. Tested in
`__tests__/python-adapter.test.ts` ("browser.init RPC").

### Quirks schema (`PlaywrightBridge` class attrs)

| Flag | Default | Effect when set |
|------|---------|-----------------|
| `_fingerprint_managed_context` | `False` | `create_browser_context()` skips hardcoded `viewport`/`user_agent`; lets the fingerprint package set them. |
| `_eval_prefix` | `""` | Prepended to every `page.evaluate` expression in `do_evaluate` (e.g. Camoufox's `"mw:"` routes writes to the main world). |
| `_scroll_via_wheel` | `False` | `do_scroll` uses `page.mouse.wheel` instead of `page.evaluate("window.scrollBy")` (avoids eval-write under isolated-world stealth). |
| `_skip_default_viewport` | `False` | Skips Playwright's `Browser.setDefaultViewport` CDP call (Camoufox binary rejects its `isMobile` prop). |
| `_skip_networkidle` | `False` | Nav-settle uses `load` instead of `networkidle` (patched binaries don't fire `networkidle` reliably). |

All flags default off → `chromium-py` / `firefox-py` behavior is
bit-identical to pre-Phase-0. Implemented in
`backends/python-base/pi_browser_bridge/playwright_base.py`.

> **Note:** v2 also specified a `_context_factory` flag dispatching to
> a `_camoufox_new_context` helper. **This was dropped during
> implementation** when it turned out `camoufox.NewContext` is broken
> on the current binary (`Protocol error (Browser.setDefaultViewport)`
> from the same `isMobile` rejection that `_skip_default_viewport`
> handles). Camoufox injects the fingerprint at **browser launch** via
> `camoufox.NewBrowser`, so standard `browser.new_context()` with
> `_fingerprint_managed_context = True` is correct. The committed
> `camoufox-py/bridge.py` documents this. v3 records it so a future
> reader does not re-attempt `NewContext`.

---

## What shipped (evidence)

| v2 item | State | Evidence |
|---------|-------|----------|
| `browser.init` handler + `plugin_config` property | ✅ | `bridge.py` L91–109, L418–424 |
| Quirks schema on `PlaywrightBridge` | ✅ | `playwright_base.py` L120–157 |
| `python-adapter.ts` sends `browser.init` after ping | ✅ | `python-adapter.ts` L430–448 |
| `python-adapter.ts` `PYTHONPATH` injection | ✅ | `python-adapter.ts` L333–336, `_buildPythonPath` L1168+ |
| `USER_BACKENDS_DIR` | ✅ | `core/shared/paths.ts` L48 |
| Multi-root `detectPluginType(dir, roots)` + absolute short-circuit | ✅ | `core/plugin-config.ts` L359–396 |
| `loadFullConfig` / `loadPluginConfig` accept `roots` | ✅ | `core/plugin-config.ts` L232, L434 |
| `index.ts` passes `DEFAULT_BACKEND_ROOTS` | ✅ | `index.ts` L76 |
| `patch_playwright.py` (Camoufox Juggler driver fix) | ✅ (bonus) | `pi_browser_bridge/patch_playwright.py` — not in v2, added because the patched Firefox binary crashes Playwright's Node driver on uncaught `Page.uncaughtError` events with a missing `location` field. |
| Camoufox `bridge.py` template (docs) | ✅ | `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py` (committed `81cecb5`; **not in npm tarball** — `docs/` is excluded from `package.json` `files`) |
| Tests: `browser.init`, `PYTHONPATH`, multi-root, default-fallback exclusion | ✅ | `python-adapter.test.ts`, `plugin-loading.test.ts`, `plugin-config-browser.test.ts` |

---

## invisible-playwright policy (NEW in v3)

invisible-playwright was used during development to validate the
quirks schema and the `_ensure_playwright` / `_maybe_stop_playwright`
override pattern against a second stealth engine. It works. But:

- It is a **low-adoption plugin**. Shipping its bridge code or
  referencing it by name in shipped docs/code constitutes an implicit
  endorsement we do not want to make — both for security
  (supply-chain surface) and reputational reasons.
- The lifecycle-ownership override it required is **already proven** by
  the development work; the pattern is documented in the quirks schema
  rationale and the Camoufox template's docstrings, without naming the
  second engine.

**Rules:**

1. **No invisible-playwright code in git.** The local
   `packages/pi-lean-portal/docs/stealth-backends/invisible-py/bridge.py`
   stays **untracked** (current state: `git status` shows it as `??`).
   It is a development artifact, not a shipped template. (It lives
   inside `packages/` so the grep guard below must be tracked-only —
   see rule 2.)
2. **No references to `invisible-playwright` / `invisible-py` in
   shipped, git-tracked files.** This includes `AGENTS.md`, `STEALTH.md`,
   the `packages/pi-lean-portal/docs/stealth-backends/README.md`, the camoufox template's
   docstrings, test files, and CI workflows. The guard is
   `git grep -ni "invisible" -- packages/` (tracked files only — a
   plain `grep -ri` would match the untracked dev artifact and give a
   false failure). It must return nothing.
3. **No invisible-py contract tests ship.** The validation it provided
   is recorded in this document's "What shipped" evidence table and in
   the quirks schema; it does not need a live test in the repo.
4. **The pattern is still documented generically.** The
   `STEALTH.md` "implementing your own stealth backend" section
   describes the lifecycle-ownership override pattern in the abstract
   ("if your stealth engine owns its own Playwright instance, override
   `_ensure_playwright` / `_maybe_stop_playwright`…") without naming
   invisible-playwright. A developer who needs it can recognize their
   engine's behavior from the abstract description.

### ⛔ Gap 0 — Scrub existing invisible references (BLOCKING, currently outstanding)

**The tree is NOT currently clean.** A review found four shipped,
git-tracked files that still name `invisible_playwright` / `invisible-py`.
The grep guard in rule 2 would fail today. This scrub is a **hard
prerequisite** for the policy being enforceable and must be done
**before** Gap 6's CI grep guard lands. Files to scrub:

1. `packages/pi-lean-portal/backends/python-base/pi_browser_bridge/playwright_base.py`
   — lines 107, 141, 147, 297, 301: comments name
   `invisible_playwright` as a stealth subclass / patched-`new_context`
   engine. Rewrite generically, e.g. replace `invisible_playwright`
   with "another stealth engine that patches `new_context`".
2. `packages/pi-lean-portal/core/shared/paths.ts:35` — JSDoc example
   lists `invisible-py/`. Remove that example (keep `camoufox-py/` as
   the sole worked example) or substitute a synthetic `stealth-py`
   placeholder.
3. `packages/pi-lean-portal/__tests__/plugin-config-browser.test.ts`
   — lines 175 (`it("does NOT include stealth backends (camoufox-py /
   invisible-py) in the default fallback", …)`) and 180
   (`expect(names).not.toContain("invisible-py")`): rename the skip
   label and the assertion to a synthetic `stealth-py` placeholder so
   the test still asserts a non-fallback stealth name is excluded
   without referencing the real engine.
4. `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py:270`
   — the comment reads "pattern was inherited from the invisible-py
   template, which has a real binary-level back-navigation bug." This
   is the flagship shipped artifact directly crediting invisible-py by
   name — the most visible violation. Rephrase to describe the pattern
   in the abstract (e.g. "some patched Firefox binaries have a
   binary-level back-navigation bug that requires a `document.referrer`
   workaround; Camoufox does not, with `enable_cache=True`") without
   naming the other engine.

After scrubbing all four, run
`git grep -ni "invisible" -- packages/` — expect zero matches (the
untracked `invisible-py/` dev artifact is correctly ignored by
`git grep`). Only then is the Gap 6 grep guard enforceable.

This keeps the shipped surface endorsement-free while preserving the
architectural knowledge for future stealth engines that share the
lifecycle-ownership quirk.

---

## Gap 1 — MiniWoB++ integration for user-managed stealth backends

### The problem

The shipped MiniWoB++ suite (`packages/pi-lean-host/suites/`) covers
the four in-package backends. Each shipped suite file hardcodes:

- `BRIDGE_SCRIPT = resolve(__dirname, "../../pi-lean-portal/backends/<name>-py/bridge.py")`
- `VENV_PYTHON = resolve(__dirname, "../../pi-lean-portal/backends/python-base/.venv/bin/python3")`

A user-managed stealth backend lives at
`~/.pi/agent/pi-lean-portal/user-backends/<name>-py/bridge.py` with its
own `.venv/bin/python`. The shipped suite files cannot point there —
they are repo artifacts, and the user's backend is not in the repo.

### The constraint

The integration must work **even when the backend is not managed in
the source repository but in a config folder within pi** — i.e. the
user's `user-backends/` tree. We must not require the user to fork the
repo or edit shipped suite files.

### The design

`pi-lean-host` already exports `registerMiniwobSuite(backend,
getBaseUrl)` as the public extension point for user-owned parity test
files (see `solvers/register-suite.ts` doc comment +
`pi-lean-host/README.md` "User-owned parity test files"). This is the
correct mechanism: a user authors a small `.test.ts` that constructs a
`PythonPluginAdapter` pointed at their user-backends install and
registers it against the 130-task suite.

What is missing is a **shipped helper that makes authoring that file
trivial for a user-managed backend**, plus a **shipped example for
Camoufox** (since we ship the Camoufox template, we can ship the
matching parity-test template alongside it).

#### 1a. New helper: `probeUserBackend(name)` in `pi-lean-host`

Export a small probe from `pi-lean-host/src/index.ts`. **Placement
note:** `probePythonBackend` already lives in
`packages/pi-lean-host/suites/miniwob-suite-helper.ts` and is
re-exported from `src/index.ts` as a public API, so adding
`probeUserBackend` alongside it is consistent with that precedent.
However, `miniwob-suite-helper.ts`'s module doc currently says
"User-owned parity test files do **not** use this helper" — that
wording is now stale (it already houses the public `probePythonBackend`).
**Either** update that doc comment to acknowledge the helper also
houses public probes reused by user-owned parity files, **or** place
`probeUserBackend` in a new `packages/pi-lean-host/src/probe-user-backend.ts`
module re-exported from `src/index.ts`. Pick one and align the docs.

The probe resolves a user-managed backend's bridge + venv and reports
availability, mirroring `probePythonBackend` but rooted at
`USER_BACKENDS_DIR`:

```ts
export function probeUserBackend(name: string): {
  available: boolean;
  bridgePath: string;
  venvPython: string;
  reason?: string;
}
```

Resolution rules (mirror `detectPluginType` so the test file and the
runtime loader agree):

- `bridgePath` = `join(USER_BACKENDS_DIR, name, "bridge.py")` (or
  absolute if the user passed one — accept an optional
  `opts.bridgePath` override).
- `venvPython` = `join(USER_BACKENDS_DIR, name, ".venv/bin/python3")`
  unless the user sets `PI_USER_BACKEND_<UPPERNAME>_PYTHON` (lets a
  user point at a non-`user-backends` venv without editing the test).
- `available` = bridge exists AND venv python runs AND (for camoufox)
  the fetched binary probe passes. Reason string explains the first
  missing piece so a skip message is useful.

This keeps the user's parity-test file to ~15 lines and avoids every
user re-implementing the probe.

#### 1b. New shipped template: `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/miniwob-parity.test.ts`

A copy-pasteable parity-test template, **docs-only (not in
`package.json` `files`, not run by `npm run test:miniwob`)**. The user
drops it into their own test tree (or a scratch vitest project) and
runs it. It uses `probeUserBackend("camoufox-py")` +
`registerMiniwobSuite`. The `PythonPluginAdapter` constructor is
`new PythonPluginAdapter(name: string, config: PythonBridgeConfig)`
where `config.bridgeScript` (not `bridgePath`) is the required field —
verified against `packages/pi-lean-host/suites/miniwob-chromium-py.test.ts:82`
and `packages/pi-lean-portal/backends/python-adapter.ts:215`. The
adapter also needs a `capabilities` override so the contract suite's
identity test reads the engine correctly (Camoufox is Firefox-based):

```ts
import { describe } from "vitest";
import { registerMiniwobSuite, probeUserBackend } from "pi-lean-host";
import { PythonPluginAdapter } from "pi-lean-portal/backends/python-adapter.js";

const probe = probeUserBackend("camoufox-py");
const baseUrl = async () => process.env.MINIWOB_URL ?? "http://localhost:8080";

registerMiniwobSuite(
  {
    name: "camoufox-py",
    available: probe.available,
    initPlugin: async () => {
      const adapter = new PythonPluginAdapter("camoufox-py", {
        bridgeScript: probe.bridgePath,
        pythonPath: probe.venvPython,
        capabilities: {
          supportsFullPageScreenshot: true,
          supportsConsoleCapture: true,
          supportsJavaScriptEvaluate: true,
          supportsBotDetection: true,
          supportsDialogAutoDismissal: true,
          supportsAbortSignal: false,
          engine: "firefox", // Camoufox is Firefox-based
        },
      });
      await adapter.init({});
      return adapter;
    },
  },
  baseUrl,
);
```

This proves the full `plugin.evaluate` episode lifecycle (setup →
solve → validate → done-poll) works through a user-managed stealth
backend, against the same 130-task set the shipped backends use.

#### 1c. Optional: a generic "discover any user backend" parity runner

If we want `npm run test:miniwob` to pick up whatever stealth backends
the developer has installed locally (without per-backend template
files), add an **opt-in, dev-only** suite file
`packages/pi-lean-host/suites/miniwob-user-backends.test.ts` (added to
the repo's `suites/` directory — note `suites/` is **not** in
`pi-lean-host`'s `package.json` `files`, so like the existing
`miniwob-*.test.ts` files it is a repo/dev artifact, **not** in the npm
tarball; it runs under `npm run test:miniwob` because that script is
`vitest run suites/`) that:

- Reads `~/.pi/agent/pi-lean-portal/user-backends/` (or an env override).
- For each `<name>-py/` with a `bridge.py`, registers a MiniWoB suite
  via `probeUserBackend(name)` + `registerMiniwobSuite`.
- Auto-skips the whole file when `user-backends/` is empty or absent
  (the normal CI state).

This is **not** required for the user-managed constraint (1b already
satisfies it), but it is a nice dev ergonomic for maintainers who run
several stealth engines locally. **DECISIONED: include it** — it
doubles as the maintainer's regression suite for the quirks schema
across whatever stealth engines are installed, without forcing any
specific engine into the repo.

> **`PythonPluginAdapter` constructor signature — verified.** The
> constructor is `new PythonPluginAdapter(name: string, config:
> PythonBridgeConfig)` with required `config.bridgeScript` (the path
> to `bridge.py`) and `config.pythonPath`. A `capabilities` override is
> needed so the contract/MiniWoB suites read the engine correctly. See
> the 1b template and `miniwob-chromium-py.test.ts:82` for the exact
> shape. (Earlier drafts of this plan used a nonexistent `bridgePath`
> field and omitted the positional `name` arg — both are corrected
> above.)

#### 1d. Why this satisfies "user-managed, not source-managed"

- The shipped code (`probeUserBackend` + `registerMiniwobSuite`) knows
  nothing about Camoufox or any specific stealth engine — it resolves
  whatever `name` the user passes against `USER_BACKENDS_DIR`.
- The Camoufox parity template (1b) lives in `docs/`, not in
  `packages/pi-lean-host/suites/`, so `npm run test:miniwob` does not
  run it and it is not in the tarball. The user owns whether and where
  they run it.
- The generic runner (1c) is shipped but **auto-skips when
  `user-backends/` is empty** — it discovers the user's config-tree
  backends at runtime, not at authoring time. No stealth engine is
  named in shipped source.

### Exit criteria (Gap 1)

- `probeUserBackend` exported from `pi-lean-host`; unit-tested against
  a temp `USER_BACKENDS_DIR` with a fake `bridge.py` + venv.
- `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/miniwob-parity.test.ts` template
  present, compiles against the shipped adapter API, and (manually
  verified on a dev machine with Camoufox installed) runs the 13
  trivial-solver tasks with reward > 0 on the 3 confident tasks.
- `packages/pi-lean-host/suites/miniwob-user-backends.test.ts` added to
  the repo's `suites/` directory (not in the npm tarball — `suites/` is
  excluded from `pi-lean-host`'s `package.json` `files`), auto-skips
  when `user-backends/` is empty, and passes `npm run test:ci`
  (structural) green.
- `npm run test:ci` green.

---

## Gap 2 — AGENTS.md updates

Both `AGENTS.md` (monorepo root, "Active plugins" table) and
`packages/pi-lean-portal/AGENTS.md` need a new section covering:

- The **user-backends model**: `~/.pi/agent/pi-lean-portal/user-backends/`,
  not in the npm tarball, trusted user code (not a plugin marketplace —
  the user wrote or audited it; no auto-download).
- **Multi-root `dir` resolution** (package root → `USER_BACKENDS_DIR` →
  absolute), with the absolute-`pythonPath` rule.
- **`browser.init` RPC** + `plugin_config` as the config channel.
- **The quirks schema** table (from this document's "Model" section).
- **`PYTHONPATH` injection** making `pi_browser_bridge` importable from
  any user venv.
- **Camoufox as the shipped example template** (docs-only, source
  repo only — not in the npm tarball because `docs/` is excluded from
  `packages/pi-lean-portal/package.json` `files`), with a one-line
  pointer to `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py`.
- A **Known Constraints** entry for: fingerprint-managed context,
  Camoufox `mw:` prefix + `main_world_eval`, the `isMobile` /
  `_skip_default_viewport` binary quirk, `xvfb` for
  `headless='virtual'`, and the user-side install burden (venv +
  binary fetch + `settings.json` entry).
- Update the root `AGENTS.md` "Active plugins" table to add a
  **user-installed (not shipped)** row for stealth backends, and the
  Test files table with the new auto-skip suites/tests.

**Do NOT mention invisible-playwright anywhere in either AGENTS.md.**
Describe the lifecycle-ownership override pattern generically under
"implementing your own stealth backend" if at all.

---

## Gap 3 — `packages/pi-lean-portal/docs/stealth-backends/README.md`

A single README covering the user install flow for any stealth backend
that follows the template shape, with Camoufox as the worked example.
**The templates and this README live in the source repo under
`packages/pi-lean-portal/docs/stealth-backends/`; they are not bundled
in the npm package** (users need the git repo, or a copy of the
files, to follow these steps):

1. **Pick a location:** `~/.pi/agent/pi-lean-portal/user-backends/<name>-py/`.
2. **Copy the template** from the source repo at
   `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py`
   (or write your own subclass using the quirks schema documented in
   `playwright_base.py`). State explicitly that this requires the git
   repo, not just `npm install pi-lean-portal`.
3. **Create a venv** at `user-backends/<name>-py/.venv/` and install the
   engine's pip package + `playwright`.
4. **Fetch the patched binary** (engine-specific command, e.g.
   `python -m camoufox fetch`).
5. **System deps:** `xvfb` on Linux if using `headless='virtual'`.
6. **Register in `settings.json`** with an **absolute** `pythonPath` and
   a `launch` object. Show the Camoufox example JSON.
7. **Verify:** `/web status` lists the plugin; `browser-navigate` to a
   test page works; on a missing binary, the bridge's `_install_hint`
   surfaces.
8. **Security note:** `user-backends/` is trusted user code. The
   extension never downloads or executes stealth backends
   automatically. Audit anything you copy.
9. **Benchmarking (optional):** pointer to the
   `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/miniwob-parity.test.ts`
   template and the `registerMiniwobSuite` public API for running the
   130-task MiniWoB++ suite against the user's install.

No mention of invisible-playwright.

---

## Gap 4 — `STEALTH.md` (or a `packages/pi-lean-portal/docs/stealth-backends/CHOOSING.md`)

A short decision doc:

- **When to use a stealth backend at all:** bot-detection sites that
  block the shipped Chromium/Firefox. Most sites do not need it; the
  shipped backends are faster and have better ARIA-tree parity.
- **When to use Camoufox specifically:** the shipped, tested template.
  Firefox-based, fingerprint injected at browser launch, `mw:`-prefix
  main-world eval, wheel-based scroll. Point at the
  `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/` template.
- **Implementing your own stealth backend:** the quirks schema is the
  contract. Describe each flag and when a given engine needs it. Cover
  the two lifecycle patterns in the abstract:
  1. **Engine accepts an external Playwright instance** (e.g.
     `NewBrowser(playwright, …)`) — do not override
     `_ensure_playwright`; override `_launch_browser` only. (Camoufox
     is the example.)
  2. **Engine owns its own Playwright instance** — override
     `_ensure_playwright` / `_maybe_stop_playwright` to delegate to the
     engine's context manager; do not call super. (Described
     abstractly; no engine named.)
- **Trade-offs:** ~100 MB binary fetch, per-engine venv, slower
  humanized input, `xvfb` on Linux for some headless modes, back-nav
  may be limited on patched binaries (Camoufox needs `enable_cache`,
  engines with bfcache disabled may need a `document.referrer`
  workaround — described generically).

No mention of invisible-playwright.

---

## Gap 5 ��� Camoufox contract tests

Ship two auto-skip test files in `packages/pi-lean-portal/__tests__/`
(mirroring `chromium-py.test.ts` / `chromium-py-persistence.test.ts`):

- `camoufox-py.test.ts` — `runContractTests("camoufox-py", factory,
  { realBrowser: true })`. **`ContractTestOptions` is
  `{ realBrowser?, navigateTimeout?, navigationSettle? }` only — there
  is no `engine` field** (verified against
  `packages/pi-lean-portal/__tests__/helpers/plugin-contract.ts:42-66`;
  passing `engine: "firefox"` would be an excess-property type error
  under `exactOptionalPropertyTypes`). The engine is advertised on the
  plugin's `capabilities`, which the contract suite's identity test
  reads (`plugin-contract.ts:281`). So the factory must construct the
  `PythonPluginAdapter` with a `capabilities` override setting
  `engine: "firefox"` (same shape as Gap 1b), and the `runContractTests`
  options pass only `{ realBrowser: true, navigateTimeout, navigationSettle }`
  — matching `firefox-py.test.ts:102`. The factory constructs a
  `PythonPluginAdapter` pointed at
  `~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/`. Auto-skip
  when `probeUserBackend("camoufox-py").available` is false. Add a
  Camoufox-specific assertion that `do_scroll` works (wheel) and
  `do_evaluate("() => 1 + 1")` returns `2` (with the `mw:` prefix).
- `camoufox-py-persistence.test.ts` — mirrors
  `chromium-py-persistence.test.ts`, auto-skip on missing deps.

These are `.test.ts` → skipped by the ship-manifest walk → not in the
tarball. They run only on a dev machine with Camoufox installed, and
they exercise the multi-root discovery + `PYTHONPATH` injection +
`browser.init` + quirks schema end-to-end against a real user-backends
install.

**No invisible-py tests ship** (per the policy).

---

## Gap 6 — CI opt-in workflow

Add a `workflow_dispatch`-only (or path-filtered on
`packages/pi-lean-portal/docs/stealth-backends/**`) job to
`.github/workflows/ci.yml` that:

1. Sets up Node 22 + Python 3.12 + a venv at
   `~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/.venv/`.
2. `pip install cloverlabs-camoufox[geoip]` + `python -m camoufox fetch`.
3. Copies `packages/pi-lean-portal/docs/stealth-backends/camoufox-py/bridge.py`
   into the user-backends tree.
4. Runs the camoufox contract tests + the
   `miniwob-user-backends.test.ts` suite (which will discover the
   copied camoufox-py).
5. **Runs the invisible-reference grep guard:**
   `git grep -ni "invisible" -- packages/` must exit non-zero on any
   match (tracked files only; the untracked `invisible-py/` dev
   artifact is correctly ignored by `git grep`). This enforces the
   Gap 0 scrub stays in place. **Depends on Gap 0 being complete** —
   do not enable this step until the four tracked files are scrubbed.
6. Uploads traces on failure.

This keeps `npm run test:ci` / `test:miniwob` green in bare CI while
giving maintainers a one-click way to validate the stealth path.

---

## Implementation order

0. **Gap 0 (Scrub existing invisible references)** — BLOCKING prerequisite
   for the policy being enforceable. Rewrite the four tracked files
   (see Gap 0 list) and confirm `git grep -ni "invisible" -- packages/`
   returns nothing. Do this first; it is small and unblocks the Gap 6
   grep guard.
1. **Gap 1 (MiniWoB integration)** — `probeUserBackend` helper + tests,
   then the generic `miniwob-user-backends.test.ts` runner, then the
   Camoufox parity-test template in docs. This is the largest gap and
   the one v2 missed entirely.
2. **Gap 5 (Camoufox contract tests)** — depends on `probeUserBackend`
   from Gap 1 for the availability probe; do after 1.
3. **Gap 2 (AGENTS.md)** + **Gap 3 (README)** + **Gap 4 (STEALTH.md)** —
   docs; do together after the code is settled so they describe what
   shipped.
4. **Gap 6 (CI)** — last; wires up everything from 0 + 1 + 5. Its grep
   guard step depends on Gap 0; its test steps depend on Gaps 1 + 5.

Gaps 1 and 5 touch disjoint files except for the shared
`probeUserBackend` export; do 1 first, then 5 reuses it.

---

## Risk summary (remaining risks only)

| Risk | Severity | Mitigation |
|------|----------|------------|
| `PythonPluginAdapter` constructor shape drift breaks the parity-test template | **Low** | Constructor signature verified against `python-adapter.ts:215` and `miniwob-chromium-py.test.ts:82`: `new PythonPluginAdapter(name, { bridgeScript, pythonPath, capabilities })`. The 1b template now uses the correct shape. Re-verify on adapter refactors; compile-check the template in a docs-only CI lint step. |
| User-managed backend not discovered by `miniwob-user-backends.test.ts` because `USER_BACKENDS_DIR` differs in CI | **Low** | The runner reads `USER_BACKENDS_DIR` (or an env override) — same constant the runtime loader uses — so discovery agrees. |
| Camoufox binary version bump breaks the shipped template (e.g. `NewContext` starts working, or `isMobile` rejection is fixed) | **Low** | The template documents the binary version it was written against; the quirks flags degrade gracefully (default off). Re-validate on Camoufox releases. |
| `git grep -ni "invisible" -- packages/` leaks a reference in shipped code/docs | **Medium** | **Gap 0 scrubs the four currently-violating tracked files first**; then Gap 6's CI grep guard (`git grep -ni "invisible" -- packages/` must be empty, tracked-only so the untracked dev artifact is ignored) enforces the policy going forward. |
| User runs un-audited third-party `bridge.py` from `user-backends/` | **Low** | Documented as trusted user code; no auto-download; the extension never fetches stealth backends. |
| `pythonPath` relative in user `settings.json` → spawn fails | **Low** | README + AGENTS.md require absolute `pythonPath`. Optional nicety: adapter resolves a relative `pythonPath` against `USER_BACKENDS_DIR` (deferred — not required for v3). |
| User expects the Camoufox template via `npm install` but it is not in the tarball | **Low** | Gap 3 README + Gap 2 AGENTS.md now state explicitly that `docs/` is excluded from `package.json` `files` and the templates require the source repo. |

**Bottom line:** the infra work (Phase 0/0b) and the Camoufox template
are done and tested. The remaining work is the **Gap 0 invisible-reference
scrub** (a hard prerequisite, currently outstanding), then MiniWoB++
integration for user-managed backends, docs, contract tests, and CI —
plus enforcing the invisible-playwright policy with a `git grep` guard.
The earlier "no blockers" framing was inaccurate: Gap 0 is a real,
small, must-do-first blocker for the policy/enforcement claims, not
for the underlying architecture (which is sound).
