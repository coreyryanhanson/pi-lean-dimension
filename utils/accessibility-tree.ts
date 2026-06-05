/**
 * Accessibility tree utilities.
 *
 * Parses Playwright's page.ariaSnapshot() YAML-like output into an
 * LLM-friendly text format with @e1, @e2 element references. Caches
 * parsed nodes so interactions (click, type) can map back via getByRole().
 */

/** A single parsed node from the aria snapshot, cached for interaction */
export interface AriaCachedNode {
  ref: string;
  role: string;
  name: string;
  props: string[];
  depth: number;
  raw: string;
}

export interface AriaParseResult {
  /** Text with @e1, @e2 refs added */
  text: string;
  /** Map of ref → parsed node for interaction lookup */
  elements: Map<string, AriaCachedNode>;
  /** Total interactive elements found */
  count: number;
}

/**
 * Roles that get @e refs and can be used for interaction.
 */
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox",
  "checkbox", "radio", "heading", "listbox", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "treeitem", "switch", "slider", "spinbutton",
  "progressbar", "meter", "scrollbar", "gridcell",
  "cell", "columnheader", "rowheader", "tabpanel",
  "img", "figure", "listitem", "dialog", "alertdialog",
  "tooltip", "navigation", "banner", "form", "search",
  "toolbar", "menu", "menubar", "note", "alert",
  "status", "list", "table", "grid", "treegrid",
  "article", "section", "blockquote", "code",
]);

/**
 * Roles that are shown in the tree but DON'T get @e refs
 * (informational only, not useful click targets).
 */
const INFORMATIONAL_ROLES = new Set([
  "paragraph", "text", "group", "region", "main",
  "complementary", "contentinfo", "definition", "term",
  "math", "marquee", "timer", "log", "deletion",
  "insertion", "mark", "suggestion", "comment",
]);

/**
 * Parse the YAML-like output of page.ariaSnapshot().
 */
export function parseSnapshot(
  snap: string,
  options?: { maxElements?: number },
): AriaParseResult {
  const elements = new Map<string, AriaCachedNode>();
  const outLines: string[] = [];
  let refCounter = 0;
  const maxElements = options?.maxElements ?? 500;

  const lines = snap.split("\n");

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    const depth = countLeadingSpaces(rawLine);
    const trimmed = rawLine.trim();

    // Property lines (start with /) — pass through as-is
    if (trimmed.startsWith("/")) {
      outLines.push(rawLine);
      continue;
    }

    // Parse "- role ..."
    const parsed = parseLine(trimmed);
    if (!parsed) {
      outLines.push(rawLine);
      continue;
    }

    const { role, name, props } = parsed;

    // Informational roles: show in tree but no @e ref
    if (INFORMATIONAL_ROLES.has(role)) {
      const indent = "  ".repeat(depth);
      const icon = roleIcon(role);
      const namePart = name ? ` "${truncate(name, 80)}"` : "";
      outLines.push(`${indent}${icon}${role}${namePart}`);
      continue;
    }

    // Non-interactive skip
    if (!INTERACTIVE_ROLES.has(role)) {
      outLines.push(rawLine);
      continue;
    }

    refCounter++;
    if (refCounter > maxElements) {
      outLines.push(rawLine);
      continue;
    }

    const ref = `e${refCounter}`;
    const node: AriaCachedNode = { ref, role, name, props, depth, raw: trimmed };
    elements.set(ref, node);

    const indent = "  ".repeat(depth);
    const icon = roleIcon(role);
    const refTag = `@${ref}`;
    const namePart = name ? ` "${truncate(name, 80)}"` : "";
    const propStr = props.length > 0 ? ` [${props.join(", ")}]` : "";

    outLines.push(`${indent}${refTag} ${icon}${role}${namePart}${propStr}`);
  }

  return {
    text: outLines.join("\n"),
    elements,
    count: refCounter,
  };
}

/**
 * Build a Playwright locator for a cached node using getByRole().
 */
export function buildLocator(
  page: import("playwright").Page,
  node: AriaCachedNode,
): import("playwright").Locator | null {
  try {
    const opts: Record<string, unknown> = {};

    if (node.name) {
      opts.name = node.name;
      opts.exact = node.name.length < 60;
    }

    for (const prop of node.props) {
      const eqIdx = prop.indexOf("=");
      if (eqIdx > 0) {
        const key = prop.slice(0, eqIdx);
        const val = prop.slice(eqIdx + 1);
        if (key === "level") opts.level = parseInt(val, 10);
        if (key === "checked") opts.checked = val === "mixed" ? "mixed" : true;
        if (key === "expanded") opts.expanded = val === "true";
        if (key === "pressed") opts.pressed = val === "mixed" ? "mixed" : true;
        if (key === "selected") opts.selected = val === "true";
      } else {
        if (prop === "checked") opts.checked = true;
        if (prop === "expanded") opts.expanded = true;
        if (prop === "pressed") opts.pressed = true;
        if (prop === "selected") opts.selected = true;
        if (prop === "disabled") opts.disabled = true;
      }
    }

    return page.getByRole(node.role as any, opts);
  } catch {
    if (node.name) {
      return page.getByText(node.name, { exact: node.name.length < 60 });
    }
    return null;
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────

interface ParsedLine {
  role: string;
  name: string;
  props: string[];
}

function parseLine(line: string): ParsedLine | null {
  if (!line.startsWith("- ")) return null;
  const content = line.slice(2).trim();

  const props: string[] = [];
  const cleaned = content.replace(/\[([^\]]+)\]/g, (_m, capture) => {
    props.push(capture.trim());
    return "";
  }).trim();

  const match = cleaned.match(/^([a-zA-Z_-]+)\s*/);
  if (!match) return null;

  const role = match[1].toLowerCase();
  let remainder = cleaned.slice(match[0].length).trim();
  let name = "";

  // Quoted name: "name" or "name":
  const nameMatch = remainder.match(/^"((?:[^"\\]|\\.)*)"\s*:?\s*/);
  if (nameMatch) {
    name = nameMatch[1];
  } else {
    // Colon-text format: ": text content"
    const textMatch = remainder.match(/^:\s*(.*)/);
    if (textMatch) {
      name = textMatch[1].trim().slice(0, 100);
    }
  }

  return { role, name, props };
}

function countLeadingSpaces(s: string): number {
  const match = s.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function roleIcon(role: string): string {
  const icons: Record<string, string> = {
    button: "🔘 ", link: "🔗 ", textbox: "📝 ", searchbox: "🔍 ",
    combobox: "📋 ", checkbox: "☑ ", radio: "○ ", heading: "📌 ",
    listbox: "📋 ", option: "• ", tab: "📑 ", switch: "🔀 ",
    slider: "🔧 ", spinbutton: "🔢 ", img: "🖼 ", figure: "🖼 ",
    table: "📊 ", grid: "📊 ", cell: "▫ ", dialog: "💬 ",
    alertdialog: "⚠ ", navigation: "🧭 ", banner: "📰 ",
    main: "📄 ", complementary: "📎 ", contentinfo: "ℹ ",
    form: "📝 ", search: "🔍 ", group: "📦 ", toolbar: "🔧 ",
    menu: "📋 ", menubar: "📋 ", paragraph: "📃 ", article: "📰 ",
    section: "📄 ", list: "📋 ", listitem: "• ", note: "📝 ",
    alert: "🔔 ", status: "📊 ", code: "💻 ", blockquote: "💬 ",
  };
  return icons[role] || "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
