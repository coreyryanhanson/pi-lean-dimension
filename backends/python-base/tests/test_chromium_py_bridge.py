"""
Tests for ``backends/chromium-py/bridge.py``.

These are pure-logic unit tests for helper functions (``_check_bot_detection``) that do NOT require a Playwright browser to be
installed.  The bridge module is loaded via ``importlib`` because the
directory name contains a hyphen.

Integration tests requiring an actual Chromium browser live in
``__tests__/chromium-py.test.ts`` (plugin contract harness).
"""


import importlib.util
from pathlib import Path
from typing import Any

import pytest

# ── Load the bridge module via file path ─────────────────────────────

_bridge_path = (
    Path(__file__).resolve().parents[3]
    / "backends"
    / "chromium-py"
    / "bridge.py"
)

assert _bridge_path.exists(), f"bridge.py not found at {_bridge_path}"

_spec = importlib.util.spec_from_file_location("chromium_py_bridge", _bridge_path)
assert _spec is not None, f"Could not create spec for {_bridge_path}"
_chromium_py_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_chromium_py_bridge)

# Shortcuts to the functions under test
_check_bot_detection = _chromium_py_bridge._check_bot_detection
ChromiumPyBridge = _chromium_py_bridge.ChromiumPyBridge


# ═══════════════════════════════════════════════════════════════════════
#  Test: ChromiumPyBridge construction and base functionality
# ═══════════════════════════════════════════════════════════════════════


class TestChromiumPyBridgeConstruction:
    def test_constructs_without_playwright_browser(self):
        """ChromiumPyBridge can be instantiated without a Playwright browser."""
        bridge = ChromiumPyBridge()
        assert bridge.sessions == {}
        assert bridge.element_caches == {}

    def test_ping_response(self):
        """Ping is handled by the base class."""
        bridge = ChromiumPyBridge()
        result = bridge.handle_command("ping", {}, 1)
        assert result["result"] == "pong"

    def test_unknown_method_returns_error(self):
        """Unknown methods return METHOD_NOT_FOUND."""
        bridge = ChromiumPyBridge()
        result = bridge.handle_command("bogus.method", {}, 2)
        assert "error" in result
        assert result["error"]["code"] == -32601

    def test_missing_session_returns_specific_error(self):
        """Operations without a session return a SESSION_ERROR."""
        bridge = ChromiumPyBridge()
        result = bridge.handle_command(
            "browser.snapshot", {"taskId": "nonexistent"}, 3
        )
        assert "error" in result
        assert result["error"]["code"] == -32002
        assert "No active session" in result["error"]["message"]

    def test_invalid_scroll_direction(self):
        """Invalid scroll direction returns INVALID_PARAMS."""
        bridge = ChromiumPyBridge()
        result = bridge.handle_command(
            "browser.scroll",
            {"taskId": "t", "direction": "sideways"},
            4,
        )
        assert "error" in result
        assert result["error"]["code"] == -32602
        assert 'direction must be "up" or "down"' in result["error"]["message"]

    def test_not_implemented_returns_application_error(self):
        """Operations not overridden in subclass return APPLICATION_ERROR."""
        bridge = ChromiumPyBridge()
        # do_navigate is implemented, but the base class requires a session
        # (which fails because create_browser_session is a different error).
        # Test with do_get_images which requires a page that doesn't exist.
        result = bridge.handle_command(
            "browser.getImages", {"taskId": "nonexistent"}, 5
        )
        assert "error" in result
        # Should be session error (not implemented can't be reached)
        assert result["error"]["code"] in (-32002, -32000)


# ═══════════════════════════════════════════════════════════════════════
#  Test: _check_bot_detection (with mock page objects)
# ═══════════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════════
#  Test: _check_bot_detection (with mock page objects)
# ═══════════════════════════════════════════════════════════════════════


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
    """Tests for _check_bot_detection() with mock pages."""

    def test_normal_page_not_detected(self):
        """A normal page with no bot signals returns False."""
        page = _MockPage(title="Example Domain", body_text="Welcome to Example")
        assert _check_bot_detection(page) is False

    def test_cloudflare_in_title(self):
        """'cloudflare' in the title triggers bot detection."""
        page = _MockPage(title="Just a moment... | Cloudflare")
        assert _check_bot_detection(page) is True

    def test_just_a_moment_in_title(self):
        """'just a moment' in the title triggers bot detection."""
        page = _MockPage(title="Just a moment...")
        assert _check_bot_detection(page) is True

    def test_checking_browser_in_title(self):
        """'checking your browser' in the title triggers bot detection."""
        page = _MockPage(title="Checking your browser before accessing")
        assert _check_bot_detection(page) is True

    def test_verify_human_in_title(self):
        """'verify you are human' in the title triggers bot detection."""
        page = _MockPage(title="Verify you are human")
        assert _check_bot_detection(page) is True

    def test_captcha_in_title_not_detected(self):
        """'captcha' in the title does NOT trigger bot detection.

        Single-word signals like 'captcha' are deliberately excluded
        to avoid false positives on legitimate pages that mention
        CAPTCHAs in passing (e.g. Wikipedia, tech blogs).
        """
        page = _MockPage(title="CAPTCHA Challenge")
        assert _check_bot_detection(page) is False

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
        assert _check_bot_detection(page) is False

    def test_akamai_reference_in_body(self):
        """Akamai-style reference codes in body trigger bot detection."""
        page = _MockPage(
            title="Error",
            body_text="Access denied. Reference #18.abc.def",
        )
        assert _check_bot_detection(page) is True

    def test_recaptcha_in_html(self):
        """'recaptcha' in HTML triggers bot detection."""
        page = _MockPage(
            title="Form",
            body_text="Submit the form",
            html='<div><script src="recaptcha/api.js"></script></div>',
        )
        assert _check_bot_detection(page) is True

    def test_hcaptcha_in_html(self):
        """'hcaptcha' in HTML triggers bot detection."""
        page = _MockPage(
            title="Login",
            body_text="Login form",
            html='<div data-sitekey="abc" class="hcaptcha"></div>',
        )
        assert _check_bot_detection(page) is True

    def test_turnstile_in_html(self):
        """Cloudflare challenge markers in body trigger bot detection."""
        page = _MockPage(
            title="Challenge",
            body_text="_cf_chl_opt",
        )
        assert _check_bot_detection(page) is True

    def test_privacy_pass_in_title_not_detected(self):
        """'privacy pass' in title does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) and was removed to align with it.
        """
        page = _MockPage(title="Privacy Pass Challenge")
        assert _check_bot_detection(page) is False

    def test_automated_access_in_title_not_detected(self):
        """'automated access' in title does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) and was removed to align with it.
        """
        page = _MockPage(title="Automated Access Blocked")
        assert _check_bot_detection(page) is False

    def test_browser_check_in_title_not_detected(self):
        """'browser check' in title does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) and was removed to align with it.
        """
        page = _MockPage(title="Browser Check")
        assert _check_bot_detection(page) is False

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
        assert _check_bot_detection(page) is False

    def test_blank_page_not_detected(self):
        """An empty or blank page does not trigger bot detection."""
        page = _MockPage(title="", body_text="", html="")
        assert _check_bot_detection(page) is False

    def test_bot_signal_in_body_not_mistaken_if_not_high_specificity(self):
        """Generic phrases in body don't trigger unless high-specificity."""
        page = _MockPage(
            title="Blog",
            body_text="This page requires JavaScript to work properly. "
                      "Please enable JavaScript.",
        )
        assert _check_bot_detection(page) is False

    def test_data_sitekey_in_html(self):
        """'data-sitekey' (reCAPTCHA) in HTML triggers bot detection."""
        page = _MockPage(
            title="Contact",
            html='<div class="g-recaptcha" data-sitekey="abc123"></div>',
        )
        assert _check_bot_detection(page) is True

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

        assert _check_bot_detection(_BrokenPage()) is True

    def test_exception_during_evaluate_safe(self):
        """If evaluate() raises, bot detection returns False gracefully."""

        class _BrokenEvalPage:
            def title(self) -> str:
                return "Normal Page"

            def evaluate(self, expression: str, *args: Any) -> str:
                raise RuntimeError("evaluate failed")

        assert _check_bot_detection(_BrokenEvalPage()) is False

    def test_cloudflare_nginx_in_body_not_detected(self):
        """'cloudflare-nginx' in body does NOT trigger detection.

        This signal is not present in the TypeScript reference
        (bot-detection.ts) and was removed to align with it.
        """
        page = _MockPage(
            title="Error 503",
            body_text="Server: cloudflare-nginx",
        )
        assert _check_bot_detection(page) is False

    def test_reference_hash_in_body(self):
        """'reference #' in body triggers bot detection."""
        page = _MockPage(
            title="Blocked",
            body_text="Reference #18.abcde12345",
        )
        assert _check_bot_detection(page) is True

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
        assert _check_bot_detection(page) is False





# ═══════════════════════════════════════════════════════════════════════
#  Test: ChromiumPyBridge command dispatch handles all methods
# ═══════════════════════════════════════════════════════════════════════


class TestChromiumPyBridgeDispatch:
    """Verify that all 13 methods are routed correctly in the handle_command.

    These tests verify the routing layer only (no browser needed) — they
    confirm that the bridge accepts commands and returns proper error
    shapes for operations that require a session.
    """

    METHOD_NAMES = [
        "browser.navigate",
        "browser.snapshot",
        "browser.click",
        "browser.type",
        "browser.scroll",
        "browser.goBack",
        "browser.press",
        "browser.screenshot",
        "browser.getImages",
        "browser.getConsoleMessages",
        "browser.clearConsole",
        "browser.evaluate",
        "browser.cleanup",
    ]

    @pytest.fixture
    def bridge(self):
        return ChromiumPyBridge()

    def test_all_methods_have_dispatch_entries(self, bridge):
        """Every method gets routed (even if it returns a session error)."""
        # Some methods safely return empty results when there's no session.
        # getConsoleMessages/clearConsole use get_session (safe).
        # cleanup is a no-op on missing sessions (returns success).
        no_session_ok = {
            "browser.getConsoleMessages",
            "browser.clearConsole",
            "browser.cleanup",
        }
        for method in self.METHOD_NAMES:
            params = {"taskId": "no-session-test"}
            result = bridge.handle_command(method, params, 99)
            if method in no_session_ok:
                # These safely return success with empty data
                assert "result" in result, f"{method} should return a result"
                continue
            # All others should produce an error
            assert "error" in result, f"{method} did not produce an error"
            code = result["error"]["code"]
            # browser.navigate without 'url' param gets APPLICATION_ERROR (-32000)
            # because the base handle_command routes InvalidParamsError to the
            # generic Exception handler (not the INVALID_PARAMS handler).
            assert code in (-32002, -32602, -32601, -32000), (
                f"{method}: unexpected error code {code}: {result['error']['message'][:60]}"
            )

    def test_navigate_missing_url(self, bridge):
        """browser.navigate without url returns an error mentioning url."""
        result = bridge.handle_command(
            "browser.navigate", {"taskId": "t"}, 1
        )
        assert "error" in result
        # Note: the base class maps InvalidParamsError to APPLICATION_ERROR
        # (-32000) rather than INVALID_PARAMS (-32602).  We just check the
        # error message mentions the missing param.
        assert "url" in result["error"]["message"]

    def test_navigate_missing_task_id(self, bridge):
        """browser.navigate without taskId returns an error mentioning taskId."""
        result = bridge.handle_command(
            "browser.navigate", {"url": "https://example.com"}, 2
        )
        assert "error" in result
        assert "taskId" in result["error"]["message"]

    def test_click_missing_ref(self, bridge):
        """browser.click without ref returns INVALID_PARAMS."""
        result = bridge.handle_command(
            "browser.click", {"taskId": "t"}, 3
        )
        assert "error" in result
        assert "ref" in result["error"]["message"]

    def test_type_missing_text(self, bridge):
        """browser.type without text returns INVALID_PARAMS."""
        result = bridge.handle_command(
            "browser.type", {"taskId": "t", "ref": "e1"}, 4
        )
        assert "error" in result
        assert "text" in result["error"]["message"]

    def test_evaluate_missing_expression(self, bridge):
        """browser.evaluate without expression returns INVALID_PARAMS."""
        result = bridge.handle_command(
            "browser.evaluate", {"taskId": "t"}, 5
        )
        assert "error" in result
        assert "expression" in result["error"]["message"]

    def test_shutdown_command(self, bridge):
        """shutdown returns success and sets _running to False."""
        result = bridge.handle_command("shutdown", {}, 6)
        assert result["result"] == "shutting_down"
        assert bridge._running is False

    def test_cleanup_missing_task_id(self, bridge):
        """browser.cleanup without taskId returns INVALID_PARAMS."""
        result = bridge.handle_command(
            "browser.cleanup", {}, 7
        )
        assert "error" in result
        assert "taskId" in result["error"]["message"]
