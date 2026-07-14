"""
Tests for pi_browser_bridge.accessibility.

Parses Playwright's page.accessibility.snapshot() YAML-like output and
produces the LLM-friendly text format with @e refs.  Tests cover every
interactive and informational role, edge cases, and output format
conformance with the TypeScript version.
"""


import pytest

from pi_browser_bridge.accessibility import (
    AriaCachedNode,
    AriaParseResult,
    parse_snapshot,
    build_locator_args,
    _parse_line,
    INTERACTIVE_ROLES,
    INFORMATIONAL_ROLES,
)


# ═════════════════════════════════════════════════════════════════════
#  _parse_line
# ═════════════════════════════════════════════════════════════════════


class TestParseLine:
    def test_basic_button(self) -> None:
        result = _parse_line('- button "Click me"')
        assert result is not None
        assert result.role == "button"
        assert result.name == "Click me"
        assert result.props == []

    def test_link_with_props(self) -> None:
        result = _parse_line('- link "Example" [level=1]')
        assert result is not None
        assert result.role == "link"
        assert result.name == "Example"
        assert result.props == ["level=1"]

    def test_multiple_props(self) -> None:
        result = _parse_line('- checkbox "Option" [checked][expanded=true]')
        assert result is not None
        assert result.role == "checkbox"
        assert result.name == "Option"
        assert result.props == ["checked", "expanded=true"]

    def test_textbox_with_name_colon(self) -> None:
        result = _parse_line('- textbox "Search":')
        assert result is not None
        assert result.role == "textbox"
        assert result.name == "Search"

    def test_colon_text_format(self) -> None:
        result = _parse_line("- heading : Welcome to the page")
        assert result is not None
        assert result.role == "heading"
        assert result.name == "Welcome to the page"

    def test_no_name(self) -> None:
        result = _parse_line("- button ")
        assert result is not None
        assert result.role == "button"
        assert result.name == ""

    def test_role_with_hyphen(self) -> None:
        result = _parse_line("- menu-item " ' "Save"')
        assert result is not None
        assert result.role == "menu-item"
        assert result.name == "Save"

    def test_not_a_dash_line(self) -> None:
        assert _parse_line("  button") is None

    def test_empty_line(self) -> None:
        assert _parse_line("") is None

    def test_only_dash(self) -> None:
        # "- " with nothing after — no role, returns None
        result = _parse_line("- ")
        assert result is None

    def test_name_with_escaped_quote(self) -> None:
        # Playwright's aria snapshot does not produce escaped quotes.
        # This is a known limitation of the current regex-based parser.
        result = _parse_line('- button "Say \\"Hello\\""')
        assert result is not None
        assert result.role == "button"


# ═════════════════════════════════════════════════════════════════════
#  parse_snapshot
# ═════════════════════════════════════════════════════════════════════

# ── Empty / edge cases ────────────────────────────────────────────


class TestParseSnapshotEmpty:
    def test_empty_string(self) -> None:
        result = parse_snapshot("")
        assert result.text == ""
        assert result.elements == {}
        assert result.count == 0

    def test_only_newlines(self) -> None:
        result = parse_snapshot("\n\n\n")
        assert result.text == ""
        assert result.count == 0

    def test_only_property_lines(self) -> None:
        snap = '/root "Root"\n/how "How"'
        result = parse_snapshot(snap)
        assert result.count == 0
        assert result.text == snap  # passed through as-is


# ── Single element ────────────────────────────────────────────────


class TestParseSnapshotSingle:
    def test_interactive_button(self) -> None:
        snap = '- button "Click Me"'
        result = parse_snapshot(snap)
        assert result.count == 1
        assert "@e1" in result.text
        assert "🔘" in result.text  # role icon
        assert "Click Me" in result.text
        assert "e1" in result.elements
        assert result.elements["e1"].role == "button"

    def test_informational_paragraph(self) -> None:
        snap = '- paragraph "Some text"'
        result = parse_snapshot(snap)
        assert result.count == 0
        assert "@e1" not in result.text
        assert "paragraph" in result.text  # shown without ref
        assert result.elements == {}

    def test_non_interactive_unknown_role(self) -> None:
        snap = "- widget 'foobar'"
        result = parse_snapshot(snap)
        assert result.count == 0  # unknown roles are not counted
        # Unknown roles are passed through as-is
        assert result.text == snap

    def test_link(self) -> None:
        snap = '- link "Example Domain"'
        result = parse_snapshot(snap)
        assert result.count == 1
        assert "@e1" in result.text
        assert "🔗" in result.text


# ── Multiple elements, indentation, hierarchy ─────────────────────


class TestParseSnapshotHierarchy:
    SNAP = (
        '- navigation "Main"\n'
        "  - link Home\n"
        "    - button \"About\"\n"
        '- main "Content"\n'
        "  - heading : Welcome\n"
        "    - paragraph \"Intro text\"\n"
        "  - button Get Started"
    )

    def test_counts_interactive_elements(self) -> None:
        result = parse_snapshot(self.SNAP)
        # navigation, link, button, heading, button = 5 interactive
        # paragraph is informational → not counted
        assert result.count == 5

    def test_assigns_consecutive_refs(self) -> None:
        result = parse_snapshot(self.SNAP)
        refs = list(result.elements.keys())
        assert refs == ["e1", "e2", "e3", "e4", "e5"]

    def test_preserves_indentation(self) -> None:
        result = parse_snapshot(self.SNAP)
        for line in result.text.split("\n"):
            if "e1" in line:
                # navigation at depth 0
                assert not line.startswith(" ")
            elif "e2" in line:
                assert line.startswith("  ")  # depth 2
            elif "e3" in line:
                assert line.startswith("    ")  # depth 4

    def test_informational_shown_without_ref(self) -> None:
        result = parse_snapshot(self.SNAP)
        # paragraph should appear in output but without @e ref
        assert "paragraph" in result.text
        assert "@e" not in (
            line
            for line in result.text.split("\n")
            if "paragraph" in line
        ).__iter__().__next__()

    def test_heading_gets_ref(self) -> None:
        result = parse_snapshot(self.SNAP)
        assert "e4" in result.elements
        assert result.elements["e4"].role == "heading"


# ── Props ─────────────────────────────────────────────────────────


class TestParseSnapshotProps:
    def test_simple_prop(self) -> None:
        snap = '- checkbox "Agree" [checked]'
        result = parse_snapshot(snap)
        assert result.count == 1
        assert result.elements["e1"].props == ["checked"]

    def test_key_value_prop(self) -> None:
        snap = '- heading "Title" [level=2]'
        result = parse_snapshot(snap)
        assert result.elements["e1"].props == ["level=2"]

    def test_multiple_props_in_output(self) -> None:
        snap = '- checkbox "Opt" [checked, disabled]'
        result = parse_snapshot(snap)
        assert "[checked, disabled]" in result.text

    def test_props_on_informational_role(self) -> None:
        # Informational roles show props but don't get refs
        snap = '- paragraph "Note" [some-prop]'
        result = parse_snapshot(snap)
        assert result.count == 0
        # paragraph text should appear without @e ref
        assert "@e1" not in result.text
        assert "paragraph" in result.text


# ── Property lines (/) ────────────────────────────────────────────


class TestParseSnapshotPropertyLines:
    def test_property_lines_passed_through(self) -> None:
        snap = "/root Root\n- link Example\n/how How"
        result = parse_snapshot(snap)
        assert "/root Root" in result.text
        assert "/how How" in result.text
        assert "@e1" in result.text


# ── All interactive roles produce refs ────────────────────────────


class TestParseSnapshotAllInteractiveRoles:
    """Every role in INTERACTIVE_ROLES should produce an @e ref."""

    @pytest.mark.parametrize("role", sorted(INTERACTIVE_ROLES))
    def test_role_gets_ref(self, role: str) -> None:
        name = f"Test{role}"
        snap = f'- {role} "{name}"'
        result = parse_snapshot(snap)
        assert result.count == 1, f"{role} should produce a ref"
        assert "e1" in result.elements
        assert result.elements["e1"].role == role


# ── All informational roles are shown without refs ────────────────


class TestParseSnapshotAllInformationalRoles:
    @pytest.mark.parametrize("role", sorted(INFORMATIONAL_ROLES))
    def test_role_shown_without_ref(self, role: str) -> None:
        snap = f'- {role} "Info text"'
        result = parse_snapshot(snap)
        assert result.count == 0, f"{role} should NOT produce a ref"
        assert role in result.text, f"{role} should appear in output"
        assert "@e1" not in result.text


# ── Name truncation ───────────────────────────────────────────────


class TestParseSnapshotNameTruncation:
    def test_long_name_truncated(self) -> None:
        long_name = "A" * 200
        snap = f'- button "{long_name}"'
        result = parse_snapshot(snap)
        assert len(long_name) > 80
        # The truncated name in output should be <= 81 chars (80 + …)
        name_part = result.text.split('"')[1]
        assert len(name_part) <= 81
        assert "…" in name_part

    def test_short_name_not_truncated(self) -> None:
        snap = '- button "Short"'
        result = parse_snapshot(snap)
        assert '"Short"' in result.text


# ── Output format conformance ─────────────────────────────────────


class TestParseSnapshotOutputFormat:
    """Verify the output format matches what the TypeScript parser produces."""

    def test_line_format_with_ref(self) -> None:
        snap = '- button "Click"'
        result = parse_snapshot(snap)
        expected = '@e1 🔘 button "Click"'
        assert result.text == expected

    def test_line_format_with_ref_and_props(self) -> None:
        snap = '- checkbox "Opt" [checked]'
        result = parse_snapshot(snap)
        expected = '@e1 ☑ checkbox "Opt" [checked]'
        assert result.text == expected

    def test_informational_line_format(self) -> None:
        snap = '- paragraph "Body text"'
        result = parse_snapshot(snap)
        expected = '📃 paragraph "Body text"'
        assert result.text == expected

    def test_no_name_line(self) -> None:
        snap = "- button"
        result = parse_snapshot(snap)
        assert result.text == "@e1 🔘 button"

    def test_complex_hierarchy(self) -> None:
        snap = (
            '- navigation "Main"\n'
            '  - link "Home"\n'
            '    - button "About"\n'
            '  - button "Search"'
        )
        result = parse_snapshot(snap)
        lines = result.text.split("\n")
        assert len(lines) == 4
        # Indentation: depth represents raw space count. The indent unit
        # is "  " (2 spaces), so output uses depth*2 spaces per level.
        assert lines[0] == '@e1 🧭 navigation "Main"'
        assert lines[1] == '    @e2 🔗 link "Home"'   # depth=2 → 4 spaces
        assert lines[2] == '        @e3 🔘 button "About"'  # depth=4 → 8 spaces
        assert lines[3] == '    @e4 🔘 button "Search"'   # depth=2 → 4 spaces


# ── Roundtrip with element cache ──────────────────────────────────


class TestParseSnapshotElementCache:
    def test_cache_contains_all_parsed_data(self) -> None:
        snap = '- checkbox "Opt" [checked][disabled]'
        result = parse_snapshot(snap)
        node = result.elements["e1"]
        assert node.ref == "e1"
        assert node.role == "checkbox"
        assert node.name == "Opt"
        assert node.props == ["checked", "disabled"]
        assert node.depth == 0
        assert node.raw == snap

    def test_cache_depth(self) -> None:
        snap = "  - button Nested"
        result = parse_snapshot(snap)
        assert result.elements["e1"].depth == 2


# ═════════════════════════════════════════════════════════════════════
#  build_locator_args
# ═════════════════════════════════════════════════════════════════════


class TestBuildLocatorArgs:
    def test_basic_button(self) -> None:
        node = AriaCachedNode(
            ref="e1",
            role="button",
            name="Click",
            props=[],
            depth=0,
            raw="- button Click",
        )
        role, kwargs = build_locator_args(node)
        assert role == "button"
        assert kwargs["name"] == "Click"
        assert kwargs["exact"] == True
        assert kwargs["occurrenceIndex"] == 0

    def test_heading_with_level(self) -> None:
        node = AriaCachedNode(
            ref="e2",
            role="heading",
            name="Title",
            props=["level=2"],
            depth=0,
            raw='- heading "Title" [level=2]',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["level"] == 2
        assert kwargs["name"] == "Title"

    def test_checked_checkbox(self) -> None:
        node = AriaCachedNode(
            ref="e3",
            role="checkbox",
            name="Agree",
            props=["checked"],
            depth=0,
            raw='- checkbox "Agree" [checked]',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["checked"] == True

    def test_mixed_checkbox(self) -> None:
        node = AriaCachedNode(
            ref="e4",
            role="checkbox",
            name="Partial",
            props=["checked=mixed"],
            depth=0,
            raw='- checkbox "Partial" [checked=mixed]',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["checked"] == "mixed"

    def test_expanded(self) -> None:
        node = AriaCachedNode(
            ref="e5",
            role="treeitem",
            name="Node",
            props=["expanded=true"],
            depth=0,
            raw='- treeitem "Node" [expanded=true]',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["expanded"] == True

    def test_collapsed(self) -> None:
        node = AriaCachedNode(
            ref="e6",
            role="treeitem",
            name="Node",
            props=["expanded=false", "selected"],
            depth=0,
            raw='- treeitem "Node" [expanded=false, selected]',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["expanded"] == False
        assert kwargs["selected"] == True

    def test_disabled(self) -> None:
        node = AriaCachedNode(
            ref="e7",
            role="button",
            name="Save",
            props=["disabled"],
            depth=0,
            raw='- button "Save" [disabled]',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["disabled"] == True

    def test_pressed(self) -> None:
        node = AriaCachedNode(
            ref="e8",
            role="button",
            name="Toggle",
            props=["pressed"],
            depth=0,
            raw='- button "Toggle" [pressed]',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["pressed"] == True

    def test_pressed_mixed(self) -> None:
        node = AriaCachedNode(
            ref="e9",
            role="button",
            name="Toggle",
            props=["pressed=mixed"],
            depth=0,
            raw='- button "Toggle" [pressed=mixed]',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["pressed"] == "mixed"

    def test_long_name_no_exact(self) -> None:
        long = "A" * 60
        node = AriaCachedNode(
            ref="e10",
            role="link",
            name=long,
            props=[],
            depth=0,
            raw=f'- link "{long}"',
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["name"] == long
        assert kwargs["exact"] == False

    def test_includes_occurrence_index_unique(self) -> None:
        """build_locator_args includes occurrenceIndex=0 for unique elements."""
        node = AriaCachedNode(
            ref="e1",
            role="button",
            name="Click",
            props=[],
            depth=0,
            raw="- button Click",
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["occurrenceIndex"] == 0

    def test_includes_occurrence_index_duplicate(self) -> None:
        """build_locator_args includes occurrenceIndex > 0 for duplicates."""
        node = AriaCachedNode(
            ref="e2",
            role="link",
            name="Promoted",
            props=[],
            depth=0,
            raw='- link "Promoted"',
            occurrence_index=2,
        )
        role, kwargs = build_locator_args(node)
        assert kwargs["occurrenceIndex"] == 2

    def test_occurrence_index_is_int(self) -> None:
        """occurrenceIndex in kwargs is always an int."""
        node = AriaCachedNode(
            ref="e1",
            role="button",
            name="Save",
            props=[],
            depth=0,
            raw="- button Save",
            occurrence_index=0,
        )
        role, kwargs = build_locator_args(node)
        assert isinstance(kwargs["occurrenceIndex"], int)


# ═════════════════════════════════════════════════════════════════════
#  parse_snapshot — occurrence_index (duplicate disambiguation)
# ═════════════════════════════════════════════════════════════════════


class TestParseSnapshotOccurrenceIndex:
    """Tests for parse_snapshot assignment of occurrence_index to each element."""

    def test_unique_element_index_zero(self) -> None:
        result = parse_snapshot('- link "Click"')
        assert result.elements["e1"].occurrence_index == 0

    def test_two_different_roles(self) -> None:
        result = parse_snapshot('- link "Home"\n- button "Submit"')
        assert result.elements["e1"].occurrence_index == 0
        assert result.elements["e2"].occurrence_index == 0

    def test_two_different_names_same_role(self) -> None:
        result = parse_snapshot('- link "First"\n- link "Second"')
        # Different names => each is unique in its group
        assert result.elements["e1"].occurrence_index == 0
        assert result.elements["e2"].occurrence_index == 0

    def test_three_identical_links(self) -> None:
        snap = "\n".join(['- link "Promoted"'] * 3)
        result = parse_snapshot(snap)
        assert result.elements["e1"].occurrence_index == 0
        assert result.elements["e2"].occurrence_index == 1
        assert result.elements["e3"].occurrence_index == 2

    def test_independent_groups(self) -> None:
        """Each (role, name) pair is tracked independently."""
        snap = "\n".join([
            '- link "Home"',
            '- link "Promoted"',
            '- button "Home"',
            '- link "Promoted"',
            '- link "Home"',
        ])
        result = parse_snapshot(snap)
        assert result.elements["e1"].occurrence_index == 0  # link "Home" #1
        assert result.elements["e2"].occurrence_index == 0  # link "Promoted" #1
        assert result.elements["e3"].occurrence_index == 0  # button "Home" #1
        assert result.elements["e4"].occurrence_index == 1  # link "Promoted" #2
        assert result.elements["e5"].occurrence_index == 1  # link "Home" #2

    def test_empty_name_duplicates(self) -> None:
        snap = "\n".join([
            '- link',
            '- link',
            '- link "Labeled"',
        ])
        result = parse_snapshot(snap)
        # Two empty-name links are duplicates
        assert result.elements["e1"].name == ""
        assert result.elements["e1"].occurrence_index == 0
        assert result.elements["e2"].name == ""
        assert result.elements["e2"].occurrence_index == 1
        # Named link with same role is a different group
        assert result.elements["e3"].occurrence_index == 0

    def test_interactive_only(self) -> None:
        """Informational roles don't get @e refs, don't affect occurrence tracking."""
        snap = "\n".join([
            '- paragraph "text"',
            '- link "Promoted"',
            '- link "Promoted"',
        ])
        result = parse_snapshot(snap)
        assert result.count == 2
        assert result.elements["e1"].occurrence_index == 0  # first link
        assert result.elements["e2"].occurrence_index == 1  # second link

