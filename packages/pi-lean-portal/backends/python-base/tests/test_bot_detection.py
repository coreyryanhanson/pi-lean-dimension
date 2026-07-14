"""
Tests for ``pi_browser_bridge.bot_detection``.

Pure-logic unit tests for ``check_bot_detection()`` that do NOT require
a Playwright browser to be installed.  Uses mock page objects.
"""

from typing import Any

from pi_browser_bridge import check_bot_detection


class _MockPage:
    """Simplified Playwright page mock that only supports title() and evaluate()."""

    def __init__(
        self,
        title: str = "",
        body_text: str = "",
        html: str = "",
    ):
        self._title = title
        self._body_text = body_text
        self._html = html

    def title(self) -> str:
        return self._title

    def evaluate(self, expression: str, *args: Any) -> str:
        # Simple expression recognition for the signals we test
        if "body?.innerText" in expression:
            return self._body_text
        if "documentElement?.innerHTML" in expression:
            return self._html
        return ""


class TestCheckBotDetection:
    """Tests for check_bot_detection() with mock pages."""

    def test_normal_page_not_detected(self):
        """A normal page with no bot signals returns False."""
        page = _MockPage(title="Example Domain", body_text="Welcome to Example")
        assert check_bot_detection(page) == False

    def test_cloudflare_in_title(self):
        """'cloudflare' in the title triggers bot detection."""
        page = _MockPage(title="Just a moment... | Cloudflare")
        assert check_bot_detection(page) == True

    def test_verify_human_in_title(self):
        """'verify you are human' in the title triggers bot detection."""
        page = _MockPage(title="Verify you are human")
        assert check_bot_detection(page) == True

    def test_captcha_in_title_not_detected(self):
        """'captcha' in the title does NOT trigger bot detection.

        Single-word signals like 'captcha' are deliberately excluded
        to avoid false positives on legitimate pages that mention
        CAPTCHAs in passing (e.g. Wikipedia, tech blogs).
        """
        page = _MockPage(title="CAPTCHA Challenge")
        assert check_bot_detection(page) == False

    def test_akamai_reference_in_body(self):
        """Akamai-style reference codes in body trigger bot detection."""
        page = _MockPage(
            title="Error",
            body_text="Access denied. Reference #18.abc.def",
        )
        assert check_bot_detection(page) == True

    def test_recaptcha_in_html(self):
        """'recaptcha' in HTML triggers bot detection."""
        page = _MockPage(
            title="Form",
            body_text="Submit the form",
            html='<div><script src="recaptcha/api.js"></script></div>',
        )
        assert check_bot_detection(page) == True

    def test_exception_during_title_safe(self):
        """If title() raises, bot detection still checks body and HTML."""

        class _BrokenPage:
            def title(self) -> str:
                raise RuntimeError("broken")

            def evaluate(self, expression: str, *args: Any) -> str:
                if "body?.innerText" in expression:
                    return "you have been blocked"
                if "documentElement?.innerHTML" in expression:
                    return ""
                return ""

        assert check_bot_detection(_BrokenPage()) == True

    def test_exception_during_evaluate_safe(self):
        """If evaluate() raises, bot detection returns False gracefully."""

        class _BrokenEvalPage:
            def title(self) -> str:
                return "Normal Page"

            def evaluate(self, expression: str, *args: Any) -> str:
                raise RuntimeError("evaluate failed")

        assert check_bot_detection(_BrokenEvalPage()) == False
