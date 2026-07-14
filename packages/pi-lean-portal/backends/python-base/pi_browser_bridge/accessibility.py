"""
Accessibility tree utilities for the Python bridge.

Parses Playwright's page.aria_snapshot() output into an
LLM-friendly text format with @e1, @e2 element references.  Caches
parsed nodes so the TypeScript adapter can map interactions back via
get_by_role().

Mirrors the logic in core/shared/accessibility-tree.ts.

Role sets and icons are loaded from the shared ``browser-data.json``
— the same file used by the TypeScript side so the two
implementations never drift.
"""

import re
from dataclasses import dataclass, field
from typing import Optional

from .browser_data import ACCESSIBILITY

# ─── Role classification sets ─────────────────────────────────────────

INTERACTIVE_ROLES: set[str] = set(ACCESSIBILITY["interactiveRoles"])

INFORMATIONAL_ROLES: set[str] = set(ACCESSIBILITY["informationalRoles"])


# ─── Data structures ──────────────────────────────────────────────────


@dataclass
class AriaCachedNode:
    ref: str
    role: str
    name: str
    props: list[str]
    depth: int
    raw: str
    occurrence_index: int = 0
    """0-based position among siblings with same role+name in the snapshot."""
    parent_ref: Optional[str] = None
    """Ref of the nearest interactive ancestor (for subtree queries)."""


@dataclass
class AriaParseResult:
    text: str
    elements: dict[str, AriaCachedNode] = field(default_factory=dict)
    count: int = 0


# ─── Role icons ──────────────────────────────────────────────────────

def _role_icon(role: str) -> str:
    return ACCESSIBILITY["roleIcons"].get(role, "")


def _truncate(s: str, max_len: int) -> str:
    if len(s) <= max_len:
        return s
    return s[: max_len - 1] + "\u2026"  # …


# ─── Line parser ──────────────────────────────────────────────────────

@dataclass
class _ParsedLine:
    role: str
    name: str
    props: list[str]


def _parse_line(line: str) -> Optional[_ParsedLine]:
    """Parse a single line from the accessibility snapshot YAML-like output.

    Expected format::

        - role "name" [prop1, prop2]
        - role "name":
        - role : text content

    Returns None if the line is not a recognised element line.
    """
    if not line.startswith("- "):
        return None
    content = line[2:].strip()

    # Extract bracketed props like [level=1, checked]
    props: list[str] = []
    cleaned = re.sub(r"\[([^\]]+)\]", lambda m: props.append(m.group(1).strip()) or "", content).strip()

    match = re.match(r"^([a-zA-Z_-]+)\s*", cleaned)
    if not match:
        return None

    role = match.group(1).lower()
    remainder = cleaned[match.end():].strip()
    name = ""

    # Quoted name: "name" or "name":
    qmatch = re.match(r'^"((?:[^"\\]|\\.)*)"\s*:?\s*', remainder)
    if qmatch:
        name = qmatch.group(1)
    else:
        # Colon-text format: : text content
        tmatch = re.match(r"^:\s*(.*)", remainder)
        if tmatch:
            name = tmatch.group(1).strip()[:100]

    return _ParsedLine(role=role, name=name, props=props)


# ─── Main parser ──────────────────────────────────────────────────────

def parse_snapshot(snap: str) -> AriaParseResult:
    """Parse the YAML-like output of Playwright's page.aria_snapshot().

    Single-pass parser that assigns @e refs sequentially to all interactive
    elements in DOM order.  Every interactive element gets a ref —
    no cap, no dialog prioritisation.

    Full ARIA trees beyond truncation are cached to disk by the router,
    so there is no need to budget or prioritise ref allocations.

    Mirrors the TypeScript ``parseSnapshot()`` in
    ``core/shared/accessibility-tree.ts``.

    Args:
        snap: The raw snapshot string.

    Returns:
        An AriaParseResult with formatted text, element cache, and count.
    """
    lines = snap.split("\n")
    elements: dict[str, AriaCachedNode] = {}
    out_lines: list[str] = []
    ref_counter = 0
    occurrence_tracker: dict[str, int] = {}
    # Depth-based parent stack — tracks the most recent interactive ref at each depth
    parent_stack: list[str] = []

    for raw_line in lines:
        if not raw_line.strip():
            continue

        depth = _count_leading_spaces(raw_line)
        trimmed = raw_line.strip()

        # Property lines (start with /) — pass through as-is
        if trimmed.startswith("/"):
            out_lines.append(raw_line)
            continue

        parsed = _parse_line(trimmed)
        if parsed is None:
            out_lines.append(raw_line)
            continue

        role = parsed.role
        name = parsed.name
        props = parsed.props

        # Informational roles: show in tree but no @e ref
        if role in INFORMATIONAL_ROLES:
            indent = "  " * depth
            icon = _role_icon(role)
            name_part = f' "{_truncate(name, 80)}"' if name else ""
            out_lines.append(f"{indent}{icon}{role}{name_part}")
            continue

        # Non-interactive — skip entirely
        if role not in INTERACTIVE_ROLES:
            out_lines.append(raw_line)
            continue

        ref_counter += 1
        ref = f"e{ref_counter}"
        occ_key = f"{role}||{name}"
        occurrence_index = occurrence_tracker.get(occ_key, 0)
        occurrence_tracker[occ_key] = occurrence_index + 1

        # Parent stack: trim entries past current depth
        while len(parent_stack) > depth:
            parent_stack.pop()

        # Determine parentRef from the element at depth-1 (if any)
        parent_ref: Optional[str] = None
        if len(parent_stack) >= depth and depth > 0:
            parent_ref = parent_stack[depth - 1]

        # Push this ref onto the parent stack at its depth
        parent_stack.append(ref)

        node = AriaCachedNode(
            ref=ref,
            role=role,
            name=name,
            props=props,
            depth=depth,
            raw=trimmed,
            occurrence_index=occurrence_index,
            parent_ref=parent_ref,
        )
        elements[ref] = node

        indent = "  " * depth
        icon = _role_icon(role)
        ref_tag = f"@{ref}"
        name_part = f' "{_truncate(name, 80)}"' if name else ""
        prop_str = f" [{', '.join(props)}]" if props else ""

        out_lines.append(f"{indent}{ref_tag} {icon}{role}{name_part}{prop_str}")

    return AriaParseResult(
        text="\n".join(out_lines),
        elements=elements,
        count=len(elements),  # refs assigned, matching TS semantics
    )


# ─── Helpers ──────────────────────────────────────────────────────────

def _count_leading_spaces(s: str) -> int:
    match = re.match(r"^(\s*)", s)
    return len(match.group(1)) if match else 0


def build_locator_args(node: AriaCachedNode) -> tuple[str, dict]:
    """Build get_by_role arguments from a cached node.

    Returns (role, kwargs), suitable for use as::

        page.get_by_role(role, **kwargs)

    The kwargs dict includes an ``occurrenceIndex`` key that callers should
    always pass to ``.nth(n)`` on the locator to avoid strict-mode violations
    from duplicate role+name elements."""
    kwargs: dict = {}

    if node.name:
        kwargs["name"] = node.name
        kwargs["exact"] = len(node.name) < 60

    for prop in node.props:
        eq_idx = prop.find("=")
        if eq_idx > 0:
            key = prop[:eq_idx]
            val = prop[eq_idx + 1:]
            if key == "level":
                kwargs["level"] = int(val)
            elif key == "checked":
                kwargs["checked"] = "mixed" if val == "mixed" else True
            elif key == "expanded":
                kwargs["expanded"] = val == "true"
            elif key == "pressed":
                kwargs["pressed"] = "mixed" if val == "mixed" else True
            elif key == "selected":
                kwargs["selected"] = val == "true"
        else:
            if prop == "checked":
                kwargs["checked"] = True
            elif prop == "expanded":
                kwargs["expanded"] = True
            elif prop == "pressed":
                kwargs["pressed"] = True
            elif prop == "selected":
                kwargs["selected"] = True
            elif prop == "disabled":
                kwargs["disabled"] = True

    kwargs["occurrenceIndex"] = node.occurrence_index
    return node.role, kwargs
