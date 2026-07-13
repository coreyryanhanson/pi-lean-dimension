"""Shared fixtures and helpers for Python bridge unit tests."""

import importlib.util
from pathlib import Path

import pytest


# ── Bridge loading ─────────────────────────────────────────────

_BACKEND_CLASSES = {
    "chromium-py": "ChromiumPyBridge",
    "firefox-py": "FirefoxPyBridge",
}


def _load_bridge_class(backend_name: str):
    """Load a bridge class by backend name (chromium-py, firefox-py)."""
    dir_name = backend_name.replace("-", "_")
    bridge_path = (
        Path(__file__).resolve().parents[3]
        / "backends"
        / backend_name
        / "bridge.py"
    )
    assert bridge_path.exists(), f"bridge.py not found at {bridge_path}"
    spec = importlib.util.spec_from_file_location(
        f"{dir_name}_bridge", bridge_path
    )
    assert spec is not None, f"Could not create spec for {bridge_path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return getattr(module, _BACKEND_CLASSES[backend_name])


@pytest.fixture(params=["chromium-py", "firefox-py"])
def bridge_factory(request):
    """Parametrized fixture yielding (backend_name, bridge_instance)."""
    backend_name = request.param
    cls = _load_bridge_class(backend_name)
    return backend_name, cls()


# ── Shared constants ──────────────────────────────────────────

METHOD_NAMES = [
    "browser.navigate",
    "browser.snapshot",
    "browser.click",
    "browser.type",
    "browser.scroll",
    "browser.goBack",
    "browser.press",
    "browser.screenshot",
    "browser.getConsoleMessages",
    "browser.clearConsole",
    "browser.evaluate",
    "browser.cleanup",
]


# ── Mock objects ──────────────────────────────────────────────


class _MockConsolePage:
    """Mock Playwright page that records ``page.on("console")`` handlers.

    Lets us invoke captured handlers directly without a real browser.
    """

    def __init__(self) -> None:
        self._handlers: dict[str, list] = {}

    def on(self, event: str, handler) -> None:
        self._handlers.setdefault(event, []).append(handler)

    def fire_console(self, text: str) -> None:
        """Simulate a console event by calling all 'console' handlers."""
        for handler in self._handlers.get("console", []):
            handler(_FakeConsoleMessage(text))


class _FakeConsoleMessage:
    """Duck-typed substitute for Playwright's ConsoleMessage."""

    def __init__(self, text: str) -> None:
        self._text = text

    @property
    def type(self) -> str:
        return "log"

    @property
    def text(self) -> str:
        return self._text
