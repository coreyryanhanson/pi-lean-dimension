/**
 * SSRF guard — blocks loopback, private RFC1918 ranges, and cloud metadata
 * endpoints on server-supplied URLs only (paginate nextLink).
 *
 * Agent-supplied URLs (restGet / buildUrl) are NOT guarded — the agent has
 * bash, so guarding them is theater. Scheme-blocking is redundant (undici
 * only fetches http:/https:). The secret-in-URL regex is omitted (host
 * doesn't handle secrets in v1).
 *
 * The guard becomes load-bearing when auth.kind:static-key / oauth2 ships:
 * at that point a server-supplied nextUrl to an internal host would leak
 * the Authorization header — textbook SSRF.
 */

// ─── Blocked hostnames ───────────────────────────────────────────────

const BLOCKED_HOSTNAMES = [
	"localhost",
	"127.0.0.1",
	"0.0.0.0",
	"::1",
	"169.254.169.254", // AWS/GCP metadata endpoint
	"metadata.google.internal",
	"100.100.100.200", // Alibaba Cloud metadata
];

/** Regex for private IP ranges (10.x, 172.16-31.x, 192.168.x) */
const PRIVATE_IP_REGEX = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

// ─── Guard ───────────────────────────────────────────────────────────

export function ssrfGuard(
	rawUrl: string,
): { ok: true } | { ok: false; reason: string } {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { ok: false, reason: "Malformed URL" };
	}

	const hostname = parsed.hostname.toLowerCase();

	// Check against blocked hostname list (exact or subdomain match).
	for (const blocked of BLOCKED_HOSTNAMES) {
		if (hostname === blocked || hostname.endsWith("." + blocked)) {
			return {
				ok: false,
				reason: `Blocked hostname: ${hostname} (private/internal network)`,
			};
		}
	}

	// Check for private IP ranges.
	if (PRIVATE_IP_REGEX.test(hostname)) {
		return {
			ok: false,
			reason: `Blocked IP range: ${hostname} (private network)`,
		};
	}

	// Check IPv6. Node's URL.hostname INCLUDES brackets for IPv6 (e.g.
	// "[::1]", "[fe80::1]"), so substring checks work on the inner form.
	if (hostname.includes("::1")) {
		return {
			ok: false,
			reason: `Blocked IPv6 address: ${hostname} (loopback)`,
		};
	}

	// IPv4-mapped IPv6. Node renders these in HEX, never decimal — e.g.
	// http://[::ffff:127.0.0.1]/ → "[::ffff:7f00:1]", so a decimal
	// string check is silently dead. No legitimate public API serves
	// nextLinks over IPv4-mapped IPv6, so reject the whole family rather
	// than trying to decode the embedded IPv4.
	if (hostname.includes("::ffff:")) {
		return {
			ok: false,
			reason: `Blocked IPv4-mapped IPv6 address: ${hostname} (private/internal network)`,
		};
	}

	return { ok: true };
}
