/**
 * Accessibility tree utilities.
 *
 * Parses Playwright's page.ariaSnapshot() YAML-like output into an
 * LLM-friendly text format with @e1, @e2 element references. Caches
 * parsed nodes so interactions (click, type) can map back via getByRole().
 *
 * Role sets and icons are loaded from the shared ``browser-data.json``
 * — the same file used by the Python bridge so the two sides never drift.
 */

import { ACCESSIBILITY } from "./browser-data.js";

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
	/** Ref of the nearest interactive ancestor (e.g., for subtree queries) */
	parentRef?: string;
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
 * Loaded from shared browser-data.json.
 */
export const INTERACTIVE_ROLES = new Set(ACCESSIBILITY.interactiveRoles);

/**
 * Roles that are shown in the tree but DON'T get @e refs
 * (informational only, not useful click targets).
 * Loaded from shared browser-data.json.
 */
export const INFORMATIONAL_ROLES = new Set(ACCESSIBILITY.informationalRoles);

/**
 * Parse the YAML-like output of page.ariaSnapshot().
 *
 * Assigns @e refs sequentially to all interactive elements in DOM order.
 * Every interactive element gets a ref — no cap, no dialog prioritization.
 */
export function parseSnapshot(snap: string): AriaParseResult {
	const elements = new Map<string, AriaCachedNode>();
	const outLines: string[] = [];
	let refCounter = 0;
	const occurrenceTracker = new Map<string, number>();
	const parentStack: string[] = [];

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
		const ref = `e${refCounter}`;
		const occKey = `${role}||${name}`;
		const occurrenceIndex = occurrenceTracker.get(occKey) ?? 0;
		occurrenceTracker.set(occKey, occurrenceIndex + 1);

		// Parent stack: trim entries past current depth
		while (parentStack.length > depth) {
			parentStack.pop();
		}

		// Determine parentRef from the element at depth-1 (if any)
		const parentRef =
			parentStack.length >= depth && depth > 0
				? parentStack[depth - 1]
				: undefined;

		// Push this ref onto the parent stack at its depth
		parentStack[depth] = ref;

		const node: AriaCachedNode = {
			ref,
			role,
			name,
			props,
			depth,
			raw: trimmed,
			occurrenceIndex,
			...(parentRef ? { parentRef } : {}),
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
		count: elements.size,
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

export function roleIcon(role: string): string {
	return ACCESSIBILITY.roleIcons[role] ?? "";
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
