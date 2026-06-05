/**
 * URL Safety Checks
 *
 * Prevents SSRF (Server-Side Request Forgery) and secret exfiltration
 * by validating URLs before navigation.
 *
 * Patterns from hermes-agent's url_safety.py.
 */

// ─── Blocked hostnames ───────────────────────────────────────────────

/** Internal/private network ranges that should never be accessed */
const BLOCKED_HOSTNAMES = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254",  // AWS/GCP metadata endpoint
  "metadata.google.internal",
  "100.100.100.200",  // Alibaba Cloud metadata
];

/** Regex for private IP ranges (10.x, 172.16-31.x, 192.168.x) */
const PRIVATE_IP_REGEX = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

// ─── Blocked URL patterns ─────────────────────────────────────────────

/** File-like schemes that shouldn't be followed */
const BLOCKED_SCHEMES = ["file:", "ftp:", "data:", "javascript:", "vbscript:"];

// ─── Secret detection ────────────────────────────────────────────────

/**
 * Patterns that look like API keys, tokens, or passwords in URLs.
 * Follows hermes-agent's approach: checks for known key prefixes rather
 * than generic length-based patterns, reducing false positives.
 * Also checks the percent-decoded URL for encoded secrets.
 */
const SECRET_PATTERNS = [
  // Generic API keys in query params (specific param names)
  /[\?&](api[_-]?key|token|secret|password|passwd|auth|credential|private[_-]?key|access[_-]?key)=/i,
  // Bearer tokens in headers (unlikely in URLs but check anyway)
  /Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/i,
  // GitHub tokens: ghp_, ghs_, ghg_, gho_, ghu_
  /gh[psogu]_[A-Za-z0-9_]{36}/,
  // Slack tokens: xoxb-, xoxp-, xoxa-, xoxs-, xoxr-
  /xox[bpras]-[A-Za-z0-9-]+/,
  // Stripe: sk_live_, sk_test_, pk_live_, pk_test_, whsec_
  /(sk|pk)_(live|test)_[A-Za-z0-9]+/,
  /whsec_[A-Za-z0-9]+/,
  // AWS access key ID (starts with AKIA)
  /AKIA[A-Z0-9]{16}/,
  // Google API keys (AIza prefix)
  /AIza[0-9A-Za-z\-_]{35}/,
  // Discord bot tokens
  /[MN][A-Za-z\d]{23}\.[XZ][A-Za-z\d]{6}\.[A-Za-z\d]{27}/,
  // SendGrid API keys (SG. prefix)
  /SG\.[A-Za-z0-9-_]{22}\.[A-Za-z0-9-_]{43}/,
  // HubSpot API keys
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  // Generic secret in URL path segment (e.g., "secret=..." in path)
  /\/secret(?:s)?\//i,
];

// ─── Types ────────────────────────────────────────────────────────────

export interface UrlSafetyResult {
  /** Whether the URL is safe to navigate to */
  safe: boolean;
  /** Human-readable reason if not safe */
  reason?: string;
  /** The specific issue category */
  category?: "ssrf" | "scheme" | "secret" | "malformed";
}

// ─── Validation ───────────────────────────────────────────────────────

export function validateUrl(rawUrl: string): UrlSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Malformed URL", category: "malformed" };
  }

  // Check scheme
  const scheme = parsed.protocol.toLowerCase();
  if (BLOCKED_SCHEMES.includes(scheme)) {
    return {
      safe: false,
      reason: `Blocked scheme: ${scheme}`,
      category: "scheme",
    };
  }

  if (scheme !== "http:" && scheme !== "https:") {
    return {
      safe: false,
      reason: `Unsupported scheme: ${scheme}. Only http and https are allowed.`,
      category: "scheme",
    };
  }

  // Check hostname against blocked list
  const hostname = parsed.hostname.toLowerCase();
  for (const blocked of BLOCKED_HOSTNAMES) {
    if (hostname === blocked || hostname.endsWith("." + blocked)) {
      return {
        safe: false,
        reason: `Blocked hostname: ${hostname} (private/internal network)`,
        category: "ssrf",
      };
    }
  }

  // Check for private IP ranges
  if (PRIVATE_IP_REGEX.test(hostname)) {
    return {
      safe: false,
      reason: `Blocked IP range: ${hostname} (private network)`,
      category: "ssrf",
    };
  }

  // Check for IPv6 loopback
  if (hostname.startsWith("[") && (hostname.includes("::1") || hostname.includes("::ffff:127"))) {
    return {
      safe: false,
      reason: `Blocked IPv6 address: ${hostname} (loopback)`,
      category: "ssrf",
    };
  }

  // Check for secrets in URL (raw and percent-decoded)
  const urlStr = parsed.toString();
  try {
    const decodedUrl = decodeURIComponent(urlStr);
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(urlStr) || pattern.test(decodedUrl)) {
        return {
          safe: false,
          reason: `Potential secret detected in URL. Remove sensitive parameters before navigating.`,
          category: "secret",
        };
      }
    }
  } catch {
    // If decoding fails, just check the raw URL
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(urlStr)) {
        return {
          safe: false,
          reason: `Potential secret detected in URL. Remove sensitive parameters before navigating.`,
          category: "secret",
        };
      }
    }
  }

  return { safe: true };
}
