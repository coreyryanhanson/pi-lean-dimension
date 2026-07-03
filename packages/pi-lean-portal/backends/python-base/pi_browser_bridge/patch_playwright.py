#!/usr/bin/env python3
"""
Idempotent Playwright coreBundle.js patcher — guard pageError.location.

The Camoufox patched Firefox binary (v135.0.1-beta.24) emits Juggler
``Page.uncaughtError`` events where the ``location`` field is undefined.
Playwright's Node driver (``coreBundle.js``) builds the wire payload
unconditionally inside ``BrowserContext.Events.PageError``::

    location: { url: pageError.location.url, ... }

and crashes with ``TypeError: Cannot read properties of undefined``
when ``pageError.location`` is missing.  The crash happens in the Node
driver **before** the event reaches any Python ``page.on('pageerror')``
listener, so a pure-Python workaround is impossible.

This module applies a one-line idempotent guard::

    location: pageError.location
      ? { url: ..., line: ..., column: ... }
      : { url: "", line: 0, column: 0 }

The fallback **must** be an object — the wire serializer rejects
``undefined`` with ``ValidationError: location: expected object``.

Usage
-----

As a Python ``-m`` module::

    python -m pi_browser_bridge.patch_playwright

From code::

    from pi_browser_bridge.patch_playwright import patch_playwright
    patch_playwright(loud=True)
"""

import sys
import sysconfig
from pathlib import Path


# ── Pattern constants ────────────────────────────────────────────────

# The exact JavaScript snippet that crashes (two identical occurrences).
_VULNERABLE_SNIPPET = (
    "location: {\n"
    "              url: pageError.location.url,\n"
    "              line: pageError.location.lineNumber,\n"
    "              column: pageError.location.columnNumber\n"
    "            }"
)

# The guard replacement.  Uses a truthy check so that undefined, null,
# and missing all produce the fallback object.  The fallback's values are
# safe empty-string / zero — never undefined — because the wire
# serializer validates ``location`` must be an object.
_GUARDED_SNIPPET = (
    "location: pageError.location ? {\n"
    "              url: pageError.location.url,\n"
    "              line: pageError.location.lineNumber,\n"
    "              column: pageError.location.columnNumber\n"
    "            } : { url: \"\", line: 0, column: 0 }"
)

# Marker comment added after a successful patch so we can cheaply detect
# it on subsequent calls without re-reading the whole file.
_PATCH_MARKER = "/* pi-bridge: guarded pageError.location */"


# ── Locate the driver file ───────────────────────────────────────────

def _default_driver_path() -> Path | None:
    """Return the path to ``coreBundle.js`` for the active Python venv.

    Resolves via ``playwright.__file__`` when playwright is importable,
    or by guessing the path from ``sys.prefix`` on the standard venv
    layout.  Returns ``None`` when neither approach finds a file.
    """
    # Strategy 1: follow the installed playwright package's __file__
    try:
        import playwright  # type: ignore[import-unresolved] # noqa: F401

        pw_dir = Path(playwright.__file__).resolve().parent
        candidate = pw_dir / "driver" / "package" / "lib" / "coreBundle.js"
        if candidate.is_file():
            return candidate
    except (ImportError, AttributeError, OSError):
        pass

    # Strategy 2: guess from sys.prefix + known venv layout
    site_packages = sysconfig.get_paths().get("purelib")
    if site_packages:
        candidate = (
            Path(site_packages)
            / "playwright"
            / "driver"
            / "package"
            / "lib"
            / "coreBundle.js"
        )
        if candidate.is_file():
            return candidate

    return None


# ── Core patch logic ─────────────────────────────────────────────────

def _check_already_patched(content: str) -> bool:
    """Cheap idempotency check — the marker comment we add after a patch."""
    return _PATCH_MARKER in content


def _check_has_unpatched_pattern(content: str) -> bool:
    """True if the vulnerable snippet exists in **unpatched** form."""
    return _VULNERABLE_SNIPPET in content


def _apply_patch(
    driver_path: Path, *, loud: bool = False, fail_on_readonly: bool = True
) -> bool:
    """Apply the guard to ``coreBundle.js``.

    Args:
        driver_path: Absolute path to the Playwright driver file.
        loud: Print a one-time stderr notice on first patch.
        fail_on_readonly: When ``True`` (default), raise ``RuntimeError``
            if the file is read-only.  When ``False``, return ``False``.

    Returns:
        ``True`` if a patch was applied (first time); ``False`` if already
        patched, the vulnerable pattern was not found, or (when
        ``fail_on_readonly=False``) the file was read-only.

    Raises:
        RuntimeError: If ``fail_on_readonly=True`` and the file is
            read-only, or the pattern match fails unexpectedly.
    """
    content = driver_path.read_text(encoding="utf-8")

    # --- Idempotency check ---
    if _check_already_patched(content):
        return False

    # --- Check for unguarded snippet ---
    if not _check_has_unpatched_pattern(content):
        # The vulnerable snippet isn't present in unguarded form.  This could
        # mean Playwright already fixed it upstream (newer version) or
        # restructured the bundle.  Warn and skip.
        if loud:
            print(
                (
                    "[camoufox-py] WARNING: Playwright coreBundle.js does not contain "
                    "the expected vulnerable pattern (pageError.location.url without "
                    "a guard).  This Playwright version may already have the fix, or "
                    "the bundle structure changed.  No patch applied."
                ),
                file=sys.stderr,
                flush=True,
            )
        return False

    # --- Apply the replacement ---
    new_content = content.replace(_VULNERABLE_SNIPPET, _GUARDED_SNIPPET)

    # Sanity check: the replace should have changed the file
    if new_content == content:
        raise RuntimeError(
            "BUG: pattern matched but replace produced identical content. "
            "Cannot patch Playwright coreBundle.js."
        )

    # Verify the replace didn't introduce a regression (count occurrences)
    patched_count = new_content.count(
        "pageError.location ? {"
    )
    expected_count = 2  # two identical occurrences in the bundle
    if patched_count != expected_count:
        raise RuntimeError(
            f"BUG: expected {expected_count} patched occurrences, got {patched_count}. "
            "Playwright bundle structure may have changed. "
            "Cannot safely patch coreBundle.js."
        )

    # Add the marker comment (appended to end for cheap subsequent check)
    new_content += "\n" + _PATCH_MARKER + "\n"

    # --- Write back ---
    try:
        driver_path.write_text(new_content, encoding="utf-8")
    except PermissionError as exc:
        if fail_on_readonly:
            raise RuntimeError(
                "Cannot write to Playwright coreBundle.js — file is read-only.\n"
                "To patch manually as a one-time command:\n"
                f"  python -m pi_browser_bridge.patch_playwright\n"
                f"  (from the camoufox-py virtual environment: {sys.prefix})"
            ) from exc
        return False
    except OSError as exc:
        raise RuntimeError(
            "Cannot write to Playwright coreBundle.js.\n"
            f"  Path: {driver_path}\n"
            f"  Error: {exc}\n"
            "To patch manually, copy the file, edit it, and re-run:\n"
            "  python -m pi_browser_bridge.patch_playwright"
        ) from exc

    # --- Loud one-time notice ---
    if loud:
        print(
            (
                "[camoufox-py] Patched Playwright coreBundle.js "
                f"({driver_path})\n"
                "  Guarded pageError.location access — required for "
                "Camoufox binary v135.0.1-beta.24 which emits "
                "uncaught-error events without location metadata."
            ),
            file=sys.stderr,
            flush=True,
        )

    return True


# ── Public API ───────────────────────────────────────────────────────

def patch_playwright(
    *,
    driver_path: str | None = None,
    loud: bool = False,
    fail_on_readonly: bool = True,
) -> bool:
    """Idempotently guard ``pageError.location`` in Playwright's coreBundle.js.

    Designed to be called automatically at bridge launch (from
    ``_launch_browser()``) or as a standalone ``python -m`` command.

    Args:
        driver_path: Explicit path to ``coreBundle.js``. When ``None``,
            auto-detect from the running venv's Playwright installation.
        loud: Print a one-time stderr notice when a patch is applied.
        fail_on_readonly: When ``True`` (default), raise ``RuntimeError``
            if the file exists but is read-only.  When ``False``, just
            return ``False`` and let the caller decide.

    Returns:
        ``True`` if a patch was applied (first-time). ``False`` if already
        patched, the pattern was not found (Playwright version may not need
        the fix), or (when ``fail_on_readonly=False``) the file was read-only.

    Raises:
        RuntimeError: If the driver file cannot be located, or
            ``fail_on_readonly=True`` and the file is read-only.
    """
    # --- Resolve driver path ---
    if driver_path is not None:
        resolved = Path(driver_path).resolve()
    else:
        resolved = _default_driver_path()
        if resolved is None:
            raise RuntimeError(
                "Cannot locate Playwright coreBundle.js — is Playwright "
                "installed in the current Python environment?\n"
                f"  sys.prefix: {sys.prefix}\n"
                f"  sys.executable: {sys.executable}\n"
                "If Playwright is installed, try the manual command:\n"
                "  python -m pi_browser_bridge.patch_playwright --help"
            )

    if not resolved.is_file():
        raise RuntimeError(
            f"Playwright coreBundle.js not found at: {resolved}\n"
            "Is Playwright properly installed in the current "
            "virtual environment?"
        )

    # --- Idempotent patch ---
    return _apply_patch(resolved, loud=loud, fail_on_readonly=fail_on_readonly)


# ── CLI entry point ──────────────────────────────────────────────────

def main() -> None:
    """CLI entry point for ``python -m pi_browser_bridge.patch_playwright``.

    Accepts:
      ``--driver PATH`` — explicit path to coreBundle.js.
      ``--quiet`` — suppress the one-time patch notice.
      ``--check`` — only check whether a patch is needed (exit 0 = patched
        or not-needed, exit 1 = unpatched).
    """
    import argparse

    parser = argparse.ArgumentParser(
        description="Guard pageError.location in Playwright's coreBundle.js",
    )
    parser.add_argument(
        "--driver",
        type=str,
        default=None,
        help="Explicit path to coreBundle.js (auto-detected by default)",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the one-time patch notice",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check-only: exit 0 if already patched / not needed, 1 if "
        "the vulnerable pattern is still present",
    )
    args = parser.parse_args()

    if args.check:
        driver = (
            Path(args.driver).resolve()
            if args.driver
            else _default_driver_path()
        )
        if driver is None or not driver.is_file():
            print("coreBundle.js not found — cannot check", file=sys.stderr)
            sys.exit(1)
        content = driver.read_text(encoding="utf-8")
        if _check_already_patched(content):
            print("PATCHED")
            sys.exit(0)
        if _check_has_unpatched_pattern(content):
            print("UNPATCHED")
            sys.exit(1)
        print("NOT_NEEDED")
        sys.exit(0)

    try:
        patched = patch_playwright(
            driver_path=args.driver,
            loud=not args.quiet,
            fail_on_readonly=True,
        )
        if patched:
            print("Patch applied.", file=sys.stderr)
        else:
            print("Already patched or not needed.", file=sys.stderr)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
