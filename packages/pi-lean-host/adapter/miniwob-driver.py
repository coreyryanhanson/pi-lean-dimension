"""
MiniWoB++ episode driver — JSON-RPC over stdio.

Hand-rolled glue replacing browsergym.miniwob. Reads the same
WOB_*_GLOBAL reward globals that BrowserGym's MiniWoBTask.validate
reads (browsergym/miniwob/base.py:155-178). No browsergym dependency.

Attribution:
  MiniWoB++ (c) Farama-Foundation (Apache-2.0).
  Episode-setup JS paraphrased from BrowserGym's base.py
  (ServiceNow, Apache-2.0).
"""

import json
import sys
import traceback
from playwright.sync_api import sync_playwright


class MiniwobDriver:
    """JSON-RPC server exposing MiniWoB++ episode lifecycle."""

    def __init__(self):
        self._pw = None
        self._browser = None
        self._page = None  # type: ignore[assignment]

    def ping(self):
        return {"pong": True}

    def connect(self, endpoint, kind):
        """Attach to an existing browser via CDP or WebSocket."""
        self._pw = sync_playwright().start()
        if kind == "cdp":
            self._browser = self._pw.chromium.connect_over_cdp(endpoint)
        elif kind == "firefox-ws":
            self._browser = self._pw.firefox.connect(endpoint)
        else:
            raise ValueError(f"Unknown connect kind: {kind}")
        # Use the first context's first page, or create one
        ctxs = self._browser.contexts
        if ctxs:
            pages = ctxs[0].pages
            self._page = pages[0] if pages else ctxs[0].new_page()
        else:
            ctx = self._browser.new_context()
            self._page = ctx.new_page()

    def setup(self, subdomain, base_url, seed, episode_max_time_ms):
        """Navigate to a MiniWoB++ task and start an episode."""
        # Task HTML lives at `${base_url}/miniwob/<subdomain>.html` —
        # `miniwob/` holds per-task files, `core/` + `common/` hold shared
        # resources (see miniwob-server.ts). Strip any trailing slash on
        # base_url so the join is stable regardless of caller.
        url = f"{base_url.rstrip('/')}/miniwob/{subdomain}.html"
        self._page.goto(url, wait_until="load")
        # Episode-setup JS: seed the RNG, set max time, start the episode.
        # Paraphrased from BrowserGym's base.py (ServiceNow, Apache-2.0).
        self._page.evaluate(f"""
            Math.seedrandom({seed});
            core.EPISODE_MAX_TIME = {episode_max_time_ms};
            core.startEpisodeReal();
        """)
        self._page.wait_for_function("() => typeof WOB_TASK_READY !== 'undefined' && WOB_TASK_READY")
        goal = self._page.evaluate("() => core.getUtterance()")
        return {"goal": goal}

    def validate(self):
        """Read reward and done flags from the MiniWoB++ page globals."""
        return self._page.evaluate("() => ({"
            "reward: WOB_RAW_REWARD_GLOBAL > 0 ? 1 : 0,"
            "raw_reward: WOB_RAW_REWARD_GLOBAL,"
            "done: WOB_DONE_GLOBAL,"
            "reason: WOB_REWARD_REASON"
        "})")

def main():
    driver = MiniwobDriver()
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            method = req.get("method", "")
            params = req.get("params", {})
            handler = getattr(driver, method, None)
            if handler is None:
                resp = {"error": f"Unknown method: {method}"}
            else:
                result = handler(**params)
                resp = {"result": result}
        except Exception as exc:
            tb = traceback.format_exc()
            resp = {"error": str(exc), "traceback": tb}
        resp["id"] = req.get("id")  # type: ignore[union-attr]
        stdout.write((json.dumps(resp) + "\n").encode())
        stdout.flush()


if __name__ == "__main__":
    main()
