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
	/** 0-based position among siblings with the same role+name in the snapshot */
	occurrenceIndex: number;
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
export const INTERACTIVE_ROLES = new Set([
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
]);

/**
 * Roles that are shown in the tree but DON'T get @e refs
 * (informational only, not useful click targets).
 */
export const INFORMATIONAL_ROLES = new Set([
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
]);

/**
 * Parse the YAML-like output of page.ariaSnapshot().
 *
 * Dialog prioritisation: interactive elements inside `dialog`/`alertdialog`
 * blocks always get @e refs even when that pushes non-dialog elements
 * beyond the maxElements cap.  This ensures modal/overlay elements are
 * always clickable regardless of where they appear in the DOM order.
 */
export function parseSnapshot(
	snap: string,
	options?: { maxElements?: number },
): AriaParseResult {
	const maxElements = options?.maxElements ?? 500;
	const elements = new Map<string, AriaCachedNode>();
	const outLines: string[] = [];
	let refCounter = 0;
	const occurrenceTracker = new Map<string, number>();

	const lines = snap.split("\n");

	// ── First pass: count interactive elements inside dialogs ─────────
	// This determines how many @e ref slots to reserve for dialog elements.
	let dialogRefsNeeded = 0;
	const countDialogDepthStack: number[] = [];

	for (const rawLine of lines) {
		if (!rawLine.trim()) continue;
		const depth = countLeadingSpaces(rawLine);
		const trimmed = rawLine.trim();
		if (trimmed.startsWith("/")) continue;

		const parsed = parseLine(trimmed);
		if (!parsed) continue;

		const { role } = parsed;

		// Close dialogs where current depth ≤ dialog-header depth
		while (
			countDialogDepthStack.length > 0 &&
			depth <= countDialogDepthStack[countDialogDepthStack.length - 1]!
		) {
			if (role !== "dialog" && role !== "alertdialog") {
				countDialogDepthStack.pop();
			} else {
				break; // This IS a dialog header — don't close previous
			}
		}

		// Open new dialog
		if (role === "dialog" || role === "alertdialog") {
			countDialogDepthStack.push(depth);
			dialogRefsNeeded++; // count the dialog header itself
			continue;
		}

		const isInside =
			countDialogDepthStack.length > 0 &&
			depth > countDialogDepthStack[countDialogDepthStack.length - 1]!;

		if (
			isInside &&
			INTERACTIVE_ROLES.has(role) &&
			!INFORMATIONAL_ROLES.has(role)
		) {
			dialogRefsNeeded++;
		}
	}

	// ── Budget ─────────────────────────────────────────────────────
	// Non-dialog elements compete for the remaining ref slots.
	const nonDialogBudget = Math.max(0, maxElements - dialogRefsNeeded);

	// ── Second pass: assign refs with dialog priority ──────────────
	const dialogDepthStack: number[] = [];
	let totalInteractiveCount = 0; // all interactive elements (even those skipped)
	let nonDialogAssigned = 0; // non-dialog refs assigned so far

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

		// Close dialogs where current depth ≤ dialog-header depth
		while (
			dialogDepthStack.length > 0 &&
			depth <= dialogDepthStack[dialogDepthStack.length - 1]!
		) {
			if (role !== "dialog" && role !== "alertdialog") {
				dialogDepthStack.pop();
			} else {
				break; // This IS a dialog header — it replaces, not closes
			}
		}

		// Open new dialog
		if (role === "dialog" || role === "alertdialog") {
			dialogDepthStack.push(depth);
		}

		const isInsideDialog =
			dialogDepthStack.length > 0 &&
			depth > dialogDepthStack[dialogDepthStack.length - 1]!;

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

		totalInteractiveCount++; // count every interactive element, even skipped

		// Dialog priority: dialog-interior elements always get refs
		// (within maxElements), non-dialog elements use remaining budget.
		if (!isInsideDialog) {
			if (nonDialogAssigned >= nonDialogBudget) {
				outLines.push(rawLine);
				continue;
			}
		}

		refCounter++;
		if (refCounter > maxElements) {
			outLines.push(rawLine);
			continue;
		}

		if (!isInsideDialog) nonDialogAssigned++;

		const ref = `e${refCounter}`;
		const occKey = `${role}||${name}`;
		const occurrenceIndex = occurrenceTracker.get(occKey) ?? 0;
		occurrenceTracker.set(occKey, occurrenceIndex + 1);

		const node: AriaCachedNode = {
			ref,
			role,
			name,
			props,
			depth,
			raw: trimmed,
			occurrenceIndex,
		};
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
		count: totalInteractiveCount,
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

		const locator = page.getByRole(node.role as any, opts);
		// Always use .nth(occurrenceIndex) to avoid strict-mode violations
		// when multiple elements share the same role+name.  For unique elements
		// (occurrenceIndex = 0) this is equivalent to the bare locator.
		return locator.nth(node.occurrenceIndex);
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
	const cleaned = content
		.replace(/\[([^\]]+)\]/g, (_m, capture) => {
			props.push(capture.trim());
			return "";
		})
		.trim();

	const match = cleaned.match(/^([a-zA-Z_-]+)\s*/);
	if (!match) return null;

	const role = (match[1] ?? "").toLowerCase();
	const remainder = cleaned.slice(match[0].length).trim();
	let name = "";

	// Quoted name: "name" or "name":
	const nameMatch = remainder.match(/^"((?:[^"\\]|\\.)*)"\s*:?\s*/);
	if (nameMatch) {
		name = nameMatch[1] ?? "";
	} else {
		// Colon-text format: ": text content"
		const textMatch = remainder.match(/^:\s*(.*)/);
		if (textMatch) {
			name = (textMatch[1] ?? "").trim().slice(0, 100);
		}
	}

	return { role, name, props };
}

function countLeadingSpaces(s: string): number {
	const match = s.match(/^(\s*)/);
	return match ? (match[1] ?? "").length : 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function roleIcon(role: string): string {
	const icons: Record<string, string> = {
		alert: "🔔 ",
		alertdialog: "⚠ ",
		article: "📰 ",
		banner: "📰 ",
		blockquote: "💬 ",
		button: "🔘 ",
		cell: "▫ ",
		checkbox: "☑ ",
		code: "💻 ",
		columnheader: "📊 ",
		combobox: "📋 ",
		comment: "💬 ",
		complementary: "📎 ",
		contentinfo: "ℹ ",
		definition: "📖 ",
		deletion: "❌ ",
		dialog: "💬 ",
		figure: "🖼 ",
		form: "📝 ",
		grid: "📊 ",
		gridcell: "▫ ",
		group: "📦 ",
		heading: "📌 ",
		img: "🖼 ",
		insertion: "➕ ",
		link: "🔗 ",
		list: "📋 ",
		listbox: "📋 ",
		listitem: "• ",
		log: "📋 ",
		main: "📄 ",
		mark: "🖍️ ",
		marquee: "📜 ",
		math: "🧮 ",
		menu: "📋 ",
		menubar: "📋 ",
		menuitem: "📋 ",
		menuitemcheckbox: "☑ ",
		menuitemradio: "○ ",
		meter: "📊 ",
		navigation: "🧭 ",
		note: "📝 ",
		option: "• ",
		paragraph: "📃 ",
		progressbar: "⏳ ",
		radio: "○ ",
		region: "📦 ",
		rowheader: "📊 ",
		search: "🔍 ",
		searchbox: "🔍 ",
		scrollbar: "📜 ",
		section: "📄 ",
		slider: "🔧 ",
		spinbutton: "🔢 ",
		status: "📊 ",
		suggestion: "💡 ",
		switch: "🔀 ",
		tab: "📑 ",
		table: "📊 ",
		tabpanel: "📑 ",
		term: "📖 ",
		text: "📝 ",
		textbox: "📝 ",
		timer: "⏱️ ",
		toolbar: "🔧 ",
		tooltip: "💡 ",
		treegrid: "📊 ",
		treeitem: "• ",
	};
	return icons[role] || "";
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

/**
 * Compute a stable, lightweight fingerprint of an accessibility snapshot.
 *
 * Uses the first 200 characters of the snapshot to produce a short hash.
 * Same snapshot → same fingerprint. Different content → different fingerprint.
 * The fingerprint captures enough structural information to detect significant
 * DOM changes (SPA navigation, dynamic content loading) while being cheap to
 * compute (O(200) with no allocations).
 *
 * The hash is a DJB2 digest of the first 200 chars, returned as a base-36
 * string for compactness.
 */
export function snapshotFingerprint(snapshot: string): string {
	const sample = snapshot.slice(0, 200);
	let hash = 5381;
	for (let i = 0; i < sample.length; i++) {
		hash = (hash << 5) + hash + sample.charCodeAt(i);
		hash = hash & hash;
	}
	// Use unsigned 32-bit to avoid negative toString(36) output
	return (hash >>> 0).toString(36);
}
