"""
BrowserBridge — base class for Python browser automation backends.

Provides JSON-RPC command routing, session lifecycle, element caching,
and a ``run()`` main loop.  Subclasses override ``create_browser_session()``,
``create_browser_context()``, and the ``do_*`` operation methods to implement
specific browser backends (e.g. Chromium via Playwright, Camoufox, etc.).

Protocol
--------
All communication is JSON-RPC 2.0 over stdin/stdout with newline-delimited
framing.  See ``transport.py`` for details.

Lifecycle
---------
1. The TypeScript ``PythonPluginAdapter`` spawns the Python process.
2. The bridge starts its ``run()`` loop, waiting for commands.
3. First command is typically ``browser.navigate``, which calls
   ``create_browser_session()`` (if no session exists yet for that taskId)
   and then navigates.
4. Subsequent commands use the existing session.
5. ``browser.cleanup`` closes the session for a taskId.
6. ``browser.shutdown`` (sent via cleanupAll) terminates the process.

Subclass contract (all ``@abstractmethod``)
--------------------------------------------
* ``create_browser_session(task_id, config)`` — build a per-task session dict.
* ``create_browser_context(config)`` — build an isolated BrowserContext.
* ``do_navigate / do_snapshot / do_click / do_type / do_scroll / do_go_back
  / do_press / do_screenshot / do_get_console_messages / do_clear_console
  / do_evaluate / do_get_cookies / do_add_cookies / do_clear_cookies
  / do_get_storage_state`` — the 15 operation methods.  Each returns a
  dict whose shape is documented at the dispatch site (``_h_*`` handlers).
  ``do_cleanup`` has a concrete default (calls ``close_browser_session``)
  and need not be overridden.

Named profiles are fully handled by the TypeScript side via
``core/shared/storage-state.ts`` (disk persistence).  The Python
bridge receives ``storageState`` in the navigate request and applies
it when creating a new BrowserContext — it does NOT track shared
contexts across tasks.
"""

import traceback
from abc import ABC, abstractmethod
from typing import Any, Optional

from .transport import (
    read_request,
    write_response,
    make_success_response,
    make_error_response,
    make_parse_error,
    make_invalid_request,
    make_application_error,
    InvalidRequestError,
    METHOD_NOT_FOUND,
    INVALID_PARAMS,
    SESSION_ERROR,
)
from .accessibility import parse_snapshot, AriaParseResult

# ─── Default timeout ──────────────────────────────────────────────────

DEFAULT_NAVIGATION_TIMEOUT_MS: int = 30_000
DEFAULT_INTERACTION_TIMEOUT_MS: int = 10_000


class BrowserBridge(ABC):
    """Base class for Python browser automation bridges.

    Subclass this and override the abstract methods listed in the module
    docstring.  Call ``run()`` to start the JSON-RPC command loop.
    """

    # ── Session storage ─────────────────────────────────────────

    #: Per-taskId session data: {task_id: {...}}.
    #: The dict contents are backend-specific (page, context, etc.).
    #: You can store whatever you need here.
    sessions: dict[str, dict[str, Any]]

    #: Per-taskId element cache: {task_id: AriaParseResult}.
    element_caches: dict[str, AriaParseResult]

    #: Whether the bridge is still running.
    _running: bool

    #: Plugin configuration dict forwarded from the TypeScript adapter via
    #: the ``browser.init`` RPC.  Defaults to ``{}`` for bridges that never
    #: receive an init call (e.g. older adapters, or the shipped
    #: ``chromium-py``/``firefox-py`` when run standalone).  Subclasses read
    #: engine-specific options from ``self.plugin_config.get("launch", {})``.
    _plugin_config: dict[str, Any]

    def __init__(self) -> None:
        self.sessions = {}
        self.element_caches = {}
        self._running = False
        self._plugin_config = {}

    # ── Plugin config (forwarded via browser.init) ───────────────

    @property
    def plugin_config(self) -> dict[str, Any]:
        """Return the plugin config dict forwarded from the TypeScript adapter.

        Populated by the ``browser.init`` RPC handler.  Always returns a
        dict (empty when no init was received) so subclasses can safely
        call ``self.plugin_config.get("launch", {})``.
        """
        return self._plugin_config

    # ── Subclass hooks ──────────────────────────────────────────

    @abstractmethod
    def create_browser_session(self, task_id: str, config: dict[str, Any]) -> dict[str, Any]:
        """Create a new browser session for the given task.

        Must return a dict that will be stored in ``self.sessions[task_id]``.
        The dict is backend-specific (e.g. containing a Playwright page/context).
        """

    def close_browser_session(self, task_id: str) -> None:
        """Close and clean up the session for the given task.

        Default implementation removes the session from the dict.  Override
        to close browser pages/contexts before removal.
        """
        self.sessions.pop(task_id, None)
        self.element_caches.pop(task_id, None)

    @abstractmethod
    def create_browser_context(self, config: dict[str, Any]) -> Any:
        """Create a new isolated BrowserContext for a task session.

        Each task gets its own BrowserContext with no sharing between
        tasks.  Named profiles are handled by the TypeScript side via
        ``core/shared/storage-state.ts`` — the ``config`` may contain
        ``storageState`` to restore cookies and localStorage.
        """

    # ── Session helpers ─────────────────────────────────────────

    def get_session(self, task_id: str) -> Optional[dict[str, Any]]:
        """Get the session data for a task, or None."""
        return self.sessions.get(task_id)

    def require_session(self, task_id: str) -> dict[str, Any]:
        """Get the session for a task, raising SESSION_ERROR if absent."""
        session = self.get_session(task_id)
        if session is None:
            raise SessionNotFoundError(
                f"No active session for task '{task_id}'. "
                "Call browser.navigate first."
            )
        return session

    def ensure_session(self, task_id: str, config: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Get or create a session for the given task."""
        session = self.get_session(task_id)
        if session is not None:
            return session
        new_session = self.create_browser_session(task_id, config or {})
        self.sessions[task_id] = new_session
        return new_session

    def get_element_cache(self, task_id: str) -> Optional[AriaParseResult]:
        """Get the cached element parse result for a task, or None."""
        return self.element_caches.get(task_id)

    def set_element_cache(self, task_id: str, result: AriaParseResult) -> None:
        """Store a parsed element cache for a task."""
        self.element_caches[task_id] = result

    # ── Operation stubs (override in subclasses) ────────────────
    #
    # The 15 ``do_*`` methods below are the operation contract.  Each
    # returns a dict whose shape is enforced at the dispatch site
    # (``_h_*`` handlers in ``_DISPATCH``).  ``do_cleanup`` has a concrete
    # default and is not abstract.

    @abstractmethod
    def do_navigate(
        self,
        task_id: str,
        url: str,
        timeout_ms: int = DEFAULT_NAVIGATION_TIMEOUT_MS,
        storageState: Optional[dict[str, Any]] = None,
        profileName: Optional[str] = None,
        profileMode: Optional[str] = None,
    ) -> dict[str, Any]:
        """Navigate the browser to a URL."""

    @abstractmethod
    def do_snapshot(self, task_id: str) -> dict[str, Any]:
        """Take an accessibility snapshot of the current page."""

    @abstractmethod
    def do_click(self, task_id: str, ref: str) -> dict[str, Any]:
        """Click an element by @e ref."""

    @abstractmethod
    def do_type(self, task_id: str, ref: str, text: str) -> dict[str, Any]:
        """Type text into an element by @e ref."""

    @abstractmethod
    def do_scroll(self, task_id: str, direction: str) -> dict[str, Any]:
        """Scroll the page up or down."""

    @abstractmethod
    def do_go_back(self, task_id: str) -> dict[str, Any]:
        """Navigate back in history."""

    @abstractmethod
    def do_press(self, task_id: str, key: str) -> dict[str, Any]:
        """Press a keyboard key on the current page (or focused element)."""

    @abstractmethod
    def do_screenshot(self, task_id: str, full_page: bool = False) -> dict[str, Any]:
        """Take a screenshot of the current page (JPEG base64 data URI)."""

    @abstractmethod
    def do_get_console_messages(self, task_id: str) -> dict[str, Any]:
        """Get captured console messages."""

    @abstractmethod
    def do_clear_console(self, task_id: str) -> dict[str, Any]:
        """Clear captured console messages."""

    @abstractmethod
    def do_evaluate(
        self, task_id: str, expression: str, *, read_only: bool = False
    ) -> dict[str, Any]:
        """Evaluate JavaScript in the page."""

    @abstractmethod
    def do_get_cookies(
        self, task_id: str, urls: Optional[list[str]] = None
    ) -> dict[str, Any]:
        """Get all cookies, optionally filtered by URL."""

    @abstractmethod
    def do_add_cookies(
        self, task_id: str, cookies: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Add cookies to the browser context."""

    @abstractmethod
    def do_clear_cookies(
        self,
        task_id: str,
        name: Optional[str] = None,
        domain: Optional[str] = None,
        path: Optional[str] = None,
    ) -> dict[str, Any]:
        """Clear cookies, optionally filtered by name/domain/path."""

    @abstractmethod
    def do_get_storage_state(self, task_id: str) -> dict[str, Any]:
        """Get full storage state (cookies + localStorage + IndexedDB)."""

    def do_cleanup(self, task_id: str) -> dict[str, Any]:
        """Clean up resources for a specific task.

        Profile persistence is handled by the TypeScript side
        (``python-adapter.ts`` auto-saves storage state before calling
        cleanup), so this default always calls ``close_browser_session()``.
        """
        self.close_browser_session(task_id)
        return {"success": True}

    # ── Command handlers ────────────────────────────────────────
    #
    # One ``_h_*`` method per JSON-RPC method.  Each extracts params and
    # calls the matching ``do_*`` method.  ``_DISPATCH`` (class attribute,
    # built at the bottom of the class body) maps method name → handler.

    def _h_ping(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        return make_success_response(cmd_id, "pong")

    def _h_init(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        # Forward plugin config from the TypeScript adapter.  Sent exactly
        # once after the ping handshake, before any other RPC.
        self._plugin_config = params.get("config") or {}
        return make_success_response(cmd_id, {"ok": True})

    def _h_shutdown(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        self._running = False
        return make_success_response(cmd_id, "shutting_down")

    def _h_navigate(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        url = self._require_param(params, "url", str)
        task_id = self._require_param(params, "taskId", str)
        timeout_ms = params.get("timeoutMs", DEFAULT_NAVIGATION_TIMEOUT_MS)
        result = self.do_navigate(
            task_id, url, timeout_ms,
            storageState=params.get("storageState"),
            profileName=params.get("profileName"),
            profileMode=params.get("profileMode"),
        )
        return make_success_response(cmd_id, result)

    def _h_snapshot(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        return make_success_response(cmd_id, self.do_snapshot(task_id))

    def _h_click(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        ref = self._require_param(params, "ref", str)
        return make_success_response(cmd_id, self.do_click(task_id, ref))

    def _h_type(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        ref = self._require_param(params, "ref", str)
        text = self._require_param(params, "text", str)
        return make_success_response(cmd_id, self.do_type(task_id, ref, text))

    def _h_scroll(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        direction = self._require_param(params, "direction", str)
        if direction not in ("up", "down"):
            return make_error_response(
                cmd_id, INVALID_PARAMS,
                'direction must be "up" or "down"',
            )
        return make_success_response(cmd_id, self.do_scroll(task_id, direction))

    def _h_go_back(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        return make_success_response(cmd_id, self.do_go_back(task_id))

    def _h_press(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        key = self._require_param(params, "key", str)
        return make_success_response(cmd_id, self.do_press(task_id, key))

    def _h_screenshot(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        full_page = params.get("fullPage", False)
        return make_success_response(cmd_id, self.do_screenshot(task_id, full_page))

    def _h_get_console_messages(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        return make_success_response(cmd_id, self.do_get_console_messages(task_id))

    def _h_clear_console(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        return make_success_response(cmd_id, self.do_clear_console(task_id))

    def _h_evaluate(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        expression = self._require_param(params, "expression", str)
        read_only = bool(params.get("readOnly", False))
        result = self.do_evaluate(task_id, expression, read_only=read_only)
        return make_success_response(cmd_id, result)

    def _h_get_cookies(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        return make_success_response(cmd_id, self.do_get_cookies(task_id, params.get("urls")))

    def _h_add_cookies(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        cookies = self._require_param(params, "cookies", list)
        return make_success_response(cmd_id, self.do_add_cookies(task_id, cookies))

    def _h_clear_cookies(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        # No required params beyond taskId — empty call clears ALL cookies
        result = self.do_clear_cookies(
            task_id, params.get("name"), params.get("domain"), params.get("path")
        )
        return make_success_response(cmd_id, result)

    def _h_get_storage_state(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        return make_success_response(cmd_id, self.do_get_storage_state(task_id))

    def _h_cleanup(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        task_id = self._require_param(params, "taskId", str)
        return make_success_response(cmd_id, self.do_cleanup(task_id))

    def _h_describe_quirks(self, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        # Return the bridge's declared quirks flags.  Uses getattr with
        # defaults so a bare BrowserBridge (no Playwright quirks) returns
        # all-defaults rather than raising AttributeError.
        return make_success_response(cmd_id, {
            "fingerprint_managed_context": getattr(
                self, "_fingerprint_managed_context", False
            ),
            "eval_prefix": getattr(self, "_eval_prefix", ""),
            "scroll_via_wheel": getattr(self, "_scroll_via_wheel", False),
            "skip_default_viewport": getattr(self, "_skip_default_viewport", False),
            "skip_networkidle": getattr(self, "_skip_networkidle", False),
            "wrap_mw_eval_in_eval": getattr(self, "_wrap_mw_eval_in_eval", False),
            "csp_safe_readonly_via_init_script": getattr(
                self, "_csp_safe_readonly_via_init_script", False
            ),
        })

    #: JSON-RPC method name → handler.  Built after the handlers are
    #: defined so the names are in scope.  ``handle_command`` looks up
    #: here and calls ``handler(self, params, cmd_id)``.
    _DISPATCH = {
        "ping": _h_ping,
        "browser.init": _h_init,
        "shutdown": _h_shutdown,
        "browser.navigate": _h_navigate,
        "browser.snapshot": _h_snapshot,
        "browser.click": _h_click,
        "browser.type": _h_type,
        "browser.scroll": _h_scroll,
        "browser.goBack": _h_go_back,
        "browser.press": _h_press,
        "browser.screenshot": _h_screenshot,
        "browser.getConsoleMessages": _h_get_console_messages,
        "browser.clearConsole": _h_clear_console,
        "browser.evaluate": _h_evaluate,
        "browser.getCookies": _h_get_cookies,
        "browser.addCookies": _h_add_cookies,
        "browser.clearCookies": _h_clear_cookies,
        "browser.getStorageState": _h_get_storage_state,
        "browser.cleanup": _h_cleanup,
        "browser.describeQuirks": _h_describe_quirks,
    }

    # ── Command routing ─────────────────────────────────────────

    def handle_command(self, method: str, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        """Route a JSON-RPC method to the appropriate operation handler.

        Returns a JSON-RPC response dict (either result or error).
        """
        try:
            handler = self._DISPATCH.get(method)
            if handler is None:
                return make_error_response(
                    cmd_id, METHOD_NOT_FOUND, f"Method not found: {method}"
                )
            return handler(self, params, cmd_id)

        except SessionNotFoundError as exc:
            return make_error_response(cmd_id, SESSION_ERROR, str(exc))
        except NotImplementedError as exc:
            return make_application_error(cmd_id, str(exc))
        except Exception as exc:
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            return make_application_error(cmd_id, str(exc), traceback_str=tb)

    # ── Main loop ─────────────────────────────────────────────

    def run(self) -> None:
        """Start the main JSON-RPC command loop.

        Reads requests from stdin, dispatches them, and writes responses
        to stdout.  Runs until EOF or a ``shutdown`` command.
        """
        self._running = True
        while self._running:
            try:
                request = read_request()
                if request is None:
                    break  # EOF

                cmd_id = request.get("id")
                method = request.get("method", "")
                params = request.get("params", {})

                if not isinstance(params, dict):
                    write_response(make_error_response(
                        cmd_id, INVALID_PARAMS,
                        '"params" must be a JSON object',
                    ))
                    continue

                response = self.handle_command(method, params, cmd_id)
                write_response(response)

            except InvalidRequestError:
                # Valid JSON but not a valid JSON-RPC Request object
                write_response(make_invalid_request(None))
            except ValueError:
                # JSON parse error
                write_response(make_parse_error(None))
            except EOFError:
                break
            except KeyboardInterrupt:
                break
            except Exception as exc:
                tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
                write_response(make_application_error(None, str(exc), traceback_str=tb))

    # ── Internal helpers ──────────────────────────────────────

    @staticmethod
    def _require_param(
        params: dict[str, Any],
        key: str,
        expected_type: type,
    ) -> Any:
        """Require a param to exist and be of the expected type.

        Raises ``InvalidParamsError`` if the param is missing or has the
        wrong type.  The caller's ``except Exception`` clause turns this
        into a JSON-RPC application-error response.
        """
        if key not in params:
            raise InvalidParamsError(f'Missing required parameter: "{key}"')
        value = params[key]
        if not isinstance(value, expected_type):
            raise InvalidParamsError(
                f'Parameter "{key}" must be of type {expected_type.__name__}, '
                f"got {type(value).__name__}"
            )
        return value


# ─── Custom exceptions ────────────────────────────────────────────────

class SessionNotFoundError(Exception):
    """Raised when an operation requires a session but none exists."""


class InvalidParamsError(Exception):
    """Raised when a required parameter is missing or has the wrong type."""
