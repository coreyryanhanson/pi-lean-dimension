"""
pi_browser_bridge — Shared Python bridge library for pi-browser.

Provides the infrastructure needed to build Python browser automation
backends that communicate with the TypeScript ``PythonPluginAdapter``
via JSON-RPC 2.0 over stdin/stdout.

Key components
--------------
* :class:`BrowserBridge` — base class; subclass and override
  ``create_browser_session()`` and operation methods.
* :mod:`.transport` — JSON-RPC 2.0 transport over stdin/stdout.
* :mod:`.accessibility` — Playwright accessibility snapshot parser,
  mirroring the TypeScript version.

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
from .accessibility import (
    AriaCachedNode,
    AriaParseResult,
    parse_snapshot,
    build_locator_args,
    INTERACTIVE_ROLES,
    INFORMATIONAL_ROLES,
)

__all__ = [
    "BrowserBridge",
    "SessionNotFoundError",
    "InvalidParamsError",
    "AriaCachedNode",
    "AriaParseResult",
    "parse_snapshot",
    "build_locator_args",
    "INTERACTIVE_ROLES",
    "INFORMATIONAL_ROLES",
]
