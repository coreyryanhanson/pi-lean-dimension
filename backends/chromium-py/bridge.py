#!/usr/bin/env python3
"""
Chromium-Py Bridge — Chrome automation via Playwright Python.

A concrete subclass of ``BrowserBridge`` that implements all 13 browser
operations using Playwright Python's Chromium API.  This is the *validation
backend* that proves the Python adapter infrastructure works end-to-end;
it is intentionally NOT a production backend (registered as disabled
by default).

Usage
-----
Run the bridge from the command line — it reads JSON-RPC 2.0 requests
from stdin and writes responses to stdout::

    python backends/chromium-py/bridge.py

The ``PythonPluginAdapter`` (TypeScript) spawns this process and
communicates via stdin/stdout.

Requires
--------
* Python >= 3.10
* ``playwright`` >= 1.50  (``pip install playwright``)
* Playwright Chromium browsers installed (``playwright install chromium``)
"""


import base64
import json
import os
import re
import sys
import time
from typing import Any, Optional

from pi_browser_bridge import (
    BrowserBridge,
    SessionNotFoundError,
    parse_snapshot,
    build_locator_args,
)

# ─── Playwright import (lazy, for better error messages) ──────────────

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout  # type: ignore[import-unresolved]
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False
    sync_playwright = None  # type: ignore[assignment]
    PlaywrightTimeout = TimeoutError  # type: ignore[misc]

# ═══════════════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════════════

# ─── BROWSER_DEBUG logging ──────────────────────────────────────────

_DEBUG = os.environ.get("BROWSER_DEBUG") == "1"


def _log(event: str, **data: Any) -> None:
    if _DEBUG:
        print(
            f"[browser] {event}: {json.dumps(data, default=str)}",
            file=sys.stderr,
            flush=True,
        )


# ─── Bot detection (mirrors core/shared/bot-detection.ts) ────────────

#: Block-level signals — checked against BOTH title and body text.
#: Mirror of TypeScript bot-detection.ts BLOCK_SIGNALS.
#: Only specific challenge phrases are included — generic single words
#: like "captcha", "cloudflare", "recaptcha" are excluded because they
#: cause false positives on legitimate pages mentioning them in passing.
_BLOCK_SIGNALS: tuple[str, ...] = (
    "please verify you are human",
    "attention required!",
    "just a moment...",
    "checking your browser",
    "you have been blocked",
    "sorry, you have been blocked",
    "verify you are human",
    "your request has been blocked",
    "we are checking your browser",
    "cf-challenge",
    "_cf_chl_opt",
    "cdn-cgi/challenge",
)

#: Body-only string signals — high-specificity CDN patterns.
#: Mirror of TypeScript bot-detection.ts BODY_ONLY_SIGNALS.
_BODY_ONLY_SIGNALS: tuple[str, ...] = (
    "errors.edgesuite.net",
    "you don't have permission to access",
)

#: Body-only regex patterns — checked against raw body text.
#: Mirror of TypeScript bot-detection.ts BODY_ONLY_PATTERNS.
_BODY_ONLY_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"reference\s*#[a-f0-9]+(?:\.[a-f0-9]+)+", re.IGNORECASE),
)

#: HTML-level CAPTCHA/widget signals (Python-only enhancement).
_HTML_SIGNALS: tuple[str, ...] = (
    "recaptcha",
    "hcaptcha",
    "turnstile",
    "g-recaptcha",
    "data-sitekey",
)


def _check_bot_detection(page: Any) -> bool:
    """Check for anti-automation / bot detection signals in the current page.

    Mirrors the logic in ``bot-detection.ts`` ``checkPage()``.

    Args:
        page: A Playwright sync Page object.

    Returns:
        True if bot detection signals were found.
    """
    try:
        title: str = page.title().lower()
    except Exception:
        title = ""

    try:
        body_text: str = page.evaluate(
            "() => document.body?.innerText || ''"
        ) or ""
        body_text = body_text.lower()
    except Exception:
        body_text = ""

    try:
        html: str = page.evaluate(
            "() => document.documentElement?.innerHTML || ''"
        ) or ""
        html = html.lower()
    except Exception:
        html = ""

    # ── Block signals: checked against both title and body ───────
    for signal in _BLOCK_SIGNALS:
        if signal in title or signal in body_text:
            return True

    # ── Body-only string signals ────────────────────────────────
    for signal in _BODY_ONLY_SIGNALS:
        if signal in body_text:
            return True

    # ── Body-only regex patterns ────────────────────────────────
    for pattern in _BODY_ONLY_PATTERNS:
        if pattern.search(body_text):
            return True

    # ── HTML-level signals (Python-only enhancement) ────────────
    for signal in _HTML_SIGNALS:
        if signal in html:
            return True

    return False


# ═══════════════════════════════════════════════════════════════════════
#  ChromiumPyBridge
# ═══════════════════════════════════════════════════════════════════════


class ChromiumPyBridge(BrowserBridge):
    """Concrete bridge that drives Chromium via Playwright Python.

    All 13 browser operations are implemented.  Console messages are
    captured per task and can be retrieved via
    ``do_get_console_messages()``.  JavaScript dialogs (alert, confirm,
    prompt) are auto-dismissed.

    Snapshots after each interaction are taken automatically, matching
    the behavior of the TypeScript ChromiumPlugin.

    Session isolation model
    -----------------------
    - *Ephemeral / session profiles*: each task gets its own
      BrowserContext + Page (current default behaviour).
    - *Named profiles* (Phase 5): tasks sharing the same named profile
      reuse a single shared BrowserContext.  Each task gets its own
      Page within that context.  Reference counting ensures the shared
      context is closed when the last task's page closes.

    A single Playwright instance and Browser are shared across all
    sessions, regardless of the isolation model.
    """

    _pw: Any  # Playwright instance (lazy, shared)
    _browser: Any  # Chromium Browser instance (lazy, shared)

    def __init__(self) -> None:
        super().__init__()
        self._pw = None
        self._browser = None
        # Read verify-click timeout from env (default: 1500ms)
        try:
            self._verify_click_timeout = int(
                os.environ.get("PY_BRIDGE_VERIFY_CLICK_TIMEOUT_MS", "1500")
            )
        except (ValueError, TypeError):
            self._verify_click_timeout = 1500

    # ── Shared Playwright lifecycle ────────────────────────────

    def _ensure_playwright(self) -> tuple[Any, Any]:
        """Return the shared ``(pw, browser)`` pair, starting if needed."""
        if self._pw is None:
            if not HAS_PLAYWRIGHT:
                raise RuntimeError(
                    "Playwright is not installed. "
                    "Run: pip install playwright && playwright install chromium"
                )
            self._pw = sync_playwright().start()  # type: ignore[union-attr]
            self._browser = self._pw.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
        return self._pw, self._browser

    def _maybe_stop_playwright(self) -> None:
        """Stop the shared Playwright if no sessions or profile contexts remain."""
        if not self.sessions and not self._profile_contexts and self._pw is not None:
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
        """Create a standalone BrowserContext for shared named profiles.

        Applies the default viewport, user agent, and ``storageState``
        from config.  Starts Playwright tracing if ``BROWSER_TRACE_DIR``
        is set.

        Returns a Playwright ``BrowserContext`` (no Page yet).
        """
        _pw, browser = self._ensure_playwright()

        context_kwargs: dict[str, Any] = {
            "viewport": {"width": 1280, "height": 720},
            "user_agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        }
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
                _log("tracing", taskId=config.get("_task_id", "shared"),
                     action="start", dir=_trace_dir)
            except Exception:
                pass  # Best-effort

        return context

    def _setup_page_session(self, page: Any) -> dict[str, Any]:
        """Attach console capture and dialog handlers to a new page.

        Returns a session dict with ``page``, ``console_messages``, and
        ``dialog_log``.
        """
        # ── Console capture ─────────────────────────────────────
        console_messages: list[dict[str, str]] = []
        page.on("console", lambda msg: console_messages.append(
            {"type": msg.type, "text": msg.text}
        ))

        # ── Dialog auto-dismissal ───────────────────────────────
        dialog_log: list[dict[str, str]] = []
        page.on("dialog", lambda dialog: (
            dialog_log.append({
                "type": dialog.type,
                "message": dialog.message[:200],
                "dismissed": "accepted",
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
        to ``create_browser_context()`` to restore cookies and localStorage.
        """
        context = self.create_browser_context(config)
        page = context.new_page()
        session = self._setup_page_session(page)
        session["context"] = context
        return session

    def close_browser_session(self, task_id: str) -> None:
        """Close the BrowserContext (and Page) for the given task.

        If the session's context is managed by a shared named profile
        (tracked in ``_profile_contexts``), delegates to
        ``remove_profile_session()`` instead of closing the context
        directly — the context must stay alive for other tasks sharing
        the same profile.
        """
        session = self.sessions.get(task_id)
        if session is not None:
            # Check if this session belongs to a shared profile context
            context: Any = session.get("context")
            if context is not None:
                for pname, pent in list(self._profile_contexts.items()):
                    if pent.get("context") is context:
                        # Shared profile context — don't close it directly.
                        # remove_profile_session handles ref count, trace
                        # stop (on last close), and _maybe_stop_playwright.
                        self.remove_profile_session(task_id, pname)
                        return

            try:
                page: Any = session.get("page")
                if page and not page.is_closed():
                    page.close()
            except Exception:
                pass

            # Stop and save Playwright trace if BROWSER_TRACE_DIR is set.
            _trace_dir = os.environ.get("BROWSER_TRACE_DIR")
            if _trace_dir:
                self._stop_trace(task_id, context, _trace_dir)

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

    def ensure_profile_session(
        self, task_id: str, profile_name: str, config: dict[str, Any]
    ) -> dict[str, Any]:
        """Get or create a page in a shared profile context.

        Overrides the base implementation to insert ``context`` into the
        session dict (needed by ``do_get_cookies``, ``do_clear_cookies``,
        etc. which access ``session["context"]``).
        """
        result = super().ensure_profile_session(task_id, profile_name, config)
        # Ensure the session dict has a "context" key pointing to the
        # shared BrowserContext (required by cookie/storage operations).
        session = self.sessions.get(task_id)
        if session is not None and session.get("context") is None:
            pent = self._profile_contexts.get(profile_name)
            if pent is not None:
                session["context"] = pent["context"]
        return result

    def _stop_trace(
        self, task_id: str, context: Any, trace_dir: str
    ) -> None:
        """Stop and save Playwright trace for a task's context.

        Only stops tracing for shared contexts when the last page closes
        (ref count reaches zero).  For isolated contexts, always stops.
        """
        try:
            os.makedirs(trace_dir, exist_ok=True)
            _trace_path = os.path.join(
                trace_dir,
                f"trace-{task_id}-{int(time.time() * 1000)}.zip",
            )
            context.tracing.stop(path=_trace_path)
            _log("tracing", taskId=task_id, action="stop", dir=trace_dir)
        except Exception:
            pass  # Best-effort

    def remove_profile_session(self, task_id: str, profile_name: str) -> None:
        """Close a page in a shared profile context and decrement ref count.

        Stops tracing only when the last page closes (ref count reaches
        zero).  Then closes the shared BrowserContext."""
        session = self.sessions.get(task_id)
        profile_entry = self._profile_contexts.get(profile_name)

        if session is not None:
            page = session.get("page")
            if page is not None:
                try:
                    if not page.is_closed():
                        page.close()
                except Exception:
                    pass

            context = session.get("context")
            if context is not None and profile_entry is not None:
                # Stop trace only on last page close
                if profile_entry["ref_count"] <= 1:
                    _trace_dir = os.environ.get("BROWSER_TRACE_DIR")
                    if _trace_dir:
                        self._stop_trace(task_id, context, _trace_dir)

            self.sessions.pop(task_id, None)
            self.element_caches.pop(task_id, None)

        if profile_entry is not None:
            profile_entry["ref_count"] -= 1
            if profile_entry["ref_count"] <= 0:
                try:
                    profile_entry["context"].close()
                except Exception:
                    pass
                self._profile_contexts.pop(profile_name, None)

        self._maybe_stop_playwright()

    # ── Internal helpers ───────────────────────────────────────────

    def _get_page(self, task_id: str) -> Any:
        """Get the Playwright Page for a task, or raise SessionNotFoundError."""
        session = self.require_session(task_id)
        return session["page"]

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

        # Append auto-dismissed dialog info
        result_text = parsed.text
        session = self.get_session(task_id)
        if session:
            dialog_log: list[dict[str, str]] = session.get("dialog_log", [])
            if dialog_log:
                dialog_text = "\n".join(
                    f"  [{d['dismissed']}] {d['type']}: {d['message']}"
                    for d in dialog_log[-10:]  # last 10
                )
                result_text += (
                    "\n\n--- Auto-dismissed dialogs ---\n" + dialog_text
                )

        return result_text, parsed.count, {
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

        When ``profileMode == "named"`` and ``profileName`` is provided,
        the session is created inside a shared BrowserContext for that
        profile (other tasks using the same profile name will share the
        same context / cookie jar).  Otherwise, each task gets its own
        isolated context.

        If ``storageState`` is provided, it is passed to the context
        creation so saved cookies and localStorage are restored.
        """
        _t_start = time.time()
        config: dict[str, Any] = {}
        if storageState is not None:
            config["storageState"] = storageState

        if profileMode == "named" and profileName is not None:
            # Named profile — use shared context (create or join)
            session = self.ensure_profile_session(task_id, profileName, config)
        else:
            # Isolated context (session profile or ephemeral)
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
                if is_transient and attempt == 0:
                    time.sleep(2)
                    last_error = msg
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
        bot_detected = _check_bot_detection(page)

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
            snap_text, element_count, elements = self._take_snapshot_and_cache(task_id, page)
        except Exception:
            snap_text = "(snapshot not available)"
            element_count = 0
            elements = {}

        try:
            title: str = page.title()
        except Exception:
            title = ""

        if last_error is None:
            _log("navigate", url=url, plugin="chromium-py", success=True,
                 botDetected=bot_detected, elementCount=element_count,
                 time=round((time.time() - _t_start) * 1000))
            return {
                "success": True,
                "url": page.url,
                "title": title,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
                "botDetected": bot_detected,
            }
        else:
            _log("navigate", url=url, plugin="chromium-py", success=False,
                 botDetected=bot_detected, elementCount=element_count,
                 error=last_error,
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

    def do_new_page(self, task_id: str, profile_name: str) -> dict[str, Any]:
        """Create a new Page in an existing shared profile context.

        Called when a second (or third, …) task joins a named profile
        whose shared BrowserContext already exists.  Attaches console
        capture and dialog handlers to the new page.
        """
        profile_entry = self._profile_contexts.get(profile_name)
        if profile_entry is None:
            return {
                "success": False,
                "error": f"No shared context for profile '{profile_name}'. "
                         "Call browser.navigate with profileMode='named' first.",
            }

        context = profile_entry["context"]
        try:
            page = context.new_page()
        except Exception as exc:
            return {"success": False, "error": str(exc)}

        session = self._setup_page_session(page)
        session["context"] = context
        self.sessions[task_id] = session
        profile_entry["ref_count"] += 1

        _log("newPage", taskId=task_id, profileName=profile_name,
             refCount=profile_entry["ref_count"])
        return {"success": True}

    def do_close_page(self, task_id: str, profile_name: str) -> dict[str, Any]:
        """Close one page in a shared profile context (decrement ref count)."""
        profile_entry = self._profile_contexts.get(profile_name)
        if profile_entry is None:
            # Context already gone — just clean up session
            self.close_browser_session(task_id)
            return {"success": True, "refCount": 0}

        self._do_close_page_in_context(task_id, profile_name, profile_entry)
        return {"success": True, "refCount": max(profile_entry["ref_count"], 0)}

    def _do_close_page_in_context(
        self, task_id: str, profile_name: str, _profile_entry: dict[str, Any]
    ) -> None:
        """Internal: close one page and decrement ref count.

        Delegates to ``remove_profile_session()`` which handles page close,
        trace stop (on last page), context close, and playlist stop.
        """
        self.remove_profile_session(task_id, profile_name)

    def do_cleanup(self, task_id: str, profileName: Optional[str] = None) -> dict[str, Any]:
        """Clean up resources for a specific task.

        When ``profileName`` is provided and references a shared profile
        context, delegates to ``do_close_page()``.  Otherwise, closes the
        isolated BrowserContext via ``close_browser_session()``.
        """
        if profileName is not None:
            return self.do_close_page(task_id, profileName)
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
            _log("snapshot", taskId=task_id, success=False, elementCount=0,
                 dialogBlocks=0, fingerprint="",
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
            _log("snapshot", taskId=task_id, success=True,
                 elementCount=element_count, dialogBlocks=dialog_blocks,
                 fingerprint=fingerprint,
                 time=round((time.time() - _t_start) * 1000))
            return {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
            }
        except Exception as exc:
            _log("snapshot", taskId=task_id, success=False, elementCount=0,
                 dialogBlocks=0, fingerprint="",
                 time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "snapshot": "",
                "elementCount": 0,
                "error": str(exc),
            }

        # ── Occlusion detection ───────────────────────────────────────

    def _check_occlusion(
        self, locator: Any, ref: str
    ) -> Optional[dict[str, Any]]:
        """Check if a locator is obscured by another element.

        Uses ``document.elementFromPoint()`` at the locator's center to verify
        the target is the top-most element at those coordinates. Returns an
        error dict if obscured, or None if clear to proceed.

        Args:
            locator: A Playwright Locator.
            ref: The @e reference (for the error message).

        Returns:
            An error dict if obscured, or None if not obscured.
        """
        try:
            # Scroll element into view with center alignment so the center
            # point is within the viewport for elementFromPoint() checking.
            # Single evaluate to avoid layout races between scroll and check.
            is_obscured = locator.evaluate("""(el) => {
                el.scrollIntoView({ block: 'center', inline: 'nearest' });
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return true;
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                if (
                    y < 0 ||
                    y > (window.innerHeight || document.documentElement.clientHeight) ||
                    x < 0 ||
                    x > (window.innerWidth || document.documentElement.clientWidth)
                ) {
                    return true;
                }
                const topEl = document.elementFromPoint(x, y);
                if (!topEl) return true;
                return !(topEl === el || el.contains(topEl));
            }""")
            if is_obscured:
                _log("occlusion", ref=ref, isObscured=True,
                     verifyClick="skipped", reason="elementFromPoint")
                return {
                    "success": False,
                    "error": (
                        f"Element {ref} is obscured by another element "
                        "(likely a modal/overlay). Try pressing Escape "
                        '(browser-press key="Escape") to dismiss the '
                        "overlay, then retry."
                    ),
                }
            _log("occlusion", ref=ref, isObscured=False,
                 verifyClick="skipped", reason="elementFromPoint")
        except Exception:
            _log("occlusion", ref=ref, isObscured=False,
                 verifyClick="skipped", reason="elementFromPoint",
                 error="check failed")
            pass  # Fail-safe: proceed with click if check itself fails
        return None

    # ── Interaction ─────────────────────────────────────────────────

    def do_click(self, task_id: str, ref: str) -> dict[str, Any]:
        """Click an element by @e ref."""
        _t_start = time.time()
        _t_phases: dict[str, int | None] = {
            "locate": None, "occlusion": None,
            "click": None, "wait": None, "snapshot": None,
        }

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
            _log("click", taskId=task_id, ref=ref, role=_role, name=_name,
                 occlusionCheck="skipped", result="fail",
                 timings=_t_phases,
                 time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Click failed: {exc}",
            }

        try:
            locator = self._locate_element(page, task_id, ref)
            _t_phases["locate"] = round((time.time() - _t_start) * 1000)
        except RuntimeError as exc:
            _t_phases["locate"] = round((time.time() - _t_start) * 1000)
            _log("click", taskId=task_id, ref=ref, role=_role, name=_name,
                 occlusionCheck="skipped", result="fail",
                 timings=_t_phases,
                 time=round((time.time() - _t_start) * 1000))
            return {"success": False, "error": str(exc)}

        # Fast occlusion check — verify with short click if flagged to
        # eliminate false positives (e.g., child elements with pointer-events:none).
        occlusion = self._check_occlusion(locator, ref)
        _t_phases["occlusion"] = round((time.time() - _t_start) * 1000)

        occlusion_check: str = "verified"
        if occlusion is not None:
            try:
                locator.click(timeout=self._verify_click_timeout)
                occlusion_check = "blocked_verify_ok"
                # Succeeded — false positive, proceed below
            except Exception:
                _t_phases["click"] = round((time.time() - _t_start) * 1000)
                _log("click", taskId=task_id, ref=ref, role=_role, name=_name,
                     occlusionCheck="blocked", result="fail",
                     timings=_t_phases,
                     time=round((time.time() - _t_start) * 1000))
                return occlusion

        try:
            if occlusion is None:
                locator.click(timeout=5_000)
            _t_phases["click"] = round((time.time() - _t_start) * 1000)

            time.sleep(0.3)
            _t_phases["wait"] = round((time.time() - _t_start) * 1000)

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
            _t_phases["snapshot"] = round((time.time() - _t_start) * 1000)

            _log("click", taskId=task_id, ref=ref, role=_role, name=_name,
                 occlusionCheck=occlusion_check, result="success",
                 timings=_t_phases,
                 time=round((time.time() - _t_start) * 1000))

            result: dict[str, Any] = {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
            }
            if new_url is not None:
                result["newUrl"] = new_url
            if new_title is not None:
                result["newTitle"] = new_title
            return result

        except Exception as exc:
            _t_phases["snapshot"] = round((time.time() - _t_start) * 1000)
            _log("click", taskId=task_id, ref=ref, role=_role, name=_name,
                 occlusionCheck=occlusion_check, result="fail",
                 timings=_t_phases,
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
            _log("type", taskId=task_id, ref=ref, role=_role, name=_name,
                 occlusionCheck="skipped", result="fail",
                 time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Type failed: {exc}",
            }

        try:
            locator = self._locate_element(page, task_id, ref)
        except RuntimeError as exc:
            _log("type", taskId=task_id, ref=ref, role=_role, name=_name,
                 occlusionCheck="skipped", result="fail",
                 time=round((time.time() - _t_start) * 1000))
            return {"success": False, "error": str(exc)}

        # Fast occlusion check — verify with short click if flagged
        occlusion = self._check_occlusion(locator, ref)

        occlusion_check: str = "verified"
        if occlusion is not None:
            try:
                locator.click(timeout=self._verify_click_timeout)
                occlusion_check = "blocked_verify_ok"
            except Exception:
                _log("type", taskId=task_id, ref=ref, role=_role, name=_name,
                     occlusionCheck="blocked", result="fail",
                     time=round((time.time() - _t_start) * 1000))
                return occlusion

        try:
            if occlusion is None:
                locator.click(timeout=5_000)  # Focus first
            locator.fill(text)

            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )

            _log("type", taskId=task_id, ref=ref, role=_role, name=_name,
                 occlusionCheck=occlusion_check, result="success",
                 elementCount=element_count,
                 time=round((time.time() - _t_start) * 1000))

            return {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
            }

        except Exception as exc:
            _log("type", taskId=task_id, ref=ref, role=_role, name=_name,
                 occlusionCheck=occlusion_check, result="fail",
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
            _log("scroll", taskId=task_id, direction=direction,
                 success=False, time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Scroll failed: {exc}",
            }

        try:
            delta = 800 if direction == "down" else -800
            page.evaluate(
                """(d) => window.scrollBy({ top: d, behavior: 'smooth' })""",
                delta,
            )
            time.sleep(0.2)

            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )

            _log("scroll", taskId=task_id, direction=direction,
                 success=True, elementCount=element_count,
                 time=round((time.time() - _t_start) * 1000))

            return {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
            }

        except Exception as exc:
            _log("scroll", taskId=task_id, direction=direction,
                 success=False, time=round((time.time() - _t_start) * 1000))
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
            _log("goBack", taskId=task_id, success=False,
                 time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"GoBack failed: {exc}",
            }

        try:
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

            _log("goBack", taskId=task_id, success=True,
                 elementCount=element_count,
                 time=round((time.time() - _t_start) * 1000))

            result: dict[str, Any] = {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
            }
            if new_url is not None:
                result["newUrl"] = new_url
            if new_title is not None:
                result["newTitle"] = new_title
            return result

        except Exception as exc:
            _log("goBack", taskId=task_id, success=False,
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
            _log("press", taskId=task_id, key=key, success=False,
                 time=round((time.time() - _t_start) * 1000))
            return {
                "success": False,
                "error": f"Press failed: {exc}",
            }

        try:
            page.keyboard.press(key)
            time.sleep(0.2)

            snap_text, element_count, elements = self._take_snapshot_and_cache(
                task_id, page
            )

            _log("press", taskId=task_id, key=key, success=True,
                 elementCount=element_count,
                 time=round((time.time() - _t_start) * 1000))

            return {
                "success": True,
                "snapshot": snap_text,
                "elementCount": element_count,
                "elements": elements,
            }

        except Exception as exc:
            _log("press", taskId=task_id, key=key, success=False,
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
            current_size = page.viewport_size
            if current_size and current_size.get("width", 0) > 1024:
                page.set_viewport_size({
                    "width": 1024,
                    "height": current_size.get("height", 720),
                })
        except Exception:
            pass

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

    def do_get_images(self, task_id: str) -> dict[str, Any]:
        """Extract all ``<img>`` tags from the current page."""
        try:
            page = self._get_page(task_id)
        except SessionNotFoundError:
            raise
        except Exception as exc:
            return {
                "success": False,
                "images": [],
                "error": str(exc),
            }

        try:
            images: list[dict[str, Any]] = page.evaluate(
                """() =>
                    Array.from(document.querySelectorAll('img'))
                        .map(img => ({
                            src: img.src,
                            alt: img.alt || '',
                            width: img.naturalWidth || img.width || 0,
                            height: img.naturalHeight || img.height || 0,
                        }))
                        .filter(img => !img.src.startsWith('data:'))
                """
            )
            return {
                "success": True,
                "images": images,
            }

        except Exception as exc:
            return {
                "success": False,
                "images": [],
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
        """Evaluate JavaScript in the page context."""
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
            result: Any = page.evaluate(expression)
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


# ═══════════════════════════════════════════════════════════════════════
#  Entry point
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    if not HAS_PLAYWRIGHT:
        msg = (
            "ERROR: Playwright is not installed.\n"
            "Run the following commands to install:\n"
            "  pip install playwright\n"
            "  playwright install chromium\n"
        )
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": None,
            "error": {
                "code": -32000,
                "message": msg.strip(),
            },
        }))
        sys.stdout.flush()
        sys.exit(1)

    bridge = ChromiumPyBridge()
    bridge.run()
