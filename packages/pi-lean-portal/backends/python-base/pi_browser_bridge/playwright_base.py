"""
Playwright Bridge Base — shared Playwright logic for Python browser bridges.

Extracts the Playwright-specific implementation from chromium-py/bridge.py
into a parameterized base class.  Subclasses override:

* ``_plugin_name`` — e.g. ``"chromium-py"``, ``"firefox-py"``
* ``_user_agent`` — fallback UA string (when dynamic probe is disabled or fails)
* ``_capture_user_agent`` — bool; if True the real UA is probed at lazy browser init
* ``_install_hint`` — engine-specific install instruction
* ``_launch_browser()`` — calls ``self._pw.chromium.launch()`` or ``self._pw.firefox.launch()``

All navigation, interaction, console, cookie, and storage operations
are shared across engines.
"""

import base64
import json
import os
import re
import sys
import time
from typing import Any, Optional

from .bridge import BrowserBridge, SessionNotFoundError
from .bot_detection import check_bot_detection
from .accessibility import parse_snapshot, build_locator_args

# ─── Playwright import (lazy, for better error messages) ──────────────

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout  # type: ignore[import-unresolved]
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False
    sync_playwright = None  # type: ignore[assignment]
    PlaywrightTimeout = TimeoutError  # type: ignore[misc]


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


class PlaywrightBridge(BrowserBridge):
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

    # ── Stealth quirks (Phase 0) ──────────────────────────────────
    #
    # These opt-in flags let stealth subclasses (Camoufox, invisible_playwright)
    # disable the base's hard-coded Playwright defaults that would otherwise
    # clobber a fingerprint-managed browser context.  All default to ``off``
    # so the shipped ``chromium-py`` / ``firefox-py`` bridges are bit-identical.
    #
    # See stealth-browser-plan-v2.md §Phase 0 "Quirks rationale" for the
    # concrete correctness problem each flag fixes.

    #: When True, ``create_browser_context()`` does NOT pass ``viewport`` or
    #: ``user_agent`` to ``new_context`` — the fingerprint package (Camoufox
    #: ``NewContext`` / invisible_playwright's patched ``new_context``)
    #: generates those from the fingerprint, and the base's hard-coded
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
    #: ``Protocol error`` on context creation.  Other backends (including
    #: invisible_playwright's patched ``new_context``) do not need this flag;
    #: only set it when the binary rejects the default viewport call.
    #: Default ``False`` so the shipped bridges stay bit-identical.
    _skip_default_viewport: bool = False

    #: When True, navigation-settle waits skip the ``networkidle`` load state.
    #: The patched Firefox binaries used by stealth backends (invisible_playwright,
    #: Camoufox) do not fire ``networkidle`` reliably, so waiting for it either
    #: times out (``do_go_back``'s 30s default) or loiters in the Playwright sync
    #: greenlet's event loop long enough to deadlock the Juggler driver when a
    #: subsequent BrowserContext's ``new_page()`` is created.  When True,
    #: ``do_go_back`` uses ``wait_until="load"`` and ``_wait_for_page_ready``
    #: skips its ``networkidle`` wait — matching ``do_navigate``'s load-based
    #: settle, which works reliably on the patched binaries.  Default ``False``
    #: so the shipped chromium-py / firefox-py bridges keep their networkidle
    #: settle behaviour bit-identical.
    _skip_networkidle: bool = False


    # ── Shared Playwright state ─────────────────────────────────

    _pw: Any  # Playwright instance (lazy, shared)
    _browser: Any  # Browser instance (lazy, shared)

    def __init__(self) -> None:
        super().__init__()
        self._pw = None
        self._browser = None
        self._cached_ua: str = ""

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
        ``NewBrowser``; invisible_playwright patches ``browser.new_context``.)

        Context creation always goes through ``browser.new_context(**kwargs)``.
        Stealth backends that need fingerprint injection at context creation
        time can override this method; the shipped quirks (Camoufox, invisible)
        both inject at launch/patch time and need no override.

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

        return context

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
        """Get the Playwright Page for a task, or raise SessionNotFoundError."""
        session = self.require_session(task_id)
        return session["page"]

    def _get_dialog_events(self, task_id: str) -> list[dict[str, str]]:
        """Get up to 10 most recent auto-dismissed dialog events for a task.

        Returns a list of ``{type, message, handledAs}`` dicts.
        """
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
        """Take snapshot, cache elements, return formatted text + count."""
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
                """() => new Promise(resolve => {
                    const count = document.querySelectorAll("*").length;
                    setTimeout(() => {
                        resolve(
                            document.querySelectorAll("*").length === count
                            || count > 5000
                        );
                    }, 400);
                })""",
                timeout=5_000,
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
        """Clean up resources for a specific task.

        Profile persistence is handled by the TypeScript side
        (``python-adapter.ts`` auto-saves storage state before calling
        cleanup), so this always calls :meth:`close_browser_session`.
        """
        self.close_browser_session(task_id)
        return {"success": True}

    def do_snapshot(self, task_id: str) -> dict[str, Any]:
        """Take a fresh accessibility snapshot and refresh element cache."""
        _t_start = time.time()
        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            self._log("snapshot", taskId=task_id, success=False,
                      elementCount=0, dialogBlocks=0, fingerprint="",
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "snapshot": "",
                "elementCount": 0,
                "error": str(exc),
            }

        try:
            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )
            session = self.get_session(task_id)
            dialog_blocks = len(session.get("dialog_log", [])) if session else 0
            fingerprint = snap_text[:16] if snap_text else ""
            self._log("snapshot", taskId=task_id, success=True,
                      elementCount=element_count,
                      dialogBlocks=dialog_blocks,
                      fingerprint=fingerprint,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "dialogEvents": self._get_dialog_events(task_id),
            }
        except Exception as exc:
            self._log("snapshot", taskId=task_id, success=False,
                      elementCount=0, dialogBlocks=0, fingerprint="",
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "snapshot": "",
                "elementCount": 0,
                "error": str(exc),
            }

    # ── Interaction ─────────────────────────────────────────────────

    def do_click(self, task_id: str, ref: str) -> dict[str, Any]:
        """Click an element by @e ref."""
        _t_start = time.time()

        # Extract role/name from element cache for debug logging
        _key = ref[1:] if ref.startswith("@") else ref
        _cache = self.get_element_cache(task_id)
        _node = _cache.elements.get(_key) if _cache else None
        _role: str = getattr(_node, "role", "unknown") if _node else "unknown"
        _name: str = getattr(_node, "name", "unknown") if _node else "unknown"

        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            self._log("click", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="fail",
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Click failed: {exc}",
            }

        try:
            locator = self._locate_element(page, task_id, ref)
        except RuntimeError as exc:
            self._log("click", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="fail",
                      time=round((time.time() - _t_start) * 1000))
            return {"success": False, "error": str(exc)}

        try:
            url_before = page.url
            locator.click(timeout=5_000)

            navigated, _ = self._wait_for_navigation_settle(
                page, url_before, skip_networkidle=self._skip_networkidle,
            )

            new_url = page.url
            new_title = page.title()

            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )

            self._log("click", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="success", navigated=navigated,
                      time=round((time.time() - _t_start) * 1000))

            dialog_events = self._get_dialog_events(task_id)
            result: dict[str, Any] = {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "dialogEvents": dialog_events,
                "newUrl": new_url,
                "newTitle": new_title,
            }
            return result

        except Exception as exc:
            self._log("click", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="fail",
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Click failed: {exc}",
            }

    def do_type(self, task_id: str, ref: str, text: str) -> dict[str, Any]:
        """Type text into an element by @e ref."""
        _t_start = time.time()

        # Extract role/name from element cache for debug logging
        _key = ref[1:] if ref.startswith("@") else ref
        _cache = self.get_element_cache(task_id)
        _node = _cache.elements.get(_key) if _cache else None
        _role: str = getattr(_node, "role", "unknown") if _node else "unknown"
        _name: str = getattr(_node, "name", "unknown") if _node else "unknown"

        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            self._log("type", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="fail",
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Type failed: {exc}",
            }

        try:
            locator = self._locate_element(page, task_id, ref)
        except RuntimeError as exc:
            self._log("type", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="fail",
                      time=round((time.time() - _t_start) * 1000))
            return {"success": False, "error": str(exc)}

        try:
            locator.click(timeout=5_000)  # Focus first
            locator.fill(text)

            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )

            self._log("type", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="success",
                      elementCount=element_count,
                      time=round((time.time() - _t_start) * 1000))

            return {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "dialogEvents": self._get_dialog_events(task_id),
            }

        except Exception as exc:
            self._log("type", taskId=task_id, ref=ref, role=_role,
                      name=_name, result="fail",
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Type failed: {exc}",
            }

    def do_scroll(self, task_id: str, direction: str) -> dict[str, Any]:
        """Scroll the page up or down."""
        _t_start = time.time()
        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            self._log("scroll", taskId=task_id, direction=direction,
                      success=False,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Scroll failed: {exc}",
            }

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

            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )

            self._log("scroll", taskId=task_id, direction=direction,
                      success=True, elementCount=element_count,
                      time=round((time.time() - _t_start) * 1000))

            return {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "dialogEvents": self._get_dialog_events(task_id),
            }

        except Exception as exc:
            self._log("scroll", taskId=task_id, direction=direction,
                      success=False,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Scroll failed: {exc}",
            }

    def do_go_back(self, task_id: str) -> dict[str, Any]:
        """Navigate back in history."""
        _t_start = time.time()
        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            self._log("goBack", taskId=task_id, success=False,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"GoBack failed: {exc}",
            }

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

            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )

            self._log("goBack", taskId=task_id, success=True,
                      elementCount=element_count,
                      time=round((time.time() - _t_start) * 1000))

            dialog_events = self._get_dialog_events(task_id)
            result: dict[str, Any] = {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "dialogEvents": dialog_events,
            }
            if new_url is not None:
                result["newUrl"] = new_url
            if new_title is not None:
                result["newTitle"] = new_title
            return result

        except Exception as exc:
            self._log("goBack", taskId=task_id, success=False,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"GoBack failed: {exc}",
            }

    def do_press(self, task_id: str, key: str) -> dict[str, Any]:
        """Press a keyboard key."""
        _t_start = time.time()
        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            self._log("press", taskId=task_id, key=key, success=False,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Press failed: {exc}",
            }

        try:
            url_before = page.url
            page.keyboard.press(key)

            navigated, _ = self._wait_for_navigation_settle(
                page, url_before, nav_timeout_ms=3000,
                skip_networkidle=self._skip_networkidle,
            )

            new_url = page.url
            new_title = page.title()

            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )

            self._log("press", taskId=task_id, key=key, success=True,
                      navigated=navigated, elementCount=element_count,
                      time=round((time.time() - _t_start) * 1000))

            result: dict[str, Any] = {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "dialogEvents": self._get_dialog_events(task_id),
                "newUrl": new_url,
                "newTitle": new_title,
            }
            return result

        except Exception as exc:
            self._log("press", taskId=task_id, key=key, success=False,
                      time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Press failed: {exc}",
            }

    # ── Media ───────────────────────────────────────────────────────

    def do_screenshot(
        self,
        task_id: str,
        full_page: bool = False,
    ) -> dict[str, Any]:
        """Take a JPEG screenshot and return as a base64 data URI."""
        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            return {
                "success": False,
                "dataUri": "",
                "error": str(exc),
            }

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
        """Return captured console messages for the task."""
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
        """Clear captured console messages for the task."""
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

    def do_evaluate(self, task_id: str, expression: str) -> dict[str, Any]:
        """Evaluate JavaScript in the page context.

        When :attr:`_eval_prefix` is non-empty (e.g. Camoufox's ``"mw:"``),
        it is prepended to the expression so the script runs in the main
        world where writes work.  Reads work with the prefix too, so it is
        safe to apply unconditionally.
        """
        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            return {
                "success": False,
                "error": str(exc),
            }

        try:
            effective_expression = (
                self._eval_prefix + expression if self._eval_prefix else expression
            )
            result: Any = page.evaluate(effective_expression)
            return {
                "success": True,
                "result": result,
            }

        except Exception as exc:
            return {
                "success": False,
                "error": str(exc),
            }

    # ── Cookies & storage state ─────────────────────────────────

    def do_get_cookies(
        self, task_id: str, urls: Optional[list[str]] = None
    ) -> dict[str, Any]:
        """Get cookies, optionally filtered by URL."""
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
        """Add cookies to the browser context."""
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
        """Clear cookies, optionally filtered by name/domain/path."""
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
        """Get full storage state (cookies + localStorage + IndexedDB)."""
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
