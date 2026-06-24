"""
pi_browser_bridge — Shared Python bridge library for pi-lean-portal.

Provides the infrastructure needed to build Python browser automation
backends that communicate with the TypeScript ``PythonPluginAdapter``
via JSON-RPC 2.0 over stdin/stdout.

Key components
--------------
* :class:`BrowserBridge` — base class; subclass and override
  ``create_browser_session()`` and operation methods.
* :class:`PlaywrightBridge` — Playwright-specific base extracted from
  the Chromium reference; parameterizes engine, UA, and launch args.
* :mod:`.transport` — JSON-RPC 2.0 transport over stdin/stdout.
* :mod:`.accessibility` — Playwright accessibility snapshot parser,
  mirroring the TypeScript version.
* :mod:`.bot_detection` — anti-automation / bot detection signal
  matcher, mirroring the TypeScript version.

Shipped bridges
---------------
* ``backends/chromium-py/bridge.py`` — ``ChromiumPyBridge``, a thin
  subclass of :class:`PlaywrightBridge` driving Chromium.  Ships as the
  parity reference for Python Chromium-based stealth backends.
* ``backends/firefox-py/bridge.py`` — ``FirefoxPyBridge``, a thin
  subclass driving Firefox.  Ships as the parity reference for Python
  Firefox-based stealth backends.

Quick start
-----------
::

    from pi_browser_bridge import BrowserBridge

    class MyBridge(BrowserBridge):
        def create_browser_session(self, task_id, config):
            # launch browser, return session dict
            ...
        def do_navigate(self, task_id, url, timeout_ms):
            # navigate, return result dict
            ...

    if __name__ == "__main__":
        MyBridge().run()
"""

from .bridge import BrowserBridge, SessionNotFoundError, InvalidParamsError
from .playwright_base import PlaywrightBridge
from .accessibility import (
    AriaCachedNode,
    AriaParseResult,
    parse_snapshot,
    build_locator_args,
    INTERACTIVE_ROLES,
    INFORMATIONAL_ROLES,
)
from .bot_detection import check_bot_detection

__all__ = [
    "BrowserBridge",
    "PlaywrightBridge",
    "SessionNotFoundError",
    "InvalidParamsError",
    "AriaCachedNode",
    "AriaParseResult",
    "parse_snapshot",
    "build_locator_args",
    "INTERACTIVE_ROLES",
    "INFORMATIONAL_ROLES",
    "check_bot_detection",
]
