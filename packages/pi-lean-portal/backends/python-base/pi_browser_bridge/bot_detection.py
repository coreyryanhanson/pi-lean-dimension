"""
Bot detection for the Python bridge.

Mirrors the logic in ``core/shared/bot-detection.ts`` ``checkPage()``.

The matching *must* run in the Python process because it needs
``page.title()`` and ``page.evaluate()`` for body/HTML — shipping the
full HTML across JSON-RPC would be prohibitively expensive.  However,
the signal lists are pure data and live here as a single source of
truth for all Python-based browser backends.
"""

import re
from typing import Any

#: Block-level signals — checked against BOTH title and body text.
#: Mirror of TypeScript bot-detection.ts BLOCK_SIGNALS.
#: Only specific challenge phrases are included — generic single words
#: like "captcha", "cloudflare", "recaptcha" are excluded because they
#: cause false positives on legitimate pages mentioning them in passing.
_BLOCK_SIGNALS: tuple[str, ...] = (
    "please verify you are human",
    "attention required!",
    "just a moment...",
    "checking your browser",
    "you have been blocked",
    "sorry, you have been blocked",
    "verify you are human",
    "your request has been blocked",
    "we are checking your browser",
    "cf-challenge",
    "_cf_chl_opt",
    "cdn-cgi/challenge",
)

#: Body-only string signals — high-specificity CDN patterns.
#: Mirror of TypeScript bot-detection.ts BODY_ONLY_SIGNALS.
_BODY_ONLY_SIGNALS: tuple[str, ...] = (
    "errors.edgesuite.net",
    "you don't have permission to access",
)

#: Body-only regex patterns — checked against raw body text.
#: Mirror of TypeScript bot-detection.ts BODY_ONLY_PATTERNS.
_BODY_ONLY_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"reference\s*#[a-f0-9]+(?:\.[a-f0-9]+)+", re.IGNORECASE),
)

#: HTML-level CAPTCHA/widget signals (Python-only enhancement).
_HTML_SIGNALS: tuple[str, ...] = (
    "recaptcha",
    "hcaptcha",
    "turnstile",
    "g-recaptcha",
    "data-sitekey",
)


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
