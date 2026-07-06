# Design — In-process BrowserGym co-hosting on `PlaywrightBridge`

> Status: **decisions closed — ready for implementation.** The four
> open questions from the draft were accepted as recommended and are
> recorded in §10. Load-bearing abstraction for resolving
> [`ISSUE-firefox-ws-cross-process-attach.md`](ISSUE-firefox-ws-cross-process-attach.md)
> without the ProxyPage carrying the whole Firefox matrix, and without
> closing the door on camoufox / invisible_playwright stealth backends.
>
> This doc specifies the two pieces that must be correct for the rest of
> the strategy to follow: (1) the lazy-import `browsergym_setup` /
> `browsergym_validate` method pair on `PlaywrightBridge`, and (2) the
> host's auto-skip probe. Everything else (ProxyPage for Node firefox,
> CDP for Node chromium, strategy selection in `benchPlugin`) is bounded
> by these two contracts.

## 1. Goals & non-goals

**Goals**

- Dissolve the Firefox ws cross-process attach problem for every
  **Python** backend (`chromium-py`, `firefox-py`, and future
  camoufox / invisible_playwright `*-py` backends) by running
  BrowserGym's `task.setup(page)` / `task.validate(page)` **in the same
  Python process** that owns the Playwright `Page`. No CDP, no ws, no
  ProxyPage, no Locator proxying.
- Cover **every** BrowserGym suite (MiniWoB today; WebArena /
  VisualWebArena / WebArenaVerified / user-authored tasks tomorrow,
  including Locator-using `ui_login` paths) for those backends, because
  `task.setup` receives a real `playwright.sync_api.Page`.
- Add the capability **strictly additively**: a portal `*-py` backend
  venv that does not have `browsergym` installed must work unchanged for
  normal browsing. BrowserGym is only required when the bench harness
  calls the new methods.
- Stay compatible with the stealth backends already anticipated by the
  portal (`_fingerprint_managed_context`, `_skip_default_viewport`,
  `plugin_config.launch`) — zero stealth-specific code in the new path.

**Non-goals**

- Replacing the existing **standalone** `browsergym-bridge.py` for the
  **Node** backends. Node `chromium` keeps CDP attach; Node `firefox`
  gets the ProxyPage (scoped to light-surface tasks). Both remain.
- Changing the `BrowserPlugin` TypeScript interface. The new path is
  reached via the existing `PythonPluginAdapter` JSON-RPC transport —
  two new method names, no new TS surface on `BrowserPlugin`.
- Coupling portal backends to a BrowserGym install. Enforced by the
  lazy-import rule (§3) and the auto-skip probe (§5).

## 2. Why this is the load-bearing piece

The cross-process attach problem is unsolvable for Firefox *only when
the plugin and BrowserGym live in different processes.* The Python
backends already run the plugin in a Python subprocess
(`PythonPluginAdapter` spawns `backends/<name>/bridge.py`, which
subclasses `PlaywrightBridge` and holds a real `Page` in
`session["page"]`). BrowserGym is a Python package. Putting the two in
the **same** process hands `task.setup` the plugin's actual `Page`.

The portal's `PlaywrightBridge` base is already designed to host
stealth subclasses (camoufox / invisible_playwright) — see
`_fingerprint_managed_context` and the `plugin_config.launch` channel
in `python-base/pi_browser_bridge/`. A method pair on that base is
therefore inherited by every `*-py` backend, present and future, with
no per-backend code.

The risk to avoid: making `browsergym` import a *startup* dependency of
the bridge. That would force every `*-py` venv to install browsergym
just to browse — a real regression, and a hard blocker for stealth
backends whose users may never run the bench. The lazy-import rule (§3)
is the contract that prevents this.

## 3. The lazy-import rule (the contract)

**Rule:** BrowserGym (`browsergym.miniwob`, `browsergym.core.task`, any
`browsergym.*`) is imported **inside** the body of
`browsergym_setup` / `browsergym_validate` / `_browsergym_probe`, never
at bridge module top level, never in `__init__`, never in
`create_browser_session`, never in `_launch_browser`.

**Consequence:** a `*-py` bridge subprocess whose venv lacks
`browsergym` starts, browses, and serves every existing
`browser.*` RPC exactly as today. The first `browsergym.*` RPC raises
a typed `browsergym-not-installed` error (§4.4), which the host
converts to an auto-skip (§5). No crash, no startup failure, no
behavioral change for non-bench users.

This mirrors the existing standalone bridge's import-at-startup
pattern in `browsergym-bridge.py:main()` (`build_task_table()`), but
**deliberately inverts it** for the co-hosted path. The standalone
bridge is a dedicated browsergym process; the co-hosted bridge is a
portal process that *optionally* also does browsergym. The two have
opposite import-time policies by design.

## 4. The `PlaywrightBridge` method pair

All three methods live on `PlaywrightBridge` in
`python-base/pi_browser_bridge/playwright_base.py`, next to
`do_evaluate` / `do_get_ws_endpoint`. They are **concrete** (not
`NotImplementedError` stubs) — the implementation is engine-agnostic
because it only touches `session["page"]` and the lazily-imported
`browsergym` package. Subclasses (including stealth backends) inherit
them unchanged.

### 4.1 `do_browsergym_probe` — capability probe

```python
def do_browsergym_probe(self) -> dict[str, Any]:
    """Report whether browsergym is importable in this bridge's venv.

    Used by the host's auto-skip gate (§5). Cheap: imports
    ``browsergym.miniwob`` and ``browsergym.core.task`` once, caches
    the result, and returns a structured capability dict. Never
    raises — import failures are reported as ``installed: False`` with
    a reason string, so the host can skip cleanly.
    """
    cached = getattr(self, "_browsergym_probe_cache", None)
    if cached is not None:
        return cached

    result: dict[str, Any] = {"installed": False, "version": None,
                              "taskCount": 0, "reason": ""}
    try:
        import browsergym  # noqa: F401
        import browsergym.core.task  # noqa: F401
        from browsergym.miniwob import ALL_MINIWOB_TASKS  # noqa: F401
        result["installed"] = True
        result["version"] = getattr(browsergym, "__version__", None)
        result["taskCount"] = len(ALL_MINIWOB_TASKS)
    except Exception as exc:  # ImportError, ModuleNotFoundError, ...
        result["reason"] = f"{type(exc).__name__}: {exc}"
    self._browsergym_probe_cache = result  # type: ignore[attr-defined]
    return result
```

**Why a probe and not just "try setup and catch":** the host needs to
make the skip decision **before** navigating (navigation launches the
browser and creates the session; skipping after that leaks a context).
The probe is called once at bench-suite setup, cheaply, with no page
touched.

**Why cache:** `import browsergym.miniwob` builds the 125-entry task
table; doing it per-task is wasteful. The cache is per-bridge-instance
(i.e. per-subprocess), which is exactly the right scope.

### 4.2 `do_browsergym_setup` — run `task.setup(page)` in-process

```python
def do_browsergym_setup(
    self,
    task_id: str,
    task_name: str,
    seed: int,
    base_url: str,
    episode_max_time_ms: int = 1_000_000,
) -> dict[str, Any]:
    """Instantiate a BrowserGym task and run ``task.setup(page)`` on
    this bridge's own ``session["page"]``.

    Lazy-imports browsergym inside the body (§3). The page handed to
    ``task.setup`` is the same Playwright ``Page`` the plugin drives
    for navigate/snapshot/click — no attach, no proxy.

    Returns:
        ``{"success": bool, "goal": str, "info": dict, "episodeId": str|None,
           "error": str?}``. On browsergym-not-installed, returns
        ``{"success": False, "error": "browsergym-not-installed",
           "reason": <import error string>}`` (§4.4).
    """
    session = self.require_session(task_id)  # raises SESSION_ERROR if no page

    # ── Lazy import (§3) ──────────────────────────────────────
    try:
        from browsergym.miniwob import ALL_MINIWOB_TASKS
    except Exception as exc:
        return self._browsergym_not_installed(exc)

    # ── Resolve task class by subdomain name ──────────────────
    cls = next((c for c in ALL_MINIWOB_TASKS
                if (getattr(c, "subdomain", None) or c.__name__) == task_name),
               None)
    if cls is None:
        return {"success": False,
                "error": f"unknown-task: {task_name!r}"}

    # ── Instantiate (defensive across browsergym 0.14.x signatures) ──
    # Mirrors the standalone bridge's fallback chain.
    import os
    os.environ["MINIWOB_URL"] = base_url.rstrip("/") + "/miniwob/"
    try:
        task = cls(seed=seed, episode_max_time=episode_max_time_ms)
    except TypeError:
        try:
            task = cls(seed=seed)
        except TypeError:
            task = cls(seed)

    # ── Run setup on the plugin's real page ───────────────────
    page = session["page"]
    try:
        setup_result = task.setup(page)
    except Exception as exc:
        return {"success": False,
                "error": f"setup-raised: {type(exc).__name__}: {exc}"}

    # browsergym 0.14.x: setup() returns (goal: str, task_info: dict).
    # Older versions returned just a dict — handle both.
    if isinstance(setup_result, tuple) and len(setup_result) >= 2:
        goal, task_info = setup_result[0], setup_result[1]
    elif isinstance(setup_result, tuple) and len(setup_result) == 1:
        goal, task_info = "", setup_result[0]
    else:
        goal, task_info = "", setup_result
    if not isinstance(task_info, dict):
        task_info = {}
    if not isinstance(goal, str):
        goal = str(goal) if goal is not None else ""

    # ── Stash the live task on the session for validate() ─────
    session["browsergym_task"] = task

    episode_id = task_info.get("episode_id") or getattr(task, "episode_id", None)
    return {"success": True, "goal": goal,
            "info": _jsonable(task_info), "episodeId": episode_id}
```

**Key invariants:**

- `require_session(task_id)` is the **only** session access. It raises
  `SESSION_ERROR` (handled by the transport) if `browser.navigate` was
  never called — same contract as `do_snapshot`. The host must navigate
  before `browsergym.setup`.
- `task.setup(page)` receives `session["page"]` directly. No copy, no
  proxy, no re-attach. This is the whole point.
- The live `task` is stashed on the session dict (`session["browsergym_task"]`)
  so `validate` can find it. The session dict is the existing
  per-task state carrier; this is a new key, not a new structure.
- Per-task `setup` overrides (e.g. `ClickMenu2Task.setup`, which
  injects an extra `page.evaluate`) work for free — they run inside
  `task.setup(page)` on the real page.

### 4.3 `do_browsergym_validate` — run `task.validate(page)` in-process

```python
def do_browsergym_validate(self, task_id: str) -> dict[str, Any]:
    """Run ``task.validate(page, [])`` on the stashed task + page.

    Returns:
        ``{"success": bool, "reward": float, "done": bool,
           "reason": str, "info": dict, "error": str?}``.
    """
    session = self.require_session(task_id)
    task = session.get("browsergym_task")
    if task is None:
        return {"success": False,
                "error": "no-active-task: call browsergym.setup first"}
    page = session["page"]

    import inspect
    try:
        sig = inspect.signature(task.validate)
        result = (task.validate(page, [])
                  if len(sig.parameters) >= 2
                  else task.validate(page))
    except TypeError:
        result = task.validate(page, [])
    except Exception as exc:
        return {"success": False,
                "error": f"validate-raised: {type(exc).__name__}: {exc}"}

    reward, done, reason, info = (list(result) + [None, None, None, None])[:4]
    try:
        reward_val = float(reward) if reward is not None else 0.0
    except (TypeError, ValueError):
        reward_val = 0.0
    return {"success": True, "reward": reward_val, "done": bool(done),
            "reason": str(reason) if reason is not None else "",
            "info": _jsonable(info) if info is not None else {}}
```

`do_browsergym_teardown(task_id)` sibling — **shipped in Phase 1 as a
real method with a stub-shaped body** (decision §10.2). MiniWoB's
`base.py:teardown` is `pass`, so the `task.teardown()` call is a no-op
today, but the **session-key cleanup is real and ships now** so the
contract is fixed before WebArena-family suites with real teardown
side-effects arrive:

```python
def do_browsergym_teardown(self, task_id: str) -> dict[str, Any]:
    """Run ``task.teardown()`` and clear the session's browsergym state.

    MiniWoB's ``teardown`` is a no-op today, but the session-key cleanup
    is the load-bearing part: it guarantees a stale ``browsergym_task``
    never leaks into a later task on the same session. Real teardown
    side-effects (WebArena family) are picked up for free when they land.
    """
    session = self.get_session(task_id)
    if session is None:
        return {"success": True}  # nothing to clean
    task = session.pop("browsergym_task", None)
    if task is not None:
        try:
            task.teardown()
        except Exception:
            pass  # teardown must never fail the bench run
    return {"success": True}
```

`get_session` (not `require_session`) is deliberate: teardown of a
non-existent session is a success, not a `SESSION_ERROR` — it's idempotent.

### 4.4 The `browsergym-not-installed` error contract

To keep the lazy-import rule enforceable and the host's skip logic
simple, every `do_browsergym_*` method returns the **same** error
shape when browsergym is missing, instead of raising:

```python
def _browsergym_not_installed(self, exc: Exception) -> dict[str, Any]:
    return {"success": False,
            "error": "browsergym-not-installed",
            "reason": f"{type(exc).__name__}: {exc}"}
```

This is a deliberate divergence from the bridge's general convention
(operations raise, the transport wraps them in `APPLICATION_ERROR`).
The reason: the host needs to **distinguish** "browsergym missing"
(skip the suite) from "setup raised" (fail the task), and catching a
generic `APPLICATION_ERROR` by message substring is brittle. A typed
`error: "browsergym-not-installed"` field is a stable contract the
host can match exactly. The transport's generic exception path still
catches anything these methods raise unexpectedly.

### 4.5 Transport wiring (`bridge.py` `handle_command`)

Three new method routes, placed next to the existing `get_ws_endpoint`
route (which is the closest analogue — an optional, capability-gated
method):

```python
if method == "browsergym.probe":
    return make_success_response(cmd_id, self.do_browsergym_probe())

if method == "browsergym.setup":
    task_id   = self._require_param(params, "taskId",   str, cmd_id)
    task_name = self._require_param(params, "taskName", str, cmd_id)
    seed      = self._require_param(params, "seed",     int, cmd_id)
    base_url  = self._require_param(params, "baseUrl",  str, cmd_id)
    ep_max    = params.get("episodeMaxTimeMs", 1_000_000)
    return make_success_response(
        cmd_id, self.do_browsergym_setup(task_id, task_name, seed,
                                         base_url, ep_max))

if method == "browsergym.validate":
    task_id = self._require_param(params, "taskId", str, cmd_id)
    return make_success_response(cmd_id, self.do_browsergym_validate(task_id))

if method == "browsergym.teardown":
    task_id = self._require_param(params, "taskId", str, cmd_id)
    return make_success_response(cmd_id, self.do_browsergym_teardown(task_id))
```

No changes to `transport.py` — the dispatcher is method-name-routed in
`bridge.py:handle_command`, which is where every existing `browser.*`
route lives.

### 4.6 `_jsonable` helper

The standalone `browsergym-bridge.py` already defines a `_jsonable`
helper (best-effort cast to JSON-serialisable types). Move it to
`python-base/pi_browser_bridge/_jsonable.py` (or `bridge.py`) so both
the standalone bridge and the co-hosted methods share one
implementation. One-line module, two importers.

## 5. The host's auto-skip probe

The host (`pi-lean-host`) decides skip-vs-run **per backend** before
the suite starts, not per task. The probe rides on the existing
`PythonPluginAdapter` lifecycle: the adapter already spawns the bridge
and does a `ping` handshake on first use. The host adds one
`browsergym.probe` RPC after init, caches the result, and uses it as a
suite-level skip gate.

### 5.1 Probe strategy — shell-check first, bridge probe authoritative

The probe runs in two tiers (decision §10.3). The **shell-check** is
the cheap suite-level gate (no bridge subprocess spawned); the
**bridge-side `do_browsergym_probe`** is the authoritative in-bridge
check, called once on the real bench run to catch the case where the
shell check lied (e.g. wrong venv on PATH, monkeypatched
`sys.modules`).

**Tier 1 — shell check (suite-level skip gate):** the host imports
browsergym directly via the `*-py` venv's Python interpreter, without
spawning a bridge. This mirrors the spirit of the existing
`setup:venv`-present gate and avoids a throwaway subprocess:

```ts
// In the host (Node). Resolved once per *-py backend, cached.
async function pyVenvHasBrowserGym(pythonPath: string): Promise<{
  installed: boolean;
  taskCount: number;
  reason: string;
}> {
  const { execFile } = await import("node:child_process");
  const script =
    "import sys; " +
    "try:\n" +
    "  from browsergym.miniwob import ALL_MINIWOB_TASKS; " +
    "  print(len(ALL_MINIWOB_TASKS))\n" +
    "except Exception as e:\n" +
    "  print(f'0|{type(e).__name__}: {e}', file=sys.stderr); sys.exit(1)";
  return new Promise((resolve) => {
    execFile(pythonPath, ["-c", script], { timeout: 10_000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ installed: false, taskCount: 0,
                    reason: (stderr.toString().trim() || err.message) });
          return;
        }
        const n = parseInt(stdout.toString().trim(), 10);
        resolve({ installed: !Number.isNaN(n) && n > 0, taskCount: n || 0,
                  reason: "" });
      });
  });
}
```

**Tier 2 — bridge-side `do_browsergym_probe` (authoritative, on the
real run):** the `browsergym.probe` RPC from §4.1 is still called once
at the start of a real (non-skipped) bench run. If the shell check
said `installed: true` but the bridge probe returns `installed: false`
(the venv Python on PATH differed from the bridge subprocess's
`sys.executable`, or `import browsergym` fails inside the bridge for
any reason), the host converts the run to a typed skip with the
bridge's `reason`. This catches the narrow case where the shell check
lied, without paying the bridge-spawn cost on the skip path.

```ts
// Resolved once per plugin instance, cached on the plugin.
// Only reached on the run path (the shell check already passed).
async browsergymProbe(): Promise<{
  installed: boolean;
  version: string | null;
  taskCount: number;
  reason: string;
}> {
  return this.call("browsergym.probe", {}, 10_000);
}
```

### 5.2 The skip gate in the suite

In `suites/miniwob-trivial.test.ts` (and the future
`registerMiniwobSuite` public API), the backend registry already has an
`available` boolean per backend. The in-process path extends the
`available` computation for `*-py` backends with the **Tier 1 shell
check** (no bridge spawn):

```ts
const PY_BACKEND_BROWSERGYM_AVAILABLE = await (async () => {
  if (!PY_VENV_PYTHON_PRESENT) return false;        // existing gate
  // Tier 1 shell check — no bridge subprocess spawned (decision §10.3).
  const probe = await pyVenvHasBrowserGym(PY_VENV_PYTHON);
  return probe.installed && probe.taskCount > 0;
})();
```

Then the backend entry's `available` is
`CONTENT_AVAILABLE && ENGINE_AVAILABLE && PY_BACKEND_BROWSERGYM_AVAILABLE`
(for a `*-py` backend). When `available` is false, `registerMiniwobSuite`
produces `describe.skip` blocks exactly as it does today for missing
chromium/venv — no new skip mechanism, just a new conjunct in the
gate.

**Why probe pre-suite and not pre-task:** the probe is one
`browsergym.probe` RPC per backend per suite run. Doing it per task
would add 125 RPCs to a `*-py` suite that already auto-skips. The
cached `_browsergym_probe_cache` on the bridge (§4.1) makes repeated
probes free, but the host only calls once.

### 5.3 What "skip" looks like to the caller

Identical to today's skips: `it.skip` with a reason string. The reason
for a `*-py` backend missing browsergym is `"browsergym not installed
in <name> venv — pip install browsergym-miniwob==0.14.3 into the
venv configured for this backend"`. The probe's `reason` field
(`"ModuleNotFoundError: No module named 'browsergym'"`) is included in
the skip reason for debuggability.

## 6. `runMiniwobTask` in-process branch

`runMiniwobTask` gains an `attachMode` option (default
`"external-bridge"` — today's behavior). The new `"in-process"` mode
is selected by `benchPlugin` for any plugin whose bridge is a
`PythonPluginAdapter` (i.e. a `*-py` backend). The branch is small
because the in-process path **reuses the plugin's own JSON-RPC
transport** instead of spawning the standalone `browsergym-bridge.py`:

```ts
// in-process branch (sketch — full diff in §8)
if (attachMode === "in-process") {
  // 0. Tier 2 probe — authoritative in-bridge check (decision §10.3).
  //    The Tier 1 shell check already passed at suite setup; this catches
  //    the case where the shell check lied (wrong venv on PATH, etc.).
  //    If it fails, the run is converted to a typed skip, not a fail.
  const probe = await plugin.browsergymProbe();
  if (!probe.installed) {
    return fail(`browsergym not installed in bridge venv: ${probe.reason}`);
  }

  // 1. Navigate — launches the *-py bridge subprocess + browser,
  //    creates session["page"]. Uses the plugin's existing navigate().
  const nav = await plugin.navigate(taskUrl, taskId, navigateTimeoutMs);
  if (!nav.success) return fail(`navigate failed: ${nav.error ?? "?"}`);

  // 2. Setup — runs task.setup(page) IN the bridge subprocess.
  //    plugin here is a PythonPluginAdapter; browsergymSetup is a thin
  //    wrapper over call("browsergym.setup", {...}).
  const setup = await plugin.browsergymSetup({ taskId, taskName, seed,
                                                baseUrl, episodeMaxTimeMs });
  if (!setup.success && setup.error === "browsergym-not-installed") {
    // Should have been caught by the suite-level probe (§5). Treat as
    // setupFailed so the result is honest, but the suite already skipped.
    return fail(`browsergym not installed: ${setup.reason}`);
  }
  if (!setup.success) return fail(`setup failed: ${setup.error}`);

  // 3. Snapshot + solver — UNCHANGED. plugin.snapshot / plugin.click /
  //    plugin.type drive session["page"] over the same transport.
  //    The @e-ref action pipeline is exercised end-to-end.
  const snap = await plugin.snapshot(taskId);
  /* …solver runs, same as today… */

  // 4. Validate — runs task.validate(page) IN the bridge subprocess.
  const v = await plugin.browsergymValidate({ taskId });
  /* …poll done, same as today… */

  // 5. Teardown + cleanup.
  await plugin.browsergymTeardown({ taskId }).catch(() => {});
  await plugin.cleanup(taskId).catch(() => {});
}
```

**Why the standalone `BridgeClient` is not reused:** the standalone
bridge spawns a *second* Python subprocess whose only job is browsergym
— that's the cross-process model the issue describes. The in-process
path's whole purpose is to *avoid* that second subprocess. So the
`browsergym.*` RPCs go to the **plugin's own** subprocess (the
`PythonPluginAdapter`'s child), alongside `browser.navigate` /
`browser.snapshot` / `browser.click`. One subprocess, one transport,
one `Page`.

`PythonPluginAdapter` (in `python-adapter.ts`) gains three thin
methods — `browsergymSetup`, `browsergymValidate`, `browsergymTeardown`
— each a one-line `this._call("browsergym.setup", params)` wrapper,
plus the `browsergymProbe` from §5.1 (Tier 2). They are **not** added
to the `BrowserPlugin` interface in `core/plugin-api.ts`; they live on
`PythonPluginAdapter` specifically, because they only make sense for
the in-process (Python-bridge) path. `benchPlugin` type-narrows to
`PythonPluginAdapter` to access them (decision §10.4), mirroring how
it already type-narrows for `getCdpEndpoint` / `getWsEndpoint`. If a
third attach mode ever appears, revisit by promoting the hint to
`BrowserPlugin`; until then, the type-narrow keeps the public
interface clean.

## 7. Stealth-backend interaction (camoufox / invisible_playwright)

This is the part the design must not break, and it falls out for free.

A camoufox or invisible_playwright backend is a `PlaywrightBridge`
subclass that overrides `_launch_browser()`:

```python
# backends/camoufox-py/bridge.py  (illustrative — not in repo yet)
from pi_browser_bridge.playwright_base import PlaywrightBridge

class CamoufoxPyBridge(PlaywrightBridge):
    _fingerprint_managed_context = True
    _skip_default_viewport = True

    def _launch_browser(self):
        from camoufox import NewBrowser  # lazy: only at first navigate
        launch_opts = self.plugin_config.get("launch", {})
        return NewBrowser(self._pw, persistent_context=False, **launch_opts)
```

It inherits `do_browsergym_setup` / `do_browsergym_validate` /
`do_browsergym_probe` unchanged. When the host calls
`browsergym.setup`, the base method does `task.setup(session["page"])`,
where `session["page"]` is a real Playwright `Page` produced by the
patched Firefox binary. BrowserGym calls `page.goto` / `page.evaluate`
/ `page.wait_for_function` / `page.url` on it — all stable Playwright
APIs. BrowserGym never sees the binary, never sees camoufox, never
sees the stealth prefs. It just calls methods on a `Page`.

**Venv compatibility (confirmed against the downloaded sources):**

| Package | playwright pin | Compatible with browsergym's `==1.44`? |
|---|---|---|
| browsergym-core 0.14.3 | `==1.44` | (baseline) |
| camoufox (`pythonlib/pyproject.toml`) | `*` | yes |
| invisible_playwright (`pyproject.toml`) | `>=1.40,<1.61` | yes (1.44 in range) |

A single venv can hold browsergym + camoufox, or browsergym +
invisible_playwright. The existing host venv isolation
(browsergym in `pi-lean-host/venv/`, portal `*-py` backends elsewhere)
was precautionary; for these two stealth backends the pins do not
collide, so a stealth-bench venv is `pip install browsergym-miniwob
camoufox` + `playwright install firefox`.

**What a stealth user who never runs the bench sees:** the same as a
`firefox-py` user who never runs the bench — nothing. The
`browsergym.*` RPCs are never sent, `browsergym` is never imported,
the bridge starts and browses exactly as today. This is the lazy-import
rule (§3) paying off.

## 8. What stays unchanged

- **Node `chromium`** — CDP attach via `connect_over_cdp`, standalone
  `browsergym-bridge.py`. Unchanged.
- **Node `firefox`** — ProxyPage over reverse RPC, scoped to
  light-surface tasks (MiniWoB + anything staying within
  `goto`/`evaluate`/`wait_for_function`/`url`). The ProxyPage is a
  *separate* component, designed after this doc is agreed, because its
  surface is bounded by what the in-process path does *not* cover.
- **Standalone `browsergym-bridge.py`** — kept for the Node backends,
  but refactored to a **thin caller of shared logic** (decision §10.1).
  The setup/validate/resolve/instantiate glue (~60 lines currently
  duplicated between the standalone bridge and the new
  `PlaywrightBridge` methods) is extracted into a new
  `python-base/pi_browser_bridge/browsergym_tasks.py` helper module:
  `resolve_task_class(all_tasks, task_name)`, `instantiate_task(cls, seed, base_url, episode_max_time_ms)`, `run_setup(task, page)`,
  `run_validate(task, page)`. Both the standalone bridge and the
  `PlaywrightBridge` `do_browsergym_*` methods import from it. One
  implementation, two entry points. The standalone bridge keeps its
  own transport + `connect_over_cdp` / `connect(ws)` attach logic —
  only the task-setup/validate glue is shared.
- **`BrowserPlugin` interface (`core/plugin-api.ts`)** — no new
  methods. The new RPCs are `PythonPluginAdapter`-specific.
- **`browser.*` RPC set** — unchanged. `browsergym.*` is a new,
  namespaced set, dispatched in the same `handle_command`.

## 9. Test plan

- **Unit (`python-base/tests/`):** `test_browsergym_methods.py` —
  mock `session["page"]`, monkeypatch `browsergym.miniwob.ALL_MINIWOB_TASKS`
  with a fake task class, assert `do_browsergym_setup` calls
  `task.setup(page)` with the real session page and stashes the task;
  assert `do_browsergym_validate` calls `task.validate(page, [])`;
  assert `do_browsergym_probe` returns `installed: False` with a
  reason when `import browsergym` fails (use `sys.modules` poisoning);
  assert the lazy-import rule: confirm `browsergym` is **not**
  imported after `bridge.__init__` + `browser.navigate` (grep
  `sys.modules` keys).
- **Stealth-quirk parity:** extend
  `test_playwright_base_quirks.py` with a case asserting
  `_fingerprint_managed_context = True` does not change
  `do_browsergym_setup` behavior — the page passed to `task.setup`
  is `session["page"]` regardless of the fingerprint flag.
- **Adapter (`pi-lean-host`):** `browsergym-adapter.test.ts` —
  in-process branch with a mock `PythonPluginAdapter`, asserting the
  Tier-2 `browsergym.probe` → `browsergym.setup` → `validate` →
  `teardown` RPC sequence and the `browsergym-not-installed` →
  `setupFailed` mapping. Also assert `do_browsergym_teardown` clears
  `session["browsergym_task"]` and is idempotent on a missing session
  (decision §10.2).
- **Auto-skip gate:** `miniwob-trivial.test.ts` — assert a `*-py`
  backend whose probe returns `installed: false` produces
  `describe.skip` with the documented reason.
- **Live (chromium-py / firefox-py, browsergym venv present):** the
  existing 13-task MiniWoB trivial suite runs against `firefox-py` and
  `chromium-py` via the in-process path. This is the coverage the
  issue's Option C would have given up.

## 10. Decisions

All four open questions from the draft are closed. The recommendations
in the draft were accepted; this section records the resolutions and
the sections they update.

### 10.1 Standalone bridge fate — extract `browsergym_tasks.py`

**Decision:** extract the setup/validate/resolve/instantiate glue into
a new `python-base/pi_browser_bridge/browsergym_tasks.py` helper module
with four functions — `resolve_task_class(all_tasks, task_name)`,
`instantiate_task(cls, seed, base_url, episode_max_time_ms)`,
`run_setup(task, page)`, `run_validate(task, page)` — that both the
standalone `browsergym-bridge.py` and the `PlaywrightBridge`
`do_browsergym_*` methods import. One implementation, two entry points.

**Rationale:** the standalone bridge is still needed for the Node
backends (CDP / ws attach), so it can't be folded away. But the
~60 lines of task-glue it currently duplicates with the new
`PlaywrightBridge` methods would be a maintenance trap — a browsergym
0.15 signature change would have to be applied in two places.
`browsergym_tasks.py` makes the two entry points share one glue layer
while keeping their distinct transports and attach logic.

**Updates:** §8 (standalone-bridge bullet now describes the thin-caller
refactor), §9 (unit tests cover `browsergym_tasks.py` directly; the
`PlaywrightBridge` and standalone-bridge tests assert they call the
helper, not that they re-implement it).

### 10.2 `browsergym.teardown` — ship the real session-key cleanup now

**Decision:** `do_browsergym_teardown` ships in Phase 1 as a **real
method with a stub-shaped body** — `task.teardown()` is called (a
no-op for MiniWoB today) **and** `session.pop("browsergym_task", None)`
clears the session key. The session-key cleanup is the load-bearing
part; it's idempotent and uses `get_session` (not `require_session`) so
tearing down a missing session is a success, not a `SESSION_ERROR`.

**Rationale:** MiniWoB's `base.py:teardown` is `pass`, so the
`task.teardown()` call buys nothing today. But the session-key cleanup
prevents a stale `browsergym_task` leaking into a later task on the
same session — a real correctness bug, not a future concern. Defining
the contract now (clear the key, idempotent, never raises) means
WebArena-family suites with real teardown side-effects pick it up for
free instead of re-litigating the shape.

**Updates:** §4.3 (the `do_browsergym_teardown` body is now specified
in full, not left as "optional in Phase 1"), §9 (the adapter test
asserts teardown clears the key and is idempotent on a missing
session).

### 10.3 Probe timing — shell-check first, bridge probe authoritative

**Decision:** two-tier probe. **Tier 1** is a shell check
(`python3 -c "from browsergym.miniwob import ALL_MINIWOB_TASKS; ..."`)
against the `*-py` venv's Python interpreter, run at suite setup with
no bridge subprocess spawned — this is the skip gate. **Tier 2** is
the bridge-side `do_browsergym_probe` RPC (§4.1), called once at the
start of a real (non-skipped) bench run as the authoritative check; if
it disagrees with the shell check, the run converts to a typed skip.

**Rationale:** the draft's single-tier probe spawned a `*-py` bridge
subprocess just to probe, then dropped it — a throwaway process per
backend per suite run. The shell check is cheaper (no spawn) and is
what the existing `setup:venv`-present gate already does in spirit.
But the shell check can lie (wrong venv on PATH, monkeypatched
`sys.modules`), so the bridge-side probe remains as the authoritative
in-bridge check on the run path. Tier 1 makes the skip path cheap;
Tier 2 makes the run path honest.

**Updates:** §5.1 (rewritten as the two-tier spec with both code
sketches), §5.2 (the suite skip gate now calls the Tier 1 shell check,
not a throwaway bridge), §6 (the in-process branch sketch now starts
with a Tier 2 probe call before navigate).

### 10.4 Strategy selection in `benchPlugin` — type-narrow on `PythonPluginAdapter`

**Decision:** `benchPlugin` type-narrows to `PythonPluginAdapter` to
access `browsergymSetup` / `browsergymValidate` / `browsergymTeardown`
/ `browsergymProbe` and select `attachMode: "in-process"`. The
`BrowserPlugin` interface in `core/plugin-api.ts` gains **no** new
method. The dispatch rule is: `PythonPluginAdapter` → in-process;
Node plugin with `getCdpEndpoint` → CDP; Node plugin with
`getWsEndpoint` → ws-proxy. Revisit by promoting a hint method to
`BrowserPlugin` only if a third attach mode appears.

**Rationale:** this matches how `benchPlugin` already type-narrows for
`getCdpEndpoint` / `getWsEndpoint` (the existing optional
`BrowserPlugin` methods). Adding a `browsergymAttachMode()` hint to
`BrowserPlugin` now would speculate a contract for a third mode that
doesn't exist, and would force every plugin author to implement it.
The type-narrow keeps the public interface clean and the dispatch rule
in one place; the cost is a `instanceof PythonPluginAdapter` check in
`benchPlugin`, which is acceptable for a host-side bench harness (not
part of the portal's per-tool dispatch hot path).

**Updates:** §6 (the type-narrow paragraph now records the decision
and the revisit trigger), §8 (the `BrowserPlugin`-interface-unchanged
bullet is now justified by this decision, not just stated).
