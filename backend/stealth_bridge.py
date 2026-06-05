#!/opt/ipw-pyenv/bin/python
"""
JSON-RPC bridge for Invisible Playwright.

Communicates over stdin/stdout with line-delimited JSON.
Commands: navigate, snapshot, click, type, scroll, screenshot, goBack, press, evaluate, ping

Usage:
  python stealth_bridge.py [--seed SEED]
"""

import sys
import json
import base64
import traceback
from invisible_playwright import InvisiblePlaywright

# ─── Module-level state ────────────────────────────────────────────────
_pw = None          # InvisiblePlaywright instance
_browser = None     # Browser or BrowserContext
_page = None


# ─── JSON-RPC helpers ──────────────────────────────────────────────────

def send_response(req_id, result=None, error=None):
    msg = {"id": req_id}
    if error:
        msg["error"] = str(error)
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


# ─── Command handlers ──────────────────────────────────────────────────

def handle_ping(cmd):
    send_response(cmd["id"], {"ok": True})


def handle_init(cmd):
    global _pw, _browser, _page
    if _pw is not None:
        send_response(cmd["id"], {"ok": True, "status": "already_initialized"})
        return
    params = cmd.get("params", {})
    seed = params.get("seed")
    kwargs = {"headless": True}
    if seed is not None:
        kwargs["seed"] = int(seed)
    _pw = InvisiblePlaywright(**kwargs)
    try:
        _browser = _pw.__enter__()
        _page = _browser.new_page(bypass_csp=True)
    except Exception:
        # Ensure cleanup on failure (e.g., new_page() throws)
        try:
            if _browser is not None:
                _pw.__exit__(None, None, None)
        except Exception:
            pass
        _pw = None
        _browser = None
        raise
    send_response(cmd["id"], {"ok": True})


def handle_navigate(cmd):
    global _page
    params = cmd.get("params", {})
    url = params.get("url", "")
    timeout = params.get("timeout", 30000)
    wait_until = params.get("waitUntil", "networkidle")
    resp = _page.goto(url, wait_until=wait_until, timeout=timeout)
    status_code = resp.status if resp else 0
    title = _page.title()
    send_response(cmd["id"], {
        "url": _page.url,
        "title": title,
        "statusCode": status_code,
    })


def handle_snapshot(cmd):
    global _page
    snap = _page.aria_snapshot()
    send_response(cmd["id"], {"snapshot": snap})


def handle_click(cmd):
    global _page
    params = cmd.get("params", {})
    role = params.get("role", "")
    name = params.get("name", "")
    opts = {}
    if name:
        opts["name"] = name
        opts["exact"] = len(name) < 60
    if params.get("level"):
        opts["level"] = int(params["level"])
    locator = _page.get_by_role(role, **opts)
    locator.wait_for(state="visible", timeout=5000)
    locator.click()
    _page.wait_for_timeout(300)
    send_response(cmd["id"], {
        "url": _page.url,
        "title": _page.title(),
    })


def handle_type(cmd):
    global _page
    params = cmd.get("params", {})
    role = params.get("role", "")
    name = params.get("name", "")
    text = params.get("text", "")
    opts = {}
    if name:
        opts["name"] = name
        opts["exact"] = len(name) < 60
    if params.get("level"):
        opts["level"] = int(params["level"])
    locator = _page.get_by_role(role, **opts)
    locator.wait_for(state="visible", timeout=5000)
    locator.click()
    locator.fill(text)
    send_response(cmd["id"], {"ok": True})


def handle_scroll(cmd):
    global _page
    params = cmd.get("params", {})
    direction = params.get("direction", "down")
    delta_y = 800 if direction == "down" else -800
    # Use native mouse wheel event instead of evaluate() to avoid CSP issues
    # and to simulate real user scrolling behavior.
    _page.mouse.wheel(0, delta_y)
    _page.wait_for_timeout(200)
    send_response(cmd["id"], {"ok": True})


def handle_screenshot(cmd):
    global _page
    # JPEG at 80% quality to match chromium backend — smaller payload for vision models
    b64_bytes = _page.screenshot(type="jpeg", quality=80, full_page=False)
    data_uri = "data:image/jpeg;base64," + base64.b64encode(b64_bytes).decode("ascii")
    send_response(cmd["id"], {"dataUri": data_uri})


def handle_goBack(cmd):
    global _page
    _page.go_back(wait_until="networkidle")
    _page.wait_for_timeout(300)
    send_response(cmd["id"], {
        "url": _page.url,
        "title": _page.title(),
    })


def handle_press(cmd):
    global _page
    params = cmd.get("params", {})
    key = params.get("key", "")
    _page.keyboard.press(key)
    _page.wait_for_timeout(200)
    send_response(cmd["id"], {"ok": True})


def handle_evaluate(cmd):
    global _page
    params = cmd.get("params", {})
    expression = params.get("expression", "")
    result = _page.evaluate(expression)
    # Ensure serializable
    try:
        json.dumps(result)
    except (TypeError, ValueError):
        result = str(result)
    send_response(cmd["id"], {"result": result})


def handle_cleanup(cmd):
    global _pw, _browser, _page
    # Close page first, then browser context, then playwright
    if _page is not None:
        try:
            _page.close()
        except Exception:
            pass
        _page = None
    if _browser is not None:
        try:
            _browser.close()
        except Exception:
            pass
        _browser = None
    if _pw is not None:
        try:
            _pw.__exit__(None, None, None)
        except Exception:
            pass
        _pw = None
    # Use cmd.get() to handle shutdown messages that may omit id
    send_response(cmd.get("id", 0), {"ok": True})


# ─── Method dispatch ──────────────────────────────────────────────────

METHODS = {
    "ping": handle_ping,
    "init": handle_init,
    "navigate": handle_navigate,
    "snapshot": handle_snapshot,
    "click": handle_click,
    "type": handle_type,
    "scroll": handle_scroll,
    "screenshot": handle_screenshot,
    "goBack": handle_goBack,
    "press": handle_press,
    "evaluate": handle_evaluate,
    "cleanup": handle_cleanup,
}


def handle_command(cmd):
    method = cmd.get("method", "")
    handler = METHODS.get(method)
    if handler:
        try:
            handler(cmd)
        except Exception as e:
            tb = traceback.format_exc()
            send_response(cmd["id"], error=f"{type(e).__name__}: {e}")
            sys.stderr.write(tb + "\n")
            sys.stderr.flush()
    else:
        send_response(cmd["id"], error=f"Unknown method: {method}")


# ─── Main loop ─────────────────────────────────────────────────────────

def main():
    # Send ack on startup
    sys.stdout.write(json.dumps({"id": 0, "result": {"ok": True, "ready": True}}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            send_response(0, error=f"Invalid JSON: {e}")
            continue

        if cmd.get("method") == "shutdown":
            handle_cleanup(cmd)
            break

        handle_command(cmd)


if __name__ == "__main__":
    main()
