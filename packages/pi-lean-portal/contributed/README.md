# Stealth Backends — Install Guide

Stealth backends are **user-installed browser plugins** that drive
patched/fingerprint-managed browser binaries (e.g. Camoufox) for sites
that block the shipped Chromium/Firefox. They are **never shipped in
the npm tarball** and the extension never downloads or executes them
automatically — you write or audit the bridge, you create the venv, you
fetch the binary, and you register it in `settings.json`.

This guide walks through the install flow with
[**Camoufox**](https://github.com/daijro/camoufox) as the worked
example. The same shape applies to any stealth backend that subclasses
`PlaywrightBridge` using the [quirks schema](#quirks-schema-reference)
documented in `playwright_base.py`.

> **You need the git repo, not just `npm install pi-lean-portal`.**
> The template bridge and this README live under
> `packages/pi-lean-portal/contributed/` in the source
> repository. `docs/` is excluded from the portal `package.json`
> `files`, so the templates are not in the published tarball. Clone the
> repo (or obtain a copy of these files) before starting.

For *whether* you should reach for a stealth backend at all, see
[`CHOOSING.md`](./CHOOSING.md). For the architecture (multi-root
discovery, `browser.init` RPC, `PYTHONPATH` injection), see the
"Stealth backends (user-managed)" section of
[`packages/pi-lean-portal/AGENTS.md`](../../AGENTS.md).

## Where things live

```
~/.pi/agent/pi-lean-portal/
├── web-guides/              (existing)
├── browser-state/           (existing)
└── user-backends/           ← stealth backends go here
    └── camoufox-py/
        ├── bridge.py        ← you copy this from the source repo
        └── .venv/           ← you create this (engine pip pkg + playwright)
```

This is a **different tree from any in-repo test fixtures** (which live
gitignored under `bench/miniwob/fixtures/` for the evaluation harness).
The `~/.pi/agent/pi-lean-portal/user-backends/` tree is what the pi
agent's production `detectPluginType` reads at runtime. The two concerns
are deliberately separate.

## Install flow (Camoufox)

### 1. Pick a location

```
~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/
```

The convention is `<name>-py/` (mirrors the shipped `chromium-py` /
`firefox-py` naming). The directory name is the plugin `name` you will
register in `settings.json`.

### 2. Copy the template bridge

Copy the source-repo template into your user-backends tree:

```bash
mkdir -p ~/.pi/agent/pi-lean-portal/user-backends/camoufox-py
cp packages/pi-lean-portal/contributed/camoufox-py/bridge.py \
   ~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/bridge.py
```

You need the **git repo** for this step — the template is not in the
`npm install pi-lean-portal` tarball (`docs/` is excluded from
`package.json` `files` by design). Alternatively, write your own
subclass using the [quirks schema](#quirks-schema-reference) documented
in `backends/python-base/pi_browser_bridge/playwright_base.py`. Either
way, audit what you copy — this is trusted user code that the extension
will spawn as a subprocess.

### 3. Create the venv and install dependencies

```bash
cd ~/.pi/agent/pi-lean-portal/user-backends/camoufox-py
python3 -m venv .venv
. .venv/bin/activate
pip install "cloverlabs-camoufox[geoip]" playwright
```

You do **not** need to `pip install` the shared `pi_browser_bridge`
library — the `PythonPluginAdapter` injects the package's
`backends/python-base/` onto `PYTHONPATH` automatically at spawn time
(see `python-adapter.ts` `_buildPythonPath()`), so
`from pi_browser_bridge.playwright_base import PlaywrightBridge` works
from your venv without a PyPI package.

### 4. Fetch the patched binary

Engine-specific. For Camoufox:

```bash
. .venv/bin/activate
python -m camoufox fetch
```

This downloads the patched Firefox binary (~100 MB). If it is missing
at runtime, the bridge's `_install_hint` surfaces the command in the
error so you know what to run.

### 5. System dependencies

- **Linux + `headless='virtual'`**: install `xvfb`
  (`apt install xvfb` / `dnf install xorgx11-server-Xvfb`). True
  headless (`headless=True`, the bridge's default) works without xvfb.
- macOS / Windows: no extra system deps for the default headless mode.

### 6. Register in `settings.json`

Edit `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(project-local). Add the plugin under `browser.plugins` with an
**absolute** `pythonPath` pointing at your venv's interpreter and a
`launch` object:

```jsonc
{
  "browser": {
    "plugins": [
      {
        "name": "camoufox-py",
        "dir": "camoufox-py",
        "enabled": true,
        "config": {
          "pythonPath": "/home/me/.pi/agent/pi-lean-portal/user-backends/camoufox-py/.venv/bin/python",
          "launch": {
            "headless": true,
            "os": "windows",
            "humanize": true,
            "enableCache": true,
            "mainWorldEval": true
          }
        }
      }
    ]
  }
}
```

Notes:

- **`pythonPath` must be absolute.** A relative `pythonPath` is not
  resolved against `USER_BACKENDS_DIR` (that nicety is intentionally
  out of scope — see the stealth plan's "Out of scope" list). Point it
  at `<user-backends>/camoufox-py/.venv/bin/python`.
- **`dir`** is resolved against the user-backends root (multi-root
  discovery: package `backends/` → `USER_BACKENDS_DIR` → absolute). A
  bare `"camoufox-py"` resolves to `~/.pi/agent/pi-lean-portal/
  user-backends/camoufox-py/`. You may also pass an absolute `dir`.
- **`launch`** keys are forwarded to the bridge as `plugin_config.launch`
  via the `browser.init` RPC. The Camoufox bridge reads them in
  `_launch_browser()` and passes them to `camoufox.NewBrowser`. Defaults
  if you omit them: `headless=true`, `os="windows"`, `geoip=true`,
  `humanize=true`, `enableCache=true`, `mainWorldEval=true`.
- **Stealth backends are never in the default fallback list.** When
  `browser.plugins` is absent, only the four shipped backends
  (`chromium`, `firefox`, `chromium-py`, `firefox-py`) are loaded. A
  fresh install must not emit validation errors for plugins the user
  never asked for.

### 7. Verify

1. **`/web status`** — lists `camoufox-py` among the discovered plugins
   (it appears once `settings.json` is picked up).
2. **`browser-navigate` to a test page** — e.g. navigate to
   `https://example.com`. The first navigate spawns the bridge, runs
   the `ping` handshake, sends `browser.init`, launches Camoufox, and
   returns an accessibility tree.
3. **Missing binary** — if you skipped step 4, the navigate fails with
   the bridge's `_install_hint` telling you to run
   `python -m camoufox fetch`.

### 8. Security note

`user-backends/` is **trusted user code**. The extension never
downloads, fetches, or executes stealth backends automatically — there
is no plugin marketplace and no auto-install. You wrote or audited
every line of `bridge.py`, you created the venv, and you fetched the
binary. Audit anything you copy from elsewhere before pointing the
agent at it; the bridge runs as a subprocess with whatever network and
filesystem access your user account has.

### 9. Benchmarking (optional)

To run the full 130-task [MiniWoB++](https://miniwob.farama.org/) suite
against your Camoufox install (or any installed stealth backend),
use the contributed discovery runner at
`packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts`.
The runner discovers every backend under `user-backends/*-py/`, loads
config from the test-local `settings.json`, and runs contract +
persistence + parity suites for each — all forwarding your configured
`launch` options. Opt-in via `CONTRIB_RUN=1`:

```bash
npm run setup:miniwob                       # one-time: clone MiniWoB++ content
CONTRIB_RUN=1 npx vitest run packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts
```

**Single-backend isolation:** set `PI_USER_BACKENDS_DIR` at a temp root
containing only the backend you want to test:

```bash
ln -s ~/.pi/agent/pi-lean-portal/user-backends/camoufox-py /tmp/one-backend/
PI_USER_BACKENDS_DIR=/tmp/one-backend CONTRIB_RUN=1 \
  npx vitest run packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts
```

The runner uses `registerContributedParitySuite` from
`bench/miniwob/solvers/contributed-parity.ts`. See that file and the
[runner source](../../__tests__/run-contributed-suites.test.ts) for
the full prerequisites and the config-forwarding wiring shape if you
want to write your own benchmark against a different backend setup.

## Quirks schema reference

The contract for writing your own stealth backend is the set of class
attributes on `PlaywrightBridge` in
`backends/python-base/pi_browser_bridge/playwright_base.py`. Set them
as class attributes on your subclass:

| Flag | Default | Effect when set |
|------|---------|-----------------|
| `_fingerprint_managed_context` | `False` | `create_browser_context()` skips hardcoded `viewport`/`user_agent`; lets the fingerprint package set them. |
| `_eval_prefix` | `""` | Prepended to every `page.evaluate` expression in `do_evaluate` (e.g. Camoufox's `"mw:"` routes writes to the main world). |
| `_scroll_via_wheel` | `False` | `do_scroll` uses `page.mouse.wheel` instead of `page.evaluate("window.scrollBy")` (avoids eval-write under isolated-world stealth). |
| `_skip_default_viewport` | `False` | Skips Playwright's `Browser.setDefaultViewport` CDP call (Camoufox binary rejects its `isMobile` prop). |
| `_skip_networkidle` | `False` | Nav-settle uses `load` instead of `networkidle` (patched binaries don't fire `networkidle` reliably). |
| `_wrap_mw_eval_in_eval` | `False` | `do_evaluate` rewrites the expression as `eval(<JSON-string of expression>)` before prepending `_eval_prefix`, so multi-statement scripts survive Camoufox's `let _s = (${script})` main-world wrapper (which only accepts a single expression). Camoufox-only; flip back to `False` when a future driver fixes the wrapper. |

All flags default off, so the shipped `chromium-py` / `firefox-py`
behavior is bit-identical to a pre-stealth install. For the two
lifecycle patterns (engine-accepts-external-Playwright vs.
engine-owns-its-own-Playwright) and the trade-offs of writing your own,
see [`CHOOSING.md`](./CHOOSING.md).

## Test-local settings for contributed runners

The contributed-backend runner (`run-contributed-suites.test.ts`) reads
backend configuration from a local settings file at:

```
packages/pi-lean-portal/__tests__/contributed/settings.json
```

This file is gitignored — you create it locally.  Below is a sample with
every supported field explained:

```json
{
 "$comment": "Sample test-local settings for contributed-backend runner. Copy to packages/pi-lean-portal/__tests__/contributed/settings.json and adjust for your installed backend.",
 "browser": {
  "plugins": [
   {
    "name": "camoufox-py",
    "dir": "camoufox-py",
    "enabled": true,
    "config": {
     "pythonPath": "/absolute/path/to/camoufox-py/.venv/bin/python3",
     "capabilities": {
      "engine": "firefox",
      "supportsFullPageScreenshot": true,
      "supportsJavaScriptEvaluate": true
     },
     "transportTimeoutMs": 60000,
     "launch": {
      "headless": true,
      "humanize": false,
      "os": "windows",
      "geoip": false
     }
    }
   }
  ]
 }
}
```

| Field | Purpose |
|-------|---------|
| `name` | Plugin name, must match the directory under `user-backends/` (e.g. `camoufox-py`). |
| `dir` | Directory name, resolved against the user-backends root. A bare `"camoufox-py"` resolves to `~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/`. |
| `enabled` | Set to `true` for the runner to pick up this backend. |
| `pythonPath` | **Absolute** path to the venv's Python interpreter. If omitted, the runner auto-detects `probe.venvPython` from the user-backend probe. |
| `capabilities` | Override the backend's capability flags. Fields not listed inherit defaults from `DEFAULT_CAPABILITIES`. |
| `capabilities.engine` | Browser engine identifier: `"firefox"` or `"chromium"`. Controls capability resolution. |
| `capabilities.supportsFullPageScreenshot` | Whether the backend can capture full-page screenshots. |
| `capabilities.supportsJavaScriptEvaluate` | Whether the backend supports `page.evaluate`. |
| `transportTimeoutMs` | JSON-RPC transport timeout in milliseconds. Defaults to the adapter's built-in fallback (usually 30s). |
| `launch` | Options forwarded to the bridge as `plugin_config.launch` via the `browser.init` RPC. |
| `launch.headless` | Run browser headless (`true`) or with a visible window (`false`). |
| `launch.humanize` | Add human-like mouse/timing noise to evade bot detection. |
| `launch.os` | Spoofed OS identity: `"windows"`, `"macos"`, or `"linux"`. |
| `launch.geoip` | Enable GeoIP-based locale/language spoofing. |

Override the settings path with `CONTRIB_SETTINGS`:

```bash
CONTRIB_SETTINGS=/path/to/my-settings.json CONTRIB_RUN=1 \
  npx vitest run packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts
```
