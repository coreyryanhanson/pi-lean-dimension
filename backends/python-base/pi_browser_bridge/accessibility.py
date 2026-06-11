"""
Accessibility tree utilities for the Python bridge.

Parses Playwright's page.aria_snapshot() output into an
LLM-friendly text format with @e1, @e2 element references.  Caches
parsed nodes so the TypeScript adapter can map interactions back via
get_by_role().

Mirrors the logic in core/shared/accessibility-tree.ts.
"""

import re
from dataclasses import dataclass, field
from typing import Optional

# ─── Role classification sets ─────────────────────────────────────────

INTERACTIVE_ROLES: set[str] = {
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "heading",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "treeitem",
    "switch",
    "slider",
    "spinbutton",
    "progressbar",
    "meter",
    "scrollbar",
    "gridcell",
    "cell",
    "columnheader",
    "rowheader",
    "tabpanel",
    "img",
    "figure",
    "listitem",
    "dialog",
    "alertdialog",
    "tooltip",
    "navigation",
    "banner",
    "form",
    "search",
    "toolbar",
    "menu",
    "menubar",
    "note",
    "alert",
    "status",
    "list",
    "table",
    "grid",
    "treegrid",
    "article",
    "section",
    "blockquote",
    "code",
}

INFORMATIONAL_ROLES: set[str] = {
    "paragraph",
    "text",
    "group",
    "region",
    "main",
    "complementary",
    "contentinfo",
    "definition",
    "term",
    "math",
    "marquee",
    "timer",
    "log",
    "deletion",
    "insertion",
    "mark",
    "suggestion",
    "comment",
}


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


@dataclass
class AriaParseResult:
    text: str
    elements: dict[str, AriaCachedNode] = field(default_factory=dict)
    count: int = 0


# ─── Role icons (same mapping as TypeScript) ───────────────—──────────

_ROLE_ICONS: dict[str, str] = {
    "button": "\U0001f518 ",        # 🔘
    "link": "\U0001f517 ",          # 🔗
    "textbox": "\U0001f4dd ",       # 📝
    "searchbox": "\U0001f50d ",     # 🔍
    "combobox": "\U0001f4cb ",      # 📋
    "checkbox": "\u2611 ",          # ☑
    "radio": "\u25cb ",             # ○
    "heading": "\U0001f4cc ",       # 📌
    "listbox": "\U0001f4cb ",       # 📋
    "option": "\u2022 ",            # •
    "tab": "\U0001f4d1 ",           # 📑
    "switch": "\U0001f500 ",        # 🔀
    "slider": "\U0001f527 ",        # 🔧
    "spinbutton": "\U0001f522 ",    # 🔢
    "img": "\U0001f5bc ",          # 🖼
    "figure": "\U0001f5bc ",       # 🖼
    "table": "\U0001f4ca ",         # 📊
    "grid": "\U0001f4ca ",          # 📊
    "gridcell": "\u25ab ",          # ▫
    "cell": "\u25ab ",              # ▫
    "dialog": "\U0001f4ac ",        # 💬
    "alertdialog": "\u26a0 ",       # ⚠
    "navigation": "\U0001f9ed ",    # 🧭
    "banner": "\U0001f4f0 ",        # 📰
    "main": "\U0001f4c4 ",          # 📄
    "complementary": "\U0001f4ce ", # 📎
    "contentinfo": "\u2139 ",       # ℹ
    "form": "\U0001f4dd ",          # 📝
    "search": "\U0001f50d ",        # 🔍
    "group": "\U0001f4e6 ",         # 📦
    "toolbar": "\U0001f527 ",       # 🔧
    "treeitem": "\u2022 ",          # •
    "menu": "\U0001f4cb ",          # 📋
    "menubar": "\U0001f4cb ",       # 📋
    "paragraph": "\U0001f4c3 ",     # 📃
    "article": "\U0001f4f0 ",       # 📰
    "section": "\U0001f4c4 ",       # 📄
    "list": "\U0001f4cb ",          # 📋
    "listitem": "\u2022 ",          # •
    "note": "\U0001f4dd ",          # 📝
    "alert": "\U0001f514 ",         # 🔔
    "status": "\U0001f4ca ",        # 📊
    "code": "\U0001f4bb ",          # 💻
    "blockquote": "\U0001f4ac ",   # 💬
    "columnheader": "\U0001f4ca ", # 📊
    "comment": "\U0001f4ac ",      # 💬
    "definition": "\U0001f4d6 ",   # 📖
    "deletion": "\u274c ",         # ❌
    "insertion": "\u2795 ",        # ➕
    "log": "\U0001f4cb ",          # 📋
    "mark": "\U0001f58d \ufe0f ", # 🖍️
    "marquee": "\U0001f4dc ",      # 📜
    "math": "\U0001f9ee ",         # 🧮
    "menuitem": "\U0001f4cb ",    # 📋
    "menuitemcheckbox": "\u2611 ",  # ☑
    "menuitemradio": "\u25cb ",    # ○
    "meter": "\U0001f4ca ",        # 📊
    "progressbar": "\u23f3 ",      # ⏳
    "region": "\U0001f4e6 ",        # 📦
    "rowheader": "\U0001f4ca ",    # 📊
    "scrollbar": "\U0001f4dc ",    # 📜
    "suggestion": "\U0001f4a1 ",   # 💡
    "tabpanel": "\U0001f4d1 ",     # 📑
    "term": "\U0001f4d6 ",         # 📖
    "text": "\U0001f4dd ",         # 📝
    "timer": "\u23f1 \ufe0f ",    # ⏱️
    "tooltip": "\U0001f4a1 ",      # 💡
    "treegrid": "\U0001f4ca ",     # 📊
}


def _role_icon(role: str) -> str:
    return _ROLE_ICONS.get(role, "")


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

def parse_snapshot(snap: str, max_elements: int = 500) -> AriaParseResult:
    """Parse the YAML-like output of Playwright's page.aria_snapshot().

    Dialog prioritisation: interactive elements inside ``dialog``/``alertdialog``
    blocks always get @e refs even when that pushes non-dialog elements
    beyond the max_elements cap.  This ensures modal/overlay elements are
    always clickable regardless of where they appear in the DOM order.

    Args:
        snap: The raw snapshot string.
        max_elements: Maximum number of interactive elements to assign @e refs.

    Returns:
        An AriaParseResult with formatted text, element cache, and count.
    """
    lines = snap.split("\n")

    # ── First pass: count interactive elements inside dialogs ─────────
    dialog_refs_needed = 0
    count_dialog_stack: list[int] = []

    for raw_line in lines:
        if not raw_line.strip():
            continue
        depth = _count_leading_spaces(raw_line)
        trimmed = raw_line.strip()
        if trimmed.startswith("/"):
            continue

        parsed = _parse_line(trimmed)
        if parsed is None:
            continue

        role = parsed.role

        # Close dialogs where current depth ≤ dialog-header depth
        while count_dialog_stack and depth <= count_dialog_stack[-1]:
            if role not in ("dialog", "alertdialog"):
                count_dialog_stack.pop()
            else:
                break

        # Open new dialog
        if role in ("dialog", "alertdialog"):
            count_dialog_stack.append(depth)
            dialog_refs_needed += 1  # count the dialog header itself
            continue

        is_inside = bool(count_dialog_stack) and depth > count_dialog_stack[-1]

        if is_inside and role in INTERACTIVE_ROLES and role not in INFORMATIONAL_ROLES:
            dialog_refs_needed += 1

    # ── Budget ──────────────────────────────────────────────────────
    non_dialog_budget = max(0, max_elements - dialog_refs_needed)

    # ── Second pass: assign refs with dialog priority ───────────────
    elements: dict[str, AriaCachedNode] = {}
    out_lines: list[str] = []
    ref_counter = 0
    total_interactive_count = 0  # all interactive elements (even those skipped)
    non_dialog_assigned = 0  # non-dialog refs assigned so far
    occurrence_tracker: dict[str, int] = {}
    dialog_stack: list[int] = []

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

        # Close dialogs where current depth ≤ dialog-header depth
        while dialog_stack and depth <= dialog_stack[-1]:
            if role not in ("dialog", "alertdialog"):
                dialog_stack.pop()
            else:
                break

        # Open new dialog
        if role in ("dialog", "alertdialog"):
            dialog_stack.append(depth)

        is_inside_dialog = bool(dialog_stack) and depth > dialog_stack[-1]

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

        total_interactive_count += 1  # count every interactive element, even skipped

        # Dialog priority: dialog-interior elements always get refs
        # (within max_elements), non-dialog elements use remaining budget.
        if not is_inside_dialog:
            if non_dialog_assigned >= non_dialog_budget:
                out_lines.append(raw_line)
                continue

        ref_counter += 1
        if ref_counter > max_elements:
            out_lines.append(raw_line)
            continue

        if not is_inside_dialog:
            non_dialog_assigned += 1

        ref = f"e{ref_counter}"
        occ_key = f"{role}||{name}"
        occurrence_index = occurrence_tracker.get(occ_key, 0)
        occurrence_tracker[occ_key] = occurrence_index + 1

        node = AriaCachedNode(
            ref=ref,
            role=role,
            name=name,
            props=props,
            depth=depth,
            raw=trimmed,
            occurrence_index=occurrence_index,
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
        count=total_interactive_count,
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
