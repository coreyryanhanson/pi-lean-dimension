"""
Tests for shared ``browser-data.json`` loading.

Verifies that the shared data file is valid JSON and that the Python
loaders in ``bot_detection``, ``accessibility``, and ``playwright_base``
can parse it correctly.  A break here means both the TS and Python
sides are broken in the same way.

Pure-logic tests — no Playwright browser required.
"""

import json
import os

import pytest
from pi_browser_bridge.bot_detection import _BLOCK_SIGNALS, _BODY_ONLY_SIGNALS, _BODY_ONLY_PATTERNS, _HTML_SIGNALS
from pi_browser_bridge.accessibility import INTERACTIVE_ROLES, INFORMATIONAL_ROLES, _role_icon

# Path to the shared JSON file (relative to this test file)
# tests/ -> python-base/ -> backends/ -> pi-lean-portal/ -> core/shared/browser-data.json
_SHARED_JSON = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "..",
    "core", "shared", "browser-data.json",
)


@pytest.fixture(scope="module")
def shared_data() -> dict:
    """Load and parse browser-data.json once per module."""
    try:
        with open(_SHARED_JSON, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        pytest.fail(f"Shared data file not found: {_SHARED_JSON}")
    except json.JSONDecodeError as exc:
        pytest.fail(f"Shared data file is not valid JSON: {exc}")
    except OSError as exc:
        pytest.fail(f"Failed to read shared data file: {exc}")


# ═════════════════════════════════════════════════════════════════════
#  JSON file validity
# ═════════════════════════════════════════════════════════════════════


class TestSharedJsonValidity:
    def test_json_is_valid(self, shared_data: dict) -> None:
        """The file parses as valid JSON with a version field."""
        assert isinstance(shared_data, dict)
        assert shared_data["version"] == 1

    def test_has_expected_top_level_keys(self, shared_data: dict) -> None:
        """All three top-level sections are present."""
        assert "botSignals" in shared_data
        assert "accessibility" in shared_data
        assert "navSettle" in shared_data

    def test_bot_signals_has_expected_keys(self, shared_data: dict) -> None:
        bot = shared_data["botSignals"]
        assert "blockSignals" in bot
        assert "bodyOnlySignals" in bot
        assert "bodyOnlyPatterns" in bot
        assert "htmlSignals" in bot

    def test_accessibility_has_expected_keys(self, shared_data: dict) -> None:
        a11y = shared_data["accessibility"]
        assert "interactiveRoles" in a11y
        assert "informationalRoles" in a11y
        assert "roleIcons" in a11y

    def test_nav_settle_has_expected_keys(self, shared_data: dict) -> None:
        ns = shared_data["navSettle"]
        assert "navTimeoutMs" in ns
        assert "settleTimeoutMs" in ns
        assert "settleRaceMs" in ns
        assert "domStabilizationJs" in ns


# ═════════════════════════════════════════════════════════════════════
#  Python-side loaders match the JSON data
# ═════════════════════════════════════════════════════════════════════


class TestBotDetectionLoader:
    """Verify bot_detection.py loaded its signals from the shared JSON."""

    def test_block_signals_match_json(self, shared_data: dict) -> None:
        expected = tuple(shared_data["botSignals"]["blockSignals"])
        assert _BLOCK_SIGNALS == expected

    def test_body_only_signals_match_json(self, shared_data: dict) -> None:
        expected = tuple(shared_data["botSignals"]["bodyOnlySignals"])
        assert _BODY_ONLY_SIGNALS == expected

    def test_html_signals_match_json(self, shared_data: dict) -> None:
        expected = tuple(shared_data["botSignals"]["htmlSignals"])
        assert _HTML_SIGNALS == expected

    def test_body_only_patterns_count(self, shared_data: dict) -> None:
        """The number of compiled patterns matches the source strings."""
        expected_count = len(shared_data["botSignals"]["bodyOnlyPatterns"])
        assert len(_BODY_ONLY_PATTERNS) == expected_count

    def test_reference_code_pattern_matches(self) -> None:
        """The compiled reference# pattern matches expected input."""
        assert len(_BODY_ONLY_PATTERNS) >= 1
        pattern = _BODY_ONLY_PATTERNS[0]
        assert pattern.search("reference #abc123.def") is not None
        assert pattern.search("Reference#abc.def") is not None
        assert pattern.search("normal text") is None


class TestAccessibilityLoader:
    """Verify accessibility.py loaded its data from the shared JSON."""

    def test_interactive_roles_match_json(self, shared_data: dict) -> None:
        expected = set(shared_data["accessibility"]["interactiveRoles"])
        assert INTERACTIVE_ROLES == expected

    def test_informational_roles_match_json(self, shared_data: dict) -> None:
        expected = set(shared_data["accessibility"]["informationalRoles"])
        assert INFORMATIONAL_ROLES == expected

    def test_role_icons_match_json(self, shared_data: dict) -> None:
        icons = shared_data["accessibility"]["roleIcons"]
        for role, expected_icon in icons.items():
            assert _role_icon(role) == expected_icon, f"Icon mismatch for role '{role}'"

    def test_role_icon_unknown_returns_empty(self) -> None:
        assert _role_icon("nonexistent_role") == ""
