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
        assert check_bot_detection(page) is False

    def test_cloudflare_in_title(self):
        """'cloudflare' in the title triggers bot detection."""
        page = _MockPage(title="Just a moment... | Cloudflare")
        assert check_bot_detection(page) is True

    def test_just_a_moment_in_title(self):
        """'just a moment' in the title triggers bot detection."""
        page = _MockPage(title="Just a moment...")
        assert check_bot_detection(page) is True

    def test_checking_browser_in_title(self):
        """'checking your browser' in the title triggers bot detection."""
        page = _MockPage(title="Checking your browser before accessing")
        assert check_bot_detection(page) is True

    def test_verify_human_in_title(self):
        """'verify you are human' in the title triggers bot detection."""
        page = _MockPage(title="Verify you are human")
        assert check_bot_detection(page) is True

    def test_captcha_in_title_not_detected(self):
        """'captcha' in the title does NOT trigger bot detection.

        Single-word signals like 'captcha' are deliberately excluded
        to avoid false positives on legitimate pages that mention
        CAPTCHAs in passing (e.g. Wikipedia, tech blogs).
        """
        page = _MockPage(title="CAPTCHA Challenge")
        assert check_bot_detection(page) is False

    def test_cf_ray_in_body_not_detected(self):
        """'cf-ray' in body does NOT trigger bot detection.

        'cf-ray' is an HTTP response header that rarely appears in
        rendered body text. The TypeScript reference (bot-detection.ts)
        does not include this signal.
        """
        page = _MockPage(
            title="Access Denied",
            body_text="cf-ray: abc123\nserver: cloudflare",
        )
        assert check_bot_detection(page) is False

    def test_akamai_reference_in_body(self):
        """Akamai-style reference codes in body trigger bot detection."""
        page = _MockPage(
            title="Error",
            body_text="Access denied. Reference #18.abc.def",
        )
        assert check_bot_detection(page) is True

    def test_recaptcha_in_html(self):
        """'recaptcha' in HTML triggers bot detection."""
        page = _MockPage(
            title="Form",
            body_text="Submit the form",
            html='<div><script src="recaptcha/api.js"></script></div>',
        )
        assert check_bot_detection(page) is True

    def test_hcaptcha_in_html(self):
        """'hcaptcha' in HTML triggers bot detection."""
        page = _MockPage(
            title="Login",
            body_text="Login form",
            html='<div data-sitekey="abc" class="hcaptcha"></div>',
        )
        assert check_bot_detection(page) is True

    def test_turnstile_in_html(self):
        """Cloudflare challenge markers in body trigger bot detection."""
        page = _MockPage(
            title="Challenge",
            body_text="_cf_chl_opt",
        )
        assert check_bot_detection(page) is True

    def test_privacy_pass_in_title_not_detected(self):
        """'privacy pass' in title does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) and was removed to align with it.
        """
        page = _MockPage(title="Privacy Pass Challenge")
        assert check_bot_detection(page) is False

    def test_automated_access_in_title_not_detected(self):
        """'automated access' in title does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) and was removed to align with it.
        """
        page = _MockPage(title="Automated Access Blocked")
        assert check_bot_detection(page) is False

    def test_browser_check_in_title_not_detected(self):
        """'browser check' in title does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) and was removed to align with it.
        """
        page = _MockPage(title="Browser Check")
        assert check_bot_detection(page) is False

    def test_wikipedia_captcha_not_false_positive(self):
        """Wikipedia's 'captcha' mention in body text is NOT detected.

        This test validates that bot detection is title-level only for
        the CAPTCHA signal, preventing false positives from sites that
        simply mention CAPTCHA in their content.
        """
        page = _MockPage(
            title="Wikipedia - The Free Encyclopedia",
            body_text=(
                "CAPTCHA is a type of challenge-response test used in computing"
            ),
        )
        # 'captcha' is not in the title, so it should NOT trigger
        assert check_bot_detection(page) is False

    def test_blank_page_not_detected(self):
        """An empty or blank page does not trigger bot detection."""
        page = _MockPage(title="", body_text="", html="")
        assert check_bot_detection(page) is False

    def test_bot_signal_in_body_not_mistaken_if_not_high_specificity(self):
        """Generic phrases in body don't trigger unless high-specificity."""
        page = _MockPage(
            title="Blog",
            body_text="This page requires JavaScript to work properly. "
                      "Please enable JavaScript.",
        )
        assert check_bot_detection(page) is False

    def test_data_sitekey_in_html(self):
        """'data-sitekey' (reCAPTCHA) in HTML triggers bot detection."""
        page = _MockPage(
            title="Contact",
            html='<div class="g-recaptcha" data-sitekey="abc123"></div>',
        )
        assert check_bot_detection(page) is True

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

        assert check_bot_detection(_BrokenPage()) is True

    def test_exception_during_evaluate_safe(self):
        """If evaluate() raises, bot detection returns False gracefully."""

        class _BrokenEvalPage:
            def title(self) -> str:
                return "Normal Page"

            def evaluate(self, expression: str, *args: Any) -> str:
                raise RuntimeError("evaluate failed")

        assert check_bot_detection(_BrokenEvalPage()) is False

    def test_cloudflare_nginx_in_body_not_detected(self):
        """'cloudflare-nginx' in body does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) and was removed to align with it.
        """
        page = _MockPage(
            title="Error 503",
            body_text="Server: cloudflare-nginx",
        )
        assert check_bot_detection(page) is False

    def test_reference_hash_in_body(self):
        """'reference #' in body triggers bot detection."""
        page = _MockPage(
            title="Blocked",
            body_text="Reference #18.abcde12345",
        )
        assert check_bot_detection(page) is True

    def test_blocked_request_in_body_not_detected(self):
        """'blocked request' in body does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) — more specific variants like
        'you have been blocked' and 'your request has been blocked'
        are used instead.
        """
        page = _MockPage(
            title="403 Forbidden",
            body_text="Blocked request",
        )
        assert check_bot_detection(page) is False
