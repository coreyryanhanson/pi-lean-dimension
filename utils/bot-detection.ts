/**
 * Bot detection heuristics.
 *
 * Analyzes page content and headers to determine if a site is blocking
 * automation tools (Cloudflare, CAPTCHA, etc.), triggering escalation
 * from Level 2 (Playwright Chromium) to Level 3 (stealth Firefox).
 */

export interface BotDetectionResult {
  /** True if the page appears to be a bot block/challenge page */
  isBlocked: boolean;
  /** Confidence score 0-1 */
  confidence: number;
  /** Signal that triggered the detection */
  signal?: string;
}

/** Content patterns that indicate a bot block */
const BLOCK_SIGNALS = [
  "please verify you are human",
  "attention required!",
  "cloudflare",
  "just a moment...",
  "checking your browser",
  "enable javascript",
  "captcha",
  "security check",
  "ddos protection",
  "you have been blocked",
  "access denied",
  "sorry, you have been blocked",
  "verify you are human",
  "automated access",
  "unusual traffic",
  "your request has been blocked",
  "we are checking your browser",
  "challenge complete",
  "press and hold",
  "turnstile",
  "hcaptcha",
  "recaptcha",
  "cf-challenge",
  "_cf_chl_opt",
  "cdn-cgi/challenge",
];

/** HTTP header patterns that suggest bot blocking */
const HEADER_SIGNALS = [
  "cf-challenge",
  "cf-ray",
  "server: cloudflare",
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
 * Check HTTP response headers for bot block signals.
 */
export function checkHeaders(
  headers: Record<string, string>,
): BotDetectionResult {
  for (const [key, value] of Object.entries(headers)) {
    const combined = `${key.toLowerCase()}: ${value.toLowerCase()}`;
    for (const signal of HEADER_SIGNALS) {
      if (combined.includes(signal)) {
        return { isBlocked: true, confidence: 0.8, signal };
      }
    }
  }
  return { isBlocked: false, confidence: 0 };
}

/**
 * Combined check: analyze both page title and body text.
 */
export function checkPage(
  title: string,
  bodyText: string,
): BotDetectionResult {
  // Check title first (often contains "Attention Required!" etc.)
  const titleResult = checkBodyText(title);
  if (titleResult.isBlocked) return titleResult;

  // Check body text
  return checkBodyText(bodyText);
}
