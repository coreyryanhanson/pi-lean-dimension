"""
pi_browser_bridge — Shared Python bridge library for pi-lean-portal.
Provides PlaywrightBridge base class for Python browser backends.
"""

from .playwright_base import PlaywrightBridge, SessionNotFoundError, InvalidParamsError
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
