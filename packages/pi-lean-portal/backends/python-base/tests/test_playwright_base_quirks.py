"""
Tests for ``pi_browser_bridge.playwright_base.PlaywrightBridge`` Phase 0 work:

* ``plugin_config`` defaults to ``{}`` and is populated by the
  ``browser.init`` RPC handler (inherited from ``BrowserBridge``).
* The four stealth quirks change base-class behavior:
    - ``_fingerprint_managed_context`` → viewport/user_agent omitted
    - ``_skip_default_viewport`` → ``no_viewport=True`` passed to avoid
      the Camoufox binary's ``setDefaultViewport`` ``isMobile`` rejection
    - ``_scroll_via_wheel`` → ``do_scroll`` uses ``page.mouse.wheel``
    - ``_eval_prefix`` → ``do_evaluate`` prepends the prefix

These are pure-logic tests — no Playwright browser required.  A small
fake page/context mocks the few Playwright methods the code paths touch.
"""

from typing import Any

from pi_browser_bridge.bridge import BrowserBridge
from pi_browser_bridge.playwright_base import PlaywrightBridge


# ═══════════════════════════════════════════════════════════════════════
#  Fakes
# ═══════════════════════════════════════════════════════════════════════


class _FakeMouse:
    """Records ``wheel`` calls so we can assert wheel-based scroll."""

    def __init__(self) -> None:
        self.wheel_calls: list[tuple[int, int]] = []

    def wheel(self, dx: int, dy: int) -> None:
        self.wheel_calls.append((dx, dy))


class _FakePage:
    """Minimal Playwright Page stand-in for the quirks code paths."""

    def __init__(self) -> None:
        self.mouse = _FakeMouse()
        self.eval_calls: list[Any] = []  # list of expressions/args evaluated
        self.eval_results: dict[str, Any] = {}

    def evaluate(self, expression: str, arg: Any = None) -> Any:
        self.eval_calls.append((expression, arg))
        # Echo back a canned result keyed by a substring of the expression
        for key, val in self.eval_results.items():
            if key in expression:
                return val
        return None


class _FakeBrowser:
    """Records ``new_context`` kwargs so we can assert what was passed."""

    def __init__(self) -> None:
        self.new_context_calls: list[dict[str, Any]] = []

    def new_context(self, **kwargs: Any) -> "_FakeContext":
        self.new_context_calls.append(kwargs)
        return _FakeContext()


class _FakeContext:
    """Minimal BrowserContext stand-in (tracing no-op)."""

    def __init__(self) -> None:
        self.tracing = _FakeTracing()

    def new_page(self) -> _FakePage:
        return _FakePage()


class _FakeTracing:
    def start(self, *args: Any, **kwargs: Any) -> None:
        pass

    def stop(self, *args: Any, **kwargs: Any) -> None:
        pass


# ═══════════════════════════════════════════════════════════════════════
#  Test bridge subclass that uses fakes
# ═══════════════════════════════════════════════════════════════════════


class _FakePlaywrightBridge(PlaywrightBridge):
    """A ``PlaywrightBridge`` whose ``_ensure_playwright`` returns fakes.

    Skips the real Playwright import/lifecycle by overriding
    ``_ensure_playwright`` to hand back a ``_FakeBrowser``.  The quirks
    under test don't depend on a real Playwright instance.
    """

    _plugin_name = "fake-py"
    _install_hint = "install hint"

    def __init__(self) -> None:
        super().__init__()
        self._fake_browser = _FakeBrowser()

    def _ensure_playwright(self) -> tuple[Any, Any]:
        # Return (pw, browser); pw is unused by the code paths under test.
        return (None, self._fake_browser)

    def _launch_browser(self) -> Any:  # pragma: no cover — not called
        return self._fake_browser


# ═══════════════════════════════════════════════════════════════════════
#  plugin_config (browser.init RPC)
# ═══════════════════════════════════════════════════════════════════════


class TestPluginConfig:
    def test_defaults_to_empty_dict(self):
        bridge = _FakePlaywrightBridge()
        assert bridge.plugin_config == {}

    def test_init_handler_populates_plugin_config(self):
        bridge = _FakePlaywrightBridge()
        result = bridge.handle_command(
            "browser.init",
            {"config": {"launch": {"headless": True}}},
            cmd_id=1,
        )
        assert result["result"] == {"ok": True}
        assert bridge.plugin_config == {"launch": {"headless": True}}

    def test_init_handler_defaults_to_empty_when_config_missing(self):
        bridge = _FakePlaywrightBridge()
        result = bridge.handle_command("browser.init", {}, cmd_id=2)
        assert result["result"] == {"ok": True}
        assert bridge.plugin_config == {}

    def test_init_handler_defaults_to_empty_when_config_none(self):
        bridge = _FakePlaywrightBridge()
        result = bridge.handle_command(
            "browser.init", {"config": None}, cmd_id=3
        )
        assert result["result"] == {"ok": True}
        assert bridge.plugin_config == {}

    def test_init_is_inherited_from_browser_bridge(self):
        """The handler lives on BrowserBridge (so non-Playwright bridges get it too)."""
        # A bare BrowserBridge can't be instantiated meaningfully (create_browser_session
        # is abstract), but the handler routing is on the base class.
        assert "browser.init" not in {
            "ping", "shutdown"
        }  # sanity: init is a distinct method
        # Verify the base class' handle_command routes browser.init by
        # constructing a trivial concrete subclass.
        class _BareBridge(BrowserBridge):
            def create_browser_session(self, task_id, config):  # pragma: no cover
                return {}

            def create_browser_context(self, config):  # pragma: no cover
                return None

        bare = _BareBridge()
        result = bare.handle_command(
            "browser.init", {"config": {"x": 1}}, cmd_id=7
        )
        assert result["result"] == {"ok": True}
        assert bare.plugin_config == {"x": 1}


# ═══════════════════════════════════════════════════════════════════════
#  _fingerprint_managed_context
# ═══════════════════════════════════════════════════════════════════════


class TestFingerprintManagedContext:
    def test_default_passes_viewport_and_user_agent(self):
        bridge = _FakePlaywrightBridge()
        # default _fingerprint_managed_context = False
        bridge.create_browser_context({})
        call = bridge._fake_browser.new_context_calls[-1]
        assert "viewport" in call
        assert call["viewport"] == {"width": 1280, "height": 720}
        assert "user_agent" in call

    def test_fingerprint_managed_omits_viewport_and_user_agent(self):
        bridge = _FakePlaywrightBridge()
        bridge._fingerprint_managed_context = True
        bridge.create_browser_context({})
        call = bridge._fake_browser.new_context_calls[-1]
        assert "viewport" not in call
        assert "user_agent" not in call

    def test_storage_state_forwarded_in_both_modes(self):
        bridge = _FakePlaywrightBridge()
        state = {"cookies": [], "origins": []}
        # Default mode
        bridge.create_browser_context({"storageState": state})
        assert bridge._fake_browser.new_context_calls[-1]["storage_state"] is state
        # Fingerprint-managed mode
        bridge._fingerprint_managed_context = True
        bridge.create_browser_context({"storageState": state})
        assert bridge._fake_browser.new_context_calls[-1]["storage_state"] is state


# ═══════════════════════════════════════════════════════════════════════
#  _skip_default_viewport
# ═══════════════════════════════════════════════════════════════════════


class TestSkipDefaultViewport:
    """``_skip_default_viewport`` makes ``create_browser_context`` pass
    ``no_viewport=True`` so the Camoufox patched Firefox binary doesn't
    reject the ``Browser.setDefaultViewport`` CDP call (its ``isMobile``
    property is not in the binary's schema).  Only meaningful alongside
    ``_fingerprint_managed_context = True``.
    """

    def test_default_does_not_pass_no_viewport(self):
        bridge = _FakePlaywrightBridge()
        bridge._fingerprint_managed_context = True
        # default _skip_default_viewport = False
        bridge.create_browser_context({})
        call = bridge._fake_browser.new_context_calls[-1]
        assert "no_viewport" not in call

    def test_skip_passes_no_viewport_true(self):
        bridge = _FakePlaywrightBridge()
        bridge._fingerprint_managed_context = True
        bridge._skip_default_viewport = True
        bridge.create_browser_context({})
        call = bridge._fake_browser.new_context_calls[-1]
        assert call["no_viewport"]
        # viewport/user_agent still omitted (fingerprint-managed)
        assert "viewport" not in call
        assert "user_agent" not in call

    def test_skip_ignored_when_not_fingerprint_managed(self):
        # The elif branch only fires under fingerprint-managed mode;
        # shipped bridges keep their hard-coded viewport/UA regardless.
        bridge = _FakePlaywrightBridge()
        bridge._skip_default_viewport = True
        bridge.create_browser_context({})
        call = bridge._fake_browser.new_context_calls[-1]
        assert "no_viewport" not in call
        assert call["viewport"] == {"width": 1280, "height": 720}
        assert "user_agent" in call

    def test_skip_forwards_storage_state(self):
        bridge = _FakePlaywrightBridge()
        bridge._fingerprint_managed_context = True
        bridge._skip_default_viewport = True
        state = {"cookies": [], "origins": []}
        bridge.create_browser_context({"storageState": state})
        call = bridge._fake_browser.new_context_calls[-1]
        assert call["no_viewport"]
        assert call["storage_state"] is state


# ═══════════════════════════════════════════════════════════════════════
#  _scroll_via_wheel
# ═══════════════════════════════════════════════════════════════════════


class TestScrollViaWheel:
    def _setup_session(self, bridge: _FakePlaywrightBridge, page: _FakePage) -> None:
        bridge.sessions["t"] = {"page": page, "context": _FakeContext()}

    def test_default_uses_eval_scrollby(self):
        bridge = _FakePlaywrightBridge()
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_scroll("t", "down")
        assert page.mouse.wheel_calls == []
        assert len(page.eval_calls) == 1
        expr, arg = page.eval_calls[0]
        assert "window.scrollBy" in expr
        assert arg == 800

    def test_scroll_via_wheel_uses_mouse_wheel(self):
        bridge = _FakePlaywrightBridge()
        bridge._scroll_via_wheel = True
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_scroll("t", "down")
        assert len(page.mouse.wheel_calls) == 1
        dx, dy = page.mouse.wheel_calls[0]
        assert dx == 0
        assert dy == 800
        assert page.eval_calls == []  # no eval path taken

    def test_scroll_up_via_wheel_negates_delta(self):
        bridge = _FakePlaywrightBridge()
        bridge._scroll_via_wheel = True
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_scroll("t", "up")
        assert len(page.mouse.wheel_calls) == 1
        dx, dy = page.mouse.wheel_calls[0]
        assert dx == 0
        assert dy == -800


# ═══════════════════════════════════════════════════════════════════════
#  _eval_prefix
# ═══════════════════════════════════════════════════════════════════════


class TestEvalPrefix:
    def _setup_session(self, bridge: _FakePlaywrightBridge, page: _FakePage) -> None:
        bridge.sessions["t"] = {"page": page, "context": _FakeContext()}

    def test_default_passes_expression_unchanged(self):
        bridge = _FakePlaywrightBridge()
        page = _FakePage()
        page.eval_results = {"1 + 1": 2}
        self._setup_session(bridge, page)
        result = bridge.do_evaluate("t", "() => 1 + 1")
        assert result["success"]
        assert result["result"] == 2
        assert page.eval_calls[0][0] == "() => 1 + 1"  # no prefix

    def test_eval_prefix_prepended(self):
        bridge = _FakePlaywrightBridge()
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        page.eval_results = {"mw:": 2}
        self._setup_session(bridge, page)
        result = bridge.do_evaluate("t", "() => 1 + 1")
        assert result["success"]
        assert result["result"] == 2
        assert page.eval_calls[0][0] == "mw:() => 1 + 1"

    def test_eval_prefix_applied_even_for_reads(self):
        """Prefix is safe to apply unconditionally — reads work with it too."""
        bridge = _FakePlaywrightBridge()
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        page.eval_results = {"mw:": "UA-string"}
        self._setup_session(bridge, page)
        result = bridge.do_evaluate("t", "() => navigator.userAgent")
        assert result["success"]
        assert result["result"] == "UA-string"
        assert page.eval_calls[0][0].startswith("mw:")


# ═══════════════════════════════════════════════════════════════════════
#  Sanity: quirks default to off (bit-identical shipped bridges)
# ═══════════════════════════════════════════════════════════════════════


class TestQuirksDefaultOff:
    def test_all_quirks_default_off(self):
        bridge = _FakePlaywrightBridge()
        assert bridge._fingerprint_managed_context == False
        assert bridge._eval_prefix == ""
        assert bridge._scroll_via_wheel == False
        assert bridge._skip_default_viewport == False
        assert bridge._skip_networkidle == False
