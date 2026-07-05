#!/usr/bin/env python3
"""
BrowserGym bridge — JSON-RPC 2.0 server that exposes BrowserGym's
MiniWoB++ task / reward protocol to the TypeScript adapter in
``pi-lean-host/adapter/browsergym-adapter.ts``.

Runs in the dedicated ``pi-lean-host/venv/`` (created by
``npm run setup:venv -w pi-lean-host``) which isolates browsergym's
own ``playwright==1.44`` pin + gymnasium/numpy from the portal's
``chromium-py`` / ``firefox-py`` venv.

Protocol
--------
JSON-RPC 2.0 over stdin/stdout, newline-delimited (one JSON object
per line). Modeled on the portal's ``pi_browser_bridge.transport``
layout but standalone — this bridge lives in ``pi-lean-host``, not
in the shared ``python-base`` lib, because its API surface
(setup/validate/teardown over a single shared page) is unrelated to
the ``BrowserBridge`` per-task-session model.

Methods
-------
* ``ping``                              → ``"pong"`` (handshake)
* ``miniwob.connect({ cdpEndpoint })``  → attach to a Node-launched
                                          Chromium via ``connect_over_cdp``.
* ``miniwob.listTasks()``               → ``{ tasks: [ {name, subdomain}, ... ] }``
                                          (125 entries — built once at
                                          startup from
                                          ``browsergym.miniwob.ALL_MINIWOB_TASKS``).
* ``miniwob.setup({ taskName, seed, baseUrl })``
                                        → ``{ goal, info, episodeId }`` —
                                          instantiate the task class by
                                          name, find the active page on
                                          the connected browser, call
                                          ``task.setup(page)``.
* ``miniwob.validate()``                → ``{ reward, done, reason, info }`` —
                                          call ``task.validate(page, chat_messages)``
                                          on the stored task/page (browsergym
                                          0.14.x signature; ``chat_messages``
                                          is ``[]`` for the trivial-solver
                                          pipeline).
* ``miniwob.teardown()``                → ``{ ok: true }`` —
                                          ``task.teardown()``, release handles.
* ``shutdown``                          → graceful exit.

Invariant
---------
Only ``setup`` and ``validate`` touch the page. The Node plugin
drives all actions (click/type/scroll/...); this bridge only sets
up the episode and reads the reward. This keeps the ``@e``-ref
accessibility model authoritative and avoids any collision with
BrowserGym's ``bid`` stamping (we never call ``observation.py`` /
``_pre_extract``).

── Attribution ──────────────────────────────────────────────────────
BrowserGym   © ServiceNow (Apache-2.0).
MiniWoB++    © Farama-Foundation (Apache-2.0), pinned at
              miniwob-plusplus@7fd85d71a4b60325c6585396ec4f48377d049838.
"""

from __future__ import annotations

import inspect
import json
import os
import sys
import traceback
from typing import Any, Optional

# ─── Standard JSON-RPC error codes ────────────────────────────────
#
# Only the codes this bridge actually emits are declared here. The
# full JSON-RPC 2.0 set (INVALID_REQUEST, INTERNAL_ERROR, ...) lives
# in the portal's pi_browser_bridge.transport for the per-task bridge
# family; this bridge only needs PARSE_ERROR (malformed stdin line),
# METHOD_NOT_FOUND, INVALID_PARAMS, and APPLICATION_ERROR.

PARSE_ERROR = -32700
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
APPLICATION_ERROR = -32000


# ─── Transport ────────────────────────────────────────────────────

def read_request() -> Optional[dict[str, Any]]:
    """Read one JSON-RPC request from stdin. None on EOF."""
    while True:
        line = sys.stdin.readline()
        if not line:
            return None
        line = line.strip()
        if line:
            break
    try:
        return json.loads(line)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Failed to parse JSON-RPC request: {exc}") from exc


def write_response(response: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(response, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def success(req_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def error(req_id: Any, code: int, message: str, data: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


# ─── Bridge state ─────────────────────────────────────────────────

class BrowserGymBridge:
    """Holds the connected browser, the active page, and the live task."""

    def __init__(self) -> None:
        self._playwright = None          # sync_playwright().start() handle
        self._browser = None             # connected Browser
        self._page = None                # active Page (shared with Node)
        self._task = None                # current AbstractBrowserTask
        self._task_info: dict[str, Any] = {}
        self._task_classes: dict[str, type] = {}
        self._task_list: list[dict[str, str]] = []

    # ── Task table (built once at startup) ──────────────────────

    def build_task_table(self) -> None:
        """Populate self._task_classes and self._task_list from
        browsergym.miniwob.ALL_MINIWOB_TASKS."""
        from browsergym.miniwob import ALL_MINIWOB_TASKS  # type: ignore

        for cls in ALL_MINIWOB_TASKS:
            subdomain = getattr(cls, "subdomain", None) or cls.__name__
            name = subdomain  # taskName passed across the wire
            self._task_classes[name] = cls
            self._task_list.append({"name": name, "subdomain": subdomain})

    # ── RPC methods ─────────────────────────────────────────────

    def connect(self, cdp_endpoint: str) -> dict[str, Any]:
        # playwright lives in the dedicated browsergym venv (not the
        # linter's env) — `reportMissingImports` is a false positive here.
        from playwright.sync_api import sync_playwright  # pyright: ignore[reportMissingImports]

        if self._playwright is None:
            self._playwright = sync_playwright().start()
        # Reconnect if the endpoint changed or we haven't connected yet.
        self._browser = self._playwright.chromium.connect_over_cdp(cdp_endpoint)
        return {"ok": True, "endpoint": cdp_endpoint}

    def list_tasks(self) -> dict[str, Any]:
        return {"tasks": self._task_list, "count": len(self._task_list)}

    def _find_active_page(self) -> Any:
        """Find the active page on the connected browser.

        Iterates browser.contexts → context.pages and returns the
        first non-empty page. The Node plugin is expected to have
        navigated to a MiniWoB URL (or about:blank) before setup is
        called, so exactly one page exists.
        """
        if self._browser is None:
            raise RuntimeError("not connected — call miniwob.connect first")
        for ctx in self._browser.contexts:
            for page in ctx.pages:
                return page
        raise RuntimeError(
            "No page found on the connected browser. The Node plugin "
            "must navigate (even to about:blank) before calling setup."
        )

    def setup(
        self,
        task_name: str,
        seed: int,
        base_url: str,
        episode_max_time_ms: int = 1_000_000,
    ) -> dict[str, Any]:
        cls = self._task_classes.get(task_name)
        if cls is None:
            raise RuntimeError(
                f"Unknown MiniWoB task '{task_name}'. "
                f"Known: {len(self._task_classes)} tasks."
            )

        # BrowserGym's MiniWoBTask builds `self.url = base_url + subdomain + ".html"`
        # (see browsergym/miniwob/base.py), so MINIWOB_URL must point at the
        # directory containing `<subdomain>.html` WITH a trailing slash. The
        # adapter passes the server root (the `miniwob/html/` serving root);
        # task files live under `miniwob/<subdomain>.html` there, so append
        # `/miniwob/`.
        os.environ["MINIWOB_URL"] = base_url.rstrip("/") + "/miniwob/"

        # Instantiate. browsergym 0.14.x constructor:
        #   __init__(seed, base_url=None, episode_max_time=1_000_000,
        #            remove_human_display=True)
        # Try the full kwarg form first, then fall back to older signatures
        # that don't accept `episode_max_time` (or any kwargs at all).
        try:
            task = cls(seed=seed, episode_max_time=episode_max_time_ms)
        except TypeError:
            try:
                task = cls(seed=seed)
            except TypeError:
                task = cls(seed)

        self._page = self._find_active_page()
        setup_result = task.setup(self._page)
        # browsergym 0.14.x: setup() returns (goal: str, task_info: dict).
        # Older versions returned just a dict — handle both defensively.
        if isinstance(setup_result, tuple) and len(setup_result) >= 2:
            goal, task_info = setup_result[0], setup_result[1]
        elif isinstance(setup_result, tuple) and len(setup_result) == 1:
            goal, task_info = "", setup_result[0]
        else:
            goal, task_info = "", setup_result
        if not isinstance(task_info, dict):
            task_info = {}
        if not isinstance(goal, str):
            goal = str(goal) if goal is not None else ""
        self._task = task
        self._task_info = task_info

        episode_id = task_info.get("episode_id") or getattr(task, "episode_id", None)
        return {
            "goal": goal or getattr(task, "goal", "") or "",
            "info": _jsonable(task_info),
            "episodeId": episode_id,
        }

    def validate(self) -> dict[str, Any]:
        if self._task is None or self._page is None:
            raise RuntimeError("No active task — call miniwob.setup first.")
        # browsergym 0.14.x: validate(page, chat_messages). The chat_messages
        # arg is the LLM chat transcript for agent-assisted validation; the
        # trivial-solver pipeline has no chat, so pass []. Inspect the
        # signature defensively for older versions that took only `page`.
        try:
            sig = inspect.signature(self._task.validate)
            if len(sig.parameters) >= 2:
                result = self._task.validate(self._page, [])
            else:
                result = self._task.validate(self._page)
        except TypeError:
            result = self._task.validate(self._page, [])
        reward, done, reason, info = (list(result) + [None, None, None, None])[:4]
        try:
            reward_val = float(reward) if reward is not None else 0.0
        except (TypeError, ValueError):
            reward_val = 0.0
        return {
            "reward": reward_val,
            "done": bool(done),
            "reason": str(reason) if reason is not None else "",
            "info": _jsonable(info) if info is not None else {},
        }

    def teardown(self) -> dict[str, Any]:
        if self._task is not None:
            try:
                self._task.teardown()
            except Exception:
                pass
        self._task = None
        self._task_info = {}
        # Keep _page + _browser alive — the Node plugin owns the page
        # lifecycle; we only release our task handle.
        return {"ok": True}

    def shutdown(self) -> None:
        try:
            self.teardown()
        except Exception:
            pass
        try:
            if self._browser is not None:
                # `connect_over_cdp` clients should not close the browser
                # they attached to — the Node owner closes it. Just drop
                # our handle.
                self._browser = None
        finally:
            try:
                if self._playwright is not None:
                    self._playwright.stop()
            except Exception:
                pass
            self._playwright = None


# ─── Helpers ──────────────────────────────────────────────────────

def _jsonable(obj: Any) -> Any:
    """Best-effort cast to JSON-serialisable types for the wire."""
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_jsonable(v) for v in obj]
    return str(obj)


# ─── Main loop ────────────────────────────────────────────────────

def main() -> None:
    bridge = BrowserGymBridge()
    # Build the task table up front so listTasks is instant and any
    # import error surfaces immediately (clearer than a per-call fail).
    try:
        bridge.build_task_table()
    except Exception as exc:
        sys.stderr.write(
            f"[browsergym-bridge] Failed to import browsergym.miniwob: {exc}\n"
            "Install with: pip install -r packages/pi-lean-host/requirements.txt\n"
        )
        sys.stderr.flush()
        # Still run so the adapter can ping and get a clear error.
        # listTasks will return an empty list.

    running = True
    while running:
        try:
            request = read_request()
            if request is None:
                break
        except ValueError as exc:
            write_response(error(None, PARSE_ERROR, f"Parse error: {exc}"))
            continue

        req_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params", {}) or {}

        try:
            if method == "ping":
                write_response(success(req_id, "pong"))
                continue
            if method == "shutdown":
                bridge.shutdown()
                running = False
                write_response(success(req_id, "shutting_down"))
                break

            if method == "miniwob.connect":
                ep = params["cdpEndpoint"]
                write_response(success(req_id, bridge.connect(ep)))
            elif method == "miniwob.listTasks":
                write_response(success(req_id, bridge.list_tasks()))
            elif method == "miniwob.setup":
                write_response(success(req_id, bridge.setup(
                    task_name=params["taskName"],
                    seed=int(params["seed"]),
                    base_url=params["baseUrl"],
                    episode_max_time_ms=int(params.get("episodeMaxTimeMs", 1_000_000)),
                )))
            elif method == "miniwob.validate":
                write_response(success(req_id, bridge.validate()))
            elif method == "miniwob.teardown":
                write_response(success(req_id, bridge.teardown()))
            else:
                write_response(error(req_id, METHOD_NOT_FOUND, f"Method not found: {method}"))

        except KeyError as exc:
            write_response(error(req_id, INVALID_PARAMS, f"Missing parameter: {exc}"))
        except Exception as exc:
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            sys.stderr.write(f"[browsergym-bridge] {method} raised: {exc}\n{tb}\n")
            sys.stderr.flush()
            write_response(error(req_id, APPLICATION_ERROR, str(exc), data={"traceback": tb}))


if __name__ == "__main__":
    main()
