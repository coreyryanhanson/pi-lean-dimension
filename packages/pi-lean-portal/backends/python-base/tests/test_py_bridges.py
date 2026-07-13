"""
Tests for Python bridge backends (chromium-py, firefox-py).

Pure-logic unit tests parametrized over both backends.  Engine-specific
assertions live in top-level test functions (not parametrized).
"""

from conftest import METHOD_NAMES, _MockConsolePage, _load_bridge_class


# ═══════════════════════════════════════════════════════════════════════
#  Engine-specific construction tests
# ═══════════════════════════════════════════════════════════════════════


class TestChromiumPyBridgeConstruction:
    def test_constructs_without_playwright_browser(self):
        """ChromiumPyBridge can be instantiated without a Playwright browser."""
        Cls = _load_bridge_class("chromium-py")
        bridge = Cls()
        assert bridge.sessions == {}
        assert bridge.element_caches == {}


class TestFirefoxPyBridgeConstruction:
    def test_constructs_without_playwright_browser(self):
        """FirefoxPyBridge has engine-specific name, UA hint, and install hint."""
        Cls = _load_bridge_class("firefox-py")
        bridge = Cls()
        assert bridge._plugin_name == "firefox-py"
        assert bridge._user_agent is not None
        assert bridge._install_hint is not None
        assert "playwright install firefox" in bridge._install_hint


# ═══════════════════════════════════════════════════════════════════════
#  Test: Dispatch layer (all methods routed correctly)
# ═══════════════════════════════════════════════════════════════════════


class TestDispatch:
    """Verify that all methods are routed correctly in handle_command."""

    def test_all_methods_have_dispatch_entries(self, bridge_factory):
        """Every method gets routed (even if it returns a session error)."""
        _, bridge = bridge_factory
        no_session_ok = {
            "browser.getConsoleMessages",
            "browser.clearConsole",
            "browser.cleanup",
        }
        for method in METHOD_NAMES:
            params = {"taskId": "no-session-test"}
            result = bridge.handle_command(method, params, 99)
            if method in no_session_ok:
                assert "result" in result, f"{method} should return a result"
                continue
            assert "error" in result, f"{method} did not produce an error"
            code = result["error"]["code"]
            _valid = {-32002, -32602, -32601, -32000}
            _msg = f"{method}: unexpected error code {code}: {result['error']['message'][:60]}"
            assert code in _valid, _msg

    def test_navigate_missing_url(self, bridge_factory):
        """navigate without url returns an error mentioning url."""
        _, bridge = bridge_factory
        result = bridge.handle_command("browser.navigate", {"taskId": "t"}, 1)
        assert "error" in result
        assert "url" in result["error"]["message"]

    def test_navigate_missing_task_id(self, bridge_factory):
        """navigate without taskId returns an error mentioning taskId."""
        _, bridge = bridge_factory
        result = bridge.handle_command(
            "browser.navigate", {"url": "https://example.com"}, 2
        )
        assert "error" in result
        assert "taskId" in result["error"]["message"]

    def test_click_missing_ref(self, bridge_factory):
        """click without ref returns INVALID_PARAMS."""
        _, bridge = bridge_factory
        result = bridge.handle_command("browser.click", {"taskId": "t"}, 3)
        assert "error" in result
        assert "ref" in result["error"]["message"]

    def test_type_missing_text(self, bridge_factory):
        """type without text returns INVALID_PARAMS."""
        _, bridge = bridge_factory
        result = bridge.handle_command(
            "browser.type", {"taskId": "t", "ref": "e1"}, 4
        )
        assert "error" in result
        assert "text" in result["error"]["message"]

    def test_evaluate_missing_expression(self, bridge_factory):
        """evaluate without expression returns INVALID_PARAMS."""
        _, bridge = bridge_factory
        result = bridge.handle_command("browser.evaluate", {"taskId": "t"}, 5)
        assert "error" in result
        assert "expression" in result["error"]["message"]

    def test_shutdown_command(self, bridge_factory):
        """shutdown returns success and sets _running to False."""
        _, bridge = bridge_factory
        result = bridge.handle_command("shutdown", {}, 6)
        assert result["result"] == "shutting_down"
        assert not bridge._running

    def test_cleanup_missing_task_id(self, bridge_factory):
        """cleanup without taskId returns INVALID_PARAMS."""
        _, bridge = bridge_factory
        result = bridge.handle_command("browser.cleanup", {}, 7)
        assert "error" in result
        assert "taskId" in result["error"]["message"]


# ═══════════════════════════════════════════════════════════════════════
#  Test: Console capture ring-buffer cap
# ═══════════════════════════════════════════════════════════════════════


class TestConsoleCap:
    """Verify the 500-entry ring buffer on console capture."""

    def test_console_capped_at_500(self, bridge_factory):
        """After 501 events, only the last 500 are retained."""
        _, bridge = bridge_factory
        page = _MockConsolePage()
        session = bridge._setup_page_session(page)
        messages: list[dict[str, str]] = session["console_messages"]

        for i in range(501):
            page.fire_console(f"msg-{i}")

        assert len(messages) == 500, f"Expected 500, got {len(messages)}"
        assert (
            messages[0]["text"] == "msg-1"
        ), "First entry should be msg-1 (msg-0 popped)"
        assert messages[-1]["text"] == "msg-500", "Last entry should be msg-500"

    def test_console_under_cap_retains_all(self, bridge_factory):
        """Fewer than 501 events are all retained."""
        _, bridge = bridge_factory
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
    """Verify ``browser.evaluate`` reads the ``readOnly`` param
    and forwards it to ``do_evaluate`` as ``read_only``."""

    def test_readonly_true_reaches_do_evaluate(self, bridge_factory):
        """readOnly: True in params reaches do_evaluate as read_only=True."""
        _, bridge = bridge_factory
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

    def test_readonly_omitted_defaults_false(self, bridge_factory):
        """No readOnly param: defaults to False."""
        _, bridge = bridge_factory
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
