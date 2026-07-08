"""
BrowserBridge — base class for Python browser automation backends.

Provides JSON-RPC command routing, session lifecycle, element caching,
and a ``run()`` main loop.  Subclasses override ``create_browser_session()``
and individual operation methods to implement specific browser backends
(e.g. Chromium via Playwright, Camoufox, etc.).

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
"""

import inspect
import sys
import traceback
from typing import Any, Optional

from .transport import (
    read_request,
    write_response,
    make_success_response,
    make_error_response,
    make_parse_error,
    make_invalid_request,
    make_internal_error,
    make_application_error,
    InvalidRequestError,
    APPLICATION_ERROR,
    METHOD_NOT_FOUND,
    INVALID_PARAMS,
    SESSION_ERROR,
)
from .accessibility import parse_snapshot, AriaParseResult

# ─── Default timeout ──────────────────────────────────────────────────

DEFAULT_NAVIGATION_TIMEOUT_MS: int = 30_000
DEFAULT_INTERACTION_TIMEOUT_MS: int = 10_000


class BrowserBridge:
    """Base class for Python browser automation bridges.

    Subclass this and override:

    * ``create_browser_session(task_id, config)`` — mandatory
    * ``create_browser_context(config)`` — mandatory (creates isolated context per task)
    * Any operation methods you want to customise (optional)
    * ``close_browser_session(task_id)`` — optional (default unregisters)

    Call ``run()`` to start the JSON-RPC command loop.

        Named profiles are fully handled by the TypeScript side via
    ``core/shared/storage-state.ts`` (disk persistence).  The Python
    bridge receives ``storageState`` in the navigate request and applies
    it when creating a new BrowserContext — it does NOT track shared
    contexts across tasks.
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

    def create_browser_session(self, task_id: str, config: dict[str, Any]) -> dict[str, Any]:
        """Create a new browser session for the given task.

        Must return a dict that will be stored in ``self.sessions[task_id]``.
        The dict is backend-specific (e.g. containing a Playwright page/context).

        Raises:
            RuntimeError: if a session cannot be created.
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement create_browser_session()"
        )

    def close_browser_session(self, task_id: str) -> None:
        """Close and clean up the session for the given task.

        Default implementation removes the session from the dict.  Override
        to close browser pages/contexts before removal.
        """
        self.sessions.pop(task_id, None)
        self.element_caches.pop(task_id, None)

    def create_browser_context(self, config: dict[str, Any]) -> Any:
        """Create a new isolated BrowserContext for a task session.

        Each task gets its own BrowserContext with no sharing between
        tasks.  Named profiles are handled by the TypeScript side via
        ``core/shared/storage-state.ts`` — the ``config`` may contain
        ``storageState`` to restore cookies and localStorage.

        Args:
            config: Configuration dict (may contain ``storageState``,
                    ``viewport``, ``userAgent``, etc.)

        Returns:
            A backend-specific BrowserContext object.

        Raises:
            NotImplementedError: if the subclass doesn't implement this.
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement create_browser_context()"
        )

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

    # ── Page session setup hook ──────────────────────────────────

    def _setup_page_session(self, page: Any) -> dict[str, Any]:
        """Set up event handlers (console capture, dialog dismissal) on a new page.

        Base implementation returns a minimal session dict.  Subclasses
        (e.g. ChromiumPyBridge) override this to attach console-message
        accumulators and dialog handlers.
        """
        return {"page": page}

    def get_element_cache(self, task_id: str) -> Optional[AriaParseResult]:
        """Get the cached element parse result for a task, or None."""
        return self.element_caches.get(task_id)

    def set_element_cache(self, task_id: str, result: AriaParseResult) -> None:
        """Store a parsed element cache for a task."""
        self.element_caches[task_id] = result

    # ── Operation stubs (override in subclasses) ────────────────

    def do_navigate(
        self,
        task_id: str,
        url: str,
        timeout_ms: int = DEFAULT_NAVIGATION_TIMEOUT_MS,
        storageState: Optional[dict[str, Any]] = None,
        profileName: Optional[str] = None,
        profileMode: Optional[str] = None,
    ) -> dict[str, Any]:
        """Navigate the browser to a URL.

        Subclasses interpret the extra params:

        - ``storageState``: Playwright storage state for session restoration.
        - ``profileName``: Named profile name (e.g. "work", "shopping").
        - ``profileMode``: ``"none"`` / ``"session"`` / ``"named"``.
          All modes create task-isolated BrowserContexts; named profiles
          are handled by the TypeScript side via ``storageState``
          (``core/shared/storage-state.ts``, disk persistence).

        Must return a dict with keys:
            success (bool), url (str), title (str),
            snapshot (str), elementCount (int)
        Optionally: botDetected (bool), profileName (str)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_navigate()"
        )

    def do_snapshot(self, task_id: str) -> dict[str, Any]:
        """Take an accessibility snapshot of the current page.

        Must return a dict with keys:
            success (bool), snapshot (str), elementCount (int)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_snapshot()"
        )

    def do_click(self, task_id: str, ref: str) -> dict[str, Any]:
        """Click an element by @e ref.

        Must return a dict with keys:
            success (bool)
        Optionally: snapshot (str), elementCount (int), newUrl (str), newTitle (str)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_click()"
        )

    def do_type(self, task_id: str, ref: str, text: str) -> dict[str, Any]:
        """Type text into an element by @e ref.

        Must return a dict with keys:
            success (bool)
        Optionally: snapshot (str), elementCount (int), newUrl (str), newTitle (str)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_type()"
        )

    def do_scroll(self, task_id: str, direction: str) -> dict[str, Any]:
        """Scroll the page up or down.

        Must return a dict with keys:
            success (bool)
        Optionally: snapshot (str), elementCount (int), newUrl (str), newTitle (str)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_scroll()"
        )

    def do_go_back(self, task_id: str) -> dict[str, Any]:
        """Navigate back in history.

        Must return a dict with keys:
            success (bool)
        Optionally: snapshot (str), elementCount (int), newUrl (str), newTitle (str)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_go_back()"
        )

    def do_press(self, task_id: str, key: str) -> dict[str, Any]:
        """Press a keyboard key on the current page (or focused element).

        Must return a dict with keys:
            success (bool)
        Optionally: snapshot (str), elementCount (int), newUrl (str), newTitle (str)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_press()"
        )

    def do_screenshot(
        self,
        task_id: str,
        full_page: bool = False,
    ) -> dict[str, Any]:
        """Take a screenshot of the current page.

        Must return a dict with keys:
            success (bool), dataUri (str) — JPEG base64 data URI
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_screenshot()"
        )

    def do_get_console_messages(self, task_id: str) -> dict[str, Any]:
        """Get captured console messages.

        Must return a dict with keys:
            success (bool), messages (list) — each with type, text
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_get_console_messages()"
        )

    def do_clear_console(self, task_id: str) -> dict[str, Any]:
        """Clear captured console messages.

        Must return a dict with keys:
            success (bool)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_clear_console()"
        )

    def do_evaluate(self, task_id: str, expression: str) -> dict[str, Any]:
        """Evaluate JavaScript in the page.

        Must return a dict with keys:
            success (bool)
        Optionally: result (any)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_evaluate()"
        )

    def do_get_cookies(
        self, task_id: str, urls: Optional[list[str]] = None
    ) -> dict[str, Any]:
        """Get all cookies, optionally filtered by URL.

        Must return a dict with keys:
            success (bool), cookies (list) — each with name, value, domain, ...
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_get_cookies()"
        )

    def do_add_cookies(
        self, task_id: str, cookies: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Add cookies to the browser context.

        Must return a dict with keys:
            success (bool)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_add_cookies()"
        )

    def do_clear_cookies(
        self,
        task_id: str,
        name: Optional[str] = None,
        domain: Optional[str] = None,
        path: Optional[str] = None,
    ) -> dict[str, Any]:
        """Clear cookies, optionally filtered by name/domain/path.

        Must return a dict with keys:
            success (bool)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_clear_cookies()"
        )

    def do_get_storage_state(self, task_id: str) -> dict[str, Any]:
        """Get full storage state (cookies + localStorage + IndexedDB).

        Must return a dict with keys:
            success (bool), cookies (list), origins (list)
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement do_get_storage_state()"
        )



    def do_cleanup(self, task_id: str) -> dict[str, Any]:
        """Clean up resources for a specific task.

        Profile persistence is handled by the TypeScript side
        (``python-adapter.ts`` auto-saves storage state before calling
        cleanup), so this method always calls ``close_browser_session()``.

        Must return a dict with keys:
            success (bool)
        """
        self.close_browser_session(task_id)
        return {"success": True}

    # ── Command routing ─────────────────────────────────────────

    def handle_command(self, method: str, params: dict[str, Any], cmd_id: Any) -> dict[str, Any]:
        """Route a JSON-RPC method to the appropriate operation handler.

        Returns a JSON-RPC response dict (either result or error).
        """
        try:
            if method == "ping":
                return make_success_response(cmd_id, "pong")

            if method == "browser.init":
                # Forward plugin config from the TypeScript adapter.
                # The adapter sends this exactly once after the ping
                # handshake, before any other RPC.  Subclasses read
                # engine-specific launch options from
                # ``self.plugin_config.get("launch", {})``.
                self._plugin_config = params.get("config") or {}
                return make_success_response(cmd_id, {"ok": True})

            if method == "shutdown":
                self._running = False
                return make_success_response(cmd_id, "shutting_down")

            if method == "browser.navigate":
                url = self._require_param(params, "url", str, cmd_id)
                task_id = self._require_param(params, "taskId", str, cmd_id)
                timeout_ms = params.get("timeoutMs", DEFAULT_NAVIGATION_TIMEOUT_MS)
                storage_state = params.get("storageState")
                profile_name = params.get("profileName")
                profile_mode = params.get("profileMode")
                result = self.do_navigate(
                    task_id, url, timeout_ms,
                    storageState=storage_state,
                    profileName=profile_name,
                    profileMode=profile_mode,
                )
                return make_success_response(cmd_id, result)

            if method == "browser.snapshot":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                result = self.do_snapshot(task_id)
                return make_success_response(cmd_id, result)

            if method == "browser.click":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                ref = self._require_param(params, "ref", str, cmd_id)
                result = self.do_click(task_id, ref)
                return make_success_response(cmd_id, result)

            if method == "browser.type":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                ref = self._require_param(params, "ref", str, cmd_id)
                text = self._require_param(params, "text", str, cmd_id)
                result = self.do_type(task_id, ref, text)
                return make_success_response(cmd_id, result)

            if method == "browser.scroll":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                direction = self._require_param(params, "direction", str, cmd_id)
                if direction not in ("up", "down"):
                    return make_error_response(
                        cmd_id, INVALID_PARAMS,
                        'direction must be "up" or "down"',
                    )
                result = self.do_scroll(task_id, direction)
                return make_success_response(cmd_id, result)

            if method == "browser.goBack":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                result = self.do_go_back(task_id)
                return make_success_response(cmd_id, result)

            if method == "browser.press":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                key = self._require_param(params, "key", str, cmd_id)
                result = self.do_press(task_id, key)
                return make_success_response(cmd_id, result)

            if method == "browser.screenshot":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                full_page = params.get("fullPage", False)
                result = self.do_screenshot(task_id, full_page)
                return make_success_response(cmd_id, result)

            if method == "browser.getConsoleMessages":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                result = self.do_get_console_messages(task_id)
                return make_success_response(cmd_id, result)

            if method == "browser.clearConsole":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                result = self.do_clear_console(task_id)
                return make_success_response(cmd_id, result)

            if method == "browser.evaluate":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                expression = self._require_param(params, "expression", str, cmd_id)
                result = self.do_evaluate(task_id, expression)
                return make_success_response(cmd_id, result)

            if method == "browser.getCookies":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                urls = params.get("urls")
                result = self.do_get_cookies(task_id, urls)
                return make_success_response(cmd_id, result)

            if method == "browser.addCookies":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                cookies = self._require_param(params, "cookies", list, cmd_id)
                result = self.do_add_cookies(task_id, cookies)
                return make_success_response(cmd_id, result)

            if method == "browser.clearCookies":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                name = params.get("name")
                domain = params.get("domain")
                path = params.get("path")
                # No required params beyond taskId — empty call clears ALL cookies
                result = self.do_clear_cookies(task_id, name, domain, path)
                return make_success_response(cmd_id, result)

            if method == "browser.getStorageState":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                result = self.do_get_storage_state(task_id)
                return make_success_response(cmd_id, result)

            if method == "browser.cleanup":
                task_id = self._require_param(params, "taskId", str, cmd_id)
                result = self.do_cleanup(task_id)
                return make_success_response(cmd_id, result)

            # Unknown method
            return make_error_response(
                cmd_id,
                METHOD_NOT_FOUND,
                f"Method not found: {method}",
            )

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
        cmd_id: Any,
    ) -> Any:
        """Require a param to exist and be of the expected type.

        Raises a JSON-RPC invalid params error if the param is missing
        or has the wrong type.
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
