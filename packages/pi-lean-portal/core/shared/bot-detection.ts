/**
 * Bot detection heuristics.
 *
 * Analyzes page content to determine if a site is blocking
 * automation tools (Cloudflare, CAPTCHA, etc.). When detected,
 * the router flags the navigation as bot-blocked so the agent
 * can decide how to proceed — try web-fetch, try a different URL,
 * or switch to a stealth browser backend if one is configured.
 */

export interface BotDetectionResult {
	/** True if the page appears to be a bot block/challenge page */
	isBlocked: boolean;
	/** Confidence score 0-1 */
	confidence: number;
	/** Signal that triggered the detection */
	signal?: string;
}

/**
 * Content patterns that indicate a bot block.
 *
 * Only specific challenge phrases are included — generic single words
 * like "cloudflare", "captcha", "recaptcha", "hcaptcha", "enable javascript"
 * etc. are excluded because they cause false positives on legitimate
 * pages (Cloudflare's own site, web scraping articles, CAPTCHA service pages).
 * Real challenge pages always use these exact phrases.
 */
const BLOCK_SIGNALS = [
	"please verify you are human",
	"attention required!",
	"just a moment...",
	"checking your browser",
	"you have been blocked",
	"sorry, you have been blocked",
	"verify you are human",
	"your request has been blocked",
	"we are checking your browser",
	"cf-challenge",
	"_cf_chl_opt",
	"cdn-cgi/challenge",
];

/**
 * Body-only string patterns — checked in body text (not the title) to
 * avoid false matches on legitimate content.  Catches CDN-specific
 * block pages (Akamai "Access Denied", generic 403s).
 */
const BODY_ONLY_SIGNALS = [
	"errors.edgesuite.net",
	"you don't have permission to access",
];

/**
 * Body-only regex patterns — more specific than string inclusion.
 * These match the exact format of CDN error reference codes to
 * avoid false positives from generic "reference #123" in normal content.
 */
const BODY_ONLY_PATTERNS: RegExp[] = [
	/reference\s*#[a-f0-9]+(?:\.[a-f0-9]+)+/i,
];

/**
 * HTML-level signals — checked against ``document.documentElement.innerHTML``
 * rather than visible body text.  These look for CAPTCHA widget embed codes
 * in the raw HTML source, which is a stronger signal than visible text
 * (generic mentions of "captcha" in body copy are excluded to avoid false
 * positives, but embed codes in HTML attributes are unambiguous).
 */
const HTML_SIGNALS = [
	"recaptcha",
	"hcaptcha",
	"turnstile",
	"g-recaptcha",
	"data-sitekey",
];

/**
 * Check if page text content suggests a bot block.
 */
export function checkBodyText(bodyText: string): BotDetectionResult {
	if (!bodyText) return { isBlocked: false, confidence: 0 };

	const lower = bodyText.toLowerCase();
	for (const signal of BLOCK_SIGNALS) {
		if (lower.includes(signal)) {
			return {
				isBlocked: true,
				confidence: signal.length > 20 ? 0.9 : 0.7,
				signal,
			};
		}
	}

	return { isBlocked: false, confidence: 0 };
}

/**
 * Check body text against body-only signal patterns that are specific
 * enough to not false-positive on normal content.  Checks both string
 * inclusion (for CDN domains, generic 403 messages) and regex patterns
 * (for Akamai reference codes, etc.).
 */
function checkBodyOnlyText(bodyText: string): BotDetectionResult {
	if (!bodyText) return { isBlocked: false, confidence: 0 };

	const lower = bodyText.toLowerCase();

	// Check string signals first
	for (const signal of BODY_ONLY_SIGNALS) {
		if (lower.includes(signal)) {
			return { isBlocked: true, confidence: 0.85, signal };
		}
	}

	// Check regex patterns against raw text (case-insensitive via /i flag)
	for (const pattern of BODY_ONLY_PATTERNS) {
		const match = bodyText.match(pattern);
		if (match) {
			return {
				isBlocked: true,
				confidence: 0.9,
				signal: `regex: ${match[0].slice(0, 50)}`,
			};
		}
	}

	return { isBlocked: false, confidence: 0 };
}

/**
 * Check raw HTML content for CAPTCHA widget embed codes.
 *
 * Looks for specific widget identifiers in the HTML source (not visible text),
 * so false positive risk from generic mentions is low.  Mirrors the Python
 * bridge's ``_HTML_SIGNALS`` in ``backends/chromium-py/bridge.py``.
 */
export function checkHtmlContent(html: string): BotDetectionResult {
	if (!html) return { isBlocked: false, confidence: 0 };

	const lower = html.toLowerCase();
	for (const signal of HTML_SIGNALS) {
		if (lower.includes(signal)) {
			return {
				isBlocked: true,
				confidence: 0.85,
				signal: `html:${signal}`,
			};
		}
	}

	return { isBlocked: false, confidence: 0 };
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
): BotDetectionResult {
	// Check title first (often contains "Attention Required!" etc.)
	const titleResult = checkBodyText(title);
	if (titleResult.isBlocked) return titleResult;

	// Check body against challenge phrases
	const bodyResult = checkBodyText(bodyText);
	if (bodyResult.isBlocked) return bodyResult;

	// Check body against CDN-specific patterns (reference #, etc.)
	const bodyOnlyResult = checkBodyOnlyText(bodyText);
	if (bodyOnlyResult.isBlocked) return bodyOnlyResult;

	// Check HTML source for CAPTCHA widget embed codes
	if (html !== undefined) {
		const htmlResult = checkHtmlContent(html);
		if (htmlResult.isBlocked) return htmlResult;
	}

	return { isBlocked: false, confidence: 0 };
}
