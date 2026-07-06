#!/usr/bin/env python3
"""
Firefox-Py Bridge — Python-side parity reference for Firefox-based stealth backends.

Thin subclass of :class:`PlaywrightBridge` that drives Firefox via
Playwright Python. All shared logic lives in
:mod:`pi_browser_bridge.playwright_base`.

Disabled by default — users enable explicitly via ``settings.json``
when parity-testing against the Node ``firefox`` backend.

Usage
-----
Run the bridge from the command line — it reads JSON-RPC 2.0 requests
from stdin and writes responses to stdout::

    python backends/firefox-py/bridge.py

The ``PythonPluginAdapter`` (TypeScript) spawns this process and
communicates via stdin/stdout.

Requires
--------
* Python >= 3.10
* ``playwright`` >= 1.50  (``pip install playwright``)
* Playwright Firefox browsers installed (``playwright install firefox``)
"""

import os
import sys

from pi_browser_bridge.playwright_base import PlaywrightBridge, check_playwright_or_exit


class FirefoxPyBridge(PlaywrightBridge):
    """Concrete bridge that drives Firefox via Playwright Python.

    Thin subclass — engine-specific settings only.
    """

    _plugin_name: str = "firefox-py"
    _user_agent: str = (
        "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0"
    )
    _capture_user_agent: bool = True
    _install_hint: str = (
        "Firefox browser not installed. "
        "Run: playwright install firefox (inside backends/python-base/.venv)"
    )

    def _launch_browser(self):
        """Launch a Firefox browser instance.

        When ``PI_BROWSER_USE_LAUNCH_SERVER=1`` is set (bench mode),
        uses ``firefox.launch_server()`` + ``firefox.connect(wsEndpoint)``
        so an external client can attach via the WebSocket endpoint.

        Normal portal usage (env var absent): plain ``firefox.launch()``
        — unchanged from the shipped firefox-py path.
        """
        if os.environ.get("PI_BROWSER_USE_LAUNCH_SERVER") == "1":
            self._browser_server = self._pw.firefox.launch_server(
                headless=True,
            )
            ws_endpoint = self._browser_server.ws_endpoint
            self._log("launchServer", wsEndpoint=ws_endpoint)
            return self._pw.firefox.connect(ws_endpoint)
        return self._pw.firefox.launch(
            headless=True,
        )


# ═══════════════════════════════════════════════════════════════════════
#  Entry point
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    check_playwright_or_exit("firefox")
    bridge = FirefoxPyBridge()
    bridge.run()
