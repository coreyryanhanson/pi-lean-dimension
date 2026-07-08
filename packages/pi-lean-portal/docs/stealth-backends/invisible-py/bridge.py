#!/usr/bin/env python3
"""
Invisible-Py Bridge — Python-side stealth backend using invisible_playwright.

**This is a user-installed backend — it does NOT ship in the npm tarball.**
To install, copy this file and its ``.venv/`` to::

    ~/.pi/agent/pi-lean-portal/user-backends/invisible-py/bridge.py

Then create a virtual environment, install dependencies, fetch the binary,
and add the plugin entry to your ``settings.json``.

invisible_playwright lifecycle
-------------------------------
Unlike the shipped Chromium-Py / Firefox-Py bridges (which let the base
class own the ``sync_playwright()`` handle), ``InvisiblePlaywright``
starts its own Playwright instance inside ``__enter__()`` and owns it.
To avoid spawning two Playwright instances (the base's
``_ensure_playwright()`` would call ``sync_playwright().start()`` as
well), this bridge overrides ``_ensure_playwright`` and
``_maybe_stop_playwright`` to delegate to the ``InvisiblePlaywright``
context manager.

For the same reason, ``_launch_browser()`` is NOT overridden — the
base's ``_launch_browser`` is never called because ``_ensure_playwright``
completely replaces the launch path.

Quirks rationale
-----------------
``_fingerprint_managed_context = True``
    The base's ``create_browser_context()`` unconditionally sets
    ``viewport: {1280, 720}`` and ``user_agent: effective_user_agent``.
    invisible_playwright's patched ``new_context`` generates viewport,
    user_agent, screen, dpr from the fingerprint with "user wins"
    semantics.  Without this flag, the base's hard-coded values would
    override the fingerprint — producing a detectable mismatch.

Requires
--------
* Python >= 3.10
* ``invisible-playwright`` installed (``pip install invisible-playwright``)
* Fetched Firefox binary (``python -m invisible_playwright fetch``)
* ``xvfb`` system package on Linux for ``headless=True``
"""

import json
import re
import sys
import time
from typing import Any

from pi_browser_bridge.playwright_base import PlaywrightBridge
from pi_browser_bridge.bridge import SessionNotFoundError


class InvisiblePyBridge(PlaywrightBridge):
    """Stealth bridge using invisible_playwright (Firefox-based).

    Overrides ``_ensure_playwright`` and ``_maybe_stop_playwright`` to
    delegate to an ``InvisiblePlaywright`` context manager, which owns
    its own Playwright instance and patches ``browser.new_context`` for
    fingerprint coherence.
    """

    _plugin_name: str = "invisible-py"
    _fingerprint_managed_context: bool = True
    # The patched FF150 binary doesn't fire `networkidle` reliably; waiting for
    # it in `do_go_back` / `_wait_for_page_ready` either times out (30s) or
    # loiters in the Playwright sync greenlet long enough to deadlock the
    # Juggler driver when a subsequent BrowserContext's `new_page()` is
    # created.  Match `do_navigate`'s load-based settle instead.
    _skip_networkidle: bool = True
    # NOTE: UA capture is intentionally DISABLED for invisible-py.
    # `_capture_ua()` probes the UA via a throwaway `self._browser.new_page()`,
    # which creates an implicit BrowserContext that is never closed. On the
    # patched FF150 binary, that leftover context reliably deadlocks the
    # Juggler driver when a subsequent (second) BrowserContext's `new_page()`
    # is created — the second `browser.navigate` for a different task hangs
    # forever inside the Playwright sync greenlet.
    # It is also pointless here: with `_fingerprint_managed_context = True`,
    # `create_browser_context()` does NOT pass `user_agent` to `new_context`
    # (the fingerprint package sets it), so `effective_user_agent` is never
    # read. The base's `_user_agent` fallback is similarly unused.
    _capture_user_agent: bool = False
    _install_hint: str = (
        "invisible-playwright browser not installed.\n"
        "Run the following commands in your invisible-py virtual environment:\n"
        "  pip install invisible-playwright\n"
        "  python -m invisible_playwright fetch\n"
        "On Linux, also install xvfb:\n"
        "  apt-get install xvfb"
    )

    #: The ``InvisiblePlaywright`` context manager instance, held for the
    #: bridge's lifetime.  ``None`` before the first call to
    #: ``_ensure_playwright()``.
    _stealth_ctx = None

    def _ensure_playwright(self):  # type: ignore[override]
        """Override base lifecycle to delegate to InvisiblePlaywright.

        Instead of calling ``sync_playwright().start()`` +
        ``_launch_browser()``, we instantiate ``InvisiblePlaywright`` from
        the plugin config and enter the context manager, which returns a
        patched Playwright Browser.  The Playwright handle is read from
        ``self._stealth_ctx._pw``.

        Returns:
            ``(pw, browser)`` — the Playwright instance and Browser.
        """
        if self._pw is None:
            # Lazy import invisible_playwright — gives better error messages
            # and avoids import cost when this bridge is disabled.
            try:
                from invisible_playwright import InvisiblePlaywright  # type: ignore[import-unresolved]
            except ImportError as exc:
                raise RuntimeError(self._install_hint) from exc

            # Read launch options from browser.init plugin config
            launch = self.plugin_config.get("launch", {}) or {}

            # Map camelCase keys from TypeScript settings to snake_case
            # Python kwargs.  Only forward keys that
            # invisible_playwright.InvisiblePlaywright accepts.
            kwargs: dict[str, object] = {
                # Default to headless=True for server agents (no X display needed).
                # invisible_playwright's ``headless=True`` uses Xvfb to hide the
                # window while keeping the real rendering pipeline (coherent
                # fingerprint).  Users can override via ``headless=False`` for
                # local headed debugging or ``headless='virtual'`` for the
                # PyVirtualDisplay-based approach.
                "headless": launch.get("headless", True),
            }
            _KEY_MAP: dict[str, str] = {
                "seed": "seed",
                "proxy": "proxy",
                "humanize": "humanize",
                "locale": "locale",
                "timezone": "timezone",
                "extraPrefs": "extra_prefs",
                "binaryPath": "binary_path",
                "prepRecaptcha": "prep_recaptcha",
                "pin": "pin",
            }
            for ts_key, py_key in _KEY_MAP.items():
                if ts_key in launch:
                    kwargs[py_key] = launch[ts_key]

            self._stealth_ctx = InvisiblePlaywright(**kwargs)
            try:
                # __enter__() returns a Browser (not a BrowserContext when
                # profile_dir is omitted — which is what we want).
                self._browser = self._stealth_ctx.__enter__()
            except Exception as _exc:
                if re.search(
                    r"Executable doesn't exist|browserType\.launch",
                    str(_exc),
                    re.IGNORECASE,
                ):
                    raise RuntimeError(self._install_hint) from _exc
                raise

            # Read the Playwright handle from the InvisiblePlaywright instance.
            # InvisiblePlaywright owns sync_playwright(); the Browser it
            # returns does not expose _pw.
            self._pw = self._stealth_ctx._pw

        # Probe UA at first launch
        if self._capture_user_agent:
            self._capture_ua()
        return self._pw, self._browser

    def _maybe_stop_playwright(self) -> None:
        """Stop the InvisiblePlaywright when no sessions remain.

        Calls ``self._stealth_ctx.__exit__(None, None, None)`` instead of
        ``self._pw.stop()`` so the context manager properly cleans up its
        own Playwright instance and the patched Firefox binary.
        """
        if not self.sessions and self._stealth_ctx is not None:
            try:
                if self._browser:
                    self._browser.close()
            except Exception:
                pass
            try:
                self._stealth_ctx.__exit__(None, None, None)
            except Exception:
                pass
            self._pw = None
            self._browser = None
            self._stealth_ctx = None

    def do_go_back(self, task_id: str) -> dict[str, Any]:
        """Navigate back — workaround for the patched FF150 binary's broken
        history navigation.

        The invisible_playwright patched Firefox (FF150) does not support
        back/forward navigation: ``page.go_back()`` times out for every
        ``wait_until`` value (``networkidle`` / ``load`` /
        ``domcontentloaded`` / ``commit`` / default) and the URL never
        changes. ``history.back()`` via ``page.evaluate`` likewise no-ops.
        Standard Playwright Firefox (the ``firefox-py`` backend) works in
        0.01s — so this is a patched-binary limitation, not a Playwright or
        bridge bug. Root cause is the binary's ``disallowBFCache`` stealth
        attribute combined with Fission and the about:newtab race.

        Workaround: re-navigate to ``document.referrer`` via ``page.goto``.
        This covers the dominant agent pattern (click a link → wrong way →
        go back), where ``document.referrer`` is populated. It's a re-fetch
        rather than a true history back, but the patched binary has bfcache
        disabled anyway, so a true history back would re-render from scratch
        too — functionally identical.

        Falls through to the base ``do_go_back`` when ``document.referrer``
        is empty (direct navigations, ``rel=noreferrer`` links, POST
        submissions, multi-step back). The base will time out on the patched
        binary and return ``success=False`` — no worse than the current
        state, and those cases are rare in agent browsing.
        """
        _t_start = time.time()
        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            self._log("goBack", taskId=task_id, success=False,
                      time=round((time.time() - _t_start) * 1000))
            return {"success": False, "error": f"GoBack failed: {exc}"}

        # Try the referrer workaround first.
        referrer: str = ""
        try:
            referrer = page.evaluate("() => document.referrer") or ""
        except Exception:
            referrer = ""

        if not referrer:
            # No referrer → return an immediate error instead of timing out
            # via ``super().do_go_back()`` (which calls ``page.go_back()`` —
            # broken on this patched FF150 binary, always times out).
            self._log("goBack", taskId=task_id, success=False,
                      reason="no referrer (fallback not supported on this binary)",
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": (
                    "GoBack not supported for direct/noreferrer navigations "
                    "on invisible-py (patched FF150 binary history navigation "
                    "is non-functional)"
                ),
            }

        try:
            page.goto(referrer, wait_until="load", timeout=15_000)

            new_url: str = page.url
            new_title: str = page.title()
            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )
            self._log("goBack", taskId=task_id, success=True,
                      elementCount=element_count, via="referrer",
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "dialogEvents": self._get_dialog_events(task_id),
                "newUrl": new_url,
                "newTitle": new_title,
            }
        except Exception as exc:
            self._log("goBack", taskId=task_id, success=False, via="referrer",
                      time=round((time.time() - _t_start) * 1000))
            return {"success": False, "error": f"GoBack failed: {exc}"}


# ═══════════════════════════════════════════════════════════════════════
#  Entry point
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    # invisible_playwright bundles its own Playwright, so we check for
    # invisible_playwright itself rather than the standard playwright
    # package.  Print a JSON-RPC error and exit immediately so the
    # TypeScript PythonPluginAdapter gets a parseable error.
    try:
        import invisible_playwright  # type: ignore[import-unresolved] # noqa: F401
    except ImportError:
        print(
            json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32000,
                    "message": (
                        "invisible-playwright is not installed.\n"
                        "Run: pip install invisible-playwright && "
                        "python -m invisible_playwright fetch"
                    ),
                },
            })
        )
        sys.stdout.flush()
        sys.exit(1)

    bridge = InvisiblePyBridge()
    bridge.run()
