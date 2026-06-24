#!/usr/bin/env python3
"""
Chromium-Py Bridge — Python-side parity reference for stealth backends.

Thin subclass of :class:`PlaywrightBridge` that drives Chromium via
Playwright Python. All shared logic lives in
:mod:`pi_browser_bridge.playwright_base`.

Usage
-----
Run the bridge from the command line — it reads JSON-RPC 2.0 requests
from stdin and writes responses to stdout::

    python backends/chromium-py/bridge.py

The ``PythonPluginAdapter`` (TypeScript) spawns this process and
communicates via stdin/stdout.

Requires
--------
* Python >= 3.10
* ``playwright`` >= 1.50  (``pip install playwright``)
* Playwright Chromium browsers installed (``playwright install chromium``)
"""

import sys

from pi_browser_bridge.playwright_base import PlaywrightBridge, check_playwright_or_exit


class ChromiumPyBridge(PlaywrightBridge):
    """Concrete bridge that drives Chromium via Playwright Python.

    Thin subclass — engine-specific settings only.
    """

    _plugin_name: str = "chromium-py"
    _user_agent: str = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
    _install_hint: str = (
        "Chromium browser not installed. "
        "Run: playwright install chromium (inside backends/python-base/.venv)"
    )

    def _launch_browser(self):
        """Launch a Chromium browser instance."""
        return self._pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        )


# ═══════════════════════════════════════════════════════════════════════
#  Entry point
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    check_playwright_or_exit("chromium")
    bridge = ChromiumPyBridge()
    bridge.run()
