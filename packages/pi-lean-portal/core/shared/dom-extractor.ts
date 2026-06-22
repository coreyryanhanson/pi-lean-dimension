/**
 * DOM Extractor — reads visible page content and correlates it with
 * the ARIA element cache for @e ref annotations.
 *
 * Contains:
 * - The inline EXTRACTOR_SCRIPT (runs in browser page context via evaluate)
 * - runExtractor() — calls the script and validates the result
 * - correlateElements() — matches extracted content against the element cache
 * - queryElementCache() — synchronous cache filtering
 * - formatCorrelatedOutput(), formatElementList(), formatRoleCountSummary()
 * - Boilerplate filtering constants
 */

import type { BrowserPlugin } from "../plugin-api.js";
import type { AriaCachedNode } from "./accessibility-tree.js";
import { roleIcon } from "./accessibility-tree.js";

// ─── Text length filter ────────────────────────────────────────────

/**
 * Minimum trimmed text length for an extracted element to be included.
 *
 * Set to 3 to capture short-but-meaningful labels like "FAQ", "Top", "Map"
 * while still filtering out true noise (single chars, whitespace-only text).
 * Visibility filters (offsetParent, getClientRects, visibility) handle most
 * garbage — lowering from 5 to 3 adds short categories/links that are clearly
 * intentional content.
 */
const MIN_TEXT_LENGTH = 3;

// ─── Types ─────────────────────────────────────────────────────────

/** Structured result from the DOM walker script. */
export interface ExtractResult {
	title: string;
	headings: Array<{ level: number; text: string }>;
	paragraphs: Array<{ text: string; region?: string }>;
	links: Array<{ text: string; href: string }>;
	images: Array<{ alt: string; src: string }>;
	/** Interactive elements (buttons, inputs, selects, textareas) */
	interactive: Array<{
		text: string;
		role: string;
		type?: string;
		disabled: boolean;
	}>;
	/** Error string if the extractor script caught an exception */
	error?: string;
}

/** Output of the correlation step — text with @e annotations. */
export interface CorrelatedResult {
	/** Formatted text output with @e annotations */
	text: string;
	/** Number of matched refs */
	matchedRefs: number;
	/** Whether a staleness notice was appended */
	staleCache: boolean;
}

/** Parameters for queryElementCache. */
export interface ElementCacheQuery {
	role?: string;
	name?: string;
	ref?: string;
	subtree?: string;
}

// ─── EXTRACTOR_SCRIPT — runs in browser page context ──────────────

/**
 * Inline DOM walker script that runs in the browser page context
 * via page.evaluate(). Returns a JSON string matching ExtractResult.
 *
 * Playwright injects evaluate() at the DevTools protocol level,
 * bypassing page CSP. Sandboxed iframes without allow-scripts
 * are the only case that fails — the caller handles that.
 */
const EXTRACTOR_SCRIPT = `(() => {
  'use strict';
  try {
    const result = {
      title: document.title || '',
      headings: [],
      paragraphs: [],
      links: [],
      images: [],
      interactive: [],
    };

    // ── Headings ──
    const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (const h of headings) {
      const text = h.innerText.trim();
      if (text.length >= ${MIN_TEXT_LENGTH}) {
        result.headings.push({ level: +h.tagName[1], text: text });
      }
    }

    // ── Paragraphs ──
    const paras = document.querySelectorAll('p, li, td, blockquote, figcaption');
    for (const p of paras) {
      if (p.offsetParent === null) continue;
      if (p.getClientRects().length === 0) continue;
      if (window.getComputedStyle(p).visibility === 'hidden') continue;
      const text = p.innerText.trim();
      if (text.length < ${MIN_TEXT_LENGTH}) continue;

      const region = p.closest('[role="region"], [aria-labelledby], [aria-label]');
      const regionLabel = region
        ? (region.getAttribute('aria-label') || region.getAttribute('aria-labelledby') || '')
        : '';
      result.paragraphs.push({ text: text, region: regionLabel || undefined });
    }

    // ── Links ──
    const links = document.querySelectorAll('a[href]');
    for (const a of links) {
      if (a.offsetParent === null) continue;
      if (a.getClientRects().length === 0) continue;
      if (window.getComputedStyle(a).visibility === 'hidden') continue;
      const text = a.innerText.trim();
      if (text.length < ${MIN_TEXT_LENGTH}) continue;

      result.links.push({ text: text, href: a.href });
    }

    // ── Images ──
    const imgs = document.querySelectorAll('img[alt]');
    for (const img of imgs) {
      if (img.offsetParent === null) continue;
      if (img.getClientRects().length === 0) continue;
      if (window.getComputedStyle(img).visibility === 'hidden') continue;
      const alt = (img.alt || '').trim();
      if (alt.length < ${MIN_TEXT_LENGTH}) continue;
      result.images.push({ alt: alt, src: img.src });
    }

    // ── Interactive elements ──
    const interactive = document.querySelectorAll(
      'button, [role="button"], input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), select, textarea'
    );
    for (const el of interactive) {
      if (el.offsetParent === null) continue;
      if (el.getClientRects().length === 0) continue;
      if (window.getComputedStyle(el).visibility === 'hidden') continue;
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || tagName;
      var text = '';
      var disabled = false;
      if (el.disabled !== undefined) disabled = el.disabled;
      if (tagName === 'input') {
        const inputType = el.getAttribute('type') || 'text';
        if (el.labels && el.labels.length > 0) {
          text = el.labels[0].innerText.trim();
        } else if (el.placeholder) {
          text = el.placeholder;
        }
        result.interactive.push({ text: text, role: role, type: inputType, disabled: disabled });
      } else if (tagName === 'select' || tagName === 'textarea') {
        if (el.labels && el.labels.length > 0) {
          text = el.labels[0].innerText.trim();
        } else if (el.placeholder) {
          text = el.placeholder;
        }
        result.interactive.push({ text: text, role: role, disabled: disabled });
      } else {
        text = (el.innerText || el.value || '').trim();
        result.interactive.push({ text: text, role: role, disabled: disabled });
      }
    }

    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
})();`;

// ─── runExtractor() — call the script via evaluate ────────────────

/**
 * Run the DOM extractor in the page context via plugin.evaluate().
 *
 * The extractor runs purely on DOM properties — no fetch, no XHR, no eval.
 * Returns a parsed ExtractResult, or null on failure (including error
 * caught by the script itself, evaluate rejection, or invalid JSON).
 */
export async function runExtractor(
	taskId: string,
	plugin: BrowserPlugin,
): Promise<ExtractResult | null> {
	try {
		const evalResult = await plugin.evaluate(taskId, EXTRACTOR_SCRIPT);

		if (!evalResult.success) {
			return null;
		}

		// The script returns a JSON string inside result.result
		const rawJson =
			typeof evalResult.result === "string"
				? evalResult.result
				: JSON.stringify(evalResult.result);

		const parsed = JSON.parse(rawJson) as ExtractResult;

		// Check for script-level error
		if (parsed.error) {
			console.warn("[pi-browser] DOM extractor script error:", parsed.error);
			return null;
		}

		// Validate shape (basic structural check)
		if (
			typeof parsed.title !== "string" ||
			!Array.isArray(parsed.headings) ||
			!Array.isArray(parsed.paragraphs) ||
			!Array.isArray(parsed.links) ||
			!Array.isArray(parsed.images) ||
			!Array.isArray(parsed.interactive)
		) {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

// ─── correlateElements() — @e ref annotation ──────────────────────

/**
 * Build a reverse index from the element cache: "role||name" → ref[].
 * Handles many-to-many duplicates (multiple elements with same role+name).
 */
function buildReverseIndex(
	cache: Map<string, AriaCachedNode>,
): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const [, node] of cache) {
		const key = `${node.role}||${node.name}`;
		const existing = index.get(key);
		if (existing) {
			existing.push(node.ref);
		} else {
			index.set(key, [node.ref]);
		}
	}
	return index;
}

/**
 * Annotate extracted text with @e refs from the element cache.
 *
 * For each element in the extract result, looks up matching AriaCachedNode
 * by role + name. Annotates with @e refs where matches are found.
 * Handles duplicate role+name by annotating ALL matching @e refs.
 *
 * @param extracted - The structured result from the DOM walker
 * @param elementCache - The plugin's element cache (ref → AriaCachedNode)
 * @param cacheFresh - Whether the cache is still fresh (true = no staleness notice)
 */
export function correlateElements(
	extracted: ExtractResult,
	elementCache: Map<string, AriaCachedNode>,
	cacheFresh: boolean,
): CorrelatedResult {
	const reverseIndex = buildReverseIndex(elementCache);
	const matchedRefs = new Set<string>();
	const lines: string[] = [];

	// ── Title ──
	if (extracted.title) {
		lines.push(`Title: ${extracted.title}`);
		lines.push("");
	}

	// ── Headings ──
	if (extracted.headings.length > 0) {
		lines.push("Headings:");
		for (const h of extracted.headings) {
			const refs = reverseIndex.get(`heading||${h.text}`);
			const refStr = refs ? annotateRefs(refs, matchedRefs) : "";
			lines.push(`  ${refStr}📌 "${h.text}" [${h.level}]`);
		}
		lines.push("");
	}

	// ── Content (paragraphs, links, images) ──
	if (
		extracted.paragraphs.length > 0 ||
		extracted.links.length > 0 ||
		extracted.images.length > 0
	) {
		lines.push("Content:");

		// Paragraphs
		for (const p of extracted.paragraphs) {
			const refs = reverseIndex.get(`paragraph||${p.text}`);
			const refStr = refs ? annotateRefs(refs, matchedRefs) : "";
			const region = p.region ? ` [${p.region}]` : "";
			// Cap individual paragraph text at 300 chars
			const displayText =
				p.text.length > 300 ? p.text.slice(0, 297) + "…" : p.text;
			lines.push(`  ${refStr}${displayText}${region}`);
		}

		// Links
		for (const link of extracted.links) {
			const refs = reverseIndex.get(`link||${link.text}`);
			const refStr = refs ? annotateRefs(refs, matchedRefs) : "";
			lines.push(`  ${refStr}🔗 "${link.text}" → ${link.href}`);
		}

		// Images
		for (const img of extracted.images) {
			const refs = reverseIndex.get(`img||${img.alt}`);
			const refStr = refs ? annotateRefs(refs, matchedRefs) : "";
			lines.push(`  ${refStr}🖼 "${img.alt}"`);
		}

		lines.push("");
	}

	// ── Interactive elements ──
	if (extracted.interactive.length > 0) {
		lines.push("Interactive:");
		for (const el of extracted.interactive) {
			const refs = reverseIndex.get(`${el.role}||${el.text}`);
			const refStr = refs ? annotateRefs(refs, matchedRefs) : "";

			const icon = roleIcon(el.role) || "• ";
			const disabledStr = el.disabled ? " [disabled]" : "";
			const typeStr = el.type ? ` type="${el.type}"` : "";
			const displayText =
				el.text && el.text.length > 0
					? ` "${el.text.length > 80 ? el.text.slice(0, 77) + "…" : el.text}"`
					: "";
			lines.push(
				`  ${refStr}${icon}${el.role}${displayText}${typeStr}${disabledStr}`,
			);
		}
		lines.push("");
	}

	// ── Staleness notice ──
	let staleCache = false;
	if (!cacheFresh && matchedRefs.size > 0) {
		staleCache = true;
		lines.push(
			"⚠ Element refs may be stale — consider browser-snapshot before clicking.",
		);
	}

	return {
		text: lines.join("\n").trim(),
		matchedRefs: matchedRefs.size,
		staleCache,
	};
}

/**
 * Annotate @e refs into a leading string.
 * Multiple refs are comma-separated.
 */
function annotateRefs(refs: string[], matchedRefs: Set<string>): string {
	for (const ref of refs) {
		matchedRefs.add(ref);
	}
	if (refs.length === 1) {
		return `@${refs[0]} `;
	}
	return `@${refs.join(", @")} `;
}

// ─── queryElementCache() — synchronous cache filter ───────────────

/**
 * Query the element cache synchronously.
 *
 * - ref: look up a specific @e ref (with or without @ prefix)
 * - role: comma-separated roles, match any
 * - name: case-insensitive substring match
 * - subtree: find elements whose parentRef chain leads to a container
 *   matching the given role
 *
 * All filters are AND-ed.
 */
export function queryElementCache(
	cache: Map<string, AriaCachedNode>,
	filters: ElementCacheQuery,
): AriaCachedNode[] {
	const results: AriaCachedNode[] = [];

	// ref lookup: direct map access (cache keys are "e5" not "@e5")
	if (filters.ref) {
		const key = filters.ref.startsWith("@")
			? filters.ref.slice(1)
			: filters.ref;
		const node = cache.get(key);
		if (node) {
			// Apply additional filters if any
			if (filters.role && !matchesRole(node, filters.role)) return [];
			if (filters.name && !matchesName(node, filters.name)) return [];
			if (filters.subtree && !matchesSubtree(node, cache, filters.subtree))
				return [];
			return [node];
		}
		return [];
	}

	// Pre-compute subtree ancestry map for subtree filter
	const subtreeAncestors = filters.subtree
		? computeSubtreeAncestors(cache, filters.subtree)
		: null;

	for (const [, node] of cache) {
		if (filters.role && !matchesRole(node, filters.role)) continue;
		if (filters.name && !matchesName(node, filters.name)) continue;
		if (filters.subtree && subtreeAncestors) {
			if (!subtreeAncestors.has(node.ref)) continue;
		}
		results.push(node);
	}

	return results;
}

function matchesRole(node: AriaCachedNode, roleFilter: string): boolean {
	const roles = roleFilter.split(",").map((r) => r.trim().toLowerCase());
	return roles.includes(node.role);
}

function matchesName(node: AriaCachedNode, nameFilter: string): boolean {
	return node.name.toLowerCase().includes(nameFilter.toLowerCase());
}

/**
 * Compute the set of element refs that are inside a container matching
 * the given role. Follows parentRef chains.
 */
function computeSubtreeAncestors(
	cache: Map<string, AriaCachedNode>,
	containerRole: string,
): Set<string> {
	const containerRefs = new Set<string>();
	const insideRefs = new Set<string>();

	// Find all container elements matching the role
	for (const [, node] of cache) {
		if (node.role === containerRole) {
			containerRefs.add(node.ref);
		}
	}

	if (containerRefs.size === 0) return insideRefs;

	// For each node, walk parentRef chain to see if any ancestor is a container
	for (const [, node] of cache) {
		// Skip the containers themselves
		if (containerRefs.has(node.ref)) continue;

		let current: AriaCachedNode | undefined = node;
		let depth = 0;
		while (current && depth < 100) {
			// Safety limit on chain depth
			if (containerRefs.has(current.ref)) {
				insideRefs.add(node.ref);
				break;
			}
			if (!current.parentRef) break;
			current = cache.get(current.parentRef);
			depth++;
		}
	}

	return insideRefs;
}

function matchesSubtree(
	node: AriaCachedNode,
	cache: Map<string, AriaCachedNode>,
	containerRole: string,
): boolean {
	const ancestors = computeSubtreeAncestors(cache, containerRole);
	return ancestors.has(node.ref);
}

// ─── Output formatting ────────────────────────────────────────────

/**
 * Format a list of AriaCachedNode elements for agent consumption.
 */
export function formatElementList(
	elements: AriaCachedNode[],
	filters?: ElementCacheQuery,
): string {
	if (elements.length === 0) {
		if (filters?.ref) {
			return `Element @${filters.ref.replace(/^@/, "")} not found in cache. Use browser-snapshot to refresh.`;
		}
		return "No matching elements found.";
	}

	const lines: string[] = [
		`Found ${elements.length} element${elements.length > 1 ? "s" : ""}:`,
		"",
	];

	for (const node of elements) {
		const icon = roleIcon(node.role);
		const refTag = `@${node.ref}`;
		const namePart = node.name ? ` "${node.name}"` : "";
		const propsStr = node.props.length > 0 ? ` [${node.props.join(", ")}]` : "";
		lines.push(`  ${refTag} ${icon}${node.role}${namePart}${propsStr}`);
	}

	return lines.join("\n");
}

/**
 * Format a role-count summary (fallback when no params provided).
 *
 * Only shows roles that have at least one element. Sorted by count descending.
 */
export function formatRoleCountSummary(
	cache: Map<string, AriaCachedNode>,
): string {
	const counts = new Map<string, number>();
	for (const [, node] of cache) {
		counts.set(node.role, (counts.get(node.role) ?? 0) + 1);
	}

	if (counts.size === 0) {
		return "No elements cached yet — use browser-snapshot to populate element cache.";
	}

	const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

	const parts: string[] = [];
	for (const [role, count] of sorted) {
		const icon = roleIcon(role);
		parts.push(`${count} ${icon}${role}${count > 1 ? "s" : ""}`);
	}

	return (
		parts.join(", ") + ". Use role=, name=, or text=true to query further."
	);
}
