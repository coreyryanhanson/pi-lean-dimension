#!/usr/bin/env python3
"""
Camoufox-Py Bridge — Python-side stealth backend using Camoufox.

**This is a user-installed backend — it does NOT ship in the npm tarball.**
To install, copy this file and its ``.venv/`` to::

    ~/.pi/agent/pi-lean-portal/user-backends/camoufox-py/bridge.py

Then create a virtual environment, install dependencies, fetch the binary,
and add the plugin entry to your ``settings.json``.

Camoufox lifecycle
-------------------
``camoufox.NewBrowser(playwright, ...)`` accepts an existing Playwright
instance — so the base class's ``_ensure_playwright()`` calls
``sync_playwright().start()`` to get ``self._pw``, and then
``_launch_browser()`` hands that to ``camoufox.NewBrowser``.  The base
owns the Playwright handle; Camoufox owns the patched browser.

The base's quirks dispatch handles ``do_scroll`` (``mouse.wheel``) and
``do_evaluate`` (``mw:`` prefix).  We only need to override
``_launch_browser`` to pass Camoufox-specific options.

Context creation uses the standard ``browser.new_context()`` — the
fingerprint is injected at browser launch via ``NewBrowser``, not at
context creation.  ``camoufox.NewContext`` exists on
``cloverlabs-camoufox>=0.6.0`` but is **broken** on the current binary
(v135.0.1-beta.24) — it crashes with ``Protocol error
(Browser.setDefaultViewport)`` due to the same ``isMobile`` rejection
that ``_skip_default_viewport`` handles.  The fingerprint is already
active by the time contexts are created, so standard
``browser.new_context()`` with ``_fingerprint_managed_context = True``
works correctly.  ``NewContext`` is a dead end on this binary.

Playwright driver patching
---------------------------
The Camoufox patched Firefox binary emits Juggler ``Page.uncaughtError``
events where the ``location`` field is **missing**.  Playwright's Node
driver (``coreBundle.js``) reads ``pageError.location.url`` without a
guard and crashes the entire browser session when the page fires an
uncaught JS error (e.g. on challenge pages like new Reddit).

This bridge auto-patches the Playwright driver at launch via
``pi_browser_bridge.patch_playwright`` — idempotent, loud, and
fail-fast.  On read-only filesystems, fall back to the manual command::

    python -m pi_browser_bridge.patch_playwright

Back navigation
----------------
Camoufox ships with ``browser.sessionhistory.max_entries = 0`` as a
stealth default (``camoufox.cfg`` line 308), which disables the browser
back stack.  ``page.go_back()`` then returns instantly as a silent no-op.

Passing ``enable_cache=True`` (the bridge's default) restores session
history via ``CACHE_PREFS`` and the base class ``do_go_back()`` works
correctly.  Users who want strict no-trace stealth can override via
``enableCache: false`` in their ``settings.json`` — they must accept
that ``/web back`` then becomes a dead-end.

Quirks rationale
-----------------
``_fingerprint_managed_context = True``
    The base's ``create_browser_context()`` unconditionally sets
    ``viewport: {1280, 720}`` and ``user_agent: effective_user_agent``.
    Camoufox generates viewport, UA, screen, dpr from the fingerprint
    (at browser launch via ``NewBrowser``).  Without this flag, the
    base's hard-coded values would override the fingerprint — producing
    a detectable mismatch.

``fingerprint at browser launch, not context creation``
    Camoufox v135.x injects the fingerprint at **browser launch** via
    ``camoufox.NewBrowser(playwright, ...)`` — the launch-time ``env`` vars
    and ``firefox_user_prefs`` patch the Juggler driver to spoof navigator/
    screen/WebGL/canvas/audio/fonts.  ``camoufox.NewContext`` exists on
    ``cloverlabs-camoufox>=0.6.0`` but crashes on this binary.
    Individual context creation uses the standard
    ``browser.new_context(**kwargs)`` with ``_fingerprint_managed_context = True``
    to avoid clobbering viewport/UA with hard-coded Playwright defaults.

``_eval_prefix = "mw:"``
    By default Camoufox runs ``page.evaluate`` scripts in an isolated
    world with **read-only** access; writes silently no-op.  Launching
    with ``main_world_eval=True`` (the default) + prefixing every expression
    with ``"mw:"`` routes the script to the main world where writes work.
    Reads work with ``mw:`` too, so it's safe to apply unconditionally.

``_scroll_via_wheel = True``
    The base's ``do_scroll`` uses
    ``page.evaluate("(d) => window.scrollBy(...)")`` — an eval-write that
    silently no-ops under Camoufox's isolated world.  Using
    ``page.mouse.wheel`` performs the scroll via input events instead.

``_skip_networkidle = True``
    The patched Camoufox Firefox binary does not fire ``networkidle``
    reliably.  Waiting for it in ``do_go_back`` / ``_wait_for_page_ready``
    either times out or loiters in the Playwright sync greenlet long
    enough to risk deadlocking the Juggler driver.  This flag makes
    navigation settle use ``load`` instead of ``networkidle``, matching
    ``do_navigate``'s load-based settle.

``_skip_default_viewport = True``
    The Camoufox patched Firefox binary does not accept the ``isMobile``
    property that Playwright Firefox includes in the
    ``Browser.setDefaultViewport`` CDP call.  Without this flag,
    ``browser.new_context()`` fails with a ``Protocol error`` on context
    creation.  Skipping the default-viewport call entirely avoids the
    mismatch; the Camoufox binary's built-in viewport defaults are
    coherent with the fingerprint injected at browser launch.

``_wrap_mw_eval_in_eval = True``
    Camoufox's patched Juggler main-world eval path
    (``MainWorldContext.executeInGlobal`` in the binary's ``omni.ja``)
    wraps every ``mw:``-prefixed script as
    ``(() => { let _s = (${script}); ... })()``.  That wrapper requires
    ``${script}`` to be a single *expression*; any *statement* — ``let`` /
    ``var`` / multiple ``;``-separated statements, which is exactly the
    shape of the MiniWoB setup scripts (``REMOVE_DISPLAY_JS``,
    ``SETUP_JS``) — is a ``SyntaxError`` (``missing ) in parenthetical``)
    that surfaces through Playwright as ``"Execution context was
    destroyed, most likely because of a navigation."``.  That error is
    NOT a navigation race (the previous ``_retry_eval_on_context_destroyed``
    quirk retried it and could never succeed — a SyntaxError is
    deterministic).  This flag makes ``do_evaluate`` rewrite the script as
    ``mw:eval(<JSON-string of script>)``: a single expression (valid
    inside ``let _s = (...)``) where ``eval`` runs the script verbatim and
    returns its completion value, handling both expressions and
    multi-statement scripts.  When a future Camoufox driver release fixes
    the wrapper, flip this flag back to ``False``.

Requires
--------
* Python >= 3.10
* ``cloverlabs-camoufox[geoip]`` installed (``pip install cloverlabs-camoufox[geoip]``)
* Fetched Camoufox binary (``python -m camoufox fetch``)
* Optional: ``xvfb`` system package on Linux for ``headless='virtual'``
* ``headless=True`` (true headless) works without xvfb
"""

import json
import sys

# Lazy-patch Playwright's coreBundle.js if needed. The patcher is idempotent
# and guarded: it only runs once per file (marker comment), warns on pattern
# miss, and raises on read-only filesystems with a manual fallback command.
try:
    from pi_browser_bridge.patch_playwright import patch_playwright

    # Auto-patch at module import time (before any navigate), so the driver
    # is fixed before any pageerror can crash it.  Loud = one-time stderr
    # notice on first patch.  fail_on_readonly=True means we raise early
    # with a clear instruction if the filesystem is read-only.
    patch_playwright(loud=True, fail_on_readonly=True)
except ImportError:
    # The patcher module lives in the portal's python-base lib; if it's not
    # importable (e.g. PYTHONPATH not set, or the user is running from a
    # standalone venv without the pi_browser_bridge package), silently
    # continue.  The crash will manifest when a JS page fires uncaught
    # errors, and the user can manually patch via:
    #   python -m pi_browser_bridge.patch_playwright
    pass

from pi_browser_bridge.playwright_base import PlaywrightBridge


class CamoufoxPyBridge(PlaywrightBridge):
    """Stealth bridge using Camoufox (Firefox-based).

    The base's quirks dispatch handles eval-world routing (``mw:`` prefix)
    and wheel-based scrolling (``_scroll_via_wheel``).  This subclass sets
    the quirk flags and overrides ``_launch_browser`` to call
    ``camoufox.NewBrowser`` with the plugin config's launch options.

    Fingerprint injection happens at **browser launch** via Camoufox's
    patched binary and its ``env`` / ``firefox_user_prefs`` — not at
    context creation.  ``camoufox.NewContext`` exists on
    ``cloverlabs-camoufox>=0.6.0`` but is broken on this binary (same
    ``isMobile`` rejection), so context creation uses the standard
    ``browser.new_context()``.
    ``_fingerprint_managed_context = True`` prevents the base from
    clobbering viewport/UA.

    Back navigation (``/web back``) works via the base class
    ``do_go_back()`` thanks to the ``enable_cache=True`` default, which
    restores the session history that Camoufox disables by default.
    """

    _plugin_name: str = "camoufox-py"
    _fingerprint_managed_context: bool = True
    # Camoufox injects the fingerprint at **browser launch** via
    # ``camoufox.NewBrowser`` — not at context creation.
    # ``camoufox.NewContext`` exists on ``cloverlabs-camoufox>=0.6.0`` but
    # crashes on this binary (same ``isMobile`` rejection).  Keep using
    # the standard ``browser.new_context()``.
    _eval_prefix: str = "mw:"
    _scroll_via_wheel: bool = True
    # The Camoufox patched Firefox binary rejects the ``isMobile`` property that
    # Playwright includes in ``Browser.setDefaultViewport``.  Skip the call.
    _skip_default_viewport: bool = True
    # The patched Camoufox Firefox binary doesn't fire `networkidle` reliably;
    # waiting for it in `do_go_back` / `_wait_for_page_ready` either times out
    # or loiters in the Playwright sync greenlet long enough to risk deadlocking
    # the Juggler driver.  Match `do_navigate`'s load-based settle instead.
    _skip_networkidle: bool = True
    # The patched Camoufox Juggler main-world eval path wraps every `mw:`
    # script as `let _s = (${script})`, which is a SyntaxError for any
    # statement (let/var/multi-statement).  Rewrite the script as
    # `mw:eval(<json>)` so it is a single expression that `eval` runs
    # verbatim.  See the `_wrap_mw_eval_in_eval` quirk docstring.
    _wrap_mw_eval_in_eval: bool = True
    _install_hint: str = (
        "Camoufox browser not installed.\n"
        "Run the following commands in your camoufox-py virtual environment:\n"
        "  pip install cloverlabs-camoufox[geoip]\n"
        "  python -m camoufox fetch"
    )

    def _launch_browser(self):  # type: ignore[override]
        """Launch Camoufox via ``camoufox.NewBrowser``.

        Reads launch options from the plugin config forwarded by
        ``browser.init``.  Applies sensible agent-friendly defaults
        that produce a stable, human-looking persona (all overridable
        via ``launch.*`` in ``settings.json``):

        * ``os="windows"`` — stable persona; real humans don't switch
          OS between sessions.
        * ``geoip=True`` — match timezone / locale / geolocation to
          the egress IP, avoiding the ``UTC`` bot tell.
        * ``humanize=True`` — bezier-curved mouse motion (the "looks
          human" knob; ~1.5s/click).
        * ``enable_cache=True`` — restore session history (disabled by
          Camoufox's stealth defaults), fixing ``/web back``.
        * ``main_world_eval=True`` (always) — required for the ``mw:``
          prefix to route ``page.evaluate`` writes to the main world.

        Returns a standard Playwright ``Browser`` patched by Camoufox.
        """
        # Lazy-import so non-Camoufox bridges don't pay the import cost
        # and to give a clear error when the package is missing.
        try:
            import camoufox  # type: ignore[import-unresolved]
        except ImportError as exc:
            raise RuntimeError(self._install_hint) from exc

        launch = self.plugin_config.get("launch", {}) or {}

        # Build Camoufox NewBrowser kwargs from the plugin config.
        # Map camelCase TypeScript keys to snake_case Python kwargs.
        # Apply sensible defaults for a human-looking agent.
        kwargs: dict[str, object] = {
            # Default to true headless — works without xvfb on Linux servers.
            # Users can override with false (headed debugging) or 'virtual'
            # (xvfb-based high-coherence fingerprint).
            "headless": launch.get("headless", True),
            # Stable OS persona — a real human doesn't switch between
            # Windows/Mac/Linux every session.
            "os": launch.get("os", "windows"),
            # Match timezone/locale/geolocation to the egress IP.
            # Replaces the hardcoded UTC/en-US/no-geo with real values.
            "geoip": launch.get("geoip", True),
            # Bezier mouse motion (the "looks human" knob).
            "humanize": launch.get("humanize", True),
            # Restore session history disabled by Camoufox's stealth
            # defaults.  Without this, /web back silently no-ops.
            "enable_cache": launch.get("enableCache", True),
        }

        _KEY_MAP: dict[str, str] = {
            # Keys WITHOUT defaults above — pass-through only when present.
            # (headless, os, geoip, humanize, enableCache are already handled
            # by the defaults dict above via launch.get(..., default).)
            "fingerprintPreset": "fingerprint_preset",
            "executablePath": "executable_path",
            "proxy": "proxy",
        }
        for ts_key, py_key in _KEY_MAP.items():
            if ts_key in launch:
                kwargs[py_key] = launch[ts_key]

        # main_world_eval must be True so the mw: prefix works
        kwargs["main_world_eval"] = launch.get("mainWorldEval", True)

        return camoufox.NewBrowser(self._pw, **kwargs)

    # NOTE: do_go_back is intentionally NOT overridden.
    #
    # Back navigation relies on the base class ``do_go_back()``, which
    # calls ``page.go_back(wait_until="load", timeout=15_000)`` (thanks
    # to ``_skip_networkidle=True``).  This works correctly when the
    # ``enable_cache=True`` default is in effect, because it restores
    # Camoufox's ``browser.sessionhistory.max_entries`` from 0 to 10.
    #
    # There is no need for a ``document.referrer`` workaround — some
    # patched Firefox binaries have a binary-level back-navigation bug
    # that requires that workaround; Camoufox does not, with
    # ``enable_cache=True``.
    #
    # Testing: with ``enable_cache=True``, back navigation completes
    # in ~0.04s and correctly returns the previous page URL/title/body.
    # Without ``enable_cache``, ``page.go_back()`` returns in 0.00s
    # as a silent no-op (URL unchanged).  Users who explicitly set
    # ``enableCache: false`` must accept this limitation.


# ═══════════════════════════════════════════════════════════════════════
#  Entry point
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    # Print a JSON-RPC error and exit immediately if camoufox is missing,
    # so the TypeScript PythonPluginAdapter gets a parseable error.
    try:
        import camoufox  # type: ignore[import-unresolved] # noqa: F401
    except ImportError:
        print(
            json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32000,
                    "message": (
                        "cloverlabs-camoufox is not installed.\n"
                        "Run: pip install cloverlabs-camoufox[geoip] && "
                        "python -m camoufox fetch"
                    ),
                },
            })
        )
        sys.stdout.flush()
        sys.exit(1)

    bridge = CamoufoxPyBridge()
    bridge.run()
