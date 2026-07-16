"""
PlaywrightBridge — Python browser automation bridge for Playwright-based backends.

Provides JSON-RPC command routing, session lifecycle, element caching,
and a ``run()`` main loop.  ``PlaywrightBridge`` is a concrete base
class that subclasses override with engine-specific settings:

* ``_plugin_name`` — e.g. ``"chromium-py"``, ``"firefox-py"``
* ``_user_agent`` — fallback UA string (when dynamic probe is disabled or fails)
* ``_capture_user_agent`` — bool; if True the real UA is probed at lazy browser init
* ``_install_hint`` — engine-specific install instruction
* ``_launch_browser()`` — calls ``self._pw.chromium.launch()`` or ``self._pw.firefox.launch()``

All navigation, interaction, console, cookie, and storage operations
are shared across engines.

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

Named profiles are fully handled by the TypeScript side via
``core/shared/storage-state.ts`` (disk persistence).  The Python
bridge receives ``storageState`` in the navigate request and applies
it when creating a new BrowserContext — it does NOT track shared
contexts across tasks.
"""

import base64
import json
import os
import re
import sys
import time
import traceback
from typing import Any, Optional
from urllib.parse import unquote as _urlunquote

from .bot_detection import check_bot_detection
from .accessibility import parse_snapshot, build_locator_args, AriaParseResult
from .browser_data import NAV_SETTLE
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

# ─── Playwright import (lazy, for better error messages) ──────────────

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout  # type: ignore[import-unresolved]
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False
    sync_playwright = None  # type: ignore[assignment]
    PlaywrightTimeout = TimeoutError  # type: ignore[misc]


# ─── Default timeout ──────────────────────────────────────────────────

DEFAULT_NAVIGATION_TIMEOUT_MS: int = 30_000
DEFAULT_INTERACTION_TIMEOUT_MS: int = 10_000


# ─── Nav-settle constants (loaded from shared browser-data.json) ──────

_DOM_STABILIZE_JS: str = NAV_SETTLE["domStabilizationJs"]


# ─── Custom exceptions ────────────────────────────────────────────────


class SessionNotFoundError(Exception):
    """Raised when an operation requires a session but none exists."""


class InvalidParamsError(Exception):
    """Raised when a required parameter is missing or has the wrong type."""


# ─── Shared helper for bridge entry points ───────────────────────────


def check_playwright_or_exit(browser: str) -> None:
    """Check Playwright is installed; print JSON-RPC error and exit if not.

    Intended for use in bridge ``if __name__ == "__main__"`` blocks to give
    the TypeScript ``PythonPluginAdapter`` an immediate, parseable error
    before the bridge tries to start.

    Args:
        browser: The browser channel name (e.g. ``"chromium"``, ``"firefox"``).
    """
    if not HAS_PLAYWRIGHT:
        msg = (
            f"ERROR: Playwright {browser} is not installed.\n"
            "Run the following commands to install:\n"
            "  pip install playwright\n"
            f"  playwright install {browser}\n"
        )
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32000, "message": msg.strip()},
        }))
        sys.stdout.flush()
        sys.exit(1)


class PlaywrightBridge:
    """Base class for Playwright-based browser bridges.

    Subclasses must set these class/instance attributes:

    * ``_plugin_name`` — log identifier (e.g. ``"chromium-py"``,
      ``"firefox-py"``)
    * ``_user_agent`` — fallback UA string (used when dynamic probe
      is disabled or fails)
    * ``_capture_user_agent`` — bool; when True the real UA is
      dynamically probed from an about:blank page at lazy browser init
    * ``_install_hint`` — shown when the browser executable is missing
    * ``_launch_browser()`` — factory for creating the Playwright
      Browser; called from ``_ensure_playwright()`` with the
      ``sync_playwright`` context already started (``self._pw`` is
      available).

    ``_plugin_name`` appears in ``_log()`` calls as ``plugin=self._plugin_name``
    so the debug output identifies which plugin is logging.
    """

    # ── Subclass contract ─────────────────────────────────────────

    #: Plugin identifier for log output (e.g. "chromium-py", "firefox-py").
    _plugin_name: str = ""

    #: Fallback user-agent string (used when ``_capture_user_agent`` is False or the dynamic probe fails).
    _user_agent: str = ""

    #: When True, dynamically probes the real UA from an about:blank page at lazy browser init.
    #: Set for engines (like Firefox) whose UA may change across Playwright versions.
    _capture_user_agent: bool = False

    #: Engine-specific install hint (shown when browser executable missing).
    _install_hint: str = ""

    # ── Stealth quirks ───────────────────────────────────────────────
    #
    # These opt-in flags let stealth subclasses (Camoufox and other stealth engines)
    # disable the base's hard-coded Playwright defaults that would otherwise
    # clobber a fingerprint-managed browser context.  All default to ``off``
    # so the shipped ``chromium-py`` / ``firefox-py`` bridges are bit-identical.
    #
    # See the portal AGENTS.md quirks table for the concrete
    # correctness problem each flag fixes.

    #: When True, ``create_browser_context()`` does NOT pass ``viewport`` or
    #: ``user_agent`` to ``new_context`` — the fingerprint package (e.g.
    #: Camoufox at browser launch via ``NewBrowser``) generates those from
    #: the fingerprint, and the base's hard-coded
    #: values would override them with a detectable mismatch.
    _fingerprint_managed_context: bool = False

    #: Prefix prepended to every ``page.evaluate`` expression in ``do_evaluate``.
    #: Camoufox runs eval in an isolated world with read-only page access by
    #: default; ``"mw:"`` routes the script to the main world where writes work.
    #: Reads work with the prefix too, so it's safe to apply unconditionally.
    #: Empty string = no prefix (the shipped bridges).
    _eval_prefix: str = ""

    #: When True, ``do_scroll`` uses ``page.mouse.wheel`` instead of
    #: ``page.evaluate("window.scrollBy")``.  The eval-based scroll is a
    #: write that silently no-ops under Camoufox's isolated world; the wheel
    #: event performs the scroll via input events instead.
    _scroll_via_wheel: bool = False

    #: When True, ``create_browser_context`` passes ``no_viewport=True`` to
    #: ``browser.new_context()``, telling Playwright to skip the
    #: ``Browser.setDefaultViewport`` CDP call.  The Camoufox patched Firefox
    #: binary does not accept the ``isMobile`` property that Playwright Firefox
    #: includes in ``setDefaultViewport``, which would otherwise cause a
    #: ``Protocol error`` on context creation.  Other backends that patch
    #: ``new_context`` do not need this flag;
    #: only set it when the binary rejects the default viewport call.
    #: Default ``False`` so the shipped bridges stay bit-identical.
    _skip_default_viewport: bool = False

    #: When True, navigation-settle waits skip the ``networkidle`` load state.
    #: The patched Firefox binaries used by some stealth backends
    #: do not fire ``networkidle`` reliably, so waiting for it either
    #: times out (``do_go_back``'s 30s default) or loiters in the Playwright sync
    #: greenlet's event loop long enough to deadlock the Juggler driver when a
    #: subsequent BrowserContext's ``new_page()`` is created.  When True,
    #: ``do_go_back`` uses ``wait_until="load"`` and ``_wait_for_page_ready``
    #: skips its ``networkidle`` wait — matching ``do_navigate``'s load-based
    #: settle, which works reliably on the patched binaries.  Default ``False``
    #: so the shipped chromium-py / firefox-py bridges keep their networkidle
    #: settle behaviour bit-identical.
    _skip_networkidle: bool = False

    #: When True, ``do_evaluate`` wraps the expression in ``eval(<json>)``
    #: before prepending :attr:`_eval_prefix` **and** enables a one-retry
    #: recovery on genuine ``Execution context was destroyed`` errors.
    #: Default ``False`` so the shipped ``chromium-py`` / ``firefox-py``
    #: bridges (which have ``_eval_prefix = ""``) stay bit-identical.
    #:
    #: **Layer 1 — SyntaxError class (``eval(<json>)`` wrap).**  Camoufox's
    #: patched Juggler main-world eval path
    #: (``MainWorldContext.executeInGlobal`` in the binary's ``omni.ja``)
    #: wraps every ``mw:``-prefixed script as
    #: ``(() => { let _s = (${script}); ... })()``.  That wrapper requires
    #: ``${script}`` to be a single *expression*; any *statement* (``let`` /
    #: ``var`` / multiple ``;``-separated statements) is a ``SyntaxError``
    #: (``missing ) in parenthetical``) that surfaces through Playwright as
    #: ``"Execution context was destroyed, most likely because of a
    #: navigation."`` — an uncatchable-looking error that is NOT a navigation
    #: race at all.  Rewriting the script as ``eval(<JSON-string of script>)``
    #: makes it a single expression (valid inside ``let _s = (...)``) while
    #: ``eval`` itself correctly handles both expressions and multi-statement
    #: scripts, returning the completion value of the last statement.
    #: This class is **terminal** — a SyntaxError after the wrap means the
    #: wrap itself is broken and there is no retry.
    #:
    #: **Layer 2 — Genuine context-destruction class (retry).**  On a
    #: bot-detection challenge page the page may settle-navigate after
    #: ``browser.navigate`` returns, destroying the ``mw:`` eval context
    #: between the snapshot and a subsequent ``browser.inspect`` or
    #: ``browser-console`` call.  The error string is identical to Layer 1
    #: (both produce ``"Execution context was destroyed…"`` through
    #: Playwright) but the class is **transient** — a single
    #: ``wait_for_load_state("load")`` + one ``page.evaluate`` retry
    #: succeeds once the challenge settles.  ``do_evaluate`` distinguishes
    #: the two classes in its ``except`` handler: a retry is attempted
    #: only when ``_wrap_mw_eval_in_eval`` is True (Camoufox-only; shipped
    #: bridges never hit the ``mw:`` path) and only for the transient class.
    #: See ``do_evaluate`` for the implementation.
    _wrap_mw_eval_in_eval: bool = False

    #: When True, read-only evals (``do_evaluate(read_only=True)``, used
    #: only for the EXTRACTOR_SCRIPT) bypass ``page.evaluate`` entirely and
    #: read a result that an ``add_init_script`` stashed in the DOM.
    #:
    #: **Why this exists.** Some patched-Firefox stealth binaries route
    #: ``page.evaluate`` through ``eval()`` in the page's *main* world (a
    #: stealth measure that kills Juggler's isolated-world debugger
    #: signature).  The page's CSP then applies, so on CSP-strict sites
    #: (e.g. Reddit, which forbids ``unsafe-eval``) every ``page.evaluate``
    #: fails with ``"call to eval() blocked by CSP"``.  Camoufox is NOT
    #: affected — its binary keeps Juggler's CSP-free isolated-world and
    #: ``MainWorldContext.executeInGlobal`` paths; other patched-Firefox
    #: stealth binaries are affected.
    #:
    #: **How it works.** ``create_browser_context`` calls
    #: :meth:`_register_readonly_extractor_init_script`, which wraps the
    #: EXTRACTOR_SCRIPT (plumbed from the TypeScript side via the
    #: ``browser.init`` config key ``readOnlyExtractorScript``) in a
    #: ``DOMContentLoaded``-deferred IIFE that writes its JSON result to
    #: ``<meta id="__pi-extract" content="<urlencoded JSON>">``.  The init
    #: script runs in the isolated world, which is CSP-free.
    #: ``do_evaluate(read_only=True)`` then reads that meta via
    #: ``page.query_selector`` + ``get_attribute`` — both native Juggler
    #: element commands, also CSP-free — instead of calling
    #: ``page.evaluate``.
    #:
    #: **Limitation.** The meta is repopulated only on a full document
    #: load (``page.goto``); SPA-style in-page route changes do NOT re-run
    #: the init script, so the stashed result goes stale until the next
    #: ``browser-navigate``.  For the navigate→inspect agent flow this is
    #: fine; document with a ``ponytail:`` note if you lift it.
    #: Default ``False`` so shipped bridges stay bit-identical.
    _csp_safe_readonly_via_init_script: bool = False


    # ── Session storage (persists across RPC calls) ─────────────

    #: Per-taskId session data: {task_id: {...}}.
    #: The dict contents are backend-specific (page, context, etc.).
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


    # ── Shared Playwright state ─────────────────────────────────

    _pw: Any  # Playwright instance (lazy, shared)
    _browser: Any  # Browser instance (lazy, shared)

    def __init__(self) -> None:
        self.sessions = {}
        self.element_caches = {}
        self._running = False
        self._plugin_config = {}
        self._pw = None
        self._browser = None
        self._cached_ua: str = ""
        # The read-only extractor script plumbed from the TypeScript side
        # via the ``browser.init`` config key ``readOnlyExtractorScript``.
        # Populated lazily by _register_readonly_extractor_init_script;
        # used by do_evaluate to gate the CSP-free meta handoff so a
        # non-extractor read_only eval (none today) can't silently receive
        # the extractor's stale result.
        self._readonly_extractor_script: str = ""

    # ── Plugin config (forwarded via browser.init) ───────────────

    @property
    def plugin_config(self) -> dict[str, Any]:
        """Return the plugin config dict forwarded from the TypeScript adapter.

        Populated by the ``browser.init`` RPC handler.  Always returns a
        dict (empty when no init was received) so subclasses can safely
        call ``self.plugin_config.get("launch", {})``.
        """
        return self._plugin_config

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

    # ── Subclass extension point ───────────────────────────────

    def _launch_browser(self) -> Any:
        """Create and return a Playwright Browser.

        Called from ``_ensure_playwright()`` after ``self._pw`` has been
        started.  Subclasses must call ``self._pw.chromium.launch(...)``
        or ``self._pw.firefox.launch(...)`` with engine-specific args.

        Raises:
            Exception: if the browser executable cannot be found or
                launched.  The base class catches this and re-raises with
                the engine-specific ``_install_hint``.
        """
        raise NotImplementedError("Subclass must override _launch_browser")

    # ── User-agent capture (probe-then-cache) ──────────────────────

    @property
    def effective_user_agent(self) -> str:
        """Return the cached dynamic UA, or the hardcoded fallback.

        When ``_capture_user_agent`` is True and the probe succeeded,
        returns the UA captured from an about:blank page.  Otherwise
        falls back to ``_user_agent``.
        """
        return self._cached_ua or self._user_agent

    def _capture_ua(self) -> None:
        """Dynamically probe the real user-agent from a throwaway about:blank page.

        Called once at lazy browser init when ``_capture_user_agent`` is True.
        Silently falls back to ``_user_agent`` on failure.
        """
        if self._cached_ua:
            return
        page = None
        try:
            page = self._browser.new_page()
            self._cached_ua = page.evaluate("() => navigator.userAgent")
            self._log("captureUA", success=True, ua=self._cached_ua)
        except Exception:
            self._log("captureUA", success=False, ua="(fallback)")
        finally:
            if page is not None:
                try:
                    page.close()
                except Exception:
                    pass


    # ── Debug logging ───────────────────────────────────────────

    @property
    def _debug(self) -> bool:
        """Whether structured debug logging is enabled."""
        return os.environ.get("BROWSER_DEBUG") == "1"

    def _log(self, event: str, **data: Any) -> None:
        """Structured debug log to stderr when BROWSER_DEBUG=1."""
        if self._debug:
            print(
                f"[browser] {event}: {json.dumps(data, default=str)}",
                file=sys.stderr,
                flush=True,
            )

    def _log_op(self, event: str, ctx: dict, result: dict) -> dict:
        """Log result and return it. Replaces success/failure _log pairs."""
        if self._debug:
            log_data = dict(ctx)
            log_data["success"] = result.get("success", False)
            if result.get("error"):
                log_data["error"] = result["error"]
            self._log(event, **log_data)
        return result

    # ── Shared Playwright lifecycle ────────────────────────────

    def _ensure_playwright(self) -> tuple[Any, Any]:
        """Return the shared ``(pw, browser)`` pair, starting if needed.

        Wraps ``_launch_browser()`` with install-error detection: if the
        executable is missing, re-raises with the engine-specific
        ``_install_hint``.
        """
        if self._pw is None:
            if not HAS_PLAYWRIGHT:
                raise RuntimeError(
                    "Playwright is not installed. "
                    "Run: pip install playwright && "
                    + (self._install_hint.lower() if self._install_hint else "playwright install <browser>")
                )
            self._pw = sync_playwright().start()  # type: ignore[union-attr]
            try:
                self._browser = self._launch_browser()
            except Exception as _exc:
                if re.search(
                    r"Executable doesn't exist|browserType\.launch",
                    str(_exc),
                    re.IGNORECASE,
                ):
                    raise RuntimeError(self._install_hint) from _exc
                raise
        # Probe UA at first launch (Firefox opt-in)
        if self._capture_user_agent:
            self._capture_ua()
        return self._pw, self._browser

    def _maybe_stop_playwright(self) -> None:
        """Stop the shared Playwright if no sessions remain."""
        if not self.sessions and self._pw is not None:
            try:
                if self._browser:
                    self._browser.close()
            except Exception:
                pass
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None
            self._browser = None

    # ── Session lifecycle ──────────────────────────────────────────

    def create_browser_context(self, config: dict[str, Any]) -> Any:
        """Create a new isolated BrowserContext for a task session.

        Applies the default viewport, :attr:`effective_user_agent`, and
        ``storageState`` from config — **unless**
        :attr:`_fingerprint_managed_context` is True, in which case viewport
        and user_agent are omitted so the stealth fingerprint package can
        generate them from the fingerprint without being clobbered.
        (Camoufox v135.x injects the fingerprint at browser launch via
        ``NewBrowser``; some stealth engines patch ``browser.new_context``.)

        Context creation always goes through ``browser.new_context(**kwargs)``.
        Stealth backends that need fingerprint injection at context creation
        time can override this method; the shipped Camoufox bridge injects at
        browser launch time and needs no override.

        Starts Playwright tracing if ``BROWSER_TRACE_DIR`` is set.

        Returns a Playwright ``BrowserContext`` (no Page yet).
        """
        _pw, browser = self._ensure_playwright()

        context_kwargs: dict[str, Any] = {}
        if not self._fingerprint_managed_context:
            # Shipped bridges: hard-coded defaults.
            context_kwargs["viewport"] = {"width": 1280, "height": 720}
            context_kwargs["user_agent"] = self.effective_user_agent
        elif self._skip_default_viewport:
            # The Camoufox patched Firefox binary does not accept the
            # ``isMobile`` property that Playwright Firefox includes in
            # ``Browser.setDefaultViewport``.  Skip the call entirely.
            context_kwargs["no_viewport"] = True
        # When fingerprint-managed, ONLY pass storage_state (and let the
        # fingerprint package set viewport/UA/screen/dpr).  proxy/geolocation
        # are forwarded by stealth subclasses at browser launch via their
        # ``_launch_browser`` override (e.g. ``camoufox.NewBrowser``).
        storage_state = config.get("storageState")
        if storage_state is not None:
            context_kwargs["storage_state"] = storage_state

        context = browser.new_context(**context_kwargs)

        # Start Playwright trace capture if BROWSER_TRACE_DIR is set.
        _trace_dir = os.environ.get("BROWSER_TRACE_DIR")
        if _trace_dir:
            try:
                context.tracing.start(
                    screenshots=True,
                    snapshots=True,
                    sources=True,
                )
                self._log("tracing", taskId=config.get("_task_id", "shared"),
                          action="start", dir=_trace_dir)
            except Exception:
                pass  # Best-effort

        # CSP-safe read-only eval path (see _csp_safe_readonly_via_init_script).
        # Registers an init script that stashes the EXTRACTOR_SCRIPT result in
        # the DOM so do_evaluate(read_only=True) can read it without
        # page.evaluate (which is CSP-blocked on some patched binaries).
        if self._csp_safe_readonly_via_init_script:
            self._register_readonly_extractor_init_script(context)

        return context

    def _register_readonly_extractor_init_script(self, context: Any) -> None:
        """Register a CSP-free init script that stashes the read-only
        extractor's JSON result in the DOM.

        Reads the EXTRACTOR_SCRIPT from ``self.plugin_config[
        "readOnlyExtractorScript"]`` (plumbed from the TypeScript adapter via
        the ``browser.init`` RPC).  Wraps it in a ``DOMContentLoaded``-deferred
        IIFE that runs in the isolated world (CSP-free) and writes its JSON
        return value to ``<meta id="__pi-extract" content="<urlencoded JSON>">``
        once the DOM is parsed.

        No-op (with a debug log) when the script is absent — e.g. an older
        adapter that doesn't forward ``readOnlyExtractorScript``.  In that
        case ``do_evaluate(read_only=True)`` falls back to ``page.evaluate``,
        which is the pre-fix behaviour (CSP-fails on strict sites, works on
        lax sites).  Idempotent: re-registering on a fresh context is fine
        (init scripts are per-context, not global).
        """
        script = (self.plugin_config or {}).get("readOnlyExtractorScript")
        if not script:
            self._log(
                "registerReadonlyExtractor",
                taskId="shared",
                success=False,
                reason="readOnlyExtractorScript not present in plugin config",
            )
            return
        self._readonly_extractor_script = script
        # The EXTRACTOR_SCRIPT is a self-contained IIFE that returns a JSON
        # string.  It ends with a trailing ``;``; strip it so the assignment
        # ``__r = <script>`` is a single expression statement (wrapping it as
        # ``__r = (<script>);`` would put the script's ``;`` *inside* parens
        # → ``__r = (...})(););`` → SyntaxError, and the whole init script
        # then silently no-ops at document-start).
        script_body = script
        while script_body.endswith(";"):
            script_body = script_body[:-1]
        # Run the extractor at ``DOMContentLoaded`` (NOT ``load``) and write
        # its JSON result to a meta tag.  Two reasons specific to the
        # affected patched-Firefox binaries force this shape:
        #   1. ``document.head`` is null at document-start, so a synchronous
        #      write at init time would throw — defer until DCL when the head
        #      exists and the DOM is parsed.
        #   2. A ``window.addEventListener('load', ...)`` listener registered
        #      from the isolated world does NOT fire on this patched binary
        #      (the isolated world's window doesn't receive the page's load
        #      event), while ``document.addEventListener('DOMContentLoaded'
        #      , ...)`` does fire.  DCL is also early enough that the
        #      extractor's offsetParent / getClientRects / computed-visibility
        #      checks are accurate for text elements (layout is done at DCL;
        #      only images are still loading, and they don't affect text
        #      element layout).
        # The init script runs in the isolated world, so it is NOT subject to
        # the page's CSP (the whole reason this path exists).
        # encodeURIComponent keeps the JSON safe inside an HTML attribute.
        wrapper = (
            "(() => {\n"
            "  const __piRun = () => {\n"
            "    let __r;\n"
            "    try { __r = " + script_body + "; }\n"
            "    catch (e) { __r = JSON.stringify({ error: (e && e.message) || String(e) }); }\n"
            "    let __m = document.getElementById('__pi-extract');\n"
            "    if (!__m) { __m = document.createElement('meta'); __m.id = '__pi-extract'; document.head.appendChild(__m); }\n"
            "    __m.setAttribute('content', encodeURIComponent(__r));\n"
            "  };\n"
            "  if (document.readyState !== 'loading') { __piRun(); }\n"
            "  else { document.addEventListener('DOMContentLoaded', __piRun, { once: true }); }\n"
            "})();"
        )
        try:
            context.add_init_script(wrapper)
        except Exception as exc:
            self._log(
                "registerReadonlyExtractor",
                taskId="shared",
                success=False,
                error=str(exc),
            )

    def _setup_page_session(self, page: Any) -> dict[str, Any]:
        """Attach console capture and dialog handlers to a new page.

        Returns a session dict with ``page``, ``console_messages``, and
        ``dialog_log``.
        """
        # ── Console capture (ring buffer, capped at 500) ────────
        console_messages: list[dict[str, str]] = []

        def _capture_console(msg: Any) -> None:
            console_messages.append({"type": msg.type, "text": msg.text})
            if len(console_messages) > 500:
                console_messages.pop(0)

        page.on("console", _capture_console)

        # ── Dialog auto-dismissal ───────────────────────────────
        dialog_log: list[dict[str, str]] = []
        page.on("dialog", lambda dialog: (
            dialog_log.append({
                "type": dialog.type,
                "message": dialog.message[:200],
                "handledAs": "accepted",
            }),
            dialog.accept(),
        ))

        return {
            "page": page,
            "console_messages": console_messages,
            "dialog_log": dialog_log,
        }

    def create_browser_session(
        self, task_id: str, config: dict[str, Any]
    ) -> dict[str, Any]:
        """Create a new BrowserContext + Page for the given task.

        Reuses the shared Playwright instance and Browser across tasks.
        Returns a session dict containing the page, context, and
        console-message accumulator.

        If ``config`` contains a ``storageState`` key, it is passed
        to :meth:`create_browser_context` to restore cookies and
        localStorage.
        """
        context = self.create_browser_context(config)
        page = context.new_page()
        session = self._setup_page_session(page)
        session["context"] = context
        return session

    def close_browser_session(self, task_id: str) -> None:
        """Close the BrowserContext (and Page) for the given task.

        Each task gets its own isolated BrowserContext created by
        :meth:`create_browser_session`, so this always closes the
        context directly.  Named profiles are handled on the TypeScript
        side via ``storage-state.ts`` (disk persistence).
        """
        session = self.sessions.get(task_id)
        if session is not None:
            context: Any = session.get("context")

            try:
                page: Any = session.get("page")
                if page and not page.is_closed():
                    page.close()
            except Exception:
                pass

            # Stop and save Playwright trace if BROWSER_TRACE_DIR is set.
            _trace_dir = os.environ.get("BROWSER_TRACE_DIR")
            if _trace_dir and context:
                try:
                    os.makedirs(_trace_dir, exist_ok=True)
                    _trace_path = os.path.join(
                        _trace_dir,
                        f"trace-{task_id}-{int(time.time() * 1000)}.zip",
                    )
                    context.tracing.stop(path=_trace_path)
                    self._log("tracing", taskId=task_id, action="stop",
                              dir=_trace_dir)
                except Exception:
                    pass

            try:
                if context:
                    context.close()
            except Exception:
                pass

        # Remove session + element cache
        self.sessions.pop(task_id, None)
        self.element_caches.pop(task_id, None)

        # Stop shared Playwright if no sessions remain
        self._maybe_stop_playwright()

    # ── Internal helpers ───────────────────────────────────────────

    def _get_page(self, task_id: str) -> Any:
        session = self.require_session(task_id)
        return session["page"]

    def _get_page_or_error(
        self, task_id: str, op: str
    ) -> tuple[Any, dict[str, Any] | None]:
        """Resolve the page for a task, or return an error dict for the caller to emit."""
        try:
            return self._get_page(task_id), None
        except SessionNotFoundError:
            raise
        except Exception as exc:
            return None, {
                "success": False,
                "error": f"{op[0].upper()}{op[1:]} failed: {exc}",
            }

    def _get_dialog_events(self, task_id: str) -> list[dict[str, str]]:
        session = self.get_session(task_id)
        if not session:
            return []
        log: list[dict[str, str]] = session.get("dialog_log", [])
        return [
            {"type": e["type"], "message": e["message"], "handledAs": e["handledAs"]}
            for e in log[-10:]
        ]

    def _take_snapshot_and_cache(
        self, task_id: str, page: Any
    ) -> tuple[str, int, dict[str, dict[str, Any]]]:
        try:
            snap_text: str = page.aria_snapshot()
        except Exception:
            return "(snapshot not available)", 0, {}

        if not snap_text:
            return "(no accessibility tree)", 0, {}

        parsed = parse_snapshot(snap_text)
        self.set_element_cache(task_id, parsed)

        return parsed.text, parsed.count, {
            ref: {
                "role": node.role,
                "name": node.name,
                "props": list(node.props),
                "depth": node.depth,
                "raw": node.raw,
                "occurrenceIndex": node.occurrence_index,
                "parentRef": node.parent_ref,
            }
            for ref, node in parsed.elements.items()
        }

    def _build_interaction_result(
        self, task_id: str, page: Any, **extra: Any
    ) -> dict[str, Any]:
        snap_text, element_count, elements = self._take_snapshot_and_cache(
            task_id, page
        )
        result: dict[str, Any] = {
            "success": True,
            "snapshot": snap_text,
            "elementCount": element_count,
            "elements": elements,
            "dialogEvents": self._get_dialog_events(task_id),
        }
        result.update(extra)
        return result

    def _ref_debug_info(self, task_id: str, ref: str) -> tuple[str, str]:
        key = ref[1:] if ref.startswith("@") else ref
        cache = self.get_element_cache(task_id)
        node = cache.elements.get(key) if cache else None
        return (
            getattr(node, "role", "unknown") if node else "unknown",
            getattr(node, "name", "unknown") if node else "unknown",
        )

    def _locate_element(
        self, page: Any, task_id: str, ref: str
    ) -> Any:
        """Resolve an @e ref to a Playwright locator.

        Args:
            page: Playwright Page.
            task_id: Task identifier for the element cache.
            ref: Element reference (e.g. "@e5" or "e5").

        Returns:
            A Playwright ``Locator``.

        Raises:
            RuntimeError: if the ref is not in the cache.
        """
        key = ref[1:] if ref.startswith("@") else ref
        cache = self.get_element_cache(task_id)
        if cache is None:
            raise RuntimeError(
                f"No element cache for task '{task_id}'. "
                "Call browser.navigate or browser.snapshot first."
            )
        node = cache.elements.get(key)
        if node is None:
            raise RuntimeError(
                f"Element @{key} not found in accessibility tree. "
                "Refresh with browser.snapshot first."
            )

        role, kwargs = build_locator_args(node)
        occurrence_index = kwargs.pop("occurrenceIndex", 0)
        locator = page.get_by_role(role, **kwargs)
        # Always use .nth(occurrence_index) to avoid strict-mode violations
        # when multiple elements share the same role+name.  For unique elements
        # (occurrence_index=0) this is equivalent to the bare locator.
        return locator.nth(occurrence_index)

    # ── Navigation settle helpers ───────────────────────────────

    @staticmethod
    def _wait_for_page_ready(page: Any, timeout_ms: int, skip_networkidle: bool = False) -> None:
        """Wait for page readiness after a navigation.

        Mirrors the TypeScript ``waitForPageReady`` helper — each load
        state check gets the full timeout budget, and timeouts are
        silently swallowed so the caller always proceeds (matching TS
        ``.catch(() => {{}})`` behavior).  Required to prevent long-polling
        or streaming sites from failing the entire settle via networkidle.

        Args:
            page: Playwright Page.
            timeout_ms: Timeout for each wait_for_load_state call.
            skip_networkidle: When True, skip the ``networkidle`` wait —
                stealth patched-Firefox binaries don't fire it reliably and
                loitering for it can deadlock the Juggler driver.
        """
        try:
            page.wait_for_load_state("load", timeout=timeout_ms)
        except Exception:
            pass
        if not skip_networkidle:
            try:
                page.wait_for_load_state("networkidle", timeout=timeout_ms)
            except Exception:
                pass

    @staticmethod
    def _wait_for_navigation_settle(
        page: Any,
        url_before: str,
        nav_timeout_ms: int = 5000,
        settle_timeout_ms: int = 400,
        skip_networkidle: bool = False,
    ) -> tuple[bool, str]:
        """Wait for navigation to settle after a user interaction.

        Replaces fixed ``time.sleep()`` calls that race against navigation
        commit.  Instead, listens for the ``framenavigated`` event and waits
        for page readiness only when a navigation has actually started.

        Args:
            page: Playwright Page.
            url_before: The page URL before the interaction.
            nav_timeout_ms: Max time (ms) to wait for each page readiness
                            check (load and networkidle each get the full
                            budget). Default: 5000.
            settle_timeout_ms: Short settle delay (ms) when no navigation
                               occurs (default: 400).

        Returns:
            ``(navigated, url)`` — whether a main-frame navigation was
            detected, and the page URL after settling.
        """
        navigated = False

        def _on_nav(frame: Any) -> None:
            nonlocal navigated
            if frame == page.main_frame:
                navigated = True

        page.on("framenavigated", _on_nav)

        try:
            # Wait for a potential navigation to start (150 ms window)
            page.wait_for_timeout(150)

            waited_for_load = False
            if navigated:
                PlaywrightBridge._wait_for_page_ready(page, nav_timeout_ms, skip_networkidle)
                waited_for_load = True
            elif page.url != url_before:
                # URL changed without framenavigated event
                PlaywrightBridge._wait_for_page_ready(page, nav_timeout_ms, skip_networkidle)
                waited_for_load = True
            else:
                # No navigation — settle for client-side rerenders
                page.wait_for_timeout(settle_timeout_ms)

            # Late-arrival gate: catch navigations that started during settle
            if not waited_for_load and (navigated or page.url != url_before):
                PlaywrightBridge._wait_for_page_ready(page, nav_timeout_ms, skip_networkidle)

        finally:
            page.remove_listener("framenavigated", _on_nav)

        return navigated, page.url

    # ── Navigation & state ─────────────────────────────────────────

    def do_navigate(
        self,
        task_id: str,
        url: str,
        timeout_ms: int = 30_000,
        storageState: Optional[dict[str, Any]] = None,
        profileName: Optional[str] = None,
        profileMode: Optional[str] = None,
    ) -> dict[str, Any]:
        """Navigate the browser to a URL.

        Includes retry on transient network errors, DOM stabilisation
        wait, bot detection, and accessibility snapshot.

        Named profiles are handled by the TypeScript side
        (``python-adapter.ts`` pre-loads ``storageState`` before
        navigate), so the Python bridge always creates isolated
        sessions regardless of ``profileName``/``profileMode``.

        If ``storageState`` is provided, it is passed to the context
        creation so saved cookies and localStorage are restored.
        """
        _t_start = time.time()
        config: dict[str, Any] = {}
        if storageState is not None:
            config["storageState"] = storageState

        session = self.ensure_session(task_id, config)
        page: Any = session["page"]

        # ── Navigate (with retry on transient errors) ───────────
        last_error: Optional[str] = None
        for attempt in range(2):
            try:
                page.goto(url, wait_until="load", timeout=timeout_ms)
                last_error = None
                break
            except PlaywrightTimeout as exc:
                last_error = str(exc)
                if attempt == 0:
                    time.sleep(2)
                else:
                    break
            except Exception as exc:
                msg = str(exc)
                is_transient = bool(
                    re.search(
                        r"net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|"
                        r"timeout|Interrupted",
                        msg,
                        re.IGNORECASE,
                    )
                )
                # Nested ifs (rather than `is_transient and attempt == 0`)
                # keep the no-boolean-in-except lint calm; behavior is
                # identical: retry once on a transient error, then give up.
                if is_transient:
                    if attempt == 0:
                        time.sleep(2)
                        last_error = msg
                    else:
                        last_error = msg
                        break
                else:
                    last_error = msg
                    break

        # ── DOM stabilization wait ──────────────────────────────
        try:
            page.wait_for_function(
                _DOM_STABILIZE_JS,
                timeout=NAV_SETTLE["navTimeoutMs"],
            )
        except Exception:
            pass  # Stabilization timed out — proceed

        # ── Bot detection ───────────────────────────────────────
        bot_detected = check_bot_detection(page)

        # If navigation failed, also check error message keywords —
        # catches challenge pages that failed to render any HTML body.
        if last_error is not None:
            err_lower = last_error.lower()
            if any(
                kw in err_lower
                for kw in ("captcha", "cloudflare", "blocked", "challenge")
            ):
                bot_detected = True

        # ── Snapshot ────────────────────────────────────────────
        try:
            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )
        except Exception:
            snap_text = "(snapshot not available)"
            element_count = 0
            elements = {}

        try:
            title: str = page.title()
        except Exception:
            title = ""

        if last_error is None:
            self._log("navigate", url=url, plugin=self._plugin_name,
                      success=True, botDetected=bot_detected,
                      elementCount=element_count,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": True,
                "url": page.url,
                "title": title,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "botDetected": bot_detected,
                "dialogEvents": self._get_dialog_events(task_id),
            }
        else:
            self._log("navigate", url=url, plugin=self._plugin_name,
                      success=False, botDetected=bot_detected,
                      elementCount=element_count, error=last_error,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "url": url,
                "title": title,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "botDetected": bot_detected,
                "error": last_error,
            }

    def do_cleanup(self, task_id: str) -> dict[str, Any]:
        self.close_browser_session(task_id)
        return {"success": True}

    def do_snapshot(self, task_id: str) -> dict[str, Any]:
        page, err = self._get_page_or_error(task_id, "snapshot")
        if err:
            return {**err, "snapshot": "", "elementCount": 0}

        try:
            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )
            result = {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "dialogEvents": self._get_dialog_events(task_id),
            }
        except Exception as exc:
            result = {
                "success": False,
                "snapshot": "",
                "elementCount": 0,
                "error": str(exc),
            }
        return self._log_op("snapshot", {"taskId": task_id}, result)

    # ── Interaction ─────────────────────────────────────────────────

    def do_click(self, task_id: str, ref: str) -> dict[str, Any]:
        _role, _name = self._ref_debug_info(task_id, ref)

        page, err = self._get_page_or_error(task_id, "click")
        if err:
            return err

        try:
            locator = self._locate_element(page, task_id, ref)
        except RuntimeError as exc:
            self._log("click", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="fail")
            return {"success": False, "error": str(exc)}

        try:
            url_before = page.url
            locator.click(timeout=5_000)

            navigated, _ = self._wait_for_navigation_settle(
                page, url_before, skip_networkidle=self._skip_networkidle,
            )

            new_url = page.url
            new_title = page.title()

            result = self._build_interaction_result(
                task_id, page, newUrl=new_url, newTitle=new_title,
            )
        except Exception as exc:
            result = {
                "success": False,
                "error": f"Click failed: {exc}",
            }
        return self._log_op("click", {"taskId": task_id, "ref": ref, "role": _role, "name": _name}, result)

    def do_type(self, task_id: str, ref: str, text: str) -> dict[str, Any]:
        _role, _name = self._ref_debug_info(task_id, ref)

        page, err = self._get_page_or_error(task_id, "type")
        if err:
            return err

        try:
            locator = self._locate_element(page, task_id, ref)
        except RuntimeError as exc:
            self._log("type", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="fail")
            return {"success": False, "error": str(exc)}

        try:
            locator.click(timeout=5_000)  # Focus first
            locator.fill(text)

            result = self._build_interaction_result(task_id, page)
        except Exception as exc:
            result = {
                "success": False,
                "error": f"Type failed: {exc}",
            }
        return self._log_op("type", {"taskId": task_id, "ref": ref, "role": _role, "name": _name}, result)

    def do_scroll(self, task_id: str, direction: str) -> dict[str, Any]:
        page, err = self._get_page_or_error(task_id, "scroll")
        if err:
            return err

        try:
            delta = 800 if direction == "down" else -800
            if self._scroll_via_wheel:
                # Camoufox runs page.evaluate in an isolated world where
                # the eval-write window.scrollBy silently no-ops; drive the
                # scroll via input events instead.
                page.mouse.wheel(0, delta)
            else:
                page.evaluate(
                    """(d) => window.scrollBy({ top: d, behavior: 'smooth' })""",
                    delta,
                )
            time.sleep(0.2)

            result = self._build_interaction_result(task_id, page)
        except Exception as exc:
            result = {
                "success": False,
                "error": f"Scroll failed: {exc}",
            }
        return self._log_op("scroll", {"taskId": task_id, "direction": direction}, result)

    def do_go_back(self, task_id: str) -> dict[str, Any]:
        page, err = self._get_page_or_error(task_id, "goBack")
        if err:
            return err

        try:
            if self._skip_networkidle:
                # Stealth patched Firefox doesn't fire networkidle; waiting for
                # it times out (30s default) and loitering in the event loop can
                # deadlock the Juggler driver for subsequent contexts.  Match
                # ``do_navigate``'s load-based settle instead.
                page.go_back(wait_until="load", timeout=15_000)
            else:
                page.go_back(wait_until="networkidle")
            time.sleep(0.3)

            new_url: Optional[str] = None
            new_title: Optional[str] = None
            try:
                new_url = page.url
                new_title = page.title()
            except Exception:
                pass

            extra: dict[str, Any] = {}
            if new_url is not None:
                extra["newUrl"] = new_url
            if new_title is not None:
                extra["newTitle"] = new_title
            result = self._build_interaction_result(task_id, page, **extra)
        except Exception as exc:
            result = {
                "success": False,
                "error": f"GoBack failed: {exc}",
            }
        return self._log_op("goBack", {"taskId": task_id}, result)

    def do_press(self, task_id: str, key: str) -> dict[str, Any]:
        page, err = self._get_page_or_error(task_id, "press")
        if err:
            return err

        try:
            url_before = page.url
            page.keyboard.press(key)

            navigated, _ = self._wait_for_navigation_settle(
                page, url_before, nav_timeout_ms=3000,
                skip_networkidle=self._skip_networkidle,
            )

            new_url = page.url
            new_title = page.title()

            result = self._build_interaction_result(
                task_id, page, newUrl=new_url, newTitle=new_title,
            )
        except Exception as exc:
            result = {
                "success": False,
                "error": f"Press failed: {exc}",
            }
        return self._log_op("press", {"taskId": task_id, "key": key}, result)

    # ── Media ───────────────────────────────────────────────────────

    def do_screenshot(
        self,
        task_id: str,
        full_page: bool = False,
    ) -> dict[str, Any]:
        page, err = self._get_page_or_error(task_id, "screenshot")
        if err:
            return {**err, "dataUri": ""}

        try:
            buffer: bytes = page.screenshot(
                type="jpeg",
                quality=80,
                full_page=full_page,
            )
            b64: str = base64.b64encode(buffer).decode("ascii")
            data_uri: str = f"data:image/jpeg;base64,{b64}"

            return {
                "success": True,
                "dataUri": data_uri,
            }

        except Exception as exc:
            return {
                "success": False,
                "dataUri": "",
                "error": str(exc),
            }

    # ── Console & eval ──────────────────────────────────────────────

    def do_get_console_messages(self, task_id: str) -> dict[str, Any]:
        try:
            session = self.get_session(task_id)
            if session is None:
                return {
                    "success": True,
                    "messages": [],
                }
            messages: list[dict[str, str]] = session.get(
                "console_messages", []
            )
            return {
                "success": True,
                "messages": messages,
            }

        except Exception as exc:
            return {
                "success": False,
                "messages": [],
                "error": str(exc),
            }

    def do_clear_console(self, task_id: str) -> dict[str, Any]:
        try:
            session = self.get_session(task_id)
            if session is not None:
                session["console_messages"] = []
            return {"success": True}

        except Exception as exc:
            return {
                "success": False,
                "error": str(exc),
            }

    def do_evaluate(
        self, task_id: str, expression: str, *, read_only: bool = False
    ) -> dict[str, Any]:
        """Evaluate JavaScript in the page context.

        When :attr:`_eval_prefix` is non-empty (e.g. Camoufox's ``"mw:"``),
        it is prepended to the expression so the script runs in the main
        world where writes work.  Reads work with the prefix too, so it is
        safe to apply unconditionally.

        When :attr:`_wrap_mw_eval_in_eval` is True (Camoufox), the expression
        is first wrapped as ``eval(<JSON-string of expression>)`` so that
        multi-statement scripts survive Camoufox's
        ``let _s = (${script})`` main-world wrapper (see the quirk's
        docstring for the full rationale).

        When *read_only* is True (used for the EXTRACTOR_SCRIPT), the
        ``_eval_prefix`` and ``_wrap_mw_eval_in_eval`` are both bypassed
        — the expression targets the isolated-world context, which survives
        in-page JS churn on Camoufox challenge pages.  Writes still need
        the ``mw:`` prefix; pure DOM reads don't.
        """
        page, err = self._get_page_or_error(task_id, "evaluate")
        if err:
            return err

        # CSP-safe read-only handoff (patched-Firefox stealth binaries).
        # On binaries that route page.evaluate through eval() in the main
        # world, the EXTRACTOR_SCRIPT is CSP-blocked on strict sites.  An init
        # script stashed the result in <meta id="__pi-extract"> at load; read
        # it via native query_selector + get_attribute (both CSP-free).  Only
        # honored when the expression is exactly the registered extractor — a
        # future non-extractor read_only eval falls through to page.evaluate.
        # ponytail: result is stale across SPA route changes (no new load);
        # fine for navigate→inspect. Re-run on demand if SPA freshness matters.
        if (
            read_only
            and self._csp_safe_readonly_via_init_script
            and self._readonly_extractor_script
            and expression == self._readonly_extractor_script
        ):
            try:
                meta = page.query_selector("meta#__pi-extract")
                if meta is not None:
                    raw = meta.get_attribute("content")
                    if raw:
                        return {"success": True, "result": _urlunquote(raw)}
            except Exception as exc:
                # Fall through to page.evaluate below — on CSP-strict pages
                # that will also fail, but the error message is then the
                # truthful CSP one rather than a meta-read exception.
                self._log(
                    "evaluate",
                    taskId=task_id,
                    success=False,
                    via="csp_safe_meta",
                    error=str(exc),
                )
            # Meta missing (page navigated before load fired, or init script
            # not registered). Fall through to page.evaluate as best-effort.

        # Build effective expression before the try block so the
        # retry path can reference it regardless of where the exception
        # came from.
        #
        # Read-only evals (EXTRACTOR_SCRIPT) skip the mw: prefix and the
        # eval() wrap entirely — they run in the isolated-world context,
        # which survives in-page JS churn on Camoufox challenge pages.
        # Writes still need mw:; pure DOM reads don't.
        if read_only:
            effective_expression = expression
        elif self._wrap_mw_eval_in_eval:
            # ``eval(<json>)`` is a single expression (valid inside
            # Camoufox's ``let _s = (...)`` wrapper) that runs the script
            # verbatim and returns its completion value.  ``json.dumps``
            # safely escapes the script into a JS string literal.
            inner = "eval(" + json.dumps(expression) + ")"
            effective_expression = (
                self._eval_prefix + inner if self._eval_prefix else inner
            )
        else:
            effective_expression = (
                self._eval_prefix + expression if self._eval_prefix else expression
            )

        try:
            result: Any = page.evaluate(effective_expression)
            return {
                "success": True,
                "result": result,
            }

        except Exception as exc:
            err_msg = str(exc)
            # Genuine context-destruction recovery (Camoufox mw: path only).
            # When _wrap_mw_eval_in_eval is True (Camoufox), distinguish:
            #   (1) "Execution context was destroyed" — a transient page
            #       navigation/challenge-settle — recover with one
            #       wait_for_load_state + retry.
            #   (2) Any other error (including a SyntaxError through the eval
            #       wrap, which means the wrap itself is broken) — terminal.
            # ponytail: single retry, no backoff — challenge pages settle in
            # one load cycle; add exponential backoff if a real challenge
            # needs >1 retry.
            # Nested ifs (rather than
            # `self._wrap_mw_eval_in_eval and "Execution context was destroyed" in err_msg`)
            # keep the no-boolean-in-except lint calm; behavior is identical.
            if self._wrap_mw_eval_in_eval:
                if "Execution context was destroyed" in err_msg:
                    try:
                        page.wait_for_load_state("load")
                    except Exception:
                        pass  # Best-effort: proceed to retry even if wait fails
                    try:
                        result = page.evaluate(effective_expression)
                        return {"success": True, "result": result}
                    except Exception as retry_exc:
                        return {"success": False, "error": str(retry_exc)}
            return {
                "success": False,
                "error": err_msg,
            }

    # ── Cookies & storage state ─────────────────────────────────

    def do_get_cookies(
        self, task_id: str, urls: Optional[list[str]] = None
    ) -> dict[str, Any]:
        try:
            session = self.require_session(task_id)
            context: Any = session["context"]
            raw = context.cookies(urls or [])
            # Normalise to our Cookie shape
            cookies = [
                {
                    "name": c["name"],
                    "value": c["value"],
                    "domain": c.get("domain"),
                    "path": c.get("path"),
                    "expires": c.get("expires"),
                    "httpOnly": c.get("httpOnly"),
                    "secure": c.get("secure"),
                    "sameSite": c.get("sameSite"),
                }
                for c in raw
            ]
            return {"success": True, "cookies": cookies}
        except SessionNotFoundError:
            raise
        except Exception as exc:
            return {"success": False, "cookies": [], "error": str(exc)}

    def do_add_cookies(
        self, task_id: str, cookies: list[dict[str, Any]]
    ) -> dict[str, Any]:
        try:
            session = self.require_session(task_id)
            context: Any = session["context"]
            context.add_cookies(cookies)
            return {"success": True}
        except SessionNotFoundError:
            raise
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def do_clear_cookies(
        self,
        task_id: str,
        name: Optional[str] = None,
        domain: Optional[str] = None,
        path: Optional[str] = None,
    ) -> dict[str, Any]:
        try:
            session = self.require_session(task_id)
            context: Any = session["context"]
            # Playwright Python accepts name/domain/path as kwargs
            kwargs: dict[str, Any] = {}
            if name is not None:
                kwargs["name"] = name
            if domain is not None:
                kwargs["domain"] = domain
            if path is not None:
                kwargs["path"] = path
            context.clear_cookies(**kwargs)
            return {"success": True}
        except SessionNotFoundError:
            raise
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def do_get_storage_state(self, task_id: str) -> dict[str, Any]:
        try:
            session = self.require_session(task_id)
            context: Any = session["context"]
            state: dict[str, Any] = context.storage_state()
            return {
                "success": True,
                "cookies": state.get("cookies", []),
                "origins": state.get("origins", []),
            }
        except SessionNotFoundError:
            raise
        except Exception as exc:
            return {
                "success": False,
                "cookies": [],
                "origins": [],
                "error": str(exc),
            }

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
        # Return the bridge's declared quirks flags.
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
