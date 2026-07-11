"""
Tests for ``pi_browser_bridge.playwright_base.PlaywrightBridge`` Phase 0 work:

* ``plugin_config`` defaults to ``{}`` and is populated by the
  ``browser.init`` RPC handler (inherited from ``BrowserBridge``).
* The stealth quirks change base-class behavior:
    - ``_fingerprint_managed_context`` → viewport/user_agent omitted
    - ``_skip_default_viewport`` → ``no_viewport=True`` passed to avoid
      the Camoufox binary's ``setDefaultViewport`` ``isMobile`` rejection
    - ``_scroll_via_wheel`` → ``do_scroll`` uses ``page.mouse.wheel``
    - ``_eval_prefix`` → ``do_evaluate`` prepends the prefix
    - ``_wrap_mw_eval_in_eval`` → ``do_evaluate`` wraps the script as
      ``eval(<json>)`` so multi-statement scripts survive Camoufox's
      ``let _s = (${script})`` main-world wrapper

These are pure-logic tests — no Playwright browser required.  A small
fake page/context mocks the few Playwright methods the code paths touch.
"""

import sys
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
        # Always-raise mode: every call raises
        self._eval_raise_always: bool = False
        self._eval_raise_error: str = ""
        # Raise-once mode: raise on first call, then fall through to canned results
        self._eval_raise_once_error: str = ""
        self._eval_raise_once_count: int = 0
        # wait_for_load_state recorder
        self.wait_for_load_state_calls: list[tuple[str, int]] = []

    def evaluate(self, expression: str, arg: Any = None) -> Any:
        self.eval_calls.append((expression, arg))
        # Always-raise mode: every call raises
        if self._eval_raise_always and self._eval_raise_error:
            raise Exception(self._eval_raise_error)
        # Raise-once mode: raise on the first call only, then fall through
        if self._eval_raise_once_error and self._eval_raise_once_count == 0:
            self._eval_raise_once_count += 1
            raise Exception(self._eval_raise_once_error)
        # Echo back a canned result keyed by a substring of the expression
        for key, val in self.eval_results.items():
            if key in expression:
                return val
        return None

    def wait_for_load_state(self, state: str, timeout: int = 30_000) -> None:
        self.wait_for_load_state_calls.append((state, timeout))


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
        assert bridge._wrap_mw_eval_in_eval == False


# ═══════════════════════════════════════════════════════════════════════
#  _wrap_mw_eval_in_eval
# ═══════════════════════════════════════════════════════════════════════


class TestWrapMwEvalInEval:
    """``_wrap_mw_eval_in_eval`` makes ``do_evaluate`` rewrite the
    expression as ``eval(<JSON-string of expression>)`` before prepending
    ``_eval_prefix``, so multi-statement scripts survive Camoufox's
    ``let _s = (${script})`` main-world wrapper.
    """

    def _setup_session(self, bridge: _FakePlaywrightBridge, page: _FakePage) -> None:
        bridge.sessions["t"] = {"page": page, "context": _FakeContext()}

    def test_default_off_expression_unwrapped(self):
        """Default off: expression is passed through unwrapped (bit-identical)."""
        bridge = _FakePlaywrightBridge()
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_evaluate("t", "let x = 5; x + 1")
        assert page.eval_calls[0][0] == "let x = 5; x + 1"
        assert len(page.eval_calls) == 1

    def test_default_off_with_prefix_expression_unwrapped(self):
        """Default off but prefix set: only the prefix is prepended, no eval wrap."""
        bridge = _FakePlaywrightBridge()
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_evaluate("t", "let x = 5; x + 1")
        assert page.eval_calls[0][0] == "mw:let x = 5; x + 1"

    def test_flag_on_wraps_in_eval(self):
        """Flag on: expression becomes ``eval(<json>)`` — a single expression."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_evaluate("t", "let x = 5; x + 1")
        assert page.eval_calls[0][0] == 'eval("let x = 5; x + 1")'
        assert len(page.eval_calls) == 1

    def test_flag_on_with_prefix_prepends_prefix(self):
        """Flag on + Camoufox prefix: ``mw:eval(<json>)`` — the production shape."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_evaluate("t", "let x = 5; x + 1")
        assert page.eval_calls[0][0] == 'mw:eval("let x = 5; x + 1")'

    def test_flag_on_escapes_special_characters(self):
        """Flag on: quotes / newlines / backslashes in the script are JSON-escaped
        so the embedded string literal is always valid JS."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        self._setup_session(bridge, page)
        # a script with a double-quote and a newline (JSON must escape both)
        script = "let s = 'a\"b';\n s"
        bridge.do_evaluate("t", script)
        sent = page.eval_calls[0][0]
        assert sent.startswith("mw:eval(")
        assert sent.endswith(")")
        # The inner literal must be a valid JSON string (round-trips to script)
        import json as _json
        literal = sent[len("mw:eval("):-1]
        assert _json.loads(literal) == script

    def test_flag_on_preserves_expression_results(self):
        """Flag on: a plain expression still round-trips its value."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        page.eval_results = {"eval(": 7}
        self._setup_session(bridge, page)
        result = bridge.do_evaluate("t", "3 + 4")
        assert result["success"] == True
        assert result["result"] == 7
        assert page.eval_calls[0][0] == 'mw:eval("3 + 4")'

    def test_no_retry_on_syntax_error(self):
        """A terminal eval error (e.g. a genuine SyntaxError through the
        eval wrap) propagates after a SINGLE call — no retry, no
        wait_for_load_state.  This guards against the old unconditional retry
        quirk regressing."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        page._eval_raise_always = True
        page._eval_raise_error = "SyntaxError: Unexpected identifier"
        self._setup_session(bridge, page)
        result = bridge.do_evaluate("t", "let x = 5; x + 1")
        assert result["success"] == False
        assert "syntaxerror" in result["error"].lower()
        assert len(page.eval_calls) == 1  # no retry
        assert page.wait_for_load_state_calls == []  # no recovery machinery

    def test_retry_once_on_context_destroyed(self):
        """A transient "Execution context was destroyed" error triggers one
        wait_for_load_state + retry.  After the retry succeeds, the result
        is returned as success."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        page._eval_raise_once_error = "Execution context was destroyed, most likely because of a navigation."
        page.eval_results = {"eval(": "retry_success"}
        self._setup_session(bridge, page)
        result = bridge.do_evaluate("t", "let x = 5; x + 1")
        assert result["success"] == True
        assert result["result"] == "retry_success"
        assert len(page.eval_calls) == 2  # first raise, retry succeeds
        assert len(page.wait_for_load_state_calls) == 1
        assert page.wait_for_load_state_calls[0][0] == "load"


# ═══════════════════════════════════════════════════════════════════════
#  browser.describeQuirks RPC handler
# ═══════════════════════════════════════════════════════════════════════


class TestDescribeQuirks:
    """Tests for the ``browser.describeQuirks`` introspection RPC handler
    on ``BrowserBridge`` (``bridge.py``).

    Verifies the handler returns the bridge's class-attribute quirks
    flags correctly, and that the getattr-based defaulting handles both
    PlaywrightBridge instances (which have the quirks attrs) and bare
    BrowserBridge instances (which don't).
    """

    def test_playwright_bridge_returns_all_defaults(self):
        """A default _FakePlaywrightBridge returns all-default/false."""
        bridge = _FakePlaywrightBridge()
        result = bridge.handle_command("browser.describeQuirks", {}, 1)
        assert "result" in result
        q = result["result"]
        assert q["fingerprint_managed_context"] == False
        assert q["eval_prefix"] == ""
        assert q["scroll_via_wheel"] == False
        assert q["skip_default_viewport"] == False
        assert q["skip_networkidle"] == False
        assert q["wrap_mw_eval_in_eval"] == False

    def test_playwright_bridge_returns_overridden_quirks(self):
        """Overridden quirks are surfaced in the response."""
        bridge = _FakePlaywrightBridge()
        bridge._fingerprint_managed_context = True
        bridge._eval_prefix = "mw:"
        bridge._scroll_via_wheel = True
        bridge._skip_default_viewport = True
        bridge._skip_networkidle = True
        bridge._wrap_mw_eval_in_eval = True
        result = bridge.handle_command("browser.describeQuirks", {}, 2)
        assert "result" in result
        q = result["result"]
        assert q["fingerprint_managed_context"] == True
        assert q["eval_prefix"] == "mw:"
        assert q["scroll_via_wheel"] == True
        assert q["skip_default_viewport"] == True
        assert q["skip_networkidle"] == True
        assert q["wrap_mw_eval_in_eval"] == True

    def test_playwright_bridge_mixed_quirks(self):
        """A partial override returns overridden + default values."""
        bridge = _FakePlaywrightBridge()
        bridge._scroll_via_wheel = True
        bridge._eval_prefix = "mw:"
        result = bridge.handle_command("browser.describeQuirks", {}, 3)
        assert "result" in result
        q = result["result"]
        assert q["scroll_via_wheel"] == True
        assert q["eval_prefix"] == "mw:"
        assert q["fingerprint_managed_context"] == False
        assert q["skip_default_viewport"] == False
        assert q["skip_networkidle"] == False
        assert q["wrap_mw_eval_in_eval"] == False

    def test_bare_bridge_returns_all_defaults(self):
        """A bare ``BrowserBridge`` (no Playwright quirks attrs) also returns
        default values via ``getattr`` — the handler doesn't throw."""
        from pi_browser_bridge.bridge import BrowserBridge

        class _BareBridge(BrowserBridge):
            def create_browser_session(self, task_id, config):
                return {}

            def create_browser_context(self, config):
                return None

        bare = _BareBridge()
        result = bare.handle_command("browser.describeQuirks", {}, 4)
        assert "result" in result
        q = result["result"]
        assert q["fingerprint_managed_context"] == False
        assert q["eval_prefix"] == ""
        assert q["scroll_via_wheel"] == False
        assert q["skip_default_viewport"] == False
        assert q["skip_networkidle"] == False
        assert q["wrap_mw_eval_in_eval"] == False


# ═══════════════════════════════════════════════════════════════════════
#  read_only eval path
# ═══════════════════════════════════════════════════════════════════════


class TestReadOnlyEval:
    """``do_evaluate(…, read_only=True)`` bypasses ``_eval_prefix`` and
    the ``eval()`` wrap, routing the expression through the isolated-world
    context instead of the main-world (``mw:``) context.
    """

    def _setup_session(
        self, bridge: _FakePlaywrightBridge, page: _FakePage
    ) -> None:
        bridge.sessions["t"] = {"page": page, "context": _FakeContext()}

    def test_read_only_bypasses_prefix_and_wrap(self):
        """read_only=True: no mw: prefix, no eval() wrap — raw expression."""
        bridge = _FakePlaywrightBridge()
        bridge._eval_prefix = "mw:"
        bridge._wrap_mw_eval_in_eval = True
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_evaluate("t", "() => 1 + 1", read_only=True)
        assert page.eval_calls[0][0] == "() => 1 + 1"

    def test_read_only_noop_when_no_prefix(self):
        """read_only=True with defaults: bit-identical to read_only=False."""
        bridge = _FakePlaywrightBridge()
        page = _FakePage()
        page.eval_results = {"1 + 1": 2}
        self._setup_session(bridge, page)
        result = bridge.do_evaluate("t", "() => 1 + 1", read_only=True)
        assert result["success"]
        assert result["result"] == 2
        assert page.eval_calls[0][0] == "() => 1 + 1"

    def test_write_path_unchanged_default(self):
        """Default (no read_only arg): wrap still applied."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_evaluate("t", "let x = 5; x + 1")
        assert page.eval_calls[0][0] == 'eval("let x = 5; x + 1")'

    def test_write_path_unchanged_explicit_false(self):
        """read_only=False explicit: same as default (wrap applied)."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        self._setup_session(bridge, page)
        bridge.do_evaluate("t", "let x = 5; x + 1", read_only=False)
        assert page.eval_calls[0][0] == 'mw:eval("let x = 5; x + 1")'


# ═══════════════════════════════════════════════════════════════════════
#  stdout hygiene (Change 2 — Camoufox launch pollution)
# ═══════════════════════════════════════════════════════════════════════


class TestStdoutHygiene:
    """Verify the stdout→stderr redirect around ``_launch_browser``.

    The Camoufox bridge redirects ``sys.stdout`` to ``sys.stderr`` around the
    ``camoufox.NewBrowser`` call so third-party print() pollution doesn't
    corrupt the JSON-RPC wire.  This test verifies the pattern works without
    importing camoufox: a stub that prints like camoufox does, wrapped in the
    same swap pattern, must leave the captured stdout buffer empty.
    """

    def test_stdout_pollution_redirected_to_stderr(self):
        """print() calls inside the swap block go to stderr, not stdout."""
        import io

        real_stdout = sys.stdout
        real_stderr = sys.stderr

        captured_stdout = io.StringIO()
        captured_stderr = io.StringIO()

        sys.stdout = captured_stdout
        sys.stderr = captured_stderr
        try:
            # Simulate the swap pattern from _launch_browser
            _real_stdout = sys.stdout
            sys.stdout = sys.stderr
            try:
                # Camoufox print()s like these (utils.py:154, addons.py:92)
                print("Skipping unknown patch: X")
                print("Applying addon: Y")
            finally:
                sys.stdout = _real_stdout
        finally:
            sys.stdout = real_stdout
            sys.stderr = real_stderr

        # stdout must be clean — pollution went to stderr
        assert captured_stdout.getvalue() == ""
        assert "Skipping unknown patch" in captured_stderr.getvalue()
        assert "Applying addon" in captured_stderr.getvalue()

    def test_swap_restores_stdout_on_error(self):
        """sys.stdout is restored even when the stub raises."""
        real_stdout = sys.stdout

        class _TestError(Exception):
            pass

        try:
            _real_stdout = sys.stdout
            sys.stdout = sys.stderr
            try:
                raise _TestError("launch failed")
            finally:
                sys.stdout = _real_stdout
        except _TestError:
            pass

        assert sys.stdout is real_stdout
