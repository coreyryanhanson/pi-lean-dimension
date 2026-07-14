"""
Bot detection for the Python bridge.

Mirrors the logic in ``core/shared/bot-detection.ts`` ``checkPage()``.

The matching *must* run in the Python process because it needs
``page.title()`` and ``page.evaluate()`` for body/HTML — shipping the
full HTML across JSON-RPC would be prohibitively expensive.  However,
the signal lists are pure data and are loaded from the shared
``browser-data.json`` file — the same file used by the TypeScript side
so the two implementations never drift.
"""

import re
from typing import Any

from .browser_data import BOT_SIGNALS

#: Block-level signals — checked against BOTH title and body text.
_BLOCK_SIGNALS: tuple[str, ...] = tuple(BOT_SIGNALS["blockSignals"])

#: Body-only string signals — high-specificity CDN patterns.
_BODY_ONLY_SIGNALS: tuple[str, ...] = tuple(BOT_SIGNALS["bodyOnlySignals"])

#: Body-only regex patterns — compiled from shared source strings.
_BODY_ONLY_PATTERNS: tuple[re.Pattern, ...] = tuple(
    re.compile(p, re.IGNORECASE) for p in BOT_SIGNALS["bodyOnlyPatterns"]
)

#: HTML-level CAPTCHA/widget signals.
_HTML_SIGNALS: tuple[str, ...] = tuple(BOT_SIGNALS["htmlSignals"])


def check_bot_detection(page: Any) -> bool:
    """Check for anti-automation / bot detection signals in the current page.

    Mirrors the logic in ``bot-detection.ts`` ``checkPage()``.

    Args:
        page: A Playwright sync Page object (or a mock with ``title()``
              and ``evaluate()`` methods).

    Returns:
        True if bot detection signals were found.
    """
    try:
        title: str = page.title().lower()
    except Exception:
        title = ""

    try:
        body_text: str = page.evaluate(
            "() => document.body?.innerText || ''"
        ) or ""
        body_text = body_text.lower()
    except Exception:
        body_text = ""

    try:
        html: str = page.evaluate(
            "() => document.documentElement?.innerHTML || ''"
        ) or ""
        html = html.lower()
    except Exception:
        html = ""

    # ── Block signals: checked against both title and body ───────
    for signal in _BLOCK_SIGNALS:
        if signal in title or signal in body_text:
            return True

    # ── Body-only string signals ────────────────────────────────
    for signal in _BODY_ONLY_SIGNALS:
        if signal in body_text:
            return True

    # ── Body-only regex patterns ────────────────────────────────
    for pattern in _BODY_ONLY_PATTERNS:
        if pattern.search(body_text):
            return True

    # ── HTML-level signals (Python-only enhancement) ────────────
    for signal in _HTML_SIGNALS:
        if signal in html:
            return True

    return False


__all__ = ["check_bot_detection"]
