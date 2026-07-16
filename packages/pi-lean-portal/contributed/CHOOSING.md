# Choosing a Backend

A short decision doc: when to reach for a stealth backend at all, when
to use the shipped Camoufox template specifically, and what the
contract looks like if you implement your own. For the install flow,
see [`README.md`](./README.md). For the architecture, see the
"Stealth backends (user-managed)" section of
[`packages/pi-lean-portal/AGENTS.md`](../../AGENTS.md).

## When to use a stealth backend at all

**Usually: don't.** The four shipped backends (`chromium`, `firefox`,
`chromium-py`, `firefox-py`) are faster, have better ARIA-tree parity,
need no per-engine venv, and need no binary fetch. Reach for a stealth
backend only when:

- The target site runs bot detection that blocks the shipped
  Chromium/Firefox (Cloudflare Turnstile, Datadome, PerimeterX, etc.
  that fingerprint the browser binary), **and**
- The `bot-detection` guide + a real User-Agent + cookie persistence
  (named profiles) are not enough to get past the challenge.

Most sites do not need it. The cost is real: a ~100 MB binary fetch, a
dedicated venv, slower humanized input, and more moving parts to keep
working across engine version bumps. Treat stealth as a last resort,
not a default.

## When to use Camoufox specifically

[Camoufox](https://github.com/daijro/camoufox) is the **shipped,
tested template** — there is a reference `bridge.py` under
[`camoufox-py/`](./camoufox-py/), and a generic discovery runner at
`__tests__/run-contributed-suites.test.ts` auto-discovers any
installed user backend and runs the shared contract + persistence +
parity + quirks introspection suites against it. Properties:

- **Firefox-based** — a patched Firefox binary, so it shares Firefox's
  ARIA-tree shape with the shipped `firefox` / `firefox-py` backends.
- **Fingerprint injected at browser launch** — via
  `camoufox.NewBrowser(playwright, ...)`, not at context creation. This
  is why Camoufox sets `_fingerprint_managed_context = True` and uses
  standard `browser.new_context()` rather than a custom context factory.
- **`mw:`-prefix main-world eval** — `_eval_prefix = "mw:"` routes
  `page.evaluate` writes to the main world (Camoufox's isolated-world
  stealth otherwise blocks them). The bridge also sets
  `main_world_eval=True` in the `NewBrowser` kwargs.
- **Wheel-based scroll** — `_scroll_via_wheel = True` uses
  `page.mouse.wheel` instead of `window.scrollBy` eval (avoids
  eval-write under isolated-world stealth).

If you want a stealth backend and you do not have a strong reason to
pick something else, use Camoufox via the template in
[`camoufox-py/bridge.py`](./camoufox-py/bridge.py). The install flow is
in [`README.md`](./README.md).

## Implementing your own stealth backend

The contract is the **quirks schema** — the set of class attributes on
`PlaywrightBridge` documented in
`backends/python-base/pi_browser_bridge/playwright_base.py` (and
reproduced in [`README.md`](./README.md#quirks-schema-reference)). Set
the flags your engine needs as class attributes on a subclass, and
override the launch hook that matches how your engine owns Playwright.
There are two lifecycle patterns:

### Pattern 1 — Engine accepts an external Playwright instance

The engine exposes a constructor like `NewBrowser(playwright, ...)`
that takes an already-running Playwright and returns a browser. **Do
not** override `_ensure_playwright` — let the base class own the
Playwright lifecycle. Override **`_launch_browser` only**, handing the
base-supplied `playwright` to the engine. (Camoufox is the example of
this pattern; see `camoufox-py/bridge.py`.)

### Pattern 2 — Engine owns its own Playwright instance

The engine brings its own Playwright (e.g. it wraps a context manager
that starts Playwright internally). Override **`_ensure_playwright`**
and **`_maybe_stop_playwright`** to delegate to the engine's context
manager, and **do not call super** in those overrides — the base
implementation would start a redundant Playwright. The base class's
`_newBrowserContext` still drives the page through the standard
`BrowserContext` / `Page` path, so navigation, snapshot, click, etc.
keep working unchanged.

In both patterns, read user launch options from
`self.plugin_config.get("launch", {})` (forwarded via the `browser.init`
RPC from `settings.json` `config.launch`), and surface a helpful
`_install_hint` string so a missing binary tells the user what to run
rather than failing opaquely.

## Trade-offs

- **~100 MB binary fetch** per engine, plus the engine's pip package.
- **Per-engine venv** at `user-backends/<name>-py/.venv/` — each
  stealth backend maintains its own dependencies.
- **Slower humanized input** — `humanize=True` (Camoufox default) uses
  bezier-curved mouse motion; fine for bot-detection sites, slower for
  bulk automation.
- **`xvfb` on Linux** for `headless='virtual'` modes; true headless
  (`headless=True`) works without it.
- **Back-navigation may be limited on patched binaries.** Camoufox
  needs `enable_cache=True` (the template's default) to restore session
  history so `do_go_back()` works. Some patched Firefox binaries have a
  binary-level back-navigation bug that requires a `document.referrer`
  workaround; Camoufox does not need it with `enable_cache=True`. If
  your engine disables the bfcache and `do_go_back` misbehaves, fall
  back to navigating to the `document.referrer`.
- **Version drift** — patched binaries are pinned to specific engine
  releases. A binary version bump can change which quirks are needed
  (e.g. an `isMobile` rejection gets fixed, or a `NewContext` path
  starts working). Re-validate your bridge on engine releases; the
  quirks flags degrade gracefully (default off).

## What this is not

- **Not a plugin marketplace.** The extension never downloads or
  executes stealth backends automatically. `user-backends/` is trusted
  user code — you wrote or audited it.
- **Not shipped in the npm tarball.** The templates live in the source
repo under `contributed/`; `contributed/` is not included in the
`package.json` `files` allow-list. You need the git repo (or a copy of the
  files) to install a stealth backend.
- **Not in the default fallback list.** Stealth backends are loaded
  only when explicitly listed in `browser.plugins`. A fresh install
  never validates plugins the user never asked for.
