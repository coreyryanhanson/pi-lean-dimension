# Stealth Python Backends — npm-Packaging-Aware Plan (v2)

> Status: **REVIEWED / REPLANNED / STANDALONE** — supersedes and fully
> replaces `stealth-browser-plan.md` (2026-06-21, "DECISIONED"). The
> original document can be deleted; this plan re-embeds all of the
> per-backend compatibility analysis ("what works as-is" + "flags") that
> a developer needs to implement the subclasses, in addition to the
> packaging-aware replan. The original plan's technical analysis of
> Camoufox / invisible_playwright compatibility was still sound, but its
> **deployment model was obsolete**: it assumed backends live as
> checked-in directories under the repo's `backends/` tree, with
> per-backend venvs at `backends/<name>-py/.venv`. The portal is now
> published as the npm package `pi-lean-portal`, whose `backends/`
> directory lives inside the read-only, npm-managed
> `node_modules/pi-lean-portal/backends/` path. You cannot drop
> user-contributed stealth backends in there.
>
> Date: 2026-06-30
> Author: review subagent (GLM 5.2)

## TL;DR (verdict)

The original plan's **per-backend bridge code and Python-side quirks work
are still viable and largely unchanged**. What is **not viable** is the
original "ship `backends/camoufox-py/` and `backends/invisible-py/` inside
the package, with checked-in venvs" model. Under npm packaging:

- **Neither stealth backend ships in the npm tarball.** They become
  **user-installed plugins** that live outside the package, sibling to
  `web-guides/`, under `~/.pi/agent/pi-lean-portal/stealth-backends/<name>-py/`.
- **The plugin loader must become multi-root.** `DEFAULT_BACKENDS_ROOT`
  (inside the package) is no longer the only place `detectPluginType`
  looks; a second user backends root under `PORTAL_DATA_DIR` must be
  supported, and the `dir` field in `settings.json` must be able to
  resolve against either root (or be an absolute path).
- **The shared Python library `pi_browser_bridge` must be importable by
  user bridges running in their own venvs.** Today the adapter does not
  inject `PYTHONPATH`, and `pi_browser_bridge` is only importable inside
  `backends/python-base/.venv` (editable install). This is a new
  hard prerequisite the original plan never considered.
- **Neither `camoufox-py` nor `invisible-py` belongs in the default
  fallback plugin list** in `parsePluginConfig` — they aren't shipped, so
  a default entry would always fail discovery.
- **Nothing from the original plan has been implemented.** `browser.init`
  RPC, the quirks schema, the stealth subclasses — all absent. The
  `chromium-py` / `firefox-py` bridges are still the original ~30-line
  thin subclasses.

The plan below keeps the original Phase 0 (shared infra: `browser.init` +
quirks) and Phase 1/2 subclass work essentially intact, but relocates
Phase 1/2's deployment to the user-data tree, adds a new **Phase 0b
(packaging/discovery)** that the original plan entirely missed, and
reworks defaults, ship-manifest, AGENTS.md, and `/web status` around the
new reality.

---

## What's already implemented vs. pending (concrete findings)

I read the current code. Findings, with file/line evidence:

### Pending — nothing from the plan was implemented

1. **`browser.init` RPC: NOT present.**
   `backends/python-base/pi_browser_bridge/bridge.py` `handle_command()`
   routes `ping`, `shutdown`, `browser.navigate`, … `browser.cleanup` —
   there is **no `browser.init` case** (searched the file; only
   `make_success_response(cmd_id, "pong")` for `ping`). `BrowserBridge`
   has no `_plugin_config` attribute and no `plugin_config` property.

2. **Quirks schema on `PlaywrightBridge`: NOT present.**
   `backends/python-base/pi_browser_bridge/playwright_base.py` defines
   `_plugin_name`, `_user_agent`, `_capture_user_agent`, `_install_hint`
   class attrs only. No `_fingerprint_managed_context`, `_eval_prefix`,
   `_scroll_via_wheel`, or `_context_factory` (grep across
   `backends/` + `core/` returned zero hits for those identifiers
   outside Playwright's vendored `browser.initScript` strings).

3. **`create_browser_context()` still hardcodes viewport/UA.**
   `playwright_base.py` `create_browser_context()` sets
   `context_kwargs = {"viewport": {"width": 1280, "height": 720},
   "user_agent": self.effective_user_agent}` unconditionally — the exact
   clobber the original plan flagged.

4. **`do_scroll` still uses `page.evaluate` + `window.scrollBy`**, and
   `do_evaluate` calls `page.evaluate(expression)` with no prefix — both
   as the original plan described pre-change.

5. **`python-adapter.ts` handshake sends only `ping`.**
   `_startProcess()` does `await this._directRpcCall("ping", {},
   PING_TIMEOUT_MS)` and resolves. No `browser.init` follow-up. The
   constructor stores no plugin config; `init(_config)` ignores its
   argument (only validates pythonPath).

6. **No stealth backends exist.**
   `ls backends/` shows: `chromium`, `chromium-py`, `firefox`,
   `firefox-py`, `playwright-base`, `python-adapter.ts`, `python-base`.
   No `camoufox-py/` or `invisible-py/`.

### Already in place — what the plan can build on

1. **`PythonBridgeConfig` already supports `pythonPath` and `pythonArgs`**
   (`python-adapter.ts` `PythonBridgeConfig` interface + constructor).
   User stealth venvs can be pointed at via `config.pythonPath` in
   `settings.json` — no adapter change needed for venv selection itself.

2. **`index.ts` already merges user `config` into `bridgeConfig`**
   (the `if (config.config)` block in the python branch): it copies
   `pythonPath`, `pythonArgs`, `capabilities`, `transportTimeoutMs`
   from the user's plugin `config` object. So a user stealth entry can
   already point at its own venv python. What's missing is forwarding
   the **rest** of `config` (the `launch` sub-object for `browser.init`)
   — currently only the four named `PythonBridgeConfig` fields are
   forwarded; arbitrary `config.config.launch` is dropped.

3. **`PythonPluginAdapter.init(_config)` accepts an arbitrary config
   dict** and currently ignores it. The signature is already there for
   `browser.init` to consume — we just need to store it and send it.

4. **`package.json` `files` ships `backends/`** (excluding
   `backends/python-base/.venv/`, `__pycache__/`, `*.pyc`, `tests/`,
   `*.egg-info/`). So the **shared `pi_browser_bridge` Python library
   source IS in the npm tarball**, at
   `node_modules/pi-lean-portal/backends/python-base/pi_browser_bridge/`.
   This is the key asset that makes user stealth bridges feasible: they
   can `from pi_browser_bridge.playwright_base import PlaywrightBridge`
   if `pi_browser_bridge` is importable in their venv.

5. **`PORTAL_DATA_DIR` already exists** (`core/shared/paths.ts`):
   `~/.pi/agent/pi-lean-portal/`. `USER_GUIDES_DIR` is
   `join(PORTAL_DATA_DIR, "web-guides")` (`core/guides.ts`). A sibling
   `stealth-backends/` directory is the natural home for user-installed
   stealth plugins and matches the established convention (user-writable,
   survives package upgrades, owned by the portal subtree).

6. **`PluginConfig.dir` is just a string** (`core/plugin-config.ts`
   `PluginConfig` interface); `validateEntry` only checks it's a
   non-empty string. The resolution-to-filesystem-path happens in
   `detectPluginType(dir, backendsRoot)` via `join(backendsRoot, dir)`.
   This is the single chokepoint to make multi-root / absolute-path
   aware.

7. **`loadPluginConfig(backendsRoot?)` and `loadFullConfig(backendsRoot?)`
   already accept an optional `backendsRoot`** — but `index.ts` calls
   `loadPluginConfig()` with no argument and `detectPluginType(config.dir,
   DEFAULT_BACKENDS_ROOT)` with the hardcoded package root. The
   plumbing for "different root" exists; the call sites don't use it.

---

## The npm-packaging problem (precise)

### 1. `DEFAULT_BACKENDS_ROOT` resolves inside the read-only package

`core/plugin-config.ts`, end of file:

```ts
export const DEFAULT_BACKENDS_ROOT = join(__dirname, "..", "backends");
```

`__dirname` for `core/plugin-config.ts` published via npm resolves to
`…/node_modules/pi-lean-portal/core/`, so `DEFAULT_BACKENDS_ROOT` =
`…/node_modules/pi-lean-portal/backends/`. That directory contains the
**four shipped backends** (`chromium`, `firefox`, `chromium-py`,
`firefox-py`) plus `python-base/` and `playwright-base/`. It is
**npm-managed**: any user-added directory there is overwritten on
`npm install` / `npm update`. End users generally cannot write to
`node_modules/` under a managed install anyway.

The original plan's Phase 1/2 step "add `backends/camoufox-py/bridge.py`"
is therefore impossible post-publication — that path is owned by npm.

### 2. `detectPluginType` assumes a single root

`core/plugin-config.ts`:

```ts
export function detectPluginType(dir, backendsRoot): PluginDetection {
    const dirPath = join(backendsRoot, dir);
    const indexPath = join(dirPath, "index.ts");
    const bridgePath = join(dirPath, "bridge.py");
    …
}
```

It joins `dir` under a single `backendsRoot`. For a user backend at
`~/.pi/agent/pi-lean-portal/stealth-backends/camoufox-py/bridge.py`, the
`dir` value `"camoufox-py"` joined with the package root would look for
`node_modules/pi-lean-portal/backends/camoufox-py/bridge.py` — not found
→ `detectPluginType` throws → `parsePluginConfig` records a validation
error and skips the plugin (`continue`). The user's stealth plugin would
be silently dropped at config load.

`parsePluginConfig` calls `detectPluginType(validated.dir, backendsRoot)`
inside its validation loop and skips on throw. `index.ts` also calls
`detectPluginType(config.dir, DEFAULT_BACKENDS_ROOT)` a second time in
its first pass — both call sites are hardcoded to the package root.

### 3. `pi_browser_bridge` importability for out-of-package bridges

`backends/chromium-py/bridge.py` and `firefox-py/bridge.py` both do:

```python
from pi_browser_bridge.playwright_base import PlaywrightBridge, check_playwright_or_exit
```

This works today only because `backends/python-base/.venv` has
`pi_browser_bridge` installed as an editable install
(`__editable__.pi_browser_bridge-0.1.0.pth` in
`backends/python-base/.venv/lib/python3.13/site-packages/`). The
adapter's `spawn()` call sets `env: { ...process.env,
PYTHONUNBUFFERED: "1" }` — **no `PYTHONPATH` injection**. So a user
stealth `bridge.py` running in its own venv (at
`~/.pi/agent/pi-lean-portal/stealth-backends/camoufox-py/.venv/`) can
only import `pi_browser_bridge` if the user separately installs the
shared library into that venv — and `pi-browser-bridge` is **not on
PyPI**; it lives inside the npm tarball at
`node_modules/pi-lean-portal/backends/python-base/`.

This is the new hard prerequisite the original plan missed. Two viable
fixes (recommend doing **both**, see Phase 0b):

- **Adapter injects `PYTHONPATH`** pointing at the package's
  `backends/python-base/` directory (resolved from `DEFAULT_BACKENDS_ROOT`
  or the detected bridge's package root). Then any venv can import
  `pi_browser_bridge` without a pip install.
- **User install docs** describe `pip install -e
  <node_modules>/pi-lean-portal/backends/python-base/` as the
  belt-and-suspenders alternative for users who want the library baked
  into their venv.

### 4. Default fallback list would always miss

`parsePluginConfig` (no-plugins branch) returns `chromium`, `firefox`,
`chromium-py`, `firefox-py`. If we added `camoufox-py` / `invisible-py`
there (as the original plan's Phase 1/2 step 3 instructed), every fresh
install without user-installed stealth backends would emit two
validation errors on startup (dir not found) and the user would see
scary warnings for plugins they never asked for. They must NOT be in the
default fallback.

### 5. Venv paths in the original plan are invalid post-packaging

The plan's Decision §6 specifies
`backends/camoufox-py/.venv/bin/python` and
`backends/invisible-py/.venv/bin/python`, with `pythonPath` in
`settings.json` set to those relative paths. Post-packaging, those
directories don't exist in the tarball and can't be created inside
`node_modules/`. The venvs must move under
`~/.pi/agent/pi-lean-portal/stealth-backends/<name>-py/.venv/`, and
`pythonPath` must be an **absolute path** (the adapter passes it
straight to `spawn()`; a relative path would resolve against the
extension's cwd, not the user-data tree).

### 6. Profile / storage-state paths: no change

`core/shared/storage-state.ts` `PROFILE_DIR = join(PORTAL_DATA_DIR,
"browser-state")` — already under `~/.pi/agent/pi-lean-portal/`,
user-writable, package-upgrade-safe. Stealth backends reuse the same
`storageState` flow (the bridge receives `storageState` in the navigate
RPC). No path change needed. The "Python bridge reuses BrowserContext
across navigates" behavior (AGENTS.md, Known Constraints) is desirable
for stealth fingerprint stability — keep documenting it.

---

## Proposed discovery model for user-installed stealth backends

### Location

```
~/.pi/agent/pi-lean-portal/
├── web-guides/              ← existing (core/guides.ts USER_GUIDES_DIR)
├── browser-state/           ← existing (storage-state.ts PROFILE_DIR)
└── stealth-backends/        ← NEW (this plan)
    ├── camoufox-py/
    │   ├── bridge.py        ← user drops the subclass here
    │   ├── README.md        ← optional
    │   └── .venv/           ← user-created venv (camoufox[geoip] + playwright)
    └── invisible-py/
        ├── bridge.py
        ├── README.md
        └── .venv/           ← user-created venv (invisible-playwright + playwright)
```

A new exported constant in `core/shared/paths.ts`:

```ts
export const USER_BACKENDS_DIR = join(PORTAL_DATA_DIR, "stealth-backends");
```

(Mirrors `USER_GUIDES_DIR` in `core/guides.ts`. Naming: "stealth-backends"
is user-facing and discoverable; internally it's just the user backends
root — any future non-stealth user Python backend could live there too.
Consider naming it `user-backends/` for generality. **Recommendation:
`user-backends/`** — don't bake "stealth" into the directory name; the
mechanism is generic. The plan below uses `user-backends/`.)

### `settings.json` shape

```jsonc
{
  "browser": {
    "plugins": [
      // shipped defaults are NOT repeated — they're the fallback
      {
        "name": "camoufox-py",
        "dir": "camoufox-py",            // resolved against USER_BACKENDS_DIR
        "enabled": true,
        "config": {
          "pythonPath": "/home/me/.pi/agent/pi-lean-portal/user-backends/camoufox-py/.venv/bin/python",
          "launch": {
            "headless": "true",
            "os": "windows",
            "mainWorldEval": true
          }
        }
      },
      {
        "name": "invisible-py",
        "dir": "invisible-py",
        "enabled": false,
        "config": {
          "pythonPath": "/home/me/.pi/agent/pi-lean-portal/user-backends/invisible-py/.venv/bin/python",
          "launch": { "headless": true, "humanize": true }
        }
      }
    ]
  }
}
```

### `dir` semantics (new, multi-root)

`dir` resolution order in the new `detectPluginType`:

1. **Absolute path** — if `path.isAbsolute(dir)`, use it directly. (Lets
   users put a backend anywhere; useful for development.)
2. **Package backends root** — `join(DEFAULT_BACKENDS_ROOT, dir)`. Hits
   shipped backends (`chromium`, `firefox`, `chromium-py`, `firefox-py`).
3. **User backends root** — `join(USER_BACKENDS_DIR, dir)`. Hits
   user-installed stealth backends.

First hit wins (index.ts or bridge.py present). If none of the three has
an entry point, throw the existing "no entry point" error. The
"ambiguous: both index.ts and bridge.py" check applies per resolved
dirPath.

The `PluginDetection.entryPoint` returned is the absolute path to the
found `index.ts` / `bridge.py`, so downstream `import()` / `spawn()`
work regardless of which root matched.

### `detectPluginType` / multi-root changes needed

- **Signature:** keep `detectPluginType(dir, backendsRoot)` for
  backward compat, but add a new
  `detectPluginTypeMultiRoot(dir, roots: string[])` that tries each root
  in order. Or change `detectPluginType` to accept `roots: string[]`
  and update the two call sites. **Recommend: change the signature to
  accept `readonly roots: string[]`** and update
  `parsePluginConfig` + `index.ts` to pass `[DEFAULT_BACKENDS_ROOT,
  USER_BACKENDS_DIR]`. Keep an absolute-path short-circuit at the top.
- **`parsePluginConfig(raw, backendsRoot)`** → change to
  `parsePluginConfig(raw, roots: readonly string[])`. The default
  fallback list (no-plugins branch) stays the four shipped backends with
  `dir` = bare name (resolved against the package root).
- **`loadFullConfig(backendsRoot?)` / `loadPluginConfig(backendsRoot?)`**
  → accept `roots?: readonly string[]`, defaulting to
  `[DEFAULT_BACKENDS_ROOT, USER_BACKENDS_DIR]`.
- **`index.ts`** → replace `detectPluginType(config.dir,
  DEFAULT_BACKENDS_ROOT)` with `detectPluginType(config.dir, roots)`
  where `roots = [DEFAULT_BACKENDS_ROOT, USER_BACKENDS_DIR]`. Pass the
  same `roots` into `loadPluginConfig()`.

### What does NOT change

- `PluginConfig` interface (`name`, `dir`, `enabled`, `config`) —
  unchanged. `dir` stays a string; resolution is internal.
- The four shipped backends' default entries — unchanged.
- `python-adapter.ts` spawn mechanics — unchanged except the new
  `PYTHONPATH` injection (Phase 0b) and `browser.init` send (Phase 0).
- Profile / storage-state paths — unchanged.

---

## Revised phase plan

### Phase 0 — Shared bridge infrastructure (in-package, unchanged from original)

**Scope:** add the `browser.init` RPC + quirks schema to the **shipped**
`pi_browser_bridge` library inside the npm package. This work is
packaging-neutral — it modifies files that already ship in the tarball.
After this phase, `chromium-py` / `firefox-py` are unchanged and all
existing tests stay green.

Files (all inside the published package, already covered by
`package.json` `files`):

1. `backends/python-base/pi_browser_bridge/bridge.py` — add
   `browser.init` handler in `handle_command()`: store
   `self._plugin_config = params.get("config", {})`, return
   `{"ok": True}`. Default `self._plugin_config = {}` in
   `BrowserBridge.__init__`. Add a `plugin_config` read property on
   `BrowserBridge` (default `{}`) so subclasses can read
   `self.plugin_config.get("launch", {})`.
2. `backends/python-base/pi_browser_bridge/playwright_base.py` — add the
   quirks class attrs (`_fingerprint_managed_context: bool = False`,
   `_eval_prefix: str = ""`, `_scroll_via_wheel: bool = False`,
   `_context_factory: Literal["new_context", "camoufox_new_context"]
   = "new_context"`). Update `create_browser_context()` to skip
   `viewport`/`user_agent` when `_fingerprint_managed_context` is True
   and dispatch on `_context_factory`. Update `do_scroll` to use
   `page.mouse.wheel` when `_scroll_via_wheel`. Update `do_evaluate` to
   prepend `_eval_prefix`. Add the internal `_camoufox_new_context`
   helper (lazy-import `camoufox` inside the helper so non-Camoufox
   bridges don't pay the import cost).
3. `backends/python-adapter.ts` — store the plugin config dict on the
   adapter (constructor or `init`), and after the `ping` handshake in
   `_startProcess()` send a `browser.init` RPC with
   `{ config: this._pluginInitConfig }` before resolving. Reject on
   error response with a clear "bridge too old" message.
4. `index.ts` — **no change needed; verify only.** The python branch
   already calls `adapter.init(config.config)` with the **entire** user
   config object (`index.ts:169`), so `launch` etc. already reach the
   adapter and (after Phase 0 step 3) the bridge via `browser.init`.
   Keep the existing `pythonPath` / `pythonArgs` /
   `capabilities` / `transportTimeoutMs` extraction into
   `bridgeConfig` — those are consumed TS-side; the rest is forwarded
   Python-side. The only `index.ts` touch in this whole replan is the
   multi-root `detectPluginType` call in Phase 0b.
5. Tests:
   - `__tests__/python-adapter.test.ts` — assert `browser.init` is sent
     exactly once after `ping`, before any other RPC; assert error
     response rejects.
   - `backends/python-base/tests/` — assert `plugin_config` defaults to
     `{}` and is populated by the init handler; assert each quirk flag
     changes behavior (skip viewport/UA, prepend prefix, use wheel,
     dispatch factory).
   - Run `npm run test:ci` to confirm 803+ structural tests stay green.

#### Quirks rationale (why each flag exists)

These flags exist to fix concrete correctness problems that would
otherwise silently produce a **non-stealth** browser. A developer
implementing the subclasses needs to understand *why* each flag is set,
not just *that* it is:

- **`_fingerprint_managed_context = True`** — The base's
  `create_browser_context()` unconditionally sets
  `viewport: {1280, 720}` and `user_agent: effective_user_agent`. Both
  Camoufox's `NewContext` and invisible_playwright's patched
  `new_context` generate `viewport`, `user_agent`, `screen`,
  `device_scale_factor` from the fingerprint and merge user kwargs with
  **"user wins"**. So the base's hardcoded viewport/UA would override
  the fingerprint values → detectable mismatch (e.g. spoofed
  `screen.width=1920` but real `viewport.width=1280`, or a hardcoded UA
  string that doesn't match the spoofed `navigator.userAgent`). When
  the flag is True, the base passes **only** `storage_state` (and
  optionally `proxy`/`geolocation`) to context creation and lets the
  fingerprint package set viewport/UA/screen/dpr.
- **`_context_factory = "camoufox_new_context"`** (Camoufox only) —
  Camoufox's entire value is in
  `camoufox.NewContext(browser, preset=..., os=..., **ctx_kwargs)`,
  which generates a BrowserForge fingerprint preset and calls
  `context.add_init_script(fp['init_script'])` to install the spoofed
  navigator/screen/WebGL/canvas/audio/fonts. Calling
  `browser.new_context(**kwargs)` directly (the base default) produces
  a **vanilla Firefox fingerprint** and defeats the whole purpose.
  The internal `_camoufox_new_context` handler calls
  `camoufox.NewContext(self._browser, preset=..., os=...,
  proxy=..., geolocation=..., storage_state=config.get("storageState"))`.
  Lazy-import `camoufox` inside the helper so non-Camoufox bridges
  don't pay the import cost. (invisible_playwright does NOT need this —
  it patches `browser.new_context` on the returned browser object, so
  the default `"new_context"` dispatch already gets coherent stealth
  defaults; just don't clobber them with viewport/UA, which
  `_fingerprint_managed_context` prevents.)
- **`_eval_prefix = "mw:"`** (Camoufox only) — By default Camoufox runs
  `page.evaluate` scripts in an isolated world with **read-only**
  access to the page. Writes (setting globals, calling page functions)
  silently no-op. Launching with `main_world_eval=True` + prefixing
  every `page.evaluate` expression with `"mw:"` routes the script to
  the main world where writes work. Reads work with `mw:` too, so the
  prefix is safe to apply unconditionally in `do_evaluate`. Affected
  bridge code paths: `do_evaluate` (handled by the prefix);
  `_capture_ua`, `bot_detection`, `dom-extractor`, nav-settle's
  `wait_for_function` are all reads and work as-is in the isolated
  world regardless. `supportsJavaScriptEvaluate` stays `true`.
- **`_scroll_via_wheel = True`** (Camoufox only) — The base's
  `do_scroll` uses `page.evaluate("(d) => window.scrollBy(...)")`, an
  eval-write. Under Camoufox's isolated world that silently no-ops.
  `page.mouse.wheel(0, delta)` performs the scroll via input events
  instead, eliminating the eval-write dependency entirely.

**Shared pre-existing behavior to keep (not a quirk, but relevant):**
the Python base reuses `BrowserContext` across navigates (unlike the TS
Chromium plugin), so `storageState` passed to `navigate()` only applies
on the first navigate. For stealth this is **desirable** — reusing the
context preserves the fingerprint across navigations. The TS-side
`_persistState()` still saves cookies via `context.storage_state()`
before re-navigate, which works unchanged. Camoufox's fingerprint init
script self-destructs after first execution per document, but re-runs
on each new document in the reused context, so this is fine. Document
as expected, not a bug.

**Exit criteria:** `npm run test:ci` green; `chromium-py` / `firefox-py`
behavior bit-identical (quirks default to off).

> **Note on the original plan:** Phase 0 is the one phase that survives
> v2 nearly verbatim. The only packaging twist is that these files are
> now inside the npm tarball — but they were already there, so no
> `files`-array change is needed.

### Phase 0b — Packaging & discovery (NEW, not in original plan)

**Scope:** make the loader multi-root and make `pi_browser_bridge`
importable by user bridges in their own venvs. This is the prerequisite
for Phase 1/2 to be installable by end users at all.

Files (in-package):

1. `core/shared/paths.ts` — add `USER_BACKENDS_DIR = join(PORTAL_DATA_DIR,
   "user-backends")`. (Pick `user-backends/` over `stealth-backends/`
   for generality — the mechanism is not stealth-specific.)
2. `core/plugin-config.ts` —
   - Change `detectPluginType(dir, backendsRoot: string)` →
     `detectPluginType(dir, roots: readonly string[])`. Add an
     absolute-path short-circuit (`if (path.isAbsolute(dir))` → check
     that dir directly). Otherwise iterate `roots` in order; first root
     with an unambiguous entry point wins. Throw the existing
     ambiguous / no-entry-point errors with a message naming **all**
     roots searched.
   - Change `parsePluginConfig(raw, backendsRoot: string)` →
     `parsePluginConfig(raw, roots: readonly string[])`. Pass `roots`
     into `detectPluginType` in the validation loop. Default fallback
     list unchanged (four shipped backends, `dir` = bare name).
   - Change `loadFullConfig(backendsRoot?)` / `loadPluginConfig(backendsRoot?)`
     to accept `roots?: readonly string[]`, default
     `[DEFAULT_BACKENDS_ROOT, USER_BACKENDS_DIR]`.
3. `index.ts` —
   - Replace `detectPluginType(config.dir, DEFAULT_BACKENDS_ROOT)` with
     `detectPluginType(config.dir, roots)` where
     `roots = [DEFAULT_BACKENDS_ROOT, USER_BACKENDS_DIR]`.
   - Pass the same `roots` into `loadPluginConfig()`.
4. `backends/python-adapter.ts` — in `_startProcess()` `spawn()` `env`,
   inject `PYTHONPATH` pointing at the package's
   `backends/python-base/` directory so user bridges can
   `from pi_browser_bridge.playwright_base import PlaywrightBridge`
   regardless of venv. Resolve the path from `DEFAULT_BACKENDS_ROOT`
   (`join(DEFAULT_BACKENDS_ROOT, "python-base")`) — **append** to any
   existing `PYTHONPATH` rather than overwriting. This makes the shared
   library importable from any venv the user points `pythonPath` at,
   without requiring a `pip install` of `pi-browser-bridge`.
   - **Important:** the `python-base/.venv`-based `chromium-py` /
     `firefox-py` backends already have `pi_browser_bridge` importable
     via their editable install; appending the package path to
     `PYTHONPATH` is harmless (editable install takes precedence in
     their venv's site-packages). Verify with the existing
     `chromium-py` / `firefox-py` contract tests.
5. Tests:
   - `__tests__/plugin-config-browser.test.ts` — add cases:
     - `dir` resolves against `USER_BACKENDS_DIR` when not in package
       root (use a temp dir as the second root).
     - Absolute `dir` short-circuits the roots list.
     - `dir` missing from all roots throws an error naming all roots.
     - Default fallback list unchanged when `browser.plugins` absent.
   - `__tests__/python-adapter.test.ts` — assert `PYTHONPATH` is set in
     the spawn env and includes the package `python-base` path.
   - `npm run test:ci` green.

**Exit criteria:** a fake user backend (a `bridge.py` placed in a temp
`USER_BACKENDS_DIR`) is discovered and spawned; `pi_browser_bridge`
imports succeed in a clean venv thanks to `PYTHONPATH` injection.

> **What's obsolete from the original plan:** the original Phase 1/2 step
> "add `backends/<name>-py/bridge.py` to the repo" and "add to default
> fallback list" — both gone. The stealth `bridge.py` files are no
> longer repo artifacts.

### Phase 1 — `invisible-py` backend (user-installed, lower risk first)

**Scope:** ship the invisible_playwright subclass as a **user-installed**
backend. The repo does NOT contain `backends/invisible-py/`. Instead,
the subclass `bridge.py` + README live in the user-data tree. The repo
**may** ship a documented example/template under a new
`docs/stealth-backends/` directory (see Phase 3) so users have a
copy-paste starting point — but that's docs, not a registered backend.

#### What works as-is (invisible_playwright)

- `InvisiblePlaywright(...).__enter__()` returns a standard Playwright
  `Browser` (or a `BrowserContext` when `profile_dir=` is set — **do not
  use that path**; see Flag 6). The returned browser/context are normal
  Playwright objects, so the base class's `page.aria_snapshot()`,
  `page.get_by_role()`, `locator.click()`, `locator.fill()`,
  `context.cookies()`, `context.add_cookies()`, `context.storage_state()`,
  `page.screenshot()`, `page.on("console")`, `page.on("dialog")` all work
  unchanged.
- `page.evaluate()` works normally for reads **and** writes — no
  isolated-world restriction (unlike Camoufox). `do_scroll`,
  `do_evaluate`, `bot_detection`, `dom-extractor` all work without
  modification. **Do not set `_eval_prefix` or `_scroll_via_wheel`** for
  invisible-py.
- The launcher **patches `browser.new_context`** on the returned browser
  to merge fingerprint defaults (viewport, screen, dpr, color_scheme,
  timezone, locale) with user kwargs (user wins). So the base class's
  `create_browser_context()` calling `browser.new_context(**kwargs)` gets
  coherent stealth defaults automatically — `_context_factory` stays at
  the default `"new_context"`. The only requirement is
  `_fingerprint_managed_context = True` so the base does NOT pass its own
  viewport/UA and clobber the fingerprint.
- The launcher wraps `ctx.new_page()` with a 0.4 s sleep to dodge an
  FF150 about:newtab race. The patch is applied to the browser/context
  returned by `__enter__()`, so the base class's `context.new_page()`
  call benefits from it transparently. First navigate per session pays
  an extra ~0.4 s — negligible.
- Humanized mouse motion (`stealthfox.humanize`) is a Juggler-level
  patch; `locator.click()` still works, just with Bezier-curved motion.
  Good for stealth, ~1.5 s slower per motion — within the router's 5 s
  click timeout.

#### Flags (invisible_playwright)

1. **Playwright lifecycle ownership clash (the big one).**
   `InvisiblePlaywright` starts its own `sync_playwright()` inside
   `__enter__()` and owns it. The base class's `_ensure_playwright()`
   **also** calls `sync_playwright().start()` and expects to own
   `self._pw` / `self._browser`. Spawning two Playwright instances is
   wasteful and would leave `self._pw` pointing at the wrong
   (non-stealth) instance. → **`invisible-py` must override
   `_ensure_playwright()`** to: build `InvisiblePlaywright(**launch_kwargs)`
   from `self.plugin_config.get("launch", {})` (headless, seed, humanize,
   locale, timezone, proxy, binaryPath, prepRecaptcha, geoIpMmdb,
   webrtcPublicIp): **instantiate** `InvisiblePlaywright(**launch_kwargs)`
   and store the **instance** (the context manager itself) as
   `self._stealth_ctx` (held for the bridge's lifetime); then call
   `self._stealth_ctx.__enter__()` **once**, which returns a `Browser` —
   assign that to `self._browser`. Read `self._pw` from
   `self._stealth_ctx._pw` (the `InvisiblePlaywright` instance owns the
   Playwright handle; the `Browser` it returns does not expose `_pw`).
   Return `(self._pw, self._browser)`. **Do NOT call the base
   `_ensure_playwright()`** (super) — it would start a second
   Playwright. Override `_maybe_stop_playwright()` to call
   `self._stealth_ctx.__exit__(None, None, None)` instead of
   `self._pw.stop()`, and null out `_pw`/`_browser`/`_stealth_ctx`, only
   when the last session goes away. This is the biggest
   invisible-py-specific change. (Camoufox avoids this entirely because
   `NewBrowser(playwright, ...)` accepts an externally-owned Playwright
   instance — invisible_playwright does not.)
2. **Hardcoded viewport/UA clobbers the fingerprint** — handled by
   `_fingerprint_managed_context = True` (see Phase 0 quirks rationale).
3. **No config channel** — handled by `browser.init` +
   `self.plugin_config.get("launch", {})` (Phase 0). Launch options to
   surface: `seed` (**must be int31** — `zoom.stealth.fpp.hw_seed` is
   `int32_t` and C++ noise hooks bail on `seed <= 0`, so a 32-bit seed
   with the high bit set produces bit-identical audio/canvas
   fingerprints across half the sessions; invisible_playwright already
   constrains via `secrets.randbits(31)` in its constructor — only
   relevant if you expose `seed` as a config knob, in which case
   document the constraint), `pin`, `headless`, `proxy`, `humanize`,
   `locale`, `timezone`, `extra_prefs`, `binary_path`, `prep_recaptcha`.
4. **~100 MB patched Firefox binary + geoip mmdb, fetched separately.**
   `python -m invisible_playwright fetch` downloads the patched Firefox
   (currently `firefox-13` / FF 150.0.1 — **verify at install time** by
   checking `invisible_playwright/constants.py`'s `BINARY_VERSION`, as
   the binary tag bumps between releases). The geoip mmdb is checked on
   every launch via a HEAD request to GitHub releases (cheap, no API
   token, no rate limit) and **downloaded only when the latest release
   tag differs from the cached copy** — so an offline/restricted
   network fails only the *first* launch after a tag bump, not every
   launch. Mitigation regardless: `STEALTHFOX_GEOIP_MMDB` env var to pin
   a local mmdb, or set an explicit `timezone=` to skip egress-IP
   resolution entirely. `firefox-8` is a known-broken binary version
   (`BROKEN_VERSIONS` refuses it with a clear error) — not an issue if
   users run the default from `fetch`; document.
5. **System dependency: `xvfb` on Linux for `headless=True`.**
   invisible_playwright's `headless=True` keeps Firefox in **headed**
   mode (real rendering pipeline → coherent fingerprint) and hides the
   window via a dedicated Xvfb on Linux. Requires the `xvfb` system
   package. Windows/macOS use the binary's own window cloak (no Xvfb).
   For a server agent on Linux, `xvfb` is a **hard prerequisite** for
   `headless=True` — unlike Camoufox, where `headless=True` means true
   headless and needs no Xvfb. Surface in `_install_hint` + docs.
6. **`profile_dir=` returns a `BrowserContext`, not a `Browser` — do
   not use it.** invisible_playwright supports a persistent Firefox
   profile dir (`launch_persistent_context`), but pi-browser manages
   profiles itself via `core/shared/storage-state.ts` (disk JSON of
   cookies + localStorage, loaded as `storage_state=` on context
   creation). Mixing the two would double-manage state. → Use
   `InvisiblePlaywright()` **without** `profile_dir` (returns a
   `Browser`), and let pi-browser's existing `storageState` flow handle
   profile persistence. Matches the existing `chromium-py`/`firefox-py`
   model.
7. **reCAPTCHA pre-seed is a config knob, not a compatibility issue.**
   `prep_recaptcha=True` injects ~6 `.google.com` + per-site cookies
   before navigation. Disabled automatically when `profile_dir` is set
   (which we don't use). Surface as an opt-in config option
   (`launch.prepRecaptcha`).

#### Implementation steps

1. **`bridge.py` content** (to be placed by the user at
   `~/.pi/agent/pi-lean-portal/user-backends/invisible-py/bridge.py`,
   sourced from the repo's `docs/stealth-backends/invisible-py/`
   template): `InvisiblePyBridge(PlaywrightBridge)` with
   `_plugin_name = "invisible-py"`, `_install_hint` pointing at
   `pip install invisible-playwright` +
   `python -m invisible_playwright fetch` + `apt-get install xvfb`,
   `_fingerprint_managed_context = True`, `_context_factory =
   "new_context"` (default — invisible patches `new_context` itself),
   override `_ensure_playwright` / `_maybe_stop_playwright` per Flag 1
   above, `_capture_user_agent = True`. Read launch options from
   `self.plugin_config.get("launch", {})`.
2. **Venv:** `~/.pi/agent/pi-lean-portal/user-backends/invisible-py/.venv/`
   with `invisible-playwright` + `playwright` installed. `pythonPath` in
   the user's `settings.json` entry is the absolute path to
   `.venv/bin/python`.
3. **No `parsePluginConfig` default change.** The user must add the
   plugin to their `settings.json` `browser.plugins` array explicitly.
4. **Contract tests:** `__tests__/invisible-py.test.ts` — mirror
   `firefox-py.test.ts`; auto-skip if
   `~/.pi/agent/pi-lean-portal/user-backends/invisible-py/.venv` or the
   fetched binary is absent. The test factory constructs a
   `PythonPluginAdapter` pointed at the user-backends path. **This test
   lives in the repo** (covered by `files` only if it's a `.test.ts` —
   it is, so it's NOT shipped; it's dev-only). It exercises the
   multi-root discovery + `PYTHONPATH` injection against a real
   user-backends install on the dev machine.
5. **Persistence test:** `__tests__/invisible-py-persistence.test.ts`
   mirroring `chromium-py-persistence.test.ts`, auto-skip on missing
   deps.

**Exit criteria:** with a user-installed invisible-py + fetched binary

- `xvfb`, `runContractTests("invisible-py", factory,
{ realBrowser: true, engine: "firefox" })` passes; auto-skip cleanly
otherwise. Manual smoke test: navigate to bot.sannysoft.com, confirm
clean fingerprint.

> **Obsolete from original:** "add `invisible-py` to the default
> fallback list" — removed. "Venv at
> `backends/invisible-py/.venv`" — moved to user-data tree.

### Phase 2 — `camoufox-py` backend (user-installed)

**Scope:** same shape as Phase 1, for Camoufox.

#### What works as-is (Camoufox)

- `camoufox.NewBrowser(playwright, *, headless=..., **kwargs)` accepts
  an existing `Playwright` instance — so it can be called from
  `_launch_browser()` with `self._pw` and returns a standard Playwright
  `Browser`. **No lifecycle refactor required** (unlike invisible-py) —
  the base's `_ensure_playwright()` calls `sync_playwright().start()` to
  get `self._pw`, then `_launch_browser()` hands that `self._pw` to
  `camoufox.NewBrowser`. The base owns the Playwright; Camoufox owns
  the patched browser. Do not override `_ensure_playwright` /
  `_maybe_stop_playwright`.
- Returns patched Firefox via `playwright.firefox.launch()` → Juggler
  protocol → same ARIA YAML format the existing `firefox-py` parser
  already handles.
- `page.evaluate()` reads work in the default isolated world
  (`navigator.userAgent`, `document.body.innerText`,
  `document.documentElement.innerHTML`, the dom-extractor's
  `querySelectorAll`/`getComputedStyle` walks).

#### Flags (Camoufox)

1. **Fingerprint injection is skipped if you call `browser.new_context()`
   directly.** Camoufox's whole value is in
   `camoufox.NewContext(browser, preset=..., os=..., **ctx_kwargs)`,
   which generates a BrowserForge fingerprint preset and calls
   `context.add_init_script(fp['init_script'])` to install the spoofed
   navigator/screen/WebGL/canvas/audio/fonts. The base class's
   `create_browser_context()` calling `browser.new_context(**kwargs)`
   directly produces a **vanilla Firefox fingerprint** and defeats the
   purpose. → Set `_context_factory = "camoufox_new_context"`; the base
   dispatches to the internal `_camoufox_new_context` handler (added in
   Phase 0) which calls
   `camoufox.NewContext(self._browser, preset=..., os=...,
   proxy=..., geolocation=..., storage_state=config.get("storageState"))`.
   No manual override of `create_browser_context`.
2. **Hardcoded viewport/UA clobbers the fingerprint** — handled by
   `_fingerprint_managed_context = True` (Phase 0 quirks rationale).
3. **`page.evaluate()` writes are gated behind `main_world_eval=True`
   at launch + a `"mw:"` script prefix.** By default Camoufox runs
   `page.evaluate` scripts in an isolated world with **read-only**
   access; writes silently no-op. → Launch with `main_world_eval=True`
   (default; via `plugin_config.launch.mainWorldEval`, default `True`),
   set `_eval_prefix = "mw:"` (base prepends in `do_evaluate`) and
   `_scroll_via_wheel = True` (base uses `page.mouse.wheel` in
   `do_scroll`, eliminating the eval-write dependency). Affected paths:
   `do_scroll` (handled by wheel), `do_evaluate` (handled by prefix);
   `_capture_ua`, `bot_detection`, `dom-extractor`, nav-settle's
   `wait_for_function` are reads — work as-is. `supportsJavaScriptEvaluate`
   stays `true`. Document the prefix behavior in the backend README.
4. **No config channel** — handled by `browser.init` +
   `self.plugin_config.get("launch", {})` (Phase 0). Launch options:
   `headless`, `os` ("windows"|"macos"|"linux" target),
   `fingerprint_preset`, `proxy`, `geolocation`, `geoip`,
   `main_world_eval`, `executable_path`, `humanize`-equivalent.
5. **~100 MB patched Firefox binary, fetched separately.**
   `python -m camoufox fetch` downloads the Camoufox build. Not bundled
   with the pip package. `_install_hint` must point users at both
   `pip install camoufox[geoip]` **and** `python -m camoufox fetch`.
   No auto-fetch (Decision #8) — fail fast with the install hint.
6. **Headless on Linux wants Xvfb for `headless='virtual'`.** True
   headless (`headless=True`) works without Xvfb but Camoufox recommends
   headed for fingerprint coherence. `headless='virtual'` uses
   `PyVirtualDisplay` and requires the `xvfb` system package. For a
   server agent, pick `headless=True` as the default and document
   `headless=virtual` as the high-coherence option requiring `xvfb`.
   (Note the contrast with invisible-py, where `headless=True` itself
   needs Xvfb — Camoufox's `headless=True` does not.)
7. **Storage state on re-navigate is ignored (pre-existing, desirable).**
   See the Phase 0 "shared pre-existing behavior" note — reusing the
   context preserves the fingerprint; `_persistState()` still saves
   cookies. No action.
8. **`addInitScript` self-destructs after first run per document.**
   Camoufox's fingerprint script self-destructs on first execution.
   Reused across navigations in the same context this is fine — the init
   script re-runs on each new document. No action; flagged so it doesn't
   surprise a future reader.
9. **`_wait_for_page_ready` / nav-settle:** verify `page.wait_for_function`
   with `setTimeout` isn't flaky in the isolated world in contract tests.
   The existing try/except already degrades gracefully; override only if
   it proves flaky.

#### Implementation steps

1. **`bridge.py` content** (template at
   `docs/stealth-backends/camoufox-py/`): `CamoufoxPyBridge(PlaywrightBridge)`
   with `_plugin_name = "camoufox-py"`, `_fingerprint_managed_context =
   True`, `_context_factory = "camoufox_new_context"`,
   `_eval_prefix = "mw:"`, `_scroll_via_wheel = True`, override
   `_launch_browser` to call `camoufox.NewBrowser(self._pw, ...)` with
   `main_world_eval=True` (default), read options from
   `self.plugin_config.get("launch", {})`. The base's quirks dispatch
   handles `create_browser_context`, `do_scroll`, `do_evaluate` — do
   NOT override those methods.
2. **Venv:** `~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/.venv/`
   with `camoufox[geoip]` + `playwright`. Absolute `pythonPath` in
   `settings.json`.
3. **No default-list change.**
4. **Contract tests:** `__tests__/camoufox-py.test.ts` +
   `__tests__/camoufox-py-persistence.test.ts`, auto-skip on missing
   deps. Add a Camoufox-specific test asserting `do_scroll` works (via
   `mouse.wheel`) and `do_evaluate("() => 1 + 1")` returns `2` (with the
   `mw:` prefix applied by the base).
5. **Install hint / fail-fast:** if the Camoufox binary is missing,
   `_launch_browser` raises with `_install_hint` pointing at
   `python -m camoufox fetch` (run inside the user's camoufox-py venv).
   No auto-fetch.

**Exit criteria:** contract tests pass with a fetched Camoufox binary;
auto-skip cleanly without. Manual smoke test: bot.sannysoft.com / creepjs
shows spoofed fingerprint.

> **Obsolete from original:** "add `camoufox-py` to the default
> fallback list" — removed. "Venv at `backends/camoufox-py/.venv`" —
> moved to user-data tree.

### Phase 3 — Polish, docs, ship-manifest, AGENTS.md (NEW + original)

1. **`docs/stealth-backends/`** (new, in-repo, **not** in `package.json`
   `files` — `docs/` is skipped by `ship-manifest` and excluded from the
   tarball by the `files` allowlist): ship copy-pasteable
   `camoufox-py/bridge.py` + `invisible-py/bridge.py` templates and a
   `README.md` covering install steps (venv creation, pip installs,
   binary fetch, `xvfb`), the `settings.json` shape (absolute
   `pythonPath`, `launch` config), and the fail-fast install-hint
   behavior. Users copy these into
   `~/.pi/agent/pi-lean-portal/user-backends/<name>-py/`.
2. **`STEALTH.md`** (original Phase 3 item): when to pick which backend.
3. **`/web status`** (`browser-status.ts`): the existing
   `pluginRegistry.availableAll()` already lists user stealth plugins
   once registered — no change needed for the plugin list. **New
   work:** add a per-stealth-backend binary-fetched check (cheap `stat`
   of `~/.cache/camoufox/...` / `~/.cache/invisible-playwright/...`).
   Since stealth backends are now user-side and the package can't know
   their cache paths generically, expose this via an optional
   `statusProbe` callback the user bridge can register, or simply
   document that `/web status` shows the plugin as registered and let
   the bridge's `_install_hint` surface on first navigate. **Recommend:
   defer the binary check** — keep `/web status` as-is for now; the
   fail-fast `_install_hint` on navigate is the primary UX. File a
   follow-up note.
4. **`ship-manifest.test.ts`:** the existing test walks production `.ts`
   in the package and asserts `files` covers them. **No change needed**
   unless we add new production `.ts` to the package — Phase 0/0b add
   logic to existing files (`plugin-config.ts`, `python-adapter.ts`,
   `index.ts`, `paths.ts`, `bridge.py`, `playwright_base.py`), all
   already covered by `files` (`core/`, `backends/`). The new
   `__tests__/invisible-py.test.ts` / `camoufox-py.test.ts` are
   `.test.ts` → skipped by the manifest walk → not shipped → no manifest
   change. Run `npm run test:ci` to confirm `ship-manifest` stays green.
5. **`AGENTS.md` (monorepo root + portal):** update the Active plugins
   table to mark `camoufox-py` / `invisible-py` as **user-installed
   (not shipped)**, document the `user-backends/` directory, the
   multi-root `dir` resolution, the `PYTHONPATH` injection, the
   `browser.init` RPC, and the quirks schema. Add Known Constraints
   entries for: fingerprint-managed context, Camoufox `mw:` prefix +
   `main_world_eval`, invisible-py lifecycle ownership, `xvfb` dep, and
   the **user-side install burden** (venv + binary fetch + `settings.json`
   entry). Update the Test files table with the new auto-skip tests.
6. **`packages/pi-lean-portal/package.json` `files`:** review whether
   `docs/` should ship. **Recommend: do NOT ship `docs/`** — keep the
   tarball lean; the templates are repo-only and the README in the
   tarball links to the repo for stealth templates. No `files` change
   required (current allowlist already excludes `docs/`).
7. **CI:** new live-browser tests auto-skip in CI. Add an opt-in
   workflow that fetches the stealth binaries and runs the stealth
   contract tests on a Linux runner with `xvfb` (original Phase 3 item,
   unchanged).

---

## New work items not in the original plan

These are the items the original plan entirely missed because it was
written pre-packaging:

1. **Multi-root plugin discovery** (`detectPluginType`, `parsePluginConfig`,
   `loadFullConfig`, `index.ts`) — Phase 0b. The original plan's
   "Discovery & naming" section (Shared Concern D) only said
   "`detectPluginType()` looks for `bridge.py` in `backends/<dir>/`" —
   that assumption is now false for user backends.
2. **`USER_BACKENDS_DIR` constant** in `core/shared/paths.ts` — Phase 0b.
3. **`PYTHONPATH` injection** in the adapter's spawn env — Phase 0b.
   Without this, user bridges can't import the shared library. The
   original plan never considered importability outside the shared
   `python-base/.venv`.
4. **Absolute-path `dir` short-circuit** in `detectPluginType` —
   Phase 0b. Enables dev workflows and power users.
5. **Forwarding the full `config.config` to `adapter.init()`** (not just
   the four `PythonBridgeConfig` fields) — Phase 0 step 4. The original
   plan mentioned `browser.init` carrying `config.config` but didn't
   note that `index.ts` currently drops everything outside the four
   named fields.
6. **Removing stealth backends from the default fallback list** —
   Phase 1/2. The original plan added them; that's wrong
   post-packaging.
7. **Templates in `docs/stealth-backends/`** (repo-only, not shipped) —
   Phase 3. The original plan had no notion of "user copy-pastes the
   bridge from docs" because it assumed the bridge was in the repo.
8. **Security note for user-contributed Python:** running a user's
   `bridge.py` is executing user-authored code as a subprocess. This is
   no different from the existing `web-learn` / `web-guides` user-authoring
   model, but Python bridges are full code execution. Document that
   `user-backends/` is **trusted user code** (the user themselves wrote
   or audited it), NOT a plugin marketplace. The extension does not
   download or execute stealth backends automatically — the user must
   place files there manually. Add this to `AGENTS.md` and the
   `STEALTH.md` docs.
9. **`ship-manifest.test.ts` regression check** — Phase 3. Confirm no
   new production `.ts` slips out of the `files` array after Phase 0/0b.
10. **AGENTS.md updates for the user-backends model** — Phase 3.
11. **`pythonPath` must be absolute** in user `settings.json` entries —
    Phase 1/2 docs. The adapter passes `pythonPath` straight to
    `spawn()`; a relative path resolves against the extension's cwd,
    not the user-data tree. Document this explicitly.

---

## Risk summary (updated)

| Risk | Severity | Mitigation | Changed from original? |
|------|----------|------------|-------------------------|
| Hardcoded viewport/UA clobbers stealth fingerprint (silent non-stealth) | **High** | Phase 0: `_fingerprint_managed_context` opt-out. | No |
| Camoufox `NewContext` not called → no fingerprint injection | **High** | Phase 2: `_context_factory = "camoufox_new_context"` dispatches in base. | No |
| No config channel → stealth options can't reach the bridge | **High** | Phase 0: `browser.init` RPC + `plugin_config`. | No |
| **User bridges can't import `pi_browser_bridge` (new)** | **High** | Phase 0b: `PYTHONPATH` injection pointing at the package's `python-base/`. | **NEW** — original plan missed this entirely. |
| **Multi-root discovery not implemented (new)** | **High** | Phase 0b: `detectPluginType` accepts `roots[]`, absolute-path short-circuit, `USER_BACKENDS_DIR`. | **NEW** |
| `page.evaluate` writes silently no-op on Camoufox | **Medium** | `main_world_eval=True` + `mw:` prefix; `mouse.wheel` for scroll. | No |
| invisible_playwright lifecycle ownership clash (two Playwrights) | **Medium** | Override `_ensure_playwright` / `_maybe_stop_playwright`. | No |
| `xvfb` missing on Linux → headless fails | **Medium** | `_install_hint` + docs; `/web status` binary check deferred. | No |
| ~100 MB binary not fetched → navigate fails | **Low** | `_install_hint` + auto-skip tests. | No |
| ARIA role-set divergence on patched Firefox | **Low** | Threshold-based contract assertions. | No |
| Dependency conflicts in shared venv | **Low** | Separate user venvs under `user-backends/<name>-py/.venv`. | Path changed from `backends/<name>-py/.venv`. |
| Geoip mmdb auto-download fails offline (invisible-py) | **Low** | `STEALTHFOX_GEOIP_MMDB` env pin or explicit `timezone=`. | No |
| **`pythonPath` relative in user settings → spawn fails (new)** | **Low** | Docs: require absolute `pythonPath`; adapter could resolve relative against `USER_BACKENDS_DIR` as a nicety (optional). | **NEW** |
| **Running user-authored Python (security) (new)** | **Low** | `user-backends/` is trusted user code, not a marketplace; no auto-download; document in AGENTS.md + STEALTH.md. | **NEW** |
| **`npm update` overwrites user backends (new)** | **Mitigated** | User backends live under `~/.pi/agent/pi-lean-portal/user-backends/`, outside `node_modules/`. | **NEW** — the root cause of this replan. |
| **`PYTHONPATH` append vs. editable install precedence** | **Low** | Append (don't prepend) the package path; editable install in `python-base/.venv` keeps precedence for `chromium-py`/`firefox-py`. Verify with existing contract tests. | **NEW** |

**Bottom line:** no blockers. The two original High-severity risks
(viewport/UA clobber, no config channel) plus two **new** High-severity
packaging risks (importability, multi-root discovery) are all addressed
by small, well-contained changes in Phase 0 and Phase 0b. The stealth
subclass work (Phase 1/2) is unchanged in substance — only its
deployment location moves from the repo to the user-data tree.

---

## Implementation order

1. **Phase 0** (in-package shared infra) — no packaging impact.
2. **Phase 0b** (packaging/discovery) — unblocks user installation.
3. **Phase 1** (`invisible-py`, user-installed) — lower risk first.
4. **Phase 2** (`camoufox-py`, user-installed).
5. **Phase 3** (docs, ship-manifest regression, AGENTS.md, CI).

Phase 0 and 0b can be done in parallel by different contributors (they
touch disjoint files except `python-adapter.ts` and `index.ts`, which
both modify — coordinate those two files).
