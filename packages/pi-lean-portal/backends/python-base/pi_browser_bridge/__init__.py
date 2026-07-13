"""
pi_browser_bridge — Shared Python bridge library for pi-lean-portal.
Provides BrowserBridge and PlaywrightBridge base classes for Python browser backends.
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
