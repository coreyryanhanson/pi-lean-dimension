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

import pytest

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


def _bind_session(bridge: _FakePlaywrightBridge, page: _FakePage) -> None:
    """Bind a fake page/context to ``task_id="t"`` on ``bridge``."""
    bridge.sessions["t"] = {"page": page, "context": _FakeContext()}


class _BareBridge(BrowserBridge):
    """Trivial concrete ``BrowserBridge`` for base-class handler tests."""

    def create_browser_session(self, task_id, config):  # pragma: no cover
        return {}

    def create_browser_context(self, config):  # pragma: no cover
        return None


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

    @pytest.mark.parametrize("init_arg", [{}, {"config": None}])
    def test_init_handler_defaults_to_empty_when_config_missing(self, init_arg):
        bridge = _FakePlaywrightBridge()
        result = bridge.handle_command("browser.init", init_arg, cmd_id=2)
        assert result["result"] == {"ok": True}
        assert bridge.plugin_config == {}

    def test_init_is_inherited_from_browser_bridge(self):
        """The handler lives on BrowserBridge (so non-Playwright bridges get it too)."""
        # A bare BrowserBridge can't be instantiated meaningfully (create_browser_session
        # is abstract), but the handler routing is on the base class.
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
    @pytest.mark.parametrize("flag,has_viewport,has_ua", [(False, True, True), (True, False, False)])
    def test_context_viewport_and_user_agent_presence(self, flag, has_viewport, has_ua):
        bridge = _FakePlaywrightBridge()
        bridge._fingerprint_managed_context = flag
        bridge.create_browser_context({})
        call = bridge._fake_browser.new_context_calls[-1]
        assert ("viewport" in call) == has_viewport
        if has_viewport:
            assert call["viewport"] == {"width": 1280, "height": 720}
        assert ("user_agent" in call) == has_ua

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
    def test_default_uses_eval_scrollby(self):
        bridge = _FakePlaywrightBridge()
        page = _FakePage()
        _bind_session(bridge, page)
        bridge.do_scroll("t", "down")
        assert page.mouse.wheel_calls == []
        assert len(page.eval_calls) == 1
        expr, arg = page.eval_calls[0]
        assert "window.scrollBy" in expr
        assert arg == 800

    @pytest.mark.parametrize("direction,expected_dy", [("down", 800), ("up", -800)])
    def test_scroll_via_wheel_uses_mouse_wheel(self, direction, expected_dy):
        bridge = _FakePlaywrightBridge()
        bridge._scroll_via_wheel = True
        page = _FakePage()
        _bind_session(bridge, page)
        bridge.do_scroll("t", direction)
        assert len(page.mouse.wheel_calls) == 1
        dx, dy = page.mouse.wheel_calls[0]
        assert dx == 0
        assert dy == expected_dy
        assert page.eval_calls == []  # no eval path taken


# ═══════════════════════════════════════════════════════════════════════
#  _eval_prefix
# ═══════════════════════════════════════════════════════════════════════


class TestEvalPrefix:
    @pytest.mark.parametrize("prefix,expression,eval_key,expected_result", [
        ("", "() => 1 + 1", "1 + 1", 2),
        ("mw:", "() => 1 + 1", "mw:", 2),
        ("mw:", "() => navigator.userAgent", "mw:", "UA-string"),
    ])
    def test_eval_prefix(self, prefix, expression, eval_key, expected_result):
        # Prefix is prepended unconditionally — writes and reads both get it.
        bridge = _FakePlaywrightBridge()
        bridge._eval_prefix = prefix
        page = _FakePage()
        page.eval_results = {eval_key: expected_result}
        _bind_session(bridge, page)
        result = bridge.do_evaluate("t", expression)
        assert result["success"]
        assert result["result"] == expected_result
        assert page.eval_calls[0][0] == prefix + expression


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

    @pytest.mark.parametrize("prefix,expected", [("", "let x = 5; x + 1"), ("mw:", "mw:let x = 5; x + 1")])
    def test_default_off_expression_unwrapped(self, prefix, expected):
        """Default off: expression is passed through unwrapped (bit-identical),
        with only the prefix prepended when set."""
        bridge = _FakePlaywrightBridge()
        bridge._eval_prefix = prefix
        page = _FakePage()
        _bind_session(bridge, page)
        bridge.do_evaluate("t", "let x = 5; x + 1")
        assert page.eval_calls[0][0] == expected
        assert len(page.eval_calls) == 1

    @pytest.mark.parametrize("prefix,script,expected_expr,eval_key,expected_result", [
        ("", "let x = 5; x + 1", 'eval("let x = 5; x + 1")', None, None),
        ("mw:", "let x = 5; x + 1", 'mw:eval("let x = 5; x + 1")', None, None),
        ("mw:", "3 + 4", 'mw:eval("3 + 4")', "eval(", 7),
    ])
    def test_flag_on_wraps_in_eval(self, prefix, script, expected_expr, eval_key, expected_result):
        """Flag on: expression becomes ``eval(<json>)`` (with ``_eval_prefix``
        prepended when set) — the production shape; a plain expression still
        round-trips its value."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = prefix
        page = _FakePage()
        if eval_key is not None:
            page.eval_results = {eval_key: expected_result}
        _bind_session(bridge, page)
        result = bridge.do_evaluate("t", script)
        assert page.eval_calls[0][0] == expected_expr
        assert len(page.eval_calls) == 1
        if expected_result is not None:
            assert result["success"] == True
            assert result["result"] == expected_result

    def test_flag_on_escapes_special_characters(self):
        """Flag on: quotes / newlines / backslashes in the script are JSON-escaped
        so the embedded string literal is always valid JS."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = "mw:"
        page = _FakePage()
        _bind_session(bridge, page)
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
        _bind_session(bridge, page)
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
        _bind_session(bridge, page)
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

    @pytest.mark.parametrize("overrides,expected", [
        (
            {},
            {"fingerprint_managed_context": False, "eval_prefix": "", "scroll_via_wheel": False, "skip_default_viewport": False, "skip_networkidle": False, "wrap_mw_eval_in_eval": False},
        ),
        (
            {"_fingerprint_managed_context": True, "_eval_prefix": "mw:", "_scroll_via_wheel": True, "_skip_default_viewport": True, "_skip_networkidle": True, "_wrap_mw_eval_in_eval": True},
            {"fingerprint_managed_context": True, "eval_prefix": "mw:", "scroll_via_wheel": True, "skip_default_viewport": True, "skip_networkidle": True, "wrap_mw_eval_in_eval": True},
        ),
        (
            {"_scroll_via_wheel": True, "_eval_prefix": "mw:"},
            {"scroll_via_wheel": True, "eval_prefix": "mw:", "fingerprint_managed_context": False, "skip_default_viewport": False, "skip_networkidle": False, "wrap_mw_eval_in_eval": False},
        ),
    ])
    def test_describe_quirks_surfaces_overrides(self, overrides, expected):
        """The handler surfaces overridden quirks alongside the defaults."""
        bridge = _FakePlaywrightBridge()
        for k, v in overrides.items():
            setattr(bridge, k, v)
        result = bridge.handle_command("browser.describeQuirks", {}, 1)
        assert "result" in result
        assert result["result"] == expected

    def test_bare_bridge_returns_all_defaults(self):
        """A bare ``BrowserBridge`` (no Playwright quirks attrs) also returns
        default values via ``getattr`` — the handler doesn't throw."""
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

    @pytest.mark.parametrize("prefix,wrap,eval_key,expected_result", [
        ("mw:", True, None, None),      # bypasses prefix and wrap
        ("", False, "1 + 1", 2),         # bit-identical to read_only=False
    ])
    def test_read_only_bypasses_prefix_and_wrap(self, prefix, wrap, eval_key, expected_result):
        """read_only=True: no mw: prefix, no eval() wrap — raw expression."""
        bridge = _FakePlaywrightBridge()
        bridge._eval_prefix = prefix
        bridge._wrap_mw_eval_in_eval = wrap
        page = _FakePage()
        if eval_key is not None:
            page.eval_results = {eval_key: expected_result}
        _bind_session(bridge, page)
        result = bridge.do_evaluate("t", "() => 1 + 1", read_only=True)
        assert page.eval_calls[0][0] == "() => 1 + 1"
        if expected_result is not None:
            assert result["success"]
            assert result["result"] == expected_result

    @pytest.mark.parametrize("prefix,read_only,expected_expr", [
        ("", None, 'eval("let x = 5; x + 1")'),         # default (no read_only arg)
        ("mw:", False, 'mw:eval("let x = 5; x + 1")'),   # explicit False
    ])
    def test_write_path_unchanged(self, prefix, read_only, expected_expr):
        """The write path (read_only unset or False) still applies the eval wrap."""
        bridge = _FakePlaywrightBridge()
        bridge._wrap_mw_eval_in_eval = True
        bridge._eval_prefix = prefix
        page = _FakePage()
        _bind_session(bridge, page)
        if read_only is None:
            bridge.do_evaluate("t", "let x = 5; x + 1")
        else:
            bridge.do_evaluate("t", "let x = 5; x + 1", read_only=read_only)
        assert page.eval_calls[0][0] == expected_expr


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


# ═══════════════════════════════════════════════════════════════════════
#  CSP-safe read-only eval (_csp_safe_readonly_via_init_script)
# ═══════════════════════════════════════════════════════════════════════


class _RecordingContext(_FakeContext):
    """``_FakeContext`` that records the init script passed to ``add_init_script``."""

    def __init__(self) -> None:
        super().__init__()
        self.init_scripts: list[str] = []

    def add_init_script(self, script: str) -> None:
        self.init_scripts.append(script)


class _FakeMeta:
    """Stand-in for the ``<meta id="__pi-extract">`` ElementHandle."""

    def __init__(self, content: str) -> None:
        self._content = content

    def get_attribute(self, name: str) -> str | None:
        if name == "content":
            return self._content
        return None


class _CspFakePage(_FakePage):
    """``_FakePage`` whose ``query_selector`` returns a canned meta element."""

    def __init__(self, meta_content: str | None) -> None:
        super().__init__()
        self._meta_content = meta_content
        self.query_calls: list[str] = []

    def query_selector(self, selector: str) -> _FakeMeta | None:
        self.query_calls.append(selector)
        if self._meta_content is None:
            return None
        return _FakeMeta(self._meta_content)


class TestCspSafeReadonlyViaInitScript:
    """Tests for the CSP-safe read-only eval quirk (patched-Firefox stealth
    binaries whose page.evaluate is CSP-blocked on strict sites)."""

    def test_default_off(self):
        """Shipped bridges keep the quirk off (bit-identical behaviour)."""
        assert not PlaywrightBridge._csp_safe_readonly_via_init_script

    def test_register_noops_without_script(self):
        """No ``readOnlyExtractorScript`` in config → no init script registered."""
        bridge = _FakePlaywrightBridge()
        bridge._plugin_config = {}
        ctx = _RecordingContext()
        bridge._register_readonly_extractor_init_script(ctx)
        assert ctx.init_scripts == []
        assert bridge._readonly_extractor_script == ""

    def test_register_strips_trailing_semicolon_and_uses_dcl(self):
        """The wrapper assigns the script directly (no wrapping parens that
        would put the script's trailing ``;`` inside parens → SyntaxError),
        and defers to ``DOMContentLoaded`` (not ``load``)."""
        bridge = _FakePlaywrightBridge()
        # A self-contained IIFE ending with a trailing ';' — the real
        # EXTRACTOR_SCRIPT shape.
        script = "(() => { return JSON.stringify({a:1}); })();"
        bridge._plugin_config = {"readOnlyExtractorScript": script}
        ctx = _RecordingContext()
        bridge._register_readonly_extractor_init_script(ctx)
        assert bridge._readonly_extractor_script == script
        assert len(ctx.init_scripts) == 1
        wrapper = ctx.init_scripts[0]
        # Direct assignment of the IIFE's return value — the script is
        # ``(() => {...})()`` so ``__r = (() =>`` is the correct shape.
        assert "__r = (() =>" in wrapper
        # The bug shape was ``__r = (<script>);`` which, with the script's
        # trailing ``;``, produced ``__r = (...})(););`` (a ``;`` inside
        # parens → SyntaxError → the whole init script silently no-ops).
        assert "})(););" not in wrapper
        # Defers to DOMContentLoaded, not the window load event (which does
        # not fire from the isolated world on the affected binary).
        assert "DOMContentLoaded" in wrapper
        assert "addEventListener('load'" not in wrapper
        assert "addEventListener(\"load\"" not in wrapper
        # Writes to the known meta tag.
        assert "__pi-extract" in wrapper

    def test_do_evaluate_read_only_serves_from_meta(self):
        """``do_evaluate(read_only=True)`` with the matching expression reads
        the stashed meta and returns the urldecoded JSON — no ``page.evaluate``."""
        from urllib.parse import quote
        bridge = _FakePlaywrightBridge()
        bridge._csp_safe_readonly_via_init_script = True
        script = "(() => { return JSON.stringify({title: 'x'}); })();"
        bridge._plugin_config = {"readOnlyExtractorScript": script}
        # Populate the registered-script gate.
        bridge._register_readonly_extractor_init_script(_RecordingContext())
        payload = '{"title": "Reddit Clone"}'
        page = _CspFakePage(meta_content=quote(payload))
        _bind_session(bridge, page)
        res = bridge.do_evaluate("t", script, read_only=True)
        assert res["success"] == True
        assert res["result"] == payload
        # The meta was read via the native query_selector (CSP-free).
        assert page.query_calls == ["meta#__pi-extract"]
        # page.evaluate was NOT called (CSP would block it).
        assert page.eval_calls == []

    @pytest.mark.parametrize("registered_script,sent_expression,eval_key,expected_result,expect_query", [
        # Expression doesn't match the gate → query_selector skipped → eval.
        ("REAL_EXTRACTOR;", "other expression", "other", "ok", False),
        # Expression matches the gate but meta is absent → eval best-effort.
        (
            "(() => { return JSON.stringify({a:1}); })();",
            "(() => { return JSON.stringify({a:1}); })();",
            "(() => { return JSON.stringify({a:1}); })();",
            "fallback",
            True,
        ),
    ])
    def test_do_evaluate_read_only_falls_through_to_eval(self, registered_script, sent_expression, eval_key, expected_result, expect_query):
        """A read_only eval that can't be served from the meta (expression
        doesn't match the gate, or the meta is absent) falls through to
        ``page.evaluate`` — no silent stale-meta return."""
        bridge = _FakePlaywrightBridge()
        bridge._csp_safe_readonly_via_init_script = True
        bridge._plugin_config = {"readOnlyExtractorScript": registered_script}
        bridge._register_readonly_extractor_init_script(_RecordingContext())
        page = _CspFakePage(meta_content=None)
        page.eval_results[eval_key] = expected_result
        _bind_session(bridge, page)
        res = bridge.do_evaluate("t", sent_expression, read_only=True)
        assert res["success"] == True
        assert res["result"] == expected_result
        if expect_query:
            assert page.query_calls == ["meta#__pi-extract"]
        else:
            assert page.query_calls == []
