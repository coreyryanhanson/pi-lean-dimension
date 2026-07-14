"""
Shared data loader for ``browser-data.json``.

Single source of truth that mirrors the TypeScript ``browser-data.ts``
loader.  Opened and validated once at import time, then re-exported
as module-level dicts that the three consumers
(``bot_detection``, ``accessibility``, ``playwright_base``) import.

Loud failure: missing/corrupt file or missing keys raises RuntimeError
at import time, so both the TS and Python sides fail identically.
"""

import json
import os
from typing import Any

_SHARED_DATA_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "..",
    "core", "shared", "browser-data.json",
)


def _load() -> dict[str, Any]:
    """Open, parse, and validate every expected key in browser-data.json."""
    try:
        with open(_SHARED_DATA_PATH, "r") as f:
            data = json.load(f)
    except Exception as exc:
        raise RuntimeError(
            f"[pi-lean-portal] Failed to load shared browser data from "
            f"{_SHARED_DATA_PATH}: {exc}"
        ) from exc

    if not isinstance(data.get("version"), int) or data["version"] < 1:
        raise RuntimeError(
            f"[pi-lean-portal] browser-data.json has invalid or missing version "
            f"field in {_SHARED_DATA_PATH}"
        )

    # ── botSignals ──────────────────────────────────────────────
    bot = data.get("botSignals")
    if not isinstance(bot, dict):
        raise RuntimeError(
            f"[pi-lean-portal] browser-data.json: missing 'botSignals' section "
            f"in {_SHARED_DATA_PATH}"
        )
    for key in ("blockSignals", "bodyOnlySignals", "bodyOnlyPatterns", "htmlSignals"):
        if key not in bot:
            raise RuntimeError(
                f"[pi-lean-portal] browser-data.json: missing "
                f"'botSignals.{key}' in {_SHARED_DATA_PATH}"
            )

    # ── accessibility ───────────────────────────────────────────
    a11y = data.get("accessibility")
    if not isinstance(a11y, dict):
        raise RuntimeError(
            f"[pi-lean-portal] browser-data.json: missing 'accessibility' section "
            f"in {_SHARED_DATA_PATH}"
        )
    for key in ("interactiveRoles", "informationalRoles", "roleIcons"):
        if key not in a11y:
            raise RuntimeError(
                f"[pi-lean-portal] browser-data.json: missing "
                f"'accessibility.{key}' in {_SHARED_DATA_PATH}"
            )

    # ── navSettle ───────────────────────────────────────────────
    ns = data.get("navSettle")
    if not isinstance(ns, dict):
        raise RuntimeError(
            f"[pi-lean-portal] browser-data.json: missing 'navSettle' section "
            f"in {_SHARED_DATA_PATH}"
        )
    for key in ("navTimeoutMs", "settleTimeoutMs", "settleRaceMs", "domStabilizationJs"):
        if key not in ns:
            raise RuntimeError(
                f"[pi-lean-portal] browser-data.json: missing "
                f"'navSettle.{key}' in {_SHARED_DATA_PATH}"
            )

    return data


_RAW = _load()

# ─── Section exports (dicts) ─────────────────────────────────────────

BOT_SIGNALS: dict[str, Any] = _RAW["botSignals"]
ACCESSIBILITY: dict[str, Any] = _RAW["accessibility"]
NAV_SETTLE: dict[str, Any] = _RAW["navSettle"]
