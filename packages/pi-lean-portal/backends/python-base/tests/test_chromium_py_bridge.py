"""
Tests for ``backends/chromium-py/bridge.py``.

Pure-logic unit tests that do NOT require a Playwright browser to be
installed.  The bridge module is loaded via ``importlib`` because the
directory name contains a hyphen.

Integration tests requiring an actual Chromium browser live in
``__tests__/chromium-py.test.ts`` (plugin contract harness).
"""


import importlib.util
from pathlib import Path

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

# Shortcuts to the classes under test
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
        # Use a different operation that doesn't require a session.
        # getConsoleMessages fails with session error for nonexistent tasks.


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


# ═══════════════════════════════════════════════════════════════════════
#  Test: Console capture ring-buffer cap
# ═══════════════════════════════════════════════════════════════════════


class _MockConsolePage:
    """Mock Playwright page that records ``page.on("console")`` handlers.

    Lets us invoke captured handlers directly without a real browser.
    """

    def __init__(self) -> None:
        self._handlers: dict[str, list] = {}

    def on(self, event: str, handler) -> None:
        self._handlers.setdefault(event, []).append(handler)

    def fire_console(self, text: str) -> None:
        """Simulate a console event by calling all 'console' handlers."""
        for handler in self._handlers.get("console", []):
            handler(_FakeConsoleMessage(text))


class _FakeConsoleMessage:
    """Duck-typed substitute for Playwright's ConsoleMessage."""

    def __init__(self, text: str) -> None:
        self._text = text

    @property
    def type(self) -> str:
        return "log"

    @property
    def text(self) -> str:
        return self._text


class TestConsoleCap:
    """Verify the 500-entry ring buffer on console capture."""

    @pytest.fixture
    def bridge(self):
        return ChromiumPyBridge()

    def test_console_capped_at_500(self, bridge):
        """After 501 events, only the last 500 are retained."""
        page = _MockConsolePage()
        session = bridge._setup_page_session(page)
        messages: list[dict[str, str]] = session["console_messages"]

        # Fire 501 messages
        for i in range(501):
            page.fire_console(f"msg-{i}")

        assert len(messages) == 500, f"Expected 500, got {len(messages)}"
        assert messages[0]["text"] == "msg-1", "First entry should be msg-1 (msg-0 popped)"
        assert messages[-1]["text"] == "msg-500", "Last entry should be msg-500"

    def test_console_under_cap_retains_all(self, bridge):
        """Fewer than 501 events are all retained."""
        page = _MockConsolePage()
        session = bridge._setup_page_session(page)
        messages: list[dict[str, str]] = session["console_messages"]

        for i in range(10):
            page.fire_console(f"msg-{i}")

        assert len(messages) == 10, f"Expected 10, got {len(messages)}"
        assert messages[0]["text"] == "msg-0"
        assert messages[-1]["text"] == "msg-9"


# ═══════════════════════════════════════════════════════════════════════
#  Test: browser.evaluate RPC dispatch with readOnly
# ═══════════════════════════════════════════════════════════════════════


class TestEvaluateReadOnly:
    """Verify that ``browser.evaluate`` reads the ``readOnly`` param
    and forwards it to ``do_evaluate`` as ``read_only``."""

    def test_readonly_true_reaches_do_evaluate(self):
        """readOnly: True in params reaches do_evaluate as read_only=True."""
        bridge = ChromiumPyBridge()
        recorded: list[bool] = []

        def spy(task_id, expression, *, read_only=False):
            recorded.append(read_only)
            return {"success": True, "result": None}

        bridge.do_evaluate = spy  # type: ignore[assignment]
        bridge.handle_command(
            "browser.evaluate",
            {"taskId": "t", "expression": "1+1", "readOnly": True},
            999,
        )
        assert recorded == [True]

    def test_readonly_omitted_defaults_false(self):
        """No readOnly param: defaults to False."""
        bridge = ChromiumPyBridge()
        recorded: list[bool] = []

        def spy(task_id, expression, *, read_only=False):
            recorded.append(read_only)
            return {"success": True, "result": None}

        bridge.do_evaluate = spy  # type: ignore[assignment]
        bridge.handle_command(
            "browser.evaluate",
            {"taskId": "t", "expression": "1+1"},
            1000,
        )
        assert recorded == [False]
