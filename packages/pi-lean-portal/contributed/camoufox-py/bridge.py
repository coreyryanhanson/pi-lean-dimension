#!/usr/bin/env python3
"""
Camoufox-Py Bridge — Python-side stealth backend using Camoufox.
User-installed backend for fingerprint-managed browsing via cloverlabs-camoufox.
"""

import json
import sys
from pathlib import Path

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
    and eval-based scrolling (``window.scrollBy``).  This subclass sets
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
    # Camoufox ``152.0.4-beta.27+`` no-ops ``page.mouse.wheel`` (the ``wheel``
    # listener never fires), so the base's eval-based ``window.scrollBy`` is
    # the only path that moves the page on the current binary.  Leave the
    # base default (``_scroll_via_wheel = False``).  The legacy
    # ``135.0.1-beta.24`` binary needed ``True`` (eval-write scrollBy
    # no-op'd under the isolated world); flipped off when the CI pin moved
    # to ``152.0.4-beta.28``.  See ``playwright_base._scroll_via_wheel``.
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
    # The patched Camoufox Juggler fires ``framenavigated`` events and
    # updates ``page.url`` with higher latency than a standard Playwright
    # browser.  Widen the settle poll budget so a ``setTimeout``-delayed
    # redirect (e.g. ``location.href`` after 280 ms) is still captured
    # under CI load.  URL stability mode confirms the URL has finished
    # changing before declaring "no navigation" — the 150 ms hold is
    # negligible against the wider budget.
    _settle_budget_ms: int = 2000
    _url_stability_settle: bool = True
    _install_hint: str = (
        "Camoufox browser not installed.\n"
        "Run the following commands in your camoufox-py virtual environment:\n"
        "  pip install cloverlabs-camoufox[geoip]\n"
        "  python -m camoufox fetch"
    )

    def _check_pinned_version(self) -> None:
        """Best-effort runtime check that the installed Camoufox stack matches pin.json.

        Reads ``pin.json`` (same directory as this module) and
        compares the pinned ``cloverlabs-camoufox`` package version
        against what's actually installed via pip metadata.
        Warns to stderr on any mismatch or if the check cannot be
        performed.  Never raises — this is advisory only.
        """
        try:
            pin_path = Path(__file__).parent / "pin.json"
            if not pin_path.exists():
                return
            pinned = json.loads(pin_path.read_text())
        except Exception:
            return

        expected_pkg = pinned.get("package", "")
        if expected_pkg:
            try:
                from importlib.metadata import version as _get_version

                installed = _get_version("cloverlabs-camoufox")
                expected_ver = expected_pkg.split("==")[-1].split("[")[0]
                if installed != expected_ver:
                    print(
                        "pi-bridge camoufox-py: pin.json pins "
                        f"cloverlabs-camoufox=={expected_ver} but "
                        f"{installed} is installed — browser binary "
                        "drift risk.",
                        file=sys.stderr,
                    )
            except Exception:
                pass  # package not installed or metadata unavailable

        expected_binary = pinned.get("binary", "")
        if expected_binary:
            try:
                import camoufox  # type: ignore[import-unresolved]
                _binary_version = None
                for _attr in (
                    "__binary_version__",
                    "_binary_version",
                    "binary_version",
                ):
                    _candidate = getattr(camoufox, _attr, None)
                    if _candidate is not None:
                        _binary_version = _candidate
                        break
                if _binary_version is None:
                    _sync = getattr(camoufox, "sync", None)
                    if _sync is not None:
                        for _attr in (
                            "__binary_version__",
                            "_binary_version",
                            "binary_version",
                        ):
                            _candidate = getattr(_sync, _attr, None)
                            if _candidate is not None:
                                _binary_version = _candidate
                                break
                if _binary_version is None:
                    return
                expected_ref = expected_binary.split("/")[-1]
                if _binary_version != expected_ref:
                    print(
                        "pi-bridge camoufox-py: pin.json expects binary "
                        f"{expected_ref} but {_binary_version} is "
                        "installed — binary drift risk.",
                        file=sys.stderr,
                    )
            except Exception:
                pass  # camoufox not importable yet — skip silently

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
        self._check_pinned_version()

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

        # Redirect third-party stdout to stderr during launch.
        # The camoufox package print()s to stdout (utils.py:154, addons.py:92,
        # etc.) with no file=stderr — polluting the JSON-RPC wire. Swap
        # sys.stdout → sys.stderr around the launch call so only
        # transport.write_response (which runs later, in the RPC loop,
        # with real stdout restored) ever writes to the real stdout.
        # ponytail: launch-window only. If post-launch pollution appears
        # (addon failures mid-session, inherited subprocess stdout), escalate
        # to a process-wide redirect with write_response holding its own
        # real_stdout ref captured at import.
        real_stdout = sys.stdout
        sys.stdout = sys.stderr
        try:
            return camoufox.NewBrowser(self._pw, **kwargs)
        finally:
            sys.stdout = real_stdout

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
            json.dumps(
                {
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
                }
            )
        )
        sys.stdout.flush()
        sys.exit(1)

    bridge = CamoufoxPyBridge()
    bridge.run()
