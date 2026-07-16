/**
 * Bot detection heuristics.
 *
 * Analyzes page content to determine if a site is blocking
 * automation tools (Cloudflare, CAPTCHA, etc.). When detected,
 * the router flags the navigation as bot-blocked so the agent
 * can decide how to proceed — try web-fetch, try a different URL,
 * or switch to a stealth browser backend if one is configured.
 *
 * Signal lists are loaded from the shared ``browser-data.json`` —
 * the same file used by the Python bridge so the two sides never drift.
 */

import { BOT_SIGNALS } from "./browser-data.js";

/**
 * Content patterns that indicate a bot block — loaded from shared data.
 */
const BLOCK_SIGNALS = BOT_SIGNALS.blockSignals;

/**
 * Body-only string patterns — loaded from shared data.
 */
const BODY_ONLY_SIGNALS = BOT_SIGNALS.bodyOnlySignals;

/**
 * Body-only regex patterns — compiled from shared data at module load.
 */
const BODY_ONLY_PATTERNS: RegExp[] = BOT_SIGNALS.bodyOnlyPatterns.map(
	(src) => new RegExp(src, "i"),
);

/**
 * HTML-level signals — loaded from shared data.
 */
const HTML_SIGNALS = BOT_SIGNALS.htmlSignals;

/**
 * Check if page text content suggests a bot block.
 */
function checkBodyText(bodyText: string): boolean {
	if (!bodyText) return false;

	const lower = bodyText.toLowerCase();
	for (const signal of BLOCK_SIGNALS) {
		if (lower.includes(signal)) {
			return true;
		}
	}

	return false;
}

/**
 * Check body text against body-only signal patterns that are specific
 * enough to not false-positive on normal content.  Checks both string
 * inclusion (for CDN domains, generic 403 messages) and regex patterns
 * (for Akamai reference codes, etc.).
 */
function checkBodyOnlyText(bodyText: string): boolean {
	if (!bodyText) return false;

	const lower = bodyText.toLowerCase();

	// Check string signals first
	for (const signal of BODY_ONLY_SIGNALS) {
		if (lower.includes(signal)) {
			return true;
		}
	}

	// Check regex patterns against raw text (case-insensitive via /i flag)
	for (const pattern of BODY_ONLY_PATTERNS) {
		const match = bodyText.match(pattern);
		if (match) {
			return true;
		}
	}

	return false;
}

/**
 * Check raw HTML content for CAPTCHA widget embed codes.
 *
 * Looks for specific widget identifiers in the HTML source (not visible text),
 * so false positive risk from generic mentions is low.  The signal list is
 * loaded from the shared ``browser-data.json`` so TypeScript and Python
 * bridge implementations share a single source of truth.
 */
function checkHtmlContent(html: string): boolean {
	if (!html) return false;

	const lower = html.toLowerCase();
	for (const signal of HTML_SIGNALS) {
		if (lower.includes(signal)) {
			return true;
		}
	}

	return false;
}

/**
 * Combined check: analyze page title, body text, and (optionally) raw HTML.
 *
 * - Title is checked against BLOCK_SIGNALS only (avoids false positives).
 * - Body is checked against BLOCK_SIGNALS + BODY_ONLY_SIGNALS + BODY_ONLY_PATTERNS
 *   (catches CDN-specific block pages like Akamai "Access Denied").
 * - HTML (if provided) is checked for CAPTCHA widget embed codes.
 */
export function checkPage(
	title: string,
	bodyText: string,
	html?: string,
): boolean {
	// Check title first (often contains "Attention Required!" etc.)
	if (checkBodyText(title)) return true;

	// Check body against challenge phrases
	if (checkBodyText(bodyText)) return true;

	// Check body against CDN-specific patterns (reference #, etc.)
	if (checkBodyOnlyText(bodyText)) return true;

	// Check HTML source for CAPTCHA widget embed codes
	if (html !== undefined && checkHtmlContent(html)) return true;

	return false;
}
